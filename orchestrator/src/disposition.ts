import type { ToolCallRecord, Disposition } from "./types.js";

// Evidence-constrained disposition — from Leavitt's design.
// resolved requires ALL tools returned ok AND the hypothesis is grounded in telemetry.
// degraded if some tools failed but we have partial signal.
// inconclusive if no tools returned usable data.
export function computeDisposition(toolLog: ToolCallRecord[], hypothesis: string): Disposition {
  const usable = toolLog.filter((r) => r.status === "ok").length;
  if (usable === 0) return "inconclusive";
  if (usable < toolLog.length) return "degraded";
  // Grounding guard: at least one token from hypothesis must appear in tool results
  const evidence = toolLog.map((r) => JSON.stringify(r.result).toLowerCase()).join(" ");
  const tokens = hypothesis.toLowerCase().split(/\W+/).filter((t) => t.length > 3);
  const grounded = tokens.some((t) => evidence.includes(t));
  return grounded ? "resolved" : "degraded";
}
