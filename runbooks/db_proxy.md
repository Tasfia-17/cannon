# DB Proxy Runbook

## Symptoms → likely cause
- `pool exhausted` log lines → connection pool saturated by slow queries.
- `pool_used` at `pool_size` for >30s → confirmed saturation.

## Triage
1. Search logs for `pool exhausted`.
2. Check inflight in `/health`.
3. Inspect traces for `db.query` spans with anomalous duration_ms.

## Remediation
- Identify slow query upstream; cancel.
- Increase pool size if structural.
