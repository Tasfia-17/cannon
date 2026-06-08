import { createIncident, appendStep, appendToolResult, finalize, renderHistory } from "./state.js";
import { SYSTEM_PROMPT } from "./prompts.js";
import { computeDisposition } from "./disposition.js";
import { compareSteps } from "./divergence.js";
import { promoteShadow, pickNewShadow } from "./failover.js";
import type { GatewayClient } from "./gateway.js";
import type { McpPool } from "./mcp-pool.js";
import type { ProviderRegistry } from "./providers.js";
import type { AgentAction, AgentStep, IncidentState, ProviderName } from "./types.js";

export interface ConductorEvent {
  type:
    | "step_start" | "primary_step" | "shadow_step"
    | "tool_call" | "tool_result" | "divergence"
    | "failover" | "provider_state" | "incident_done";
  data: Record<string, unknown>;
}

export interface ConductorOpts {
  gateway: GatewayClient;
  pool: McpPool;
  incidentId: string;
  primaryModel: string;
  shadowModel: string;
  maxSteps?: number;
  providers?: ProviderRegistry;
  emit?: (e: ConductorEvent) => void;
  stepTimeoutMs?: number;
}

export async function runConductor(opts: ConductorOpts): Promise<IncidentState> {
  const s = createIncident(opts.incidentId, SYSTEM_PROMPT);
  const emit = opts.emit ?? (() => {});
  const maxSteps = opts.maxSteps ?? 14;
  const timeoutMs = opts.stepTimeoutMs ?? 30_000;

  for (let step = 0; step < maxSteps; step++) {
    const isFinal = step === maxSteps - 1;
    emit({ type: "step_start", data: { step, primary: s.primary, shadow: s.shadow } });

    const messages = buildMessages(s, isFinal);

    // --- Primary LLM call ---
    let primaryRes: { text: string; resolvedModel: string };
    try {
      primaryRes = await withTimeout(
        opts.gateway.chat({ provider: s.primary, model: modelFor(s.primary, opts), messages, temperature: 0, maxTokens: 4096 }),
        timeoutMs,
      );
    } catch (err) {
      emit({ type: "failover", data: { from: s.primary, to: s.shadow, reason: (err as Error).message } });
      emit({ type: "provider_state", data: { provider: s.primary, killed: true } });
      if (opts.providers) opts.providers.markFailure(s.primary);
      if (!s.shadow) { finalize(s, "# Investigation halted\nBoth providers unavailable."); break; }
      promoteShadow(s);
      if (opts.providers) s.shadow = pickNewShadow(s, opts.providers);
      continue;
    }
    emit({ type: "primary_step", data: { step, text: primaryRes.text, provider: s.primary, resolvedModel: primaryRes.resolvedModel } });

    // --- Parse primary step ---
    let parsed: AgentStep;
    try {
      parsed = parseStep(step, primaryRes.text);
    } catch (err) {
      s.messages.push({ role: "assistant", content: primaryRes.text });
      s.messages.push({ role: "user", content: `Invalid JSON: ${(err as Error).message}. Reply with a single JSON object.` });
      continue;
    }

    // --- Shadow LLM call (parallel, non-blocking) ---
    const shadowPromise: Promise<AgentStep | null> = opts.gateway && s.shadow
      ? (async () => {
          try {
            const res = await withTimeout(
              opts.gateway.chat({ provider: s.shadow!, model: modelFor(s.shadow!, opts), messages, temperature: 0 }),
              timeoutMs,
            );
            emit({ type: "shadow_step", data: { step, text: res.text, provider: s.shadow } });
            return parseStep(step, res.text);
          } catch { return null; }
        })()
      : Promise.resolve(null);

    appendStep(s, parsed);

    // --- Terminal: report action ---
    if (parsed.action === "report") {
      const md = String(parsed.args.markdown ?? "");
      const disposition = computeDisposition(s.toolLog, md);
      const report = `${md}\n\n---\n**Disposition: ${disposition.toUpperCase()}** (${s.toolLog.filter(r=>r.status==="ok").length}/${s.toolLog.length} sources usable)`;
      finalize(s, report);
      emit({ type: "incident_done", data: { report_md: report, disposition } });
      return s;
    }

    // --- Tool call ---
    emit({ type: "tool_call", data: { step, tool: parsed.action, args: parsed.args } });
    const toolResult = await opts.pool.invoke(step, parsed.action, parsed.args as Record<string, unknown>);
    appendToolResult(s, toolResult);
    emit({ type: "tool_result", data: { step, status: toolResult.status, result: toolResult.result } });

    s.messages.push({ role: "assistant", content: primaryRes.text });
    s.messages.push({ role: "user", content: `Tool result (status=${toolResult.status}): ${JSON.stringify(toolResult.result).slice(0, 800)}` });

    // --- Divergence check ---
    const shadowStep = await shadowPromise;
    if (shadowStep) {
      const div = compareSteps(step, parsed, shadowStep);
      emit({ type: "divergence", data: div as unknown as Record<string, unknown> });
    }
  }

  const disposition = computeDisposition(s.toolLog, s.finalReport ?? "");
  if (!s.finalReport) {
    finalize(s, `# Investigation incomplete\nMax steps reached.\n\n**Disposition: ${disposition.toUpperCase()}**`);
    emit({ type: "incident_done", data: { report_md: s.finalReport, disposition } });
  }
  return s;
}

function modelFor(provider: ProviderName, opts: ConductorOpts): string {
  return provider === "claude" ? opts.primaryModel : opts.shadowModel;
}

function buildMessages(s: IncidentState, finalStep = false) {
  const nudge = finalStep
    ? "\n\nFINAL STEP: You MUST call action=\"report\" now with a complete postmortem in args.markdown. Partial conclusions are acceptable."
    : "";
  return [
    { role: "system" as const, content: s.messages[0]!.content },
    { role: "user" as const, content: `Incident: ${s.id}\nHistory:\n${renderHistory(s) || "(no steps yet)"}\n\nDecide your next action.${nudge}` },
    ...s.messages.slice(1),
  ];
}

function parseStep(index: number, raw: string): AgentStep {
  const trimmed = (raw.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? raw).trim();
  const parsed = JSON.parse(trimmed) as { action: string; args?: Record<string, unknown>; rationale?: string; hypotheses?: string[] };
  const valid: AgentAction[] = ["search_logs", "query_metrics", "query_traces", "read_runbook", "report"];
  if (!valid.includes(parsed.action as AgentAction)) throw new Error(`invalid action "${parsed.action}"`);
  return { index, action: parsed.action as AgentAction, args: parsed.args ?? {}, rationale: parsed.rationale ?? "", hypotheses: parsed.hypotheses ?? [] };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
