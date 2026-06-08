"""auth: light verify endpoint; calls db_proxy."""
from __future__ import annotations
import time
import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from argus_cluster.common import chaos, logs, metrics, state, traces

state.init("auth", time.time())
app = FastAPI(title="argus-auth")
DB_URL = "http://127.0.0.1:7103"


@app.middleware("http")
async def chaos_mw(request, call_next):
    await chaos.apply(request.url.path)
    return await call_next(request)


@app.post("/chaos/inject")
async def chaos_inject(spec: chaos.ChaosSpec):
    chaos.inject(spec)
    return {"ok": True}


@app.post("/chaos/clear")
async def chaos_clear():
    chaos.clear()
    return {"ok": True}


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/metrics")
async def metrics_endpoint():
    body, ct = metrics.render()
    return Response(content=body, media_type=ct)


@app.get("/_internal/logs")
async def _logs(): return logs.snapshot()


@app.get("/_internal/traces")
async def _traces(): return traces.snapshot()


@app.post("/verify")
async def verify(body: dict):
    with traces.span("auth.verify"):
        async with httpx.AsyncClient(timeout=2) as c:
            r = await c.post(f"{DB_URL}/query", json={"sql": "select 1"})
        if r.status_code != 200:
            logs.emit("error", "auth.verify db error", code=r.status_code)
            raise HTTPException(503, "db down")
        return {"ok": True}
