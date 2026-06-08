# API Service Runbook

## Symptoms → likely cause
- 503 spikes in `requests_total{code="503"}` → upstream worker or db_proxy unhealthy.
- 401 spikes → auth service failing.

## Triage
1. Inspect `api` logs for downstream error pattern.
2. Check upstream health: worker, db_proxy, auth.
3. Confirm via traces which span is failing.
