import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { GatewayClient } from "./gateway.js";
import { McpPool } from "./mcp-pool.js";
import { ProviderRegistry } from "./providers.js";
import { runConductor, type ConductorEvent } from "./conductor.js";
import { saveIncident, loadAllIncidents, type PersistedIncident } from "./incident-store.js";

// ── Scenario definitions (from Argus, repurposed for Cannon) ─────────────────
const SCENARIOS: Record<string, {
  id: string; title: string; blurb: string; chaosType: string;
  target: string; params: Record<string, number>;
  durationS: number; warmupS: number; symptom: string;
  metric: { label: string; value: string; trend: "up"|"down" };
  sampleLog: string;
}> = {
  "worker-oom":      { id:"worker-oom",      title:"Worker OOM",          blurb:"Worker heap climbing, jobs backing up.",          chaosType:"memleak",    target:"worker",   params:{mb_per_tick:120}, durationS:120, warmupS:10, symptom:"Worker heap climbing, job queue backing up",           metric:{label:"heap_used",       value:"92%",  trend:"up"}, sampleLog:"worker-3 heap_used=3.8GB queue_depth=11820" },
  "db-saturation":   { id:"db-saturation",   title:"DB Saturation",       blurb:"db_proxy responding at 1.5s/query.",             chaosType:"slow_query", target:"db_proxy", params:{ms:1500},         durationS:120, warmupS:3,  symptom:"Query p99 at 1.5s, connection pool saturating",       metric:{label:"pool_wait_p99",   value:"1.5s", trend:"up"}, sampleLog:"db pool exhausted inflight=16" },
  "auth-5xx":        { id:"auth-5xx",        title:"Auth 5xx Storm",      blurb:"auth throwing 503s on 50% of verify calls.",     chaosType:"error_5xx",  target:"auth",     params:{rate:0.5},        durationS:120, warmupS:3,  symptom:"Logins failing, 503 rate climbing on auth",           metric:{label:"auth_503_rate",   value:"48%",  trend:"up"}, sampleLog:"chaos: 5xx injected path=/verify" },
  "api-brownout":    { id:"api-brownout",    title:"API Brownout",        blurb:"api latency spiking, requests piling inflight.", chaosType:"latency",    target:"api",      params:{mean_ms:1200},    durationS:120, warmupS:3,  symptom:"App slow, requests piling inflight",                  metric:{label:"req_p99",         value:"1.2s", trend:"up"}, sampleLog:"api inflight=42 latency_p99=1180ms" },
  "db-timeout":      { id:"db-timeout",      title:"Upstream Timeouts",   blurb:"db_proxy stalling 2.5s/call.",                  chaosType:"latency",    target:"db_proxy", params:{mean_ms:2500},    durationS:120, warmupS:3,  symptom:"Upstream db calls timing out from api",               metric:{label:"db_timeout_rate", value:"31%",  trend:"up"}, sampleLog:"worker failed err=ReadTimeout job=..." },
  "api-config-drift":{ id:"api-config-drift",title:"Bad Config Deploy",   blurb:"config revision flipped api routing to invalid.",chaosType:"config_drift",target:"api",    params:{rate:0.45,revision:47}, durationS:120, warmupS:3, symptom:"Error spike immediately after config revision 47", metric:{label:"error_rate",      value:"44%",  trend:"up"}, sampleLog:"config revision 47 applied: routing=invalid" },
};

type IncidentEntry = {
  events: ConductorEvent[];
  subs: Array<(e: ConductorEvent, idx: number) => void>;
  done: boolean; startedAt: number; endedAt?: number; scenario?: string;
};

export function buildApp() {
  const app = new Hono();
  const incidents = new Map<string, IncidentEntry>();
  const gateway = new GatewayClient();
  const pool = new McpPool();
  const registry = new ProviderRegistry(["claude", "llama"]);
  const chaos = { killClaude: false, killLlama: false };

  const primaryModel  = process.env.CLAUDE_MODEL  ?? "tfy-ai-bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0";
  const shadowModel   = process.env.LLAMA_MODEL   ?? "tfy-ai-bedrock/meta.llama3-3-70b-instruct-v1:0";
  const clusterUrl    = (process.env.MOCK_CLUSTER_URL ?? "http://127.0.0.1:7100").replace(/\/$/, "");

  // Rehydrate persisted incidents on boot
  for (const p of loadAllIncidents()) {
    incidents.set(p.id, { events: p.events as ConductorEvent[], subs: [], done: p.done, startedAt: p.startedAt, endedAt: p.endedAt, scenario: p.scenario });
  }

  app.use("*", cors({
    origin: (process.env.CORS_ORIGINS ?? "*") === "*" ? "*" :
      (process.env.CORS_ORIGINS ?? "").split(",").map(s => s.trim()),
    allowMethods: ["GET","POST","OPTIONS"],
    allowHeaders: ["content-type"],
    credentials: false,
  }));

  function broadcast(e: ConductorEvent) {
    for (const entry of incidents.values()) {
      entry.events.push(e);
      const idx = entry.events.length - 1;
      for (const fn of entry.subs) fn(e, idx);
    }
  }

  function spawnIncident(id: string, scenario?: string) {
    const entry: IncidentEntry = { events: [], subs: [], done: false, startedAt: Date.now(), scenario };
    incidents.set(id, entry);

    runConductor({
      gateway, pool, providers: registry,
      incidentId: id, primaryModel, shadowModel, maxSteps: 14,
      emit(e) {
        entry.events.push(e);
        const idx = entry.events.length - 1;
        for (const fn of entry.subs) fn(e, idx);
        if (e.type === "incident_done") {
          entry.done = true; entry.endedAt = Date.now();
          // Auto-restore chaos so next run starts clean
          if (chaos.killClaude) { chaos.killClaude = false; gateway.setProviderBlocked("claude", false); broadcast({ type:"provider_state", data:{provider:"claude",killed:false,reason:"auto-restore"} }); }
          if (chaos.killLlama)  { chaos.killLlama  = false; gateway.setProviderBlocked("llama",  false); broadcast({ type:"provider_state", data:{provider:"llama", killed:false,reason:"auto-restore"} }); }
          saveIncident({ id, events: entry.events, done: true, startedAt: entry.startedAt, endedAt: entry.endedAt, scenario }).catch(() => {});
        }
      },
    }).catch((err: unknown) => {
      const e: ConductorEvent = { type:"incident_done", data:{ error:(err as Error).message } };
      entry.events.push(e); entry.done = true; entry.endedAt = Date.now();
      for (const fn of entry.subs) fn(e, entry.events.length - 1);
    });
  }

  // ── Routes ────────────────────────────────────────────────────────────────
  app.get("/health", (c) => c.json({ ok: true, name: "Cannon" }));

  app.get("/state", (c) => c.json({
    providers: {
      claude: { killed: chaos.killClaude },
      llama:  { killed: chaos.killLlama  },
    },
  }));

  app.get("/scenarios", (c) => c.json({ scenarios: Object.values(SCENARIOS) }));

  app.post("/scenarios/:scenario/start", async (c) => {
    const cfg = SCENARIOS[c.req.param("scenario")];
    if (!cfg) return c.json({ error: "unknown scenario" }, 404);
    const id = `${cfg.id}-${Date.now().toString(36)}`;

    try {
      await fetch(`${clusterUrl}/chaos/inject`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: cfg.chaosType, target: cfg.target, duration_s: cfg.durationS, params: cfg.params }),
      });
    } catch (err) {
      return c.json({ error: `chaos inject failed: ${(err as Error).message}` }, 502);
    }

    if (cfg.warmupS > 0) await new Promise(r => setTimeout(r, cfg.warmupS * 1000));
    spawnIncident(id, cfg.id);
    return c.json({ ok: true, id });
  });

  app.post("/incident/:id/start", (c) => {
    const id = c.req.param("id");
    if (incidents.has(id)) return c.json({ error: "already started" }, 400);
    spawnIncident(id);
    return c.json({ ok: true, id });
  });

  app.get("/incidents", (c) => {
    const list = [...incidents.entries()].map(([id, e]) => {
      const done = [...e.events].reverse().find(ev => ev.type === "incident_done");
      const disposition = (done?.data as {disposition?:string})?.disposition ?? "running";
      return { id, done: e.done, disposition, stepCount: e.events.filter(ev=>ev.type==="step_start").length, startedAt: e.startedAt, endedAt: e.endedAt ?? null, scenario: e.scenario ?? null };
    }).sort((a,b) => b.startedAt - a.startedAt);
    return c.json({ incidents: list });
  });

  app.get("/incident/:id/stream", (c) =>
    streamSSE(c, async (stream) => {
      const entry = incidents.get(c.req.param("id"));
      if (!entry) { await stream.writeSSE({ event: "error", data: JSON.stringify({ error: "not_found" }) }); return; }

      const lastId = c.req.header("Last-Event-ID");
      const from = lastId && /^\d+$/.test(lastId) ? Number(lastId) + 1 : 0;
      for (let i = from; i < entry.events.length; i++) {
        await stream.writeSSE({ event: entry.events[i]!.type, id: String(i), data: JSON.stringify(entry.events[i]!.data) });
      }
      if (entry.done) return;

      await new Promise<void>((resolve) => {
        const fn = (e: ConductorEvent, idx: number) => {
          stream.writeSSE({ event: e.type, id: String(idx), data: JSON.stringify(e.data) }).catch(() => {});
          if (e.type === "incident_done") { entry.subs.splice(entry.subs.indexOf(fn), 1); resolve(); }
        };
        entry.subs.push(fn);
      });
    }),
  );

  // ── Chaos endpoints ───────────────────────────────────────────────────────
  app.post("/chaos/kill-provider", async (c) => {
    const { provider } = await c.req.json<{ provider: "claude" | "llama" }>();
    if (provider === "claude") { chaos.killClaude = true; gateway.setProviderBlocked("claude", true); }
    if (provider === "llama")  { chaos.killLlama  = true; gateway.setProviderBlocked("llama",  true); }
    broadcast({ type:"provider_state", data:{ provider, killed:true, reason:"chaos" } });
    return c.json({ ok: true });
  });

  app.post("/chaos/restore-provider", async (c) => {
    const { provider } = await c.req.json<{ provider: "claude" | "llama" }>();
    if (provider === "claude") { chaos.killClaude = false; gateway.setProviderBlocked("claude", false); }
    if (provider === "llama")  { chaos.killLlama  = false; gateway.setProviderBlocked("llama",  false); }
    broadcast({ type:"provider_state", data:{ provider, killed:false, reason:"chaos" } });
    return c.json({ ok: true });
  });

  // Quick triage (fast single LLM call for embedded product triggers)
  app.post("/triage", async (c) => {
    const { scenario } = await c.req.json<{ scenario: string }>().catch(() => ({ scenario: "" }));
    const cfg = SCENARIOS[scenario];
    if (!cfg) return c.json({ error: "unknown scenario" }, 404);
    const prompt = `You are Cannon SRE triage. Service: ${cfg.target}. Symptom: ${cfg.symptom}. Log sample: ${cfg.sampleLog}. Metric: ${cfg.metric.label}=${cfg.metric.value}. Reply ONLY as JSON: {"diagnosis":"<1-2 sentences>","suspectedRootCause":"<short phrase>"}`;
    try {
      const res = await gateway.chat({ provider:"claude", model:primaryModel, messages:[{role:"user",content:prompt}], temperature:0.1, maxTokens:200 });
      const start = res.text.indexOf("{"), end = res.text.lastIndexOf("}");
      const parsed = JSON.parse(res.text.slice(start, end + 1)) as { diagnosis:string; suspectedRootCause:string };
      return c.json(parsed);
    } catch {
      return c.json({ diagnosis: cfg.symptom, suspectedRootCause: `fault in ${cfg.target}` });
    }
  });

  return app;
}
