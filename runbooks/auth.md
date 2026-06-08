# Auth Runbook

## Symptoms → likely cause
- `auth.verify db error` logs → upstream db_proxy unhealthy.
- 503s from `/verify` → propagating from db_proxy.

## Triage
1. Check auth logs for `db error`.
2. Confirm db_proxy health.
