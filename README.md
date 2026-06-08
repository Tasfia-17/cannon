# Cannon

**Autonomous on-call SRE triage agent** built for the [TrueFoundry Resilient Agents Hackathon 2026](https://lu.ma/resilient-agents).

Infrastructure fails. Rate limits hit. Timeouts happen. Most agents just crash.

Cannon keeps investigating. When a provider goes down mid-step, it switches models without restarting. When a tool server dies, the circuit opens and investigation continues on cached data. When evidence is incomplete, Cannon says so -- it never reports `resolved` when the data does not support it.

---

## The problem

On-call engineers are woken up at 3am by an alert. They open five dashboards, grep through logs, scroll through traces, check runbooks -- all while half asleep. It takes 20-40 minutes to form a hypothesis, longer to confirm it. Mistakes under pressure lead to wrong root causes and repeat incidents.

Cannon automates the first-response investigation. It reads the same signals a senior SRE would read, applies a structured method, and produces a timestamped postmortem with a disposition: `resolved`, `degraded`, or `inconclusive`. If the data is not there, it says that clearly rather than guessing.

It is read-only by design. It cannot restart services, run commands, or modify configuration. It observes, correlates, and reports.

---

## How it works

When a fault fires in the simulated product surface, Cannon runs a bounded investigation loop (maximum 14 steps):

1. **Two LLMs run in parallel.** Claude (primary) and Llama (shadow) both receive the same system prompt, incident context, and full step history. They each propose the next action independently.

2. **Divergence is scored at every step.** Cannon computes an agreement score from action match (30% weight) and Jaccard cosine similarity of the rationale text (70% weight). When agreement falls below 0.35, the step is flagged as a divergence signal. Two independent models disagreeing is genuinely diagnostic -- it means the evidence is ambiguous or one model is hallucinating. The divergence summary is surfaced in the UI immediately.

3. **Tool calls go through TrueFoundry MCP Gateway.** The four tools (search_logs, query_metrics, query_traces, read_runbook) are registered in TrueFoundry MCP Gateway. Every invocation is intercepted server-side by guardrails before the result reaches the model: Cedar read-only policy enforces that only the four named tools can be called, SQL sanitizer blocks destructive query syntax, and secrets detection redacts credentials from tool output.

4. **The circuit breaker handles dead tools.** After 3 consecutive failures on any tool, the circuit opens for 30 seconds. While open, the pool returns a synthetic response with the last cached result (5-minute TTL) and a specific hint ("try query_metrics instead"). The LLM prompt is designed to understand this hint and adapt its strategy. A dead log server does not stall the investigation.

5. **If a provider fails mid-step, the shadow takes over immediately.** Each in-flight LLM call is tracked with an `AbortController`. When a provider is killed (via chaos panel, rate limit, or outage), the current HTTP request is aborted. The conductor catches the error, promotes the shadow model to primary, picks a new shadow from healthy providers, emits a `failover` SSE event, and continues from the same step. No restart. No lost context.

6. **Disposition is evidence-constrained.** Cannon computes the final disposition only from what the tools actually returned. `resolved` requires every tool call to have returned `ok` status AND the hypothesis to mention at least one entity that appears in the raw telemetry (grounding guard). Partial source coverage produces `degraded`. Zero usable sources produces `inconclusive`. The model cannot reason its way to `resolved` if the data is not there.

7. **Every investigation is persisted.** Each SSE event is stored in memory and written to disk as JSON when the incident completes. On restart, the orchestrator rehydrates all incidents. The SSE stream endpoint supports `Last-Event-ID` so the browser reconnects without re-fetching history.

---

## Stack

| Layer | Technology |
|---|---|
| Investigation view | Next.js 15, React 19 |
| Orchestrator | Hono, Node.js, TypeScript |
| MCP tool servers | FastMCP, Python |
| Mock cluster (chaos substrate) | FastAPI, Python |
| LLM routing and fallback | TrueFoundry AI Gateway |
| Models | Claude 3.5 Sonnet + Llama 3.3 70B via AWS Bedrock |
| Tool governance | TrueFoundry MCP Gateway + Cedar policy |
| Guardrails | Prompt injection detection, SQL sanitizer, secrets redaction |

---

## Architecture

```
Web (Next.js :3000)
  |  SSE stream + REST
  v
Orchestrator (Hono :7200)
  runConductor()
  +-- primary: Claude ----+
  +-- shadow: Llama  -----+--> TrueFoundry AI Gateway --> AWS Bedrock
                               priority-based routing
                               retry 3x on 429/503
                               mid-step AbortController failover
  |
  v  tool calls
TrueFoundry MCP Gateway
  Cedar read-only policy    (pre-tool)
  SQL sanitizer             (pre-tool)
  Secrets detection         (post-tool)
  |
  v
MCP Tool Server (:8100) --------> Mock Cluster (:7100)
  search_logs                       api / worker / db_proxy / auth
  query_metrics                     chaos inject endpoints
  query_traces
  read_runbook
```

---

## Resilience mechanisms

### 1. TrueFoundry AI Gateway -- LLM routing and fallback

Both Claude and Llama are accessed exclusively through TrueFoundry AI Gateway. AWS Bedrock is the provider for both. The gateway config in `gateway-config/virtual-model.yaml` sets up priority-based routing:

- Priority 0: Claude 3.5 Sonnet -- 3 retries on 429/503, 200ms delay between retries
- Priority 1: Llama 3.3 70B -- 2 retries on 429/503

If Claude is unavailable or exhausted, the gateway promotes Llama automatically for the current call. The `x-tfy-resolved-model` response header is captured on every LLM call and surfaced in the investigation UI, so during a live demo you can see exactly which model handled each step.

This is also where the dual-cognition pattern runs: both models are called at every step via the same gateway endpoint, just with different model identifiers. The gateway handles retries, rate limiting, and cost tracking for both simultaneously.

### 2. Mid-step failover via AbortController

Provider failure during an investigation is the hardest resilience case to handle well. Most approaches either restart the investigation (losing context) or let the step time out (wasting 30+ seconds).

Cannon uses a different approach. Every outgoing LLM HTTP call is paired with an `AbortController`. When `gateway.setProviderBlocked("claude", true)` is called (triggered by the chaos panel, a rate limit, or a detected outage), it immediately calls `controller.abort()` on every in-flight request for that provider. The `fetch()` rejects with an abort error within milliseconds.

The conductor catches this error in the primary call handler, emits a `failover` event with the from/to providers, calls `promoteShadow()` to make Llama the new primary, calls `pickNewShadow()` to select a replacement shadow from the healthy provider list, and then `continue`s the loop. The step index does not increment. The next iteration re-runs the same step with the new primary.

This means a provider kill during step 7 of 14 results in step 7 being re-run with Llama. The investigation history is intact.

### 3. TrueFoundry MCP Gateway -- tool access control and audit

All four tools are registered and served through TrueFoundry MCP Gateway. The orchestrator's `mcp-pool.ts` sends every tool call as a JSON-RPC request to the gateway endpoint rather than calling the tool server directly. The gateway applies three server-side guardrails on every invocation:

**Cedar read-only policy** (`gateway-config/cedar-read-only.cedar`): A Cedar policy that explicitly permits only `search_logs`, `query_metrics`, `query_traces`, and `read_runbook`. Any tool name containing "write", "delete", or "update" is explicitly forbidden. If an LLM attempts to call a non-existent tool or a write-adjacent action, the gateway returns a `blocked` response before the tool server is even contacted.

**SQL sanitizer** (pre-tool): Inspects PromQL and LogQL query strings for destructive syntax -- DROP, DELETE, TRUNCATE, INSERT, UPDATE. Blocked queries return a structured error that the conductor logs as `status=blocked` and the investigation continues without that tool call.

**Secrets detection** (post-tool): Before the tool result is returned to the orchestrator, the gateway scans the output for API key patterns, JWT tokens, private key headers, and similar credential patterns. Matches are redacted with a `[REDACTED]` placeholder. This prevents the LLM from ever seeing real credentials even if the mock cluster logs contain them.

Every tool call through the gateway is logged with caller identity, timestamp, tool name, arguments, and status -- forming a per-incident audit trail.

### 4. MCP circuit breaker

The `McpPool` class in `orchestrator/src/mcp-pool.ts` wraps every tool call with a per-tool circuit breaker:

- After 3 consecutive failures on a tool, the circuit opens for 30 seconds
- While open, `invoke()` returns a synthetic result immediately (no HTTP call made) containing:
  - The last successful result from that tool (up to 5 minutes old), labelled `last_known`
  - A specific alternative tool hint: `search_logs` suggests `query_metrics`, `query_metrics` suggests `search_logs`, and so on
  - `status: "synthetic"` so the conductor and disposition engine can distinguish synthetic from real data
- After 30 seconds, the next call attempts a real request. If it succeeds, the circuit resets

The hints are deliberate. Rather than just telling the LLM "tool unavailable", the synthetic response tells it what to try instead. The LLM prompt instructs Cannon to follow these hints.

Synthetic results count as neither `ok` nor `error` in the disposition calculation. An investigation that had to rely on synthetic data for one tool produces `degraded`, not `resolved`.

### 5. Evidence-constrained disposition

The `computeDisposition()` function in `orchestrator/src/disposition.ts` is the only authority on what the final disposition means. It takes the full tool call log and the LLM-generated hypothesis text:

```
inconclusive  -- zero tool calls returned status=ok
degraded      -- some tool calls returned ok, but not all
               -- OR all tools returned ok but the hypothesis is not grounded
resolved      -- all tools returned ok AND hypothesis is grounded in telemetry
```

The grounding check compares tokens from the hypothesis text against the raw text of all tool results. If the LLM writes a hypothesis mentioning "auth service certificate expired" but none of the tool results contain "auth" or "certificate", the grounding check fails and the disposition is `degraded` rather than `resolved`.

This is the key safety property: Cannon cannot report `resolved` through confident reasoning alone. The evidence must be there.

### 6. Divergence detection as hallucination signal

At every step, both the primary and shadow LLM responses are parsed and scored against each other by `compareSteps()` in `orchestrator/src/divergence.ts`:

```
agreement = 0.30 * action_match + 0.70 * jaccard_cosine(primary_rationale, shadow_rationale)
```

The rationale weight (70%) is intentionally high. Two models choosing the same tool for different reasons is a more useful signal than two models choosing different tools for the same reason. Agreement below 0.35 emits a `divergence` SSE event with a human-readable summary.

In a live investigation, divergence flags look like: "shadow chose query_metrics vs primary search_logs" or "divergent rationale (cosine=0.12)". This is shown in the web UI as a purple banner. It does not stop the investigation, but it tells the operator that the evidence at this step was ambiguous.

### 7. State persistence and resumable streams

`incident-store.ts` writes each completed incident to `data/incidents/<id>.json`. On orchestrator startup, all JSON files are loaded and the in-memory incident map is rehydrated. This means:

- A container restart does not lose investigation history
- The web dashboard shows all past investigations with their dispositions
- The SSE endpoint at `/incident/:id/stream` replays all past events before subscribing to live ones, using `Last-Event-ID` to resume from the correct position after a browser reconnect

---

## Demo scenarios

Six fault scenarios are pre-configured in the mock cluster:

| Scenario | Target service | Fault type | What you see |
|---|---|---|---|
| Worker OOM | worker | memleak at 120 MB/tick | Heap climbing, job queue depth growing |
| DB Saturation | db_proxy | slow_query at 1.5s | Pool wait p99 at 1.5s, connections exhausted |
| Auth 5xx Storm | auth | error_5xx at 50% rate | Login failures, 503 rate on /verify climbing |
| API Brownout | api | latency at 1.2s mean | Requests piling inflight, p99 above threshold |
| Upstream Timeouts | db_proxy | latency at 2.5s mean | Cascading timeouts from api into db_proxy |
| Bad Config Deploy | api | config_drift revision 47 | Error rate spike immediately after deploy |

Each scenario injects a fault into the mock cluster's chaos endpoint, waits a warmup period for signal to build, then starts a Cannon investigation automatically.

---

## Demo: resilience in action

**Normal investigation**

Click any scenario from the dashboard. The mock cluster receives the chaos injection. After the warmup delay, the orchestrator starts the investigation. The web UI opens the SSE stream and begins rendering each event in real time: step index, which model is handling it, what tool is being called, what the result was, and the current hypotheses. The investigation ends with a disposition badge (green for resolved, amber for degraded, red for inconclusive) and a full postmortem markdown.

**Kill a provider mid-step (live failover)**

Start any investigation, then click "kill claude" in the Chaos Panel while the investigation is running. The in-flight HTTP call to the TrueFoundry AI Gateway aborts within milliseconds. The web UI shows a red failover banner: "claude -> llama". Llama re-runs the same step. The investigation continues without interruption. After the investigation completes, clicking "restore claude" brings it back for the next run.

**Tool server failure (circuit breaker)**

Stop the MCP tool server process (`Ctrl+C` on terminal 2) and start a new investigation. The first three calls to any tool will fail with a connection error. On the fourth call, the circuit opens. The investigation continues with synthetic responses (cached data + hints). The final disposition is `degraded` with a note showing how many sources were usable.

**Rate limit simulation (gateway routing)**

In the TrueFoundry AI Gateway UI, set a rate limit on the Claude model to 1 request per minute. Start an investigation that will run more than 1 step. After the first step, the gateway returns a 429. The retry policy exhausts (3 attempts), then the gateway promotes Llama as the active model for that call. The `x-tfy-resolved-model` header changes from the Claude ARN to the Llama ARN. No code change is needed -- the gateway handles this entirely.

**Guardrail block (Cedar policy)**

The Cedar policy permits exactly four tool names. If the LLM ever attempts to call a tool outside the allowed set, the gateway returns a blocked response before the tool server is contacted. The conductor logs `status=blocked`, emits a tool_result event with the blocked status, and continues the investigation. This can be observed in the SSE stream event log.

---

## Quick start

### Prerequisites

- Node.js 22+
- Python 3.11+
- TrueFoundry account with AI Gateway and MCP Gateway enabled
- AWS Bedrock access configured in TrueFoundry (set provider name to `tfy-ai-bedrock`)

### 1. Configure environment

```bash
cp .env.example .env
```

Open `.env` and set:
- `TFY_API_KEY` -- your TrueFoundry personal access token or virtual access token
- `TFY_MCP_GATEWAY_URL` -- your workspace MCP Gateway URL (found in TrueFoundry UI under AI Gateway > MCP)

### 2. TrueFoundry AI Gateway setup

Apply the virtual model config to create the priority-based routing model:

```bash
tfy apply -f gateway-config/virtual-model.yaml
```

This registers a virtual model that routes to Claude first, falls back to Llama, with automatic retries on 429/503 for both.

### 3. TrueFoundry MCP Gateway setup

Start the MCP tool server locally:

```bash
cd mcp-servers
pip install fastmcp httpx
python server.py  # runs on :8100
```

Then in the TrueFoundry MCP Gateway UI:
- Add a new MCP server pointing to your server URL (use ngrok if running locally: `ngrok http 8100`)
- Register the four tools: `search_logs`, `query_metrics`, `query_traces`, `read_runbook`
- Upload the Cedar policy from `gateway-config/cedar-read-only.cedar`
- Apply the guardrail config from `gateway-config/guardrails.yaml`

### 4. Run with Docker Compose

```bash
docker compose up --build
```

Open http://localhost:3000

### 5. Run locally (four terminals)

Terminal 1 -- mock cluster:
```bash
cd mock-cluster
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
uvicorn argus_cluster.orchestrator:app --port 7100 --reload
```

Terminal 2 -- MCP tool server:
```bash
cd mcp-servers
pip install fastmcp httpx
python server.py
```

Terminal 3 -- orchestrator:
```bash
cd orchestrator
npm install
npm run dev
```

Terminal 4 -- web:
```bash
cd web
npm install
npm run dev
```

Open http://localhost:3000

---

## Running tests

Orchestrator (11 unit tests covering disposition, divergence, state helpers, conductor normal run, failover promotion, and inconclusive disposition):
```bash
cd orchestrator && npm test
```

Mock cluster (6 tests covering chaos injection and service state):
```bash
cd mock-cluster && python -m pytest tests/ -q
```

---

## Project structure

```
cannon/
  orchestrator/               Hono orchestrator (TypeScript)
    src/
      conductor.ts            Dual-cognition step loop (14-step cap, failover, divergence)
      gateway.ts              TrueFoundry AI Gateway client with AbortController kill
      mcp-pool.ts             MCP tool pool with circuit breaker (3 failures -> 30s open)
      disposition.ts          Evidence-constrained disposition (resolved/degraded/inconclusive)
      divergence.ts           Step comparison: action match + Jaccard cosine rationale
      failover.ts             promoteShadow(), pickNewShadow()
      providers.ts            ProviderRegistry with per-provider quarantine tracking
      incident-store.ts       JSON persistence for restart recovery
      server.ts               Hono routes: scenarios, SSE stream, chaos endpoints, triage
      state.ts                IncidentState creation and mutation helpers
      types.ts                Shared TypeScript types
      prompts.ts              LLM system prompt
    test/
      cannon.test.ts          Vitest unit tests (11 tests)
  web/                        Next.js 15 investigation UI
    app/
      page.tsx                Dashboard (scenario launcher + incident list)
      DashboardClient.tsx     Client component for scenario launch and list
      incident/[id]/page.tsx  Live investigation view
    components/
      InvestigationView.tsx   SSE stream renderer with disposition badge and banners
      ChaosPanel.tsx          Kill/restore provider buttons
    lib/
      api.ts                  Orchestrator API calls and SSE URL helper
  mcp-servers/                FastMCP tool server (Python)
    server.py                 Four read-only tools: search_logs, query_metrics, query_traces, read_runbook
  mock-cluster/               FastAPI chaos-injectable cluster (Python)
    src/argus_cluster/
      orchestrator.py         Main FastAPI app with /chaos/inject endpoint
      api.py                  API service with chaos-aware request handling
      auth.py                 Auth service with error_5xx injection
      worker.py               Worker service with memleak injection
      db_proxy.py             DB proxy with slow_query and latency injection
      gateway.py              Gateway service
      common/                 Shared chaos state, metrics, logs, traces
    tests/
      test_chaos.py           Pytest tests (6 tests)
  gateway-config/
    virtual-model.yaml        TrueFoundry AI Gateway priority routing config
    guardrails.yaml           Guardrails config reference for TrueFoundry UI
    cedar-read-only.cedar     Cedar policy: permit only 4 tools, forbid write operations
  runbooks/                   Markdown runbooks for each service (read by read_runbook tool)
    api.md / auth.md / db_proxy.md / worker.md
  docker-compose.yml          Full-stack local dev compose
  .env.example                Environment variable reference
```

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `TFY_API_KEY` | Yes | -- | TrueFoundry PAT or VAT. Create at app.truefoundry.com -> Settings -> API Keys |
| `TFY_AI_GATEWAY_URL` | No | `https://gateway.truefoundry.ai` | TrueFoundry AI Gateway base URL |
| `TFY_MCP_GATEWAY_URL` | Yes | -- | Your workspace MCP Gateway URL |
| `CLAUDE_MODEL` | No | `tfy-ai-bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0` | Primary model identifier |
| `LLAMA_MODEL` | No | `tfy-ai-bedrock/meta.llama3-3-70b-instruct-v1:0` | Shadow model identifier |
| `MOCK_CLUSTER_URL` | No | `http://localhost:7100` | Mock cluster base URL |
| `CORS_ORIGINS` | No | `*` | Comma-separated allowed origins for the orchestrator |

---

## Hackathon judging criteria

| Criterion | How Cannon addresses it |
|---|---|
| AI Gateway setup | Priority-based routing config in `gateway-config/virtual-model.yaml`. Retries 3x on 429/503. Mid-step failover via AbortController without restarting the investigation. `x-tfy-resolved-model` header captured and shown in UI so the routing decision is always visible. |
| MCP Gateway usage | All 4 tools registered through TrueFoundry MCP Gateway. Cedar read-only policy restricts callable tools at the gateway layer, not in application code. Per-call audit trail maintained by the gateway. Tool credentials managed centrally. |
| Guardrails | Four guardrail layers: prompt injection detection on LLM input, secrets detection on LLM output, SQL sanitizer blocking destructive query syntax pre-tool, Cedar policy blocking write-adjacent tool names pre-tool. |
| Resilience | Five distinct failure modes demonstrated live: provider outage (AbortController failover), rate limit (gateway routing), tool server failure (circuit breaker), bad tool output (disposition grounding guard), cascading errors (inconclusive disposition). Each has a visible recovery path. |
| Usefulness | SRE incident triage is a real on-call pain point. Read-only by construction -- it cannot act on the system. Evidence-constrained disposition means it will not give a confident wrong answer. Safe to leave running. |
| Demo clarity | Six pre-configured fault scenarios. Chaos Panel lets judges kill a provider or trigger a tool failure on demand. Live SSE stream shows the agent reasoning step by step. Failover and divergence banners surface the interesting moments automatically. |
