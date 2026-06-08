"""worker service: simulates compute; vulnerable to memleak chaos."""
from __future__ import annotations
import asyncio
import time
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.responses import Response
from argus_cluster.common import chaos, logs, metrics, state, traces

state.init("worker", time.time())


@asynccontextmanager
async def lifespan(app: FastAPI):
    async def tick():
        while True:
            chaos.memleak_tick()
            s = state.get()
            metrics.memory_mb.labels("worker").set(s.memory_mb)
            # crude OOM: above 1024 MB → emit + 503 all requests until restart
            if s.memory_mb > 1024 and "oom" not in s.chaos:
                logs.emit("error", "OutOfMemoryError: heap exhausted", memory_mb=s.memory_mb)
                s.chaos["oom"] = {"expires_at": time.time() + 9999}
            await asyncio.sleep(1.0)
    task = asyncio.create_task(tick())
    try:
        yield
    finally:
        task.cancel()


app = FastAPI(title="argus-worker", lifespan=lifespan)


@app.middleware("http")
async def chaos_mw(request, call_next):
    await chaos.apply(request.url.path)
    if "oom" in state.get().chaos and not request.url.path.startswith(("/chaos", "/health", "/metrics", "/_internal")):
        return Response(status_code=503, content="OOM")
    return await call_next(request)


@app.post("/chaos/inject")
async def chaos_inject(spec: chaos.ChaosSpec):
    chaos.inject(spec)
    logs.emit("info", "chaos injected", chaos=spec.model_dump())
    return {"ok": True}


@app.post("/chaos/clear")
async def chaos_clear():
    chaos.clear()
    state.get().memory_mb = 100.0
    return {"ok": True}


@app.get("/health")
async def health():
    s = state.get()
    healthy = "oom" not in s.chaos and s.memory_mb < 900
    return {"status": "ok" if healthy else "degraded", "memory_mb": s.memory_mb}


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


@app.post("/run")
async def run(body: dict):
    with traces.span("worker.run", job=body.get("job")):
        await asyncio.sleep(0.05)
        metrics.requests_total.labels("worker", "200").inc()
        logs.emit("info", "job done", job=body.get("job"))
        return {"result": "ok"}
