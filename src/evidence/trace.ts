import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import type { EvidenceSink } from "./types.js";

export interface TraceOptions {
  screenshots?: boolean;
  snapshots?: boolean;
  title?: string;
}

export interface TraceSession {
  /** `keep: true` saves `trace.zip` as a run attachment and returns its run-relative path; otherwise discards. */
  stop(options: { keep: boolean; name?: string }): Promise<string | undefined>;
}

/**
 * Playwright traces are NOT redacted: they hold raw DOM snapshots, screenshots
 * and network bodies (including the login POST). They are therefore kept only
 * on failure, and callers should flag the attachment as unredacted evidence.
 */
export async function startTrace(context: BrowserContext, sink: EvidenceSink, options: TraceOptions = {}): Promise<TraceSession> {
  await context.tracing.start({
    screenshots: options.screenshots ?? true,
    snapshots: options.snapshots ?? true,
    sources: false,
    ...(options.title !== undefined && { title: options.title }),
  });
  let stopped = false;
  return {
    async stop({ keep, name = "trace.zip" }) {
      if (stopped) return undefined;
      stopped = true;
      if (!keep) {
        await context.tracing.stop();
        return undefined;
      }
      const tmp = join(tmpdir(), `cf-trace-${randomBytes(6).toString("hex")}.zip`);
      try {
        await context.tracing.stop({ path: tmp });
        return await sink.attach(name, await readFile(tmp));
      } finally {
        await rm(tmp, { force: true });
      }
    },
  };
}

/**
 * Runs `fn` under tracing and keeps the trace when it throws or when `isFailure`
 * says the returned result is a failure. `onTrace` receives the attachment path.
 */
export async function withTraceOnFailure<T>(
  context: BrowserContext,
  sink: EvidenceSink,
  fn: () => Promise<T>,
  opts: TraceOptions & { isFailure?: (result: T) => boolean; onTrace?: (relPath: string) => void } = {},
): Promise<T> {
  const session = await startTrace(context, sink, opts);
  let result: T;
  try {
    result = await fn();
  } catch (err) {
    const path = await session.stop({ keep: true }).catch(() => undefined);
    if (path) opts.onTrace?.(path);
    throw err;
  }
  const keep = opts.isFailure?.(result) ?? false;
  const path = await session.stop({ keep });
  if (path) opts.onTrace?.(path);
  return result;
}
