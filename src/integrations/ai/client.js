/**
 * A thin HTTP client for the chat-completions proxy, using Node's built-in
 * `fetch` — no axios, because there is nothing here axios would do better.
 */

import config from '../../config/index.js';
import logger from '../../utils/logger.js';
import { ApiError } from '../../utils/ApiError.js';
import { ERROR_CODES } from '../../constants/errorCodes.js';

/* Circuit breaker */

const breaker = {
  failures: 0,
  openedAt: null,

  /** True when requests should fail fast without touching the network. */
  isOpen() {
    if (!config.ai.circuitBreaker.enabled || this.openedAt === null) return false;

    const elapsed = Date.now() - this.openedAt;
    if (elapsed >= config.ai.circuitBreaker.resetTimeoutMs) {
      // Cooldown elapsed. Let ONE request through to test recovery; if it
      // fails the circuit re-opens immediately.
      this.openedAt = null;
      this.failures = config.ai.circuitBreaker.failureThreshold - 1;
      logger.info('AI circuit breaker entering half-open state — probing upstream');
      return false;
    }
    return true;
  },

  recordSuccess() {
    this.failures = 0;
    this.openedAt = null;
  },

  recordFailure() {
    this.failures += 1;
    if (this.failures >= config.ai.circuitBreaker.failureThreshold && this.openedAt === null) {
      this.openedAt = Date.now();
      logger.error(
        `AI circuit breaker OPEN after ${this.failures} consecutive failures — failing fast for ${config.ai.circuitBreaker.resetTimeoutMs / 1000}s`
      );
    }
  },

  state() {
    if (this.openedAt !== null) return 'open';
    if (this.failures > 0) return 'half-open';
    return 'closed';
  },
};

export const circuitState = () => breaker.state();

/* Request execution */

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Exponential backoff with jitter.
 */
const backoffDelay = (attempt) => {
  const base = config.ai.retry.baseDelayMs * config.ai.retry.factor ** attempt;
  const jitter = base * config.ai.retry.jitterRatio * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
};

/** Is this failure worth retrying? */
const isRetryable = (statusCode) =>
  statusCode === null || config.ai.retry.retryableStatuses.includes(statusCode);

/**
 * Map an upstream error onto a typed ApiError.
 */
const translateError = (statusCode, body) => {
  const upstreamCode = body?.error?.code;
  const upstreamMessage = body?.error?.message ?? 'The AI service returned an error';

  if (statusCode === 401 || upstreamCode === 'invalid_api_key') {
    return ApiError.serviceUnavailable(
      'The AI service rejected our credentials',
      ERROR_CODES.AI_INVALID_TOKEN
    );
  }

  if (statusCode === 429 || upstreamCode === 'rate_limit_exceeded') {
    return ApiError.tooManyRequests(
      'The AI service quota has been exhausted',
      ERROR_CODES.AI_QUOTA_EXHAUSTED
    );
  }

  if (statusCode === 404 || upstreamCode === 'model_not_found') {
    return ApiError.badGateway(
      `The AI service does not recognise the model "${config.ai.api.model}"`,
      ERROR_CODES.AI_UNAVAILABLE
    );
  }

  if (statusCode === 400) {
    return ApiError.badGateway(
      `The AI service rejected the request: ${upstreamMessage}`,
      ERROR_CODES.AI_UNAVAILABLE
    );
  }

  return ApiError.badGateway(upstreamMessage, ERROR_CODES.AI_UNAVAILABLE);
};

/**
 * Send a chat completion request.
 */
export const chat = async (messages, options = {}) => {
  if (breaker.isOpen()) {
    throw ApiError.serviceUnavailable(
      'The AI service is temporarily unavailable',
      ERROR_CODES.AI_UNAVAILABLE,
      { details: { circuitBreaker: 'open' } }
    );
  }

  const url = `${config.ai.api.baseUrl}${config.ai.api.chatPath}`;

  const payload = {
    model: config.ai.api.model,
    messages,
    max_tokens: options.maxTokens ?? config.ai.api.maxTokens,
    temperature: options.temperature ?? config.ai.api.temperature,
    // Guarantees parseable output, so responses are read rather than scraped.
    ...(options.jsonMode ? { response_format: { type: 'json_object' } } : {}),
  };

  let lastError = null;

  for (let attempt = 0; attempt <= config.ai.retry.maxAttempts; attempt += 1) {
    const startedAt = Date.now();

    // A fresh controller per attempt — an aborted one stays aborted.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.ai.api.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.ai.api.token}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeout);
      const latencyMs = Date.now() - startedAt;

      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }

      if (!response.ok) {
        const error = translateError(response.status, body);

        // A retryable status gets another attempt; anything else fails now.
        if (isRetryable(response.status) && attempt < config.ai.retry.maxAttempts) {
          lastError = error;
          const wait = backoffDelay(attempt);
          logger.warn(`AI request failed with ${response.status}; retrying in ${wait}ms`, {
            attempt: attempt + 1,
          });
          await delay(wait);
          continue;
        }

        breaker.recordFailure();
        throw error;
      }

      const content = body?.choices?.[0]?.message?.content;

      if (!content) {
        breaker.recordFailure();
        throw ApiError.badGateway(
          'The AI service returned an empty response',
          ERROR_CODES.AI_MALFORMED_RESPONSE
        );
      }

      breaker.recordSuccess();

      return {
        content,
        usage: {
          promptTokens: body.usage?.prompt_tokens ?? 0,
          completionTokens: body.usage?.completion_tokens ?? 0,
          totalTokens: body.usage?.total_tokens ?? 0,
        },
        model: body.model ?? config.ai.api.model,
        latencyMs,
      };
    } catch (error) {
      clearTimeout(timeout);

      // Already a typed error from the block above — do not re-wrap.
      if (error instanceof ApiError) {
        if (attempt >= config.ai.retry.maxAttempts) throw error;
        lastError = error;
        continue;
      }

      const isTimeout = error.name === 'AbortError';

      const wrapped = isTimeout
        ? ApiError.gatewayTimeout(
            `The AI service did not respond within ${config.ai.api.timeoutMs / 1000}s`,
            ERROR_CODES.AI_TIMEOUT
          )
        : ApiError.serviceUnavailable(
            `Could not reach the AI service: ${error.message}`,
            ERROR_CODES.AI_UNAVAILABLE
          );

      if (attempt < config.ai.retry.maxAttempts) {
        lastError = wrapped;
        const wait = backoffDelay(attempt);
        logger.warn(`AI request ${isTimeout ? 'timed out' : 'failed'}; retrying in ${wait}ms`, {
          attempt: attempt + 1,
        });
        await delay(wait);
        continue;
      }

      breaker.recordFailure();
      throw wrapped;
    }
  }

  breaker.recordFailure();
  throw lastError ?? ApiError.serviceUnavailable('The AI service is unavailable', ERROR_CODES.AI_UNAVAILABLE);
};

/**
 * Ask the provider how much of OUR quota is left.
 */
export const fetchUsage = async () => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(`${config.ai.api.baseUrl}${config.ai.api.usagePath}`, {
      headers: { Authorization: `Bearer ${config.ai.api.token}` },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw translateError(response.status, body);
    }

    return response.json();
  } catch (error) {
    clearTimeout(timeout);
    if (error instanceof ApiError) throw error;
    throw ApiError.serviceUnavailable(
      `Could not read AI usage: ${error.message}`,
      ERROR_CODES.AI_UNAVAILABLE
    );
  }
};

/** Is the provider reachable? Used by the readiness probe. No auth needed. */
export const ping = async () => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(`${config.ai.api.baseUrl}${config.ai.api.healthPath}`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return { reachable: response.ok, status: response.status };
  } catch (error) {
    clearTimeout(timeout);
    return { reachable: false, error: error.message };
  }
};

export default { chat, fetchUsage, ping, circuitState };
