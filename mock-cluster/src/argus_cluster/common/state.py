"""Process-global state for a single mock service."""
from __future__ import annotations
from dataclasses import dataclass, field


@dataclass
class ServiceState:
    name: str
    boot_at: float
    memory_mb: float = 100.0       # simulated heap
    inflight_requests: int = 0
    chaos: dict[str, dict] = field(default_factory=dict)  # type -> params

_state: ServiceState | None = None


def init(name: str, boot_at: float) -> None:
    global _state
    _state = ServiceState(name=name, boot_at=boot_at)


def get() -> ServiceState:
    assert _state is not None, "service state not initialized"
    return _state
