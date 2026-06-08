"""Cluster-wide chaos control + query rollup (logs/metrics/traces from all services)."""
from __future__ import annotations
import httpx
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="argus-cluster-gateway")

SERVICES = {
    "api":      "http://127.0.0.1:7101",
    "worker":   "http://127.0.0.1:7102",
    "db_proxy": "http://127.0.0.1:7103",
    "auth":     "http://127.0.0.1:7104",
}


class ChaosBody(BaseModel):
    type: str
    target: str
    duration_s: float
    params: dict = {}


@app.post("/chaos/inject")
async def chaos_inject(body: ChaosBody):
    url = SERVICES.get(body.target)
    if url is None:
        return {"error": f"unknown target {body.target}"}
    async with httpx.AsyncClient(timeout=5) as c:
        r = await c.post(f"{url}/chaos/inject", json=body.model_dump())
    return r.json()


@app.post("/chaos/clear")
async def chaos_clear():
    async with httpx.AsyncClient(timeout=5) as c:
        for u in SERVICES.values():
            try:
                await c.post(f"{u}/chaos/clear")
            except Exception:
                pass
    return {"ok": True}


@app.get("/logs")
async def logs(service: str | None = None, q: str | None = None, since: float | None = None):
    """Aggregate logs across services. Filter by service, substring, ts."""
    out: list[dict] = []
    async with httpx.AsyncClient(timeout=5) as c:
        targets = [service] if service in SERVICES else list(SERVICES.keys())
        for name in targets:
            try:
                r = await c.get(f"{SERVICES[name]}/_internal/logs")
                for rec in r.json():
                    if since is not None and rec["ts"] < since:
                        continue
                    if q and q.lower() not in rec["msg"].lower():
                        continue
                    rec["service"] = name
                    out.append(rec)
            except Exception:
                continue
    return out


@app.get("/metrics")
async def metrics(service: str | None = None):
    out: dict[str, str] = {}
    async with httpx.AsyncClient(timeout=5) as c:
        targets = [service] if service in SERVICES else list(SERVICES.keys())
        for name in targets:
            try:
                r = await c.get(f"{SERVICES[name]}/metrics")
                out[name] = r.text
            except Exception:
                out[name] = ""
    return out


@app.get("/traces")
async def traces(service: str | None = None):
    out: list[dict] = []
    async with httpx.AsyncClient(timeout=5) as c:
        targets = [service] if service in SERVICES else list(SERVICES.keys())
        for name in targets:
            try:
                r = await c.get(f"{SERVICES[name]}/_internal/traces")
                for s in r.json():
                    s["service"] = name
                    out.append(s)
            except Exception:
                continue
    return out


@app.get("/health")
async def health():
    out = {}
    async with httpx.AsyncClient(timeout=2) as c:
        for name, u in SERVICES.items():
            try:
                r = await c.get(f"{u}/health")
                out[name] = r.json()
            except Exception as e:
                out[name] = {"status": "down", "error": str(e)}
    return out
