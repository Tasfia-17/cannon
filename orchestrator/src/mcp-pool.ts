// MCP tool pool — calls tools through TrueFoundry MCP Gateway.
// Circuit breaker: after 3 failures, open for 30s, return synthetic response.
// Guardrails (SQL sanitizer + read-only Cedar policy) run server-side at TFY gateway.

import type { ToolCallRecord } from "./types.js";

const TOOL_TO_SERVER: Record<string, string> = {
  search_logs: "cannon-logs",
  query_metrics: "cannon-metrics",
  query_traces: "cannon-traces",
  read_runbook: "cannon-runbooks",
};

const HINTS: Record<string, string> = {
  search_logs: "try query_metrics or query_traces instead",
  query_metrics: "try search_logs to find recent error patterns",
  query_traces: "fall back to search_logs and query_metrics",
  read_runbook: "continue with logs and metrics evidence",
};

interface BreakerState {
  failures: number;
  openUntil: number;
  lastSuccess: { at: number; result: unknown } | null;
}

export class McpPool {
  private breakers = new Map<string, BreakerState>();
  private readonly failureThreshold = 3;
  private readonly openMs = 30_000;
  private readonly cacheTtlMs = 5 * 60_000;

  private get gatewayUrl() {
    return (process.env.TFY_MCP_GATEWAY_URL ?? "").replace(/\/$/, "");
  }
  private get apiKey() { return process.env.TFY_API_KEY ?? ""; }

  private breaker(tool: string): BreakerState {
    if (!this.breakers.has(tool)) this.breakers.set(tool, { failures: 0, openUntil: 0, lastSuccess: null });
    return this.breakers.get(tool)!;
  }

  async invoke(step: number, tool: string, args: Record<string, unknown>): Promise<ToolCallRecord> {
    const server = TOOL_TO_SERVER[tool];
    if (!server) return { step, tool, args, result: { error: `unknown tool ${tool}` }, durationMs: 0, status: "error" };

    const b = this.breaker(tool);
    if (Date.now() < b.openUntil) return this.synthetic(step, tool, args, b);

    const t0 = Date.now();
    try {
      // Call through TFY MCP Gateway — pre-tool guardrails (SQL sanitizer, Cedar read-only) run server-side
      const res = await fetch(`${this.gatewayUrl}/mcp/v1/${server}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${this.apiKey}`,
          // Wire MCP pre/post tool guardrails
          "x-tfy-guardrails": JSON.stringify({
            mcp_tool_pre_invoke_guardrails: ["cannon/sql-sanitizer", "cannon/read-only-policy"],
            mcp_tool_post_invoke_guardrails: ["cannon/secrets-detection"],
          }),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
      });

      if (!res.ok) throw new Error(`MCP gateway status ${res.status}`);

      // Check if guardrail blocked the call
      const guardrailStatus = res.headers.get("x-tfy-guardrail-action");
      if (guardrailStatus === "blocked") {
        return { step, tool, args, result: { blocked: true, reason: "guardrail" }, durationMs: Date.now() - t0, status: "blocked" };
      }

      const json = (await res.json()) as { result?: { content?: Array<{ text: string }> } };
      const text = json.result?.content?.[0]?.text ?? JSON.stringify(json.result);
      b.failures = 0;
      b.lastSuccess = { at: Date.now(), result: text };
      return { step, tool, args, result: text, durationMs: Date.now() - t0, status: "ok" };
    } catch (err) {
      b.failures++;
      if (b.failures >= this.failureThreshold) { b.openUntil = Date.now() + this.openMs; b.failures = 0; }
      return { step, tool, args, result: { error: (err as Error).message }, durationMs: Date.now() - t0, status: "error" };
    }
  }

  private synthetic(step: number, tool: string, args: Record<string, unknown>, b: BreakerState): ToolCallRecord {
    const cached = b.lastSuccess && Date.now() - b.lastSuccess.at < this.cacheTtlMs ? b.lastSuccess.result : null;
    return {
      step, tool, args,
      result: { status: "unavailable", hint: HINTS[tool] ?? "", last_known: cached },
      durationMs: 0,
      status: "synthetic",
    };
  }
}
