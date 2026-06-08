# Cannon

**Autonomous on-call SRE triage agent** built for the [TrueFoundry Resilient Agents Hackathon 2026](https://lu.ma/resilient-agents).

Named after Annie Jump Cannon, who classified 350,000 stars from raw spectral observations using a rigorous, systematic method. Cannon reads raw telemetry, applies a systematic method, and produces a disposition.

---

## What it does

Cannon investigates production incidents autonomously. When a fault fires in the simulated product surface (Ridgeline), Cannon:

1. Runs two LLMs in parallel: Claude (primary) and Llama (shadow) through TrueFoundry AI Gateway to AWS Bedrock
2. Each step, both models propose the next tool call independently. Cannon scores agreement between them (action match + Jaccard cosine of rationale). Agreement below 0.35 is flagged as a divergence signal and surfaced in the UI
3. Executes the tool call through TrueFoundry MCP Gateway, where Cedar read-only policy, SQL sanitizer, and secrets redaction run server-side before the model sees any result
4. If Claude fails mid-step (rate limit, outage, or chaos kill), the AbortController cancels the in-flight HTTP call immediately and Llama takes over the same step with no context loss
5. After gathering evidence from logs, metrics, traces, and runbooks, Cannon produces a postmortem with a disposition:
   - `resolved` -- all sources healthy and the hypothesis is grounded in telemetry
   - `degraded` -- partial source failure, investigation continued with available data
   - `inconclusive` -- no usable tool data returned
6. Every investigation is persisted to disk. If the orchestrator restarts, the SSE stream rehydrates from the last event

---

## Stack

| Layer | Technology |
|---|---|
| Investigation view | Next.js 15, React 19 |
| Orchestrator | Hono, Node.js, TypeScript |
| MCP tool servers | FastMCP, Python |
| Mock cluster (chaos substrate) | FastAPI, Python |
| LLM routing + fallback | TrueFoundry AI Gateway |
| Models | Claude 3.5 Sonnet + Llama 3.3 70B via AWS Bedrock |
| Tool governance | TrueFoundry MCP Gateway + Cedar read-only policy |
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

Both Claude and Llama are accessed exclusively through TrueFoundry AI Gateway with AWS Bedrock as the provider. The gateway config (`gateway-config/virtual-model.yaml`) sets up priority-based routing:

- Priority 0: Claude 3.5 Sonnet, 3 retries on 429/503 with 200ms delay
- Priority 1: Llama 3.3 70B, 2 retries on 429/503

The `x-tfy-resolved-model` response header is captured on every call and surfaced in the investigation UI so you can see exactly which model handled each step.

### 2. Mid-step failover via AbortController

Each in-flight LLM call is tracked with an `AbortController`. When a chaos kill is triggered (or a rate limit hits), the current HTTP request is cancelled immediately. The conductor catches the error, promotes the shadow to primary, picks a new shadow from the healthy provider list, emits a `failover` SSE event, and continues from the same step -- no restart, no context loss.

### 3. TrueFoundry MCP Gateway -- tool access control

All four tools (search_logs, query_metrics, query_traces, read_runbook) are registered through TrueFoundry MCP Gateway. Every tool call passes through:

- **Cedar read-only policy** (`gateway-config/cedar-read-only.cedar`): permits only the four named tools, explicitly forbids any tool name containing "write", "delete", or "update"
- **SQL sanitizer**: blocks PromQL/LogQL containing DROP, DELETE, or TRUNCATE before execution
- **Secrets detection** (post-tool): redacts API keys, tokens, and credentials in tool results before the model sees them

### 4. MCP circuit breaker

After 3 consecutive failures, a tool's circuit opens for 30 seconds. While open, the pool returns a synthetic response containing the last cached result (5-minute TTL) and a hint telling the model which alternative tool to use. This prevents a dead log server from stalling the entire investigation.

### 5. Evidence-constrained disposition

Cannon never reports `resolved` unless all tool calls returned `ok` status AND the hypothesis mentions at least one entity that appears in the telemetry. If evidence is partial, the disposition is `degraded`. If no tool returned usable data, it is `inconclusive`. This prevents a confident wrong answer.

### 6. Divergence detection

At each step, primary and shadow responses are scored on:
- Action match (30% weight)
- Jaccard cosine of the rationale text (70% weight)

When agreement falls below 0.35, the step is flagged as a divergence. The summary ("shadow chose query_metrics vs primary search_logs") is emitted as a `divergence` SSE event and shown in the UI. Two independent models disagreeing is a genuine hallucination signal.

### 7. State persistence

Every SSE event is appended to an in-memory list and persisted to disk as JSON on incident completion. On startup, the orchestrator rehydrates all incidents from `data/incidents/`. The SSE endpoint supports `Last-Event-ID` for resumable streams.

---

## Demo scenarios

Six fault scenarios are built into the mock cluster:

| Scenario | Target | Fault type | Symptom |
|---|---|---|---|
| Worker OOM | worker | memleak (120 MB/tick) | Heap climbing, job queue backing up |
| DB Saturation | db_proxy | slow_query (1.5s) | Query p99 at 1.5s, pool saturating |
| Auth 5xx Storm | auth | error_5xx (50% rate) | Logins failing, 503 rate climbing |
| API Brownout | api | latency (1.2s mean) | App slow, requests piling inflight |
| Upstream Timeouts | db_proxy | latency (2.5s mean) | Upstream db calls timing out |
| Bad Config Deploy | api | config_drift (rev 47) | Error spike after config push |

---

## Demo: resilience in action

**Normal run**
Open the dashboard, click any scenario. Watch the live SSE stream: step by step, both models propose actions, tools execute, rationale appears. The investigation concludes with a disposition badge.

**Kill Claude mid-step**
During an active investigation, click "kill claude" in the Chaos Panel. The in-flight HTTP call aborts via AbortController. Llama takes over the same step. A failover banner appears in the UI showing "claude -> llama". The investigation completes without restarting.

**Tool failure / circuit breaker**
After 3 consecutive tool errors, the circuit opens. The tool returns a synthetic response with cached data and a hint ("try query_metrics instead"). The investigation continues with available sources. The final disposition is `degraded`, not `resolved`.

**Rate limit simulation**
Configure the TrueFoundry AI Gateway to rate-limit Claude at 1 request/minute. The gateway automatically routes to Llama. The `x-tfy-resolved-model` header shows the switch. No code change required.

**Guardrail block**
The Cedar policy at MCP Gateway rejects any tool name that does not match the four allowed tools. The conductor receives `status=blocked`, logs the guardrail violation, and continues with the remaining tools.

---

## Quick start

### Prerequisites

- Node.js 22+
- Python 3.11+
- TrueFoundry account with AI Gateway and MCP Gateway enabled
- AWS Bedrock access configured in TrueFoundry (provider name: `tfy-ai-bedrock`)

### 1. Configure environment

```bash
cp .env.example .env
# Edit .env and fill in:
#   TFY_API_KEY          -- your TrueFoundry PAT or VAT
#   TFY_MCP_GATEWAY_URL  -- your workspace MCP Gateway URL
```

### 2. TrueFoundry AI Gateway setup

Apply the virtual model config:

```bash
tfy apply -f gateway-config/virtual-model.yaml
```

This creates a priority-based routing model that tries Claude first, falls back to Llama, with retries on 429/503.

### 3. TrueFoundry MCP Gateway setup

Register the four tools from `mcp-servers/server.py` through the TrueFoundry MCP Gateway UI:

- Deploy the MCP server (or run it locally and expose via ngrok)
- Register tools: `search_logs`, `query_metrics`, `query_traces`, `read_runbook`
- Upload Cedar policy from `gateway-config/cedar-read-only.cedar`
- Apply guardrails from `gateway-config/guardrails.yaml`

### 4. Run with Docker Compose

```bash
docker compose up --build
```

Open http://localhost:3000

### 5. Run locally (dev mode)

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

Orchestrator (11 tests covering disposition, divergence, state, conductor, failover):
```bash
cd orchestrator && npm test
```

Mock cluster (6 tests):
```bash
cd mock-cluster && python -m pytest tests/ -q
```

---

## Project structure

```
cannon/
  orchestrator/           Hono orchestrator (TypeScript)
    src/
      conductor.ts        Dual-cognition step loop (14-step cap, failover, divergence)
      gateway.ts          TrueFoundry AI Gateway client with AbortController kill
      mcp-pool.ts         MCP tool pool with circuit breaker (3 failures -> 30s open)
      disposition.ts      Evidence-constrained disposition logic (from Leavitt)
      divergence.ts       Step comparison: action match + Jaccard cosine rationale
      failover.ts         promoteShadow(), pickNewShadow()
      providers.ts        ProviderRegistry with quarantine tracking
      incident-store.ts   JSONL persistence for restart recovery
      server.ts           Hono routes: scenarios, SSE stream, chaos endpoints, triage
      state.ts            IncidentState helpers
      types.ts            Shared TypeScript types
      prompts.ts          LLM system prompt
    test/
      cannon.test.ts      Vitest unit tests
  web/                    Next.js 15 investigation UI
    app/
      page.tsx            Dashboard (scenarios + incident list)
      DashboardClient.tsx  Scenario launcher and incident list
      incident/[id]/      Live investigation view
    components/
      InvestigationView.tsx  SSE stream renderer with disposition badge
      ChaosPanel.tsx         Kill/restore provider buttons
    lib/
      api.ts              Orchestrator API and SSE helpers
  mcp-servers/            FastMCP tool server (Python)
    server.py             Four read-only tools proxying mock cluster
  mock-cluster/           FastAPI chaos-injectable cluster (Python)
    src/argus_cluster/
      orchestrator.py     Main FastAPI app
      api.py / auth.py / worker.py / db_proxy.py / gateway.py
      common/             Chaos injection, metrics, logs, traces, state
    tests/
      test_chaos.py       Pytest tests
  gateway-config/
    virtual-model.yaml    TrueFoundry AI Gateway priority routing config
    guardrails.yaml       Guardrails configuration reference
    cedar-read-only.cedar Cedar policy: read-only tool enforcement
  docker-compose.yml
  .env.example
```

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `TFY_API_KEY` | Yes | TrueFoundry PAT or VAT (create at app.truefoundry.com -> Settings -> API Keys) |
| `TFY_AI_GATEWAY_URL` | No | Default: `https://gateway.truefoundry.ai` |
| `TFY_MCP_GATEWAY_URL` | Yes | Your workspace MCP Gateway URL |
| `CLAUDE_MODEL` | No | Default: `tfy-ai-bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0` |
| `LLAMA_MODEL` | No | Default: `tfy-ai-bedrock/meta.llama3-3-70b-instruct-v1:0` |
| `MOCK_CLUSTER_URL` | No | Default: `http://localhost:7100` |
| `CORS_ORIGINS` | No | Default: `*` (comma-separated origins for production) |

---

## Hackathon judging criteria

| Criterion | How Cannon addresses it |
|---|---|
| AI Gateway setup | Priority-based routing, 3x retry on 429/503, mid-step AbortController failover, `x-tfy-resolved-model` surfaced in UI |
| MCP Gateway usage | All 4 tools registered through TFY MCP Gateway, Cedar read-only policy, SQL sanitizer, secrets redaction, per-call audit trail |
| Guardrails | Prompt injection (LLM input), secrets detection (LLM output + tool output), SQL sanitizer (pre-tool), Cedar read-only enforcement (pre-tool) |
| Resilience | Provider outage, rate limit, tool failure, bad tool output, cascading errors -- all demonstrated live with visible recovery |
| Usefulness | SRE incident triage is a genuine on-call pain point; read-only by design, safe to leave running overnight |
| Demo clarity | Ridgeline product simulation shows a product breaking; live SSE stream shows the agent reasoning step by step; chaos panel lets judges trigger failures on demand |

---

## Credits

Architecture inspired by:
- [Argus](https://github.com/aditya1rawat/devnetwork-aiml-hackathon-2026) (dual-cognition conductor, mock cluster, Ridgeline demo surface)
- [Leavitt](https://github.com/msradam/leavitt) (evidence-constrained disposition, grounding guard design)

Named after [Annie Jump Cannon](https://en.wikipedia.org/wiki/Annie_Jump_Cannon) (1863-1941), Harvard astronomer who developed the Harvard spectral classification system and personally classified over 350,000 stellar spectra.
