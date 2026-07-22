/**
 * 21_ADRs > ADR-088 — tiny shared HTTP helper used by all three provider
 * services (`email-provider.service.ts`/`sms-provider.service.ts`/
 * `push-provider.service.ts`). Built entirely on Node's global `fetch`
 * (already relied on elsewhere in this codebase — see
 * `scripts/verify-storage-roundtrip.ts`, ADR-087) — zero new npm
 * dependency, same discipline ADR-087 established for object storage,
 * applied here to three more third-party HTTP integrations.
 *
 * Deliberately minimal: no retry logic here (BullMQ already owns retries
 * for the two async channels — see `NotificationDispatchProcessor` — and
 * `AuthService.requestOtp`'s own SMS send is synchronous-with-fallback by
 * design, not retried). This helper only standardizes "make the request,
 * throw with a useful message on a non-2xx or network failure."
 */
export class ProviderHttpError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}

export async function postJson(params: {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  providerName: string;
}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(params.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...params.headers },
      body: JSON.stringify(params.body),
    });
  } catch (error) {
    throw new ProviderHttpError(
      `${params.providerName} request failed (network error): ${(error as Error).message}`,
    );
  }

  const text = await response.text();
  const parsed = text.length > 0 ? safeJsonParse(text) : undefined;

  if (!response.ok) {
    throw new ProviderHttpError(
      `${params.providerName} request failed: ${response.status} ${response.statusText} — ${text.slice(0, 500)}`,
      response.status,
      parsed,
    );
  }

  return parsed;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function postForm(params: {
  url: string;
  headers: Record<string, string>;
  form: Record<string, string>;
  providerName: string;
}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(params.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...params.headers },
      body: new URLSearchParams(params.form).toString(),
    });
  } catch (error) {
    throw new ProviderHttpError(
      `${params.providerName} request failed (network error): ${(error as Error).message}`,
    );
  }

  const text = await response.text();
  const parsed = text.length > 0 ? safeJsonParse(text) : undefined;

  if (!response.ok) {
    throw new ProviderHttpError(
      `${params.providerName} request failed: ${response.status} ${response.statusText} — ${text.slice(0, 500)}`,
      response.status,
      parsed,
    );
  }

  return parsed;
}
