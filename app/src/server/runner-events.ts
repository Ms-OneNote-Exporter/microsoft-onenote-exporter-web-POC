/**
 * The runner's event wire format, mirrored on the app side.
 *
 * Declared here rather than imported from the runner package: the two run in
 * different containers with different dependency graphs, and the app should not
 * need the runner's node_modules to know what a log line looks like. The two
 * definitions are checked against each other by the app's runner-client test,
 * which parses frames produced by the real sidecar.
 */

/** How a child process ended. Mirrors the runner's JobResult. */
export interface JobResult {
  kind: 'login' | 'list' | 'export';
  /** Exit code, or null when the process died from a signal. */
  code: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  /** Set when the process never started. */
  spawnError?: string;
}

export type RunnerEvent =
  | {
      kind: 'line';
      seq: number;
      stream: 'stdout' | 'stderr';
      text: string;
      at: string;
    }
  | { kind: 'end'; seq: number; at: string; result: JobResult };

/** A `line` event narrowed for the app's use. */
export interface LineEvent {
  kind: 'line';
  seq: number;
  stream: 'stdout' | 'stderr';
  text: string;
  at: string;
}

export function isLineEvent(event: RunnerEvent): event is LineEvent {
  return event.kind === 'line';
}

export function isEndEvent(event: RunnerEvent): event is Extract<RunnerEvent, { kind: 'end' }> {
  return event.kind === 'end';
}