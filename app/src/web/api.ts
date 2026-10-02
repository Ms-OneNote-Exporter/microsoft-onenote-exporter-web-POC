import type { AppEvent, SessionState } from '@msout-poc/shared';

/**
 * The browser's API client.
 *
 * Deliberately small and typed against the shared contract. The one thing worth
 * noting is the credential call: the body is built here, encoded as a string, and
 * sent as `application/octet-stream` so the app forwards it without parsing.
 */

/** Same-origin: the app serves the UI, so there is no CORS and no second origin. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { accept: 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export const api = {
  createSession: (guid: string) =>
    request<SessionState>(`/api/session?guid=${guid}`, { method: 'POST' }),

  readSession: (guid: string) => request<SessionState>(`/api/session?guid=${guid}`),

  erase: (guid: string) => request<{ erased: boolean }>(`/api/session?guid=${guid}`, { method: 'DELETE' }),

  list: (guid: string) =>
    request<{ jobId: string; position: number }>(`/api/session/list?guid=${guid}`, { method: 'POST' }),

  abort: (guid: string) => request<{ aborted: boolean }>(`/api/session/abort?guid=${guid}`, { method: 'POST' }),

  /**
   * Sends the credentials.
   *
   * The body is serialised *here* and handed over as an opaque string. The app
   * never sees the password as a parsed field, which is the property the whole
   * credential path is built around.
   */
  login: (guid: string, email: string, password: string) =>
    request<{ jobId: string; position: number }>(`/api/session/credentials?guid=${guid}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: JSON.stringify({ email, password }),
    }),

  mfa: (guid: string, code: string) =>
    request<{ sent: boolean }>(`/api/session/mfa?guid=${guid}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    }),

  exportNotebook: (guid: string, target: { notebook?: string; notebookUrl?: string }) =>
    request<{ jobId: string; position: number }>(`/api/session/export?guid=${guid}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(target),
    }),
};

export type { AppEvent, SessionState };

/** One log line as the UI holds it. */
export interface UiLogLine {
  seq: number;
  level: string;
  text: string;
  at: string;
}