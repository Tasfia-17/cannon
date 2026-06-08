# Cannon

**A dual-cognition SRE triage agent that keeps investigating when its own infrastructure fails.**

Two models run the same incident in parallel. When one goes down mid-step, the other takes over with no context loss. When tools fail, the circuit opens and investigation continues on cached data. When evidence is incomplete, Cannon says so rather than guessing.

Built for the [TrueFoundry Resilient Agents Hackathon 2026](https://lu.ma/resilient-agents).

---

## What it does

You launch a scenario. A fault injects into the mock cluster. Cannon opens an investigation:

- Reads logs, metrics, traces, and runbooks through TrueFoundry MCP Gateway
- Runs Claude (primary) and Llama (shadow) on the same step in parallel through TrueFoundry AI Gateway to AWS Bedrock
- Scores agreement between them at every step -- action match plus Jaccard cosine of the rationale text. When agreement falls below 0.35, that step is flagged as a divergence signal
- If Claude dies mid-step, the AbortController cancels the in-flight HTTP call immediately and Llama re-runs the same step from scratch
- Produces a postmortem with a disposition tied to the evidence:
  - `resolved` -- every tool returned ok and the hypothesis is grounded in the telemetry
  - `degraded` -- partial source coverage, investigation continued on available data
  - `inconclusive` -- no usable data came back

It only reads. There are no write actions in the graph. The Cedar policy at the MCP Gateway layer enforces this structurally.

```
$ # Worker heap climbing, job queue backed up
$ # Click "Worker OOM" in the dashboard

disposition:   resolved
confidence:    full
root cause:    worker heap_used at 92%, queue_depth 11820, memleak confirmed
sources used:  4/4 (search_logs, query_metrics, query_traces, read_runbook)
steps:         7 / 14 cap
```

---

## Architecture

```
Web (Next.js :3000)
  |  SSE stream + REST
  v
Orchestrator (Hono :7200)
  runConductor()
  +-- primary: Claude  --+
  +-- shadow:  Llama   --+--> TrueFoundry AI Gateway --> AWS Bedrock
                              priority-based routing
                              3x retry on 429/503
                              mid-step AbortController failover
  |
  v  tool calls
TrueFoundry MCP Gateway
  Cedar read-only policy  (pre-tool)
  SQL sanitizer           (pre-tool)
  Secrets detection       (post-tool)
  |
  v
MCP Tool Server (:8100) -------> Mock Cluster (:7100)
  search_logs                      api / worker / db_proxy / auth
  query_metrics                    chaos inject endpoints
  query_traces
  read_runbook
```

| Component | Port | Stack |
|---|---|---|
| Web (investigation view) | `:3000` | Next.js 15, React 19 |
| Orchestrator | `:7200` | Hono, Node.js, TypeScript |
| MCP tool server | `:8100` | FastMCP, Python |
| Mock cluster | `:7100` | FastAPI, Python |

---

## Resilience

### TrueFoundry AI Gateway

Both models route exclusively through TrueFoundry AI Gateway with AWS Bedrock as the provider. The config in `gateway-config/virtual-model.yaml` sets priority 0 to Claude (3 retries, 200ms delay) and priority 1 to Llama (2 retries). The `x-tfy-resolved-model` response header is captured on every call and shown in the UI -- you can see which model handled each step live.

### Mid-step failover

Each outgoing LLM call is tracked with an `AbortController`. When a provider is killed -- by the chaos panel, a rate limit, or an outage -- `controller.abort()` fires on every in-flight request for that provider within milliseconds. The conductor catches the abort error, promotes the shadow to primary, picks a new shadow from the healthy provider list, emits a `failover` SSE event, and re-runs the same step. The step index does not increment. No restart. No lost context.

### TrueFoundry MCP Gateway

All four tools are registered and served through TrueFoundry MCP Gateway. Every invocation passes through three server-side guardrails before the result reaches the model:

- **Cedar read-only policy**: permits only the four named tools, forbids any tool name containing "write", "delete", or "update"
- **SQL sanitizer**: blocks PromQL and LogQL containing DROP, DELETE, or TRUNCATE
- **Secrets detection**: redacts API keys, tokens, and credentials in tool output before the model sees them

### Circuit breaker

After 3 consecutive failures on any tool, the circuit opens for 30 seconds. The pool returns a synthetic response with the last cached result (5-minute TTL) and a specific hint telling the model which alternative tool to try. Synthetic results are tagged `status=synthetic` and excluded from the `resolved` disposition check.

### Evidence-constrained disposition

`computeDisposition()` is the only authority on the final verdict. `resolved` requires every tool call to have returned `ok` status and the hypothesis to mention at least one entity present in the raw telemetry (grounding guard). Partial coverage produces `degraded`. Zero usable sources produces `inconclusive`. The model cannot reason its way to `resolved` if the data is not there.

### Divergence detection

At every step, primary and shadow responses are scored:

```
agreement = 0.30 * action_match + 0.70 * jaccard_cosine(primary_rationale, shadow_rationale)
```

Agreement below 0.35 emits a `divergence` SSE event with a summary ("shadow chose query_metrics vs primary search_logs"). Two independent models disagreeing is a genuine signal that the evidence at that step is ambiguous.

---

## Demo scenarios

| Scenario | Target | Fault | Symptom |
|---|---|---|---|
| Worker OOM | worker | memleak 120 MB/tick | Heap climbing, job queue backing up |
| DB Saturation | db_proxy | slow_query 1.5s | Pool wait p99 at 1.5s, connections exhausted |
| Auth 5xx Storm | auth | error_5xx 50% rate | Login failures, 503 rate on /verify climbing |
| API Brownout | api | latency 1.2s mean | Requests piling inflight, p99 above threshold |
| Upstream Timeouts | db_proxy | latency 2.5s mean | Cascading timeouts from api into db_proxy |
| Bad Config Deploy | api | config_drift revision 47 | Error spike immediately after config push |

### Resilience demos

**Kill a provider mid-step.** Click "kill claude" in the Chaos Panel during an active investigation. The HTTP call aborts. Llama takes over the same step. A red failover banner appears: "claude -> llama". The investigation completes without restarting.

**Tool server failure.** Stop the MCP server process during an investigation. After 3 failures the circuit opens. Investigation continues on synthetic responses. Final disposition is `degraded`.

**Rate limit.** Set a 1 req/min rate limit on Claude in the TrueFoundry AI Gateway UI. After the first step, the gateway returns 429, exhausts retries, and promotes Llama. The `x-tfy-resolved-model` header shows the switch. No code change needed.

**Guardrail block.** The Cedar policy blocks any tool name outside the allowed set. The conductor receives `status=blocked`, logs the violation, and continues with remaining tools.

---

## Getting started

### Prerequisites

- Node.js 22+
- Python 3.11+
- TrueFoundry account with AI Gateway and MCP Gateway enabled
- AWS Bedrock configured in TrueFoundry (provider name: `tfy-ai-bedrock`)

### Setup

```bash
cp .env.example .env
# fill in TFY_API_KEY and TFY_MCP_GATEWAY_URL
```

Apply the AI Gateway routing config:

```bash
tfy apply -f gateway-config/virtual-model.yaml
```

Register the MCP tool server in TrueFoundry MCP Gateway UI, then upload `gateway-config/cedar-read-only.cedar` and apply `gateway-config/guardrails.yaml`.

### Run with Docker Compose

```bash
docker compose up --build
```

Open http://localhost:3000

### Run locally

```bash
# terminal 1 -- mock cluster
cd mock-cluster && python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
uvicorn argus_cluster.orchestrator:app --port 7100 --reload

# terminal 2 -- MCP tool server
cd mcp-servers && pip install fastmcp httpx
python server.py

# terminal 3 -- orchestrator
cd orchestrator && npm install && npm run dev

# terminal 4 -- web
cd web && npm install && npm run dev
```

Open http://localhost:3000

### Tests

```bash
cd orchestrator && npm test       # 11 unit tests: disposition, divergence, state, conductor, failover
cd mock-cluster && python -m pytest tests/ -q   # 6 tests
```

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `TFY_API_KEY` | Yes | | TrueFoundry PAT or VAT |
| `TFY_MCP_GATEWAY_URL` | Yes | | Your workspace MCP Gateway URL |
| `TFY_AI_GATEWAY_URL` | No | `https://gateway.truefoundry.ai` | AI Gateway base URL |
| `CLAUDE_MODEL` | No | `tfy-ai-bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0` | Primary model |
| `LLAMA_MODEL` | No | `tfy-ai-bedrock/meta.llama3-3-70b-instruct-v1:0` | Shadow model |
| `MOCK_CLUSTER_URL` | No | `http://localhost:7100` | Mock cluster URL |
| `CORS_ORIGINS` | No | `*` | Allowed origins for the orchestrator |

---

## Project structure

```
cannon/
  orchestrator/
    src/
      conductor.ts        dual-cognition step loop, 14-step cap, failover, divergence
      gateway.ts          TrueFoundry AI Gateway client with AbortController kill
      mcp-pool.ts         tool pool with circuit breaker (3 failures -> 30s open)
      disposition.ts      evidence-constrained disposition
      divergence.ts       action match + Jaccard cosine rationale scoring
      failover.ts         promoteShadow, pickNewShadow
      providers.ts        ProviderRegistry with quarantine tracking
      incident-store.ts   JSON persistence for restart recovery
      server.ts           Hono routes: scenarios, SSE, chaos, triage
      state.ts / types.ts / prompts.ts
    test/cannon.test.ts   11 vitest unit tests
  web/
    app/page.tsx                    dashboard
    app/incident/[id]/page.tsx      live investigation view
    components/InvestigationView.tsx  SSE stream renderer with disposition badge
    components/ChaosPanel.tsx         kill/restore provider buttons
  mcp-servers/server.py   4 read-only tools proxying the mock cluster
  mock-cluster/           FastAPI chaos-injectable cluster, 4 services
  gateway-config/
    virtual-model.yaml      AI Gateway priority routing
    guardrails.yaml         guardrails config reference
    cedar-read-only.cedar   Cedar policy: read-only tool enforcement
  runbooks/               markdown runbooks for each service
```

---

## Built with

Next.js 15, React 19, Hono, TrueFoundry AI Gateway, TrueFoundry MCP Gateway, AWS Bedrock, Claude 3.5 Sonnet, Llama 3.3 70B, FastMCP, FastAPI, Docker Compose, TypeScript, Python.
