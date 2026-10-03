import type { JobResult, RunnerEvent } from './runner-events';

/**
 * The app's client for the runner.
 *
 * Two jobs, deliberately separated by typing:
 *
 *  - `start*` returns as soon as the runner has spawned the child (HTTP 202).
 *    Everything after that arrives over `/events`, so a login that takes forty
 *    minutes never holds an HTTP request open.
 *  - `credentials` forwards the browser's bytes **verbatim**. This function
 *    does not parse, log, copy or transform them. The runner is the only process
 *    that ever holds a password in memory, and that property depends on this
 *    being a byte pipe rather than a field on a JSON object.
 */

/** What the runner returns when it has spawned a child. */
export interface JobStart {
  /** Subscribe to /events from this sequence: this job's output, not the last one's. */
  fromSeq: number;
}

export class RunnerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'RunnerError';
  }
}

export interface RunnerClientOptions {
  baseUrl: string;
  token: string;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export class RunnerClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RunnerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { 'x-runner-token': this.token, ...extra };
  }

  private async request(
    path: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: this.headers(init.headers),
        body: init.body,
      });
    } catch (error) {
      // The runner being unreachable is an operational fact, not a user error,
      // so it is reported as its own code rather than folded into 'unknown'.
      throw new RunnerError('runner_unreachable', (error as Error).message, 502);
    }
    if (!response.ok) {
      let code = 'unknown';
      let message = `runner responded ${response.status}`;
      try {
        const body = (await response.json()) as { error?: string; message?: string };
        if (body.error) code = body.error;
        if (body.message) message = body.message;
      } catch {
        // A non-JSON error body is not worth failing over; the status is the fact.
      }
      throw new RunnerError(code, message, response.status);
    }
    return response;
  }

  /**
   * Forwards the browser's credential bytes without looking at them.
   *
   * `Content-Type: application/octet-stream` is what selects the runner's
   * "hand me the raw string" parser. No JSON is constructed here, and the body is
   * passed straight to fetch.
   */
  async credentials(guid: string, rawBody: string): Promise<JobStart> {
    return this.start(`/sessions/${guid}/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: rawBody,
    });
  }

  /**
   * Issues a job request and returns the sequence its output starts after.
   *
   * The sequence matters: the event stream is per session, so a subscriber that
   * starts from 0 is handed the previous job's buffered lines *including its
   * `end` event* - and would conclude the new job had already finished, with the
   * old job's result.
   */
  private async start(
    path: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<JobStart> {
    const response = await this.request(path, init);
    const body = (await response.json()) as Partial<JobStart>;
    return { fromSeq: typeof body.fromSeq === 'number' ? body.fromSeq : 0 };
  }

  async mfa(guid: string, code: string): Promise<void> {
    await this.request(`/sessions/${guid}/mfa`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
  }

  /**
   * Asks Microsoft whether the saved session is still live.
   *
   * Only meaningful since 0.1.9, when `check` stopped reporting success for a
   * dead session; before that this call would have rubber-stamped an expired
   * login, which is why the preflight did not exist at all.
   */
  async check(guid: string): Promise<JobStart> {
    return this.start(`/sessions/${guid}/check`, { method: 'POST' });
  }

  async list(guid: string): Promise<JobStart> {
    return this.start(`/sessions/${guid}/list`, { method: 'POST' });
  }

  async export(
    guid: string,
    target: { notebook?: string; notebookUrl?: string },
  ): Promise<JobStart> {
    return this.start(`/sessions/${guid}/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(target),
    });
  }

  async abort(guid: string): Promise<boolean> {
    const response = await this.request(`/sessions/${guid}/abort`, { method: 'POST' });
    const body = (await response.json()) as { aborted?: boolean };
    return body.aborted === true;
  }

  async erase(guid: string): Promise<void> {
    await this.request(`/sessions/${guid}`, { method: 'DELETE' });
  }

  async artifactSize(guid: string): Promise<number> {
    const response = await this.request(`/artifact/size?guid=${encodeURIComponent(guid)}`, {
      method: 'GET',
    });
    const body = (await response.json()) as { bytes?: number };
    return body.bytes ?? 0;
  }

  /** URL for the browser to download from. The app proxies it, so no token leaks. */
  artifactPath(guid: string, notebook: string | null, partial: boolean): string {
    const params = new URLSearchParams({ guid });
    if (notebook) params.set('notebook', notebook);
    if (partial) params.set('partial', '1');
    return `/artifact?${params.toString()}`;
  }

  /**
   * Opens the artifact stream. The Response is returned unconsumed so the caller
   * can pipe it; the runner does the zipping and this process never holds it.
   */
  async fetchArtifact(path: string): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, { headers: this.headers() });
    } catch (error) {
      throw new RunnerError('runner_unreachable', (error as Error).message, 502);
    }
    if (!response.ok) {
      throw new RunnerError('no_artifact', `runner responded ${response.status}`, response.status);
    }
    return response;
  }

  /**
   * Subscribes to a session's events.
   *
   * Returns an unsubscribe function. `onEvent` receives raw runner events; the
   * decision about what they mean belongs to the app's log parser.
   */
  subscribe(
    guid: string,
    sinceSeq: number,
    onEvent: (event: RunnerEvent | { kind: 'gap' }) => void,
    onError?: (error: Error) => void,
  ): () => void {
    const controller = new AbortController();
    const url = `${this.baseUrl}/events?guid=${encodeURIComponent(guid)}&since=${sinceSeq}`;

    void (async () => {
      try {
        const response = await this.fetchImpl(url, {
          headers: this.headers(),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new RunnerError('runner_unreachable', `events stream responded ${response.status}`, 502);
        }
        // Read the SSE stream by hand: the runner's frames are `id:`/`data:`
        // pairs and each payload is a self-contained JSON event, so a parser per
        // frame is enough and avoids buffering the whole stream.
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const parsed = parseFrame(frame);
            if (parsed) onEvent(parsed);
            boundary = buffer.indexOf('\n\n');
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          onError?.(error as Error);
        }
      }
    })();

    return () => controller.abort();
  }
}

/** Parses one SSE frame. Returns null for comments, keepalives and blank frames. */
export function parseFrame(frame: string): RunnerEvent | { kind: 'gap' } | null {
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue; // keepalive comment
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  try {
    return JSON.parse(dataLines.join('\n')) as RunnerEvent | { kind: 'gap' };
  } catch {
    // A frame we cannot parse is dropped rather than thrown: one malformed
    // payload must not tear down the stream the UI depends on.
    return null;
  }
}

export type { JobResult };