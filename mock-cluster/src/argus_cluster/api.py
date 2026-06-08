"""api service: thin HTTP fronts that calls worker + db_proxy + auth."""
from __future__ import annotations
import time
import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from argus_cluster.common import chaos, logs, metrics, state, traces

state.init("api", time.time())
app = FastAPI(title="argus-api")

WORKER_URL = "http://127.0.0.1:7102"
DB_URL = "http://127.0.0.1:7103"
AUTH_URL = "http://127.0.0.1:7104"


@app.middleware("http")
async def chaos_mw(request, call_next):
    await chaos.apply(request.url.path)
    return await call_next(request)


@app.post("/chaos/inject")
async def chaos_inject(spec: chaos.ChaosSpec):
    chaos.inject(spec)
    logs.emit("info", "chaos injected", chaos=spec.model_dump())
    return {"ok": True}


@app.post("/chaos/clear")
async def chaos_clear():
    chaos.clear()
    return {"ok": True}


@app.get("/health")
async def health():
    s = state.get()
    return {"status": "ok", "memory_mb": s.memory_mb, "inflight": s.inflight_requests}


@app.get("/metrics")
async def metrics_endpoint():
    body, ct = metrics.render()
    return Response(content=body, media_type=ct)


@app.get("/_internal/logs")
async def _logs():
    return logs.snapshot()


@app.get("/_internal/traces")
async def _traces():
    return traces.snapshot()


@app.get("/process/{job_id}")
async def process_job(job_id: str):
    metrics.inflight.labels("api").inc()
    s = state.get()
    s.inflight_requests += 1
    try:
        with traces.span("api.process", job=job_id):
            async with httpx.AsyncClient(timeout=2) as c:
                try:
                    await c.post(f"{AUTH_URL}/verify", json={"job": job_id})
                except Exception as e:
                    logs.emit("error", "auth failed", err=str(e))
                    metrics.requests_total.labels("api", "401").inc()
                    raise HTTPException(401, "auth down")
                try:
                    r = await c.post(f"{WORKER_URL}/run", json={"job": job_id})
                    out = r.json()
                except httpx.HTTPError as e:
                    logs.emit("error", "worker failed", err=str(e), job=job_id)
                    metrics.requests_total.labels("api", "503").inc()
                    raise HTTPException(503, f"worker error: {e}")
                metrics.requests_total.labels("api", "200").inc()
                return {"job": job_id, "result": out}
    finally:
        s.inflight_requests -= 1
        metrics.inflight.labels("api").dec()
