"""db_proxy: pool can saturate under slow_query chaos."""
from __future__ import annotations
import asyncio
import time
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from argus_cluster.common import chaos, logs, metrics, state, traces

state.init("db_proxy", time.time())
app = FastAPI(title="argus-db-proxy")
POOL_SIZE = 10
_sem = asyncio.Semaphore(POOL_SIZE)


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
    return {"status": "ok", "pool_used": POOL_SIZE - _sem._value, "pool_size": POOL_SIZE}


@app.get("/metrics")
async def metrics_endpoint():
    body, ct = metrics.render()
    return Response(content=body, media_type=ct)


@app.get("/_internal/logs")
async def _logs(): return logs.snapshot()


@app.get("/_internal/traces")
async def _traces(): return traces.snapshot()


@app.post("/query")
async def query(body: dict):
    try:
        await asyncio.wait_for(_sem.acquire(), timeout=2.0)
    except asyncio.TimeoutError:
        logs.emit("error", "db pool exhausted", inflight=POOL_SIZE)
        metrics.requests_total.labels("db_proxy", "503").inc()
        raise HTTPException(503, "pool exhausted")
    try:
        with traces.span("db.query"):
            slow = chaos._active("slow_query")
            delay = (slow or {}).get("ms", 30) / 1000
            await asyncio.sleep(delay)
            metrics.requests_total.labels("db_proxy", "200").inc()
            return {"rows": 1}
    finally:
        _sem.release()
