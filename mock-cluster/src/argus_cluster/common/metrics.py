"""Prometheus-style counters/gauges per service."""
from __future__ import annotations
from prometheus_client import Counter, Gauge, generate_latest, CONTENT_TYPE_LATEST

requests_total = Counter("requests_total", "request count", ["service", "code"])
inflight = Gauge("inflight_requests", "in-flight", ["service"])
memory_mb = Gauge("memory_mb", "simulated heap MB", ["service"])


def render() -> tuple[bytes, str]:
    return generate_latest(), CONTENT_TYPE_LATEST
