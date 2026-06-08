"""Structured logs: ring buffer per service, queryable via cluster API."""
from __future__ import annotations
import collections
import json
import time
from typing import Any

_RING: collections.deque[dict[str, Any]] = collections.deque(maxlen=5000)


def emit(level: str, msg: str, **fields: Any) -> None:
    rec = {"ts": time.time(), "level": level, "msg": msg, **fields}
    _RING.append(rec)
    print(json.dumps(rec), flush=True)


def snapshot() -> list[dict[str, Any]]:
    return list(_RING)
