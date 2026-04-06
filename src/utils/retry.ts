/** Exponential backoff retry wrapper for Oxlo API calls. */

/** Options for the retry wrapper. */
export interface RetryOptions {
  /** Maximum number of attempts (including the first try). Default: 3 */
  maxAttempts?: number;
  /** Initial delay in ms before first retry. Doubles each attempt. Default: 500 */
  initialDelayMs?: number;
  /** Maximum delay cap in ms. Default: 8000 */
  maxDelayMs?: number;
  /** If provided, only retry when this predicate returns true. */
  retryIf?: (err: unknown) => boolean;
}

/**
 * Wraps an async function with exponential backoff retry logic.
 * Retries on any thrown error unless `retryIf` returns false.
 *
 * @param fn      - Async function to retry
 * @param options - Retry configuration
 * @returns The result of the first successful call
 * @throws The last error if all attempts fail
 *
 * @example
 * const result = await withRetry(() => client.chat(messages, system), { maxAttempts: 3 });
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 500,
    maxDelayMs = 8_000,
    retryIf,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      const isLastAttempt = attempt === maxAttempts;
      if (isLastAttempt) break;

      // Check if we should retry this error type
      if (retryIf && !retryIf(err)) throw err;

      const delay = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Returns true for errors that are likely transient (rate limits, 5xx, timeouts).
 * Use as the `retryIf` option to avoid retrying on 4xx client errors.
 */
export function isTransientError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('rate limit') || msg.includes('429')) return true;
    if (msg.includes('timeout') || msg.includes('econnreset')) return true;
    if (msg.includes('500') || msg.includes('502') || msg.includes('503')) return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
