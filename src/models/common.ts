export interface AdapterOptions {
  /** Defaults to GEMINI_API_KEY (or OPENAI_API_KEY for the OpenAI adapter), read at call time. */
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class AdapterError extends Error {
  constructor(
    message: string,
    public readonly kind: "not_configured" | "rate_limit" | "api_error" | "invalid_output",
  ) {
    super(message);
    this.name = "AdapterError";
  }
}
