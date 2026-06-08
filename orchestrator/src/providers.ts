import type { ProviderName, ProviderState } from "./types.js";

export class ProviderRegistry {
  private state: Map<ProviderName, ProviderState>;
  private quarantineMs: number;

  constructor(providers: ProviderName[], quarantineMs = 60_000) {
    this.quarantineMs = quarantineMs;
    this.state = new Map(providers.map((p) => [p, {
      name: p, health: "healthy" as const,
      lastFailureAt: null, quarantineUntil: null,
    }]));
  }

  isHealthy(name: ProviderName): boolean {
    const s = this.state.get(name);
    if (!s) return false;
    if (s.quarantineUntil !== null && Date.now() < s.quarantineUntil) return false;
    return true;
  }

  healthy(): ProviderName[] {
    return (["claude", "llama"] as ProviderName[]).filter((p) => this.isHealthy(p));
  }

  markFailure(name: ProviderName): void {
    const s = this.state.get(name);
    if (!s) return;
    s.health = "quarantined";
    s.lastFailureAt = Date.now();
    s.quarantineUntil = Date.now() + this.quarantineMs;
  }
}
