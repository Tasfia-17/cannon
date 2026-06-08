import type { AgentStep, IncidentState, ToolCallRecord } from "./types.js";

export function createIncident(id: string, systemPrompt: string): IncidentState {
  return {
    id,
    startedAt: Date.now(),
    messages: [{ role: "system", content: systemPrompt }],
    toolLog: [],
    steps: [],
    primary: "claude",
    shadow: "llama",
    finalReport: null,
  };
}

export function appendStep(s: IncidentState, step: AgentStep): void {
  s.steps.push(step);
}

export function appendToolResult(s: IncidentState, rec: ToolCallRecord): void {
  s.toolLog.push(rec);
}

export function finalize(s: IncidentState, reportMd: string): void {
  s.finalReport = reportMd;
}

export function renderHistory(s: IncidentState): string {
  return s.steps.map((step) => {
    const tool = s.toolLog.find((t) => t.step === step.index);
    return [
      `STEP ${step.index}: ${step.action} ${JSON.stringify(step.args)}`,
      `  rationale: ${step.rationale}`,
      tool ? `  result(status=${tool.status}): ${JSON.stringify(tool.result).slice(0, 400)}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n");
}
