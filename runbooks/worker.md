# Worker Service Runbook

## Symptoms → likely cause
- `OutOfMemoryError` in logs → memory leak in batch processor (since release 0.4.2).
- High memory_mb metric over 800 with rising trend → leak confirmed.
- Cascading 503s in `api` → worker upstream is OOM-killed.

## Triage steps
1. Search worker logs for `OutOfMemoryError`.
2. Check worker `memory_mb` metric trend over last 5 min.
3. Confirm cascading 503 spike in `api` `requests_total{code="503"}`.

## Remediation
- Short-term: restart worker process to clear leak.
- Long-term: roll back `batch_processor` to <0.4.2.
