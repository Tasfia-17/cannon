"""Mock OTel-ish span list, in-memory."""
from __future__ import annotations
import collections
import time
import uuid
from contextlib import contextmanager
from typing import Any

_SPANS: collections.deque[dict[str, Any]] = collections.deque(maxlen=2000)


@contextmanager
def span(name: str, **attrs: Any):
    span_id = uuid.uuid4().hex[:8]
    start = time.time()
    try:
        yield span_id
    finally:
        _SPANS.append({
            "id": span_id, "name": name, "start": start,
            "duration_ms": (time.time() - start) * 1000, **attrs,
        })


def snapshot() -> list[dict[str, Any]]:
    return list(_SPANS)
