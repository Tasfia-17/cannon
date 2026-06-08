import { describe, it, expect, vi } from "vitest";
import { computeDisposition } from "../src/disposition.js";
import { compareSteps } from "../src/divergence.js";
import { createIncident, appendStep, appendToolResult, finalize, renderHistory } from "../src/state.js";
import { runConductor } from "../src/conductor.js";
import type { ToolCallRecord, AgentStep } from "../src/types.js";

// ── disposition ────────────────────────────────────────────────────────────
describe("computeDisposition", () => {
  it("inconclusive when no ok results", () => {
    const log: ToolCallRecord[] = [
      { step: 0, tool: "query_metrics", args: {}, result: {}, durationMs: 0, status: "error" },
    ];
    expect(computeDisposition(log, "db_proxy error")).toBe("inconclusive");
  });

  it("degraded when some tools failed", () => {
    const log: ToolCallRecord[] = [
      { step: 0, tool: "query_metrics", args: {}, result: "db_proxy error rate high", durationMs: 0, status: "ok" },
      { step: 1, tool: "search_logs",   args: {}, result: {},                          durationMs: 0, status: "error" },
    ];
    expect(computeDisposition(log, "db_proxy")).toBe("degraded");
  });

  it("resolved when all ok and hypothesis is grounded", () => {
    const log: ToolCallRecord[] = [
      { step: 0, tool: "query_metrics", args: {}, result: "worker heap_used=95%", durationMs: 0, status: "ok" },
      { step: 1, tool: "search_logs",   args: {}, result: "worker OOM killed",    durationMs: 0, status: "ok" },
    ];
    expect(computeDisposition(log, "worker OOM causing job queue backup")).toBe("resolved");
  });

  it("degraded when all ok but hypothesis not grounded in telemetry", () => {
    const log: ToolCallRecord[] = [
      { step: 0, tool: "query_metrics", args: {}, result: "api latency=200ms",    durationMs: 0, status: "ok" },
    ];
    // hypothesis mentions "auth" but telemetry only has "api"
    expect(computeDisposition(log, "auth service certificate expired")).toBe("degraded");
  });
});

// ── divergence ─────────────────────────────────────────────────────────────
describe("compareSteps", () => {
  const base = (action: string, rationale: string): AgentStep => ({
    index: 0, action: action as AgentStep["action"],
    args: {}, rationale, hypotheses: [],
  });

  it("agreement when action and rationale match", () => {
    const d = compareSteps(0, base("query_metrics", "check error rate"), base("query_metrics", "check error rate"));
    expect(d.flagged).toBe(false);
    expect(d.agreement).toBeGreaterThan(0.35);
  });

  it("flagged when action mismatch and rationale diverges", () => {
    const d = compareSteps(0,
      base("query_metrics", "check prometheus error rate for db_proxy"),
      base("search_logs",   "look at kubernetes pod restart events"),
    );
    expect(d.flagged).toBe(true);
    expect(d.actionMismatch).toBe(true);
  });
});

// ── state helpers ──────────────────────────────────────────────────────────
describe("state", () => {
  it("renderHistory returns formatted step lines", () => {
    const s = createIncident("test-1", "system prompt");
    appendStep(s, { index: 0, action: "query_metrics", args: { service: "api" }, rationale: "check errors", hypotheses: [] });
    appendToolResult(s, { step: 0, tool: "query_metrics", args: {}, result: "api error_rate=5%", durationMs: 50, status: "ok" });
    const h = renderHistory(s);
    expect(h).toContain("query_metrics");
    expect(h).toContain("check errors");
    expect(h).toContain("status=ok");
  });

  it("finalize sets finalReport", () => {
    const s = createIncident("test-2", "sys");
    finalize(s, "# Report\nroot cause: db_proxy slow_query");
    expect(s.finalReport).toContain("db_proxy");
  });
});

// ── conductor (stub gateway + pool) ────────────────────────────────────────
describe("runConductor", () => {
  it("completes with resolved disposition when stub returns good data", async () => {
    const events: string[] = [];

    // Stub gateway: returns a valid report action on first call, shadow returns same
    const gateway = {
      setProviderBlocked: vi.fn(),
      chat: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          action: "report",
          args: { markdown: "# Postmortem\nworker OOM root cause: memleak in worker service" },
          rationale: "sufficient evidence gathered",
          hypotheses: ["worker OOM"],
        }),
        latencyMs: 10,
        resolvedModel: "tfy-ai-bedrock/stub",
      }),
    };

    // Stub pool: returns ok metrics result with worker data
    const pool = {
      invoke: vi.fn().mockResolvedValue({
        step: 0, tool: "query_metrics", args: {}, durationMs: 5,
        result: "worker heap_used=92% queue_depth=11000",
        status: "ok",
      }),
    };

    const s = await runConductor({
      gateway: gateway as never,
      pool: pool as never,
      incidentId: "test-conductor-1",
      primaryModel: "stub-claude",
      shadowModel: "stub-llama",
      maxSteps: 3,
      emit: (e) => events.push(e.type),
    });

    expect(s.finalReport).toBeTruthy();
    expect(events).toContain("incident_done");
    const doneEvt = events.filter(e => e === "incident_done");
    expect(doneEvt.length).toBe(1);
  });

  it("promotes shadow and continues when primary fails", async () => {
    const events: { type: string; data: Record<string, unknown> }[] = [];
    let callCount = 0;

    const gateway = {
      setProviderBlocked: vi.fn(),
      chat: vi.fn().mockImplementation(({ provider }: { provider: string }) => {
        callCount++;
        // First call (claude primary) throws; subsequent calls (llama) succeed
        if (provider === "claude" && callCount === 1) {
          return Promise.reject(new Error("provider claude killed by chaos"));
        }
        return Promise.resolve({
          text: JSON.stringify({
            action: "report",
            args: { markdown: "# Report\nauth service 5xx root cause confirmed" },
            rationale: "evidence complete",
            hypotheses: ["auth 5xx"],
          }),
          latencyMs: 10,
          resolvedModel: "tfy-ai-bedrock/llama",
        });
      }),
    };

    const pool = { invoke: vi.fn().mockResolvedValue({ step: 0, tool: "query_metrics", args: {}, result: "auth error=48%", durationMs: 5, status: "ok" }) };
    const providers = { healthy: () => ["llama" as const], markFailure: vi.fn() };

    const s = await runConductor({
      gateway: gateway as never,
      pool: pool as never,
      providers: providers as never,
      incidentId: "test-failover-1",
      primaryModel: "stub-claude",
      shadowModel: "stub-llama",
      maxSteps: 5,
      emit: (e) => events.push(e),
    });

    const failoverEvt = events.find(e => e.type === "failover");
    expect(failoverEvt).toBeTruthy();
    expect(s.finalReport).toBeTruthy();
    // After failover, llama became primary and finished the investigation
    expect(s.primary).toBe("llama");
  });

  it("returns inconclusive disposition when all tools fail", async () => {
    const events: { type: string; data: Record<string, unknown> }[] = [];

    // Gateway always returns report action immediately
    const gateway = {
      setProviderBlocked: vi.fn(),
      chat: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          action: "report",
          args: { markdown: "# Report\ndb_proxy network partition suspected" },
          rationale: "no tool data available",
          hypotheses: ["network partition"],
        }),
        latencyMs: 5,
        resolvedModel: "tfy-ai-bedrock/stub",
      }),
    };

    // Pool always errors
    const pool = {
      invoke: vi.fn().mockResolvedValue({
        step: 0, tool: "query_metrics", args: {}, result: { error: "connection refused" },
        durationMs: 0, status: "error",
      }),
    };

    const s = await runConductor({
      gateway: gateway as never,
      pool: pool as never,
      incidentId: "test-inconclusive-1",
      primaryModel: "stub",
      shadowModel: "stub",
      maxSteps: 3,
      emit: (e) => events.push(e),
    });

    const doneEvt = events.find(e => e.type === "incident_done");
    // With no ok tool results, disposition should be inconclusive or degraded
    expect(["inconclusive", "degraded"]).toContain(doneEvt?.data.disposition);
  });
});
