// TrueFoundry AI Gateway client.
// Both providers (claude + llama) route through gateway.truefoundry.ai → AWS Bedrock.
// AbortController per in-flight request enables instant kill-provider chaos.

import type { ProviderName } from "./types.js";

export interface ChatRequest {
  provider: ProviderName;
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature: number;
  maxTokens?: number;
}

export interface ChatResponse {
  text: string;
  latencyMs: number;
  resolvedModel: string;
}

export class GatewayClient {
  private blocked = new Set<ProviderName>();
  private inflight = new Map<ProviderName, Set<AbortController>>();

  private get baseUrl() {
    return (process.env.TFY_AI_GATEWAY_URL ?? "https://gateway.truefoundry.ai").replace(/\/$/, "");
  }

  private get apiKey() {
    return process.env.TFY_API_KEY ?? "";
  }

  setProviderBlocked(provider: ProviderName, blocked: boolean): void {
    if (blocked) {
      this.blocked.add(provider);
      // Abort any in-flight call immediately — demo shows failover within the step
      const set = this.inflight.get(provider);
      if (set) for (const ctrl of set) ctrl.abort();
    } else {
      this.blocked.delete(provider);
    }
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (this.blocked.has(req.provider)) {
      throw new Error(`provider ${req.provider} killed by chaos`);
    }

    const ctrl = new AbortController();
    let set = this.inflight.get(req.provider);
    if (!set) { set = new Set(); this.inflight.set(req.provider, set); }
    set.add(ctrl);

    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${this.apiKey}`,
          // Pass guardrails via header — TFY evaluates them server-side
          "x-tfy-guardrails": JSON.stringify({
            llm_input_guardrails: ["cannon/prompt-injection"],
            llm_output_guardrails: ["cannon/secrets-detection"],
          }),
        },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          temperature: req.temperature,
          max_tokens: req.maxTokens ?? 4096,
          response_format: { type: "json_object" },
        }),
        signal: ctrl.signal,
      });
    } catch (err) {
      const msg = (err as Error).message;
      throw new Error(ctrl.signal.aborted ? `provider ${req.provider} killed by chaos` : `network: ${msg}`);
    } finally {
      set.delete(ctrl);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${req.provider} status ${res.status}: ${body.slice(0, 200)}`);
    }

    const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    const text = (json.choices[0]?.message?.content ?? "").trim();
    const resolvedModel = res.headers.get("x-tfy-resolved-model") ?? req.model;

    return { text, latencyMs: Date.now() - t0, resolvedModel };
  }
}
