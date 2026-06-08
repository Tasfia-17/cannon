import asyncio
import time
from argus_cluster.common import chaos, state


def setup_function():
    state.init("test", time.time())


def test_inject_and_clear_latency():
    chaos.inject(chaos.ChaosSpec(type="latency", target="test", duration_s=10, params={"mean_ms": 1}))
    assert chaos._active("latency") is not None
    chaos.clear()
    assert chaos._active("latency") is None


def test_latency_applies_under_one_second():
    chaos.inject(chaos.ChaosSpec(type="latency", target="test", duration_s=10, params={"mean_ms": 100}))
    start = time.time()
    asyncio.run(chaos.apply("/x"))
    elapsed = time.time() - start
    assert 0.04 < elapsed < 0.30
    chaos.clear()


def test_expired_chaos_self_clears():
    chaos.inject(chaos.ChaosSpec(type="latency", target="test", duration_s=0.05, params={"mean_ms": 1000}))
    time.sleep(0.06)
    assert chaos._active("latency") is None


def test_config_drift_inject_emits_revision_log():
    from argus_cluster.common import logs
    before = len(logs.snapshot())
    chaos.inject(chaos.ChaosSpec(type="config_drift", target="api", duration_s=10, params={"revision": 47}))
    snap = logs.snapshot()
    assert len(snap) > before
    assert any("config revision 47" in r["msg"] for r in snap[-3:])
    chaos.clear()


def test_config_drift_active_after_inject():
    chaos.inject(chaos.ChaosSpec(type="config_drift", target="api", duration_s=10, params={"rate": 1.0}))
    assert chaos._active("config_drift") is not None
    chaos.clear()
    assert chaos._active("config_drift") is None


def test_config_drift_apply_raises_503_when_rate_one():
    import pytest
    from fastapi import HTTPException
    chaos.inject(chaos.ChaosSpec(type="config_drift", target="api", duration_s=10, params={"rate": 1.0}))
    with pytest.raises(HTTPException) as ei:
        asyncio.run(chaos.apply("/process/x"))
    assert ei.value.status_code == 503
    assert "config drift" in ei.value.detail
    chaos.clear()
