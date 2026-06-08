"""Chaos injection: register/clear and decorator for endpoints."""
from __future__ import annotations
import asyncio
import random
import time
from fastapi import HTTPException
from pydantic import BaseModel
from . import state


class ChaosSpec(BaseModel):
    type: str        # latency | error_5xx | memleak | crash | slow_query | config_drift
    target: str      # service name (informational; the receiving svc applies)
    duration_s: float
    params: dict = {}


def inject(spec: ChaosSpec) -> None:
    s = state.get()
    s.chaos[spec.type] = {
        "expires_at": time.time() + spec.duration_s,
        **spec.params,
    }
    if spec.type == "config_drift":
        from . import logs
        rev = spec.params.get("revision", 1)
        logs.emit(
            "warn",
            f"config revision {rev} applied: routing=invalid pool_size=0",
            revision=rev,
            target=spec.target,
        )


def clear() -> None:
    state.get().chaos.clear()


def _active(kind: str) -> dict | None:
    s = state.get()
    entry = s.chaos.get(kind)
    if entry is None:
        return None
    if time.time() >= entry["expires_at"]:
        s.chaos.pop(kind, None)
        return None
    return entry


async def apply(endpoint: str) -> None:
    """Call at the top of each request handler to apply active chaos."""
    if (lat := _active("latency")) is not None:
        mean = lat.get("mean_ms", 500) / 1000
        await asyncio.sleep(random.uniform(mean * 0.5, mean * 1.5))
    if (err := _active("error_5xx")) is not None:
        rate = err.get("rate", 0.5)
        if random.random() < rate:
            raise HTTPException(status_code=503, detail="chaos: 5xx injected")
    if (drift := _active("config_drift")) is not None:
        rate = drift.get("rate", 0.4)
        if random.random() < rate:
            raise HTTPException(status_code=503, detail="chaos: config drift (invalid routing)")
    if (crash := _active("crash")) is not None:
        # one-shot crash
        state.get().chaos.pop("crash", None)
        import os
        os._exit(1)


def memleak_tick() -> None:
    """Called by background tick — applies memory growth if memleak active."""
    if (leak := _active("memleak")) is not None:
        rate = leak.get("mb_per_tick", 5)
        state.get().memory_mb += rate
