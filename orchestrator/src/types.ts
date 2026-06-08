export type ProviderName = "claude" | "llama";

export type ProviderHealth = "healthy" | "quarantined";

export interface ProviderState {
  name: ProviderName;
  health: ProviderHealth;
  lastFailureAt: number | null;
  quarantineUntil: number | null;
}

export type AgentAction =
  | "search_logs"
  | "query_metrics"
  | "query_traces"
  | "read_runbook"
  | "report";

export interface AgentStep {
  index: number;
  action: AgentAction;
  args: Record<string, unknown>;
  rationale: string;
  hypotheses: string[];
}

export interface ToolCallRecord {
  step: number;
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  durationMs: number;
  status: "ok" | "error" | "synthetic" | "blocked";
}

export interface IncidentState {
  id: string;
  startedAt: number;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  toolLog: ToolCallRecord[];
  steps: AgentStep[];
  primary: ProviderName;
  shadow: ProviderName | null;
  finalReport: string | null;
}

export interface DivergenceScore {
  step: number;
  cosine: number;
  actionMismatch: boolean;
  agreement: number;
  flagged: boolean;
  summary: string;
}

export type Disposition = "resolved" | "degraded" | "inconclusive";
