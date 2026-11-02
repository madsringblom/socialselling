import Anthropic from "@anthropic-ai/sdk";

/** USD per million tokens. */
type Price = { input: number; output: number; cacheRead: number; cacheWrite: number };

const OPUS: Price = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
const HAIKU: Price = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 };
/** Web search is billed at $10 per 1,000 searches. */
const WEB_SEARCH_USD = 0.01;

const MAX_RETRIES = 3;
const BACKOFF_MS = [2000, 8000, 30000];

export type Usage = { calls: number; costUsd: number };

export function priceFor(model: string): Price {
  return /opus/.test(model) ? OPUS : HAIKU;
}

/** Token cost for one response plus server-side web searches. */
export function costUsd(u: Anthropic.Usage, model: string): number {
  const p = priceFor(model);
  const tokens =
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * p.cacheWrite) /
    1_000_000;
  return tokens + (u.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD;
}

/** A client with the SDK's default retries (2). */
export function newClient(timeoutMs = 120_000): Anthropic {
  return new Anthropic({ timeout: timeoutMs });
}

/**
 * Retries rate limits, 408, 409, 5xx and connection errors up to 3 times with 2s/8s/30s backoff plus jitter.
 * Authentication errors, other API errors and non-API errors are rethrown immediately.
 */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw e;
      if (!(e instanceof Anthropic.APIError)) throw e;
      const status: number | undefined = e.status;
      const retryable =
        e instanceof Anthropic.RateLimitError || status === undefined || status === 408 || status === 409 || status >= 500;
      if (!retryable || attempt >= MAX_RETRIES) throw e;
      await Bun.sleep((BACKOFF_MS[attempt] ?? 30000) + Math.random() * 1000);
    }
  }
}

/** Returns parsed structured output, or throws `<label>: stop_reason …` / `<label>: unparseable output`. */
export function parsedOrThrow<T>(res: { stop_reason: string | null; parsed_output: T | null }, label: string): T {
  if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") {
    throw new Error(`${label}: stop_reason ${res.stop_reason}`);
  }
  if (res.parsed_output == null) throw new Error(`${label}: unparseable output (stop_reason ${res.stop_reason})`);
  return res.parsed_output;
}

/** Authentication errors abort a whole play instead of failing item by item. */
export function isFatal(e: unknown): boolean {
  return e instanceof Anthropic.AuthenticationError;
}

export function isHttpUrl(s: unknown): s is string {
  return typeof s === "string" && /^https?:\/\/\S+$/.test(s);
}
