import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Redactor } from "../policy/redact.js";
import type { Actor, EvidenceSink, NewRunEvent, RunEvent, RunEventType, RunManifest, RunMode } from "./types.js";

export function newRunId(mode: RunMode, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}-${mode}-${randomBytes(3).toString("hex")}`;
}

export interface SinkOptions {
  redactor: Redactor;
  mode: RunMode;
  runId?: string;
  manifest?: Partial<Omit<RunManifest, "runId" | "mode">>;
  clock?: () => Date;
}

export interface FileSinkOptions extends SinkOptions {
  /** Parent of the per-run directory; defaults to "runs". */
  rootDir?: string;
}

/** Fields a caller supplies when recording an event from raw (unredacted) data. */
export interface RecordOptions {
  stepId?: string;
  rationale?: string;
  attachments?: string[];
}

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function attachmentName(seq: number, name: string): string {
  const base = name.split(/[\\/]/).pop() || "attachment";
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 80) || "attachment";
  return `${String(seq).padStart(3, "0")}-${clean}`;
}

/**
 * Shared sequencing/redaction for both sinks. Payloads are typed `RedactedPayload`
 * (so only the redactor can produce them) and are run through the redactor again
 * here together with the rationale, so every write path is redacted.
 */
abstract class BaseSink implements EvidenceSink {
  readonly runId: string;
  abstract readonly dir: string;
  protected readonly redactor: Redactor;
  protected manifest: RunManifest;
  protected seq = 0;
  protected attachmentSeq = 0;
  protected closed = false;
  private readonly clock: () => Date;

  constructor(opts: SinkOptions) {
    this.redactor = opts.redactor;
    this.clock = opts.clock ?? (() => new Date());
    this.runId = opts.runId ?? newRunId(opts.mode, this.clock());
    if (!SAFE_RUN_ID.test(this.runId)) throw new Error(`unsafe runId '${this.runId}'`);
    this.manifest = this.redactManifest({
      startedAt: this.clock().toISOString(),
      ...opts.manifest,
      runId: this.runId,
      mode: opts.mode,
    });
  }

  append(event: NewRunEvent): RunEvent {
    if (this.closed) throw new Error(`evidence sink for run ${this.runId} is closed`);
    const full: RunEvent = {
      runId: this.runId,
      seq: ++this.seq,
      at: this.clock().toISOString(),
      actor: event.actor,
      type: event.type,
      ...(event.stepId !== undefined && { stepId: this.redactor.redactString(event.stepId) }),
      ...(event.rationale !== undefined && { rationale: this.redactor.redactString(event.rationale) }),
      payload: this.redactor.redact(event.payload),
      ...(event.attachments?.length && { attachments: [...event.attachments] }),
    };
    this.write(full);
    return full;
  }

  /** Convenience for call sites holding raw data: redacts, then appends. */
  record(actor: Actor, type: RunEventType, payload: object, options: RecordOptions = {}): RunEvent {
    return this.append({ actor, type, payload: this.redactor.redact(payload), ...options });
  }

  /** Text attachments (DOM snapshots, observations) are redacted before they are written. */
  attachText(name: string, text: string): Promise<string> {
    return this.attach(name, Buffer.from(this.redactor.redactString(text), "utf8"));
  }

  async attach(name: string, data: Buffer): Promise<string> {
    if (this.closed) throw new Error(`evidence sink for run ${this.runId} is closed`);
    const file = attachmentName(++this.attachmentSeq, this.redactor.redactString(name));
    const rel = `attachments/${file}`;
    await this.writeAttachment(rel, data);
    return rel;
  }

  async close(manifest: Partial<RunManifest> = {}): Promise<void> {
    if (this.closed) return;
    this.manifest = this.redactManifest({
      ...this.manifest,
      finishedAt: this.clock().toISOString(),
      ...manifest,
      runId: this.runId,
      mode: this.manifest.mode,
    });
    await this.writeManifest(this.manifest);
    this.closed = true;
  }

  getManifest(): RunManifest {
    return { ...this.manifest };
  }

  protected redactManifest(m: RunManifest): RunManifest {
    const redacted = { ...m };
    if (m.goal !== undefined) redacted.goal = this.redactor.redactString(m.goal);
    if (m.status !== undefined) redacted.status = this.redactor.redactString(m.status);
    return redacted;
  }

  protected abstract write(event: RunEvent): void;
  protected abstract writeAttachment(relPath: string, data: Buffer): Promise<void>;
  protected abstract writeManifest(manifest: RunManifest): Promise<void>;
}

/** Writes `<rootDir>/<runId>/{events.jsonl, manifest.json, attachments/}`. */
export class JsonlEvidenceSink extends BaseSink {
  readonly dir: string;
  readonly eventsPath: string;
  readonly manifestPath: string;
  readonly attachmentsDir: string;

  constructor(opts: FileSinkOptions) {
    super(opts);
    this.dir = resolve(opts.rootDir ?? "runs", this.runId);
    this.eventsPath = join(this.dir, "events.jsonl");
    this.manifestPath = join(this.dir, "manifest.json");
    this.attachmentsDir = join(this.dir, "attachments");
    mkdirSync(this.attachmentsDir, { recursive: true });
    writeFileSync(this.eventsPath, "", { flag: "a" });
    // Written up front so a crashed run still has a manifest.
    writeFileSync(this.manifestPath, `${JSON.stringify(this.manifest, null, 2)}\n`);
  }

  protected write(event: RunEvent): void {
    // Synchronous so the log survives a crash right after the event and stays in seq order.
    appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`);
  }

  protected async writeAttachment(relPath: string, data: Buffer): Promise<void> {
    await writeFile(join(this.dir, relPath), data);
  }

  protected async writeManifest(manifest: RunManifest): Promise<void> {
    await writeFile(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  /** Absolute path for a run-relative attachment path returned by `attach`. */
  pathOf(relPath: string): string {
    return join(this.dir, relPath);
  }
}

export class InMemoryEvidenceSink extends BaseSink {
  readonly dir: string;
  readonly events: RunEvent[] = [];
  readonly attachments = new Map<string, Buffer>();
  closedManifest?: RunManifest;

  constructor(opts: SinkOptions) {
    super(opts);
    this.dir = `memory://${this.runId}`;
  }

  protected write(event: RunEvent): void {
    this.events.push(event);
  }

  protected async writeAttachment(relPath: string, data: Buffer): Promise<void> {
    this.attachments.set(relPath, Buffer.from(data));
  }

  protected async writeManifest(manifest: RunManifest): Promise<void> {
    this.closedManifest = { ...manifest };
  }

  /** Every persisted byte as one string, for "no raw value survives" assertions. */
  dump(): string {
    return [
      ...this.events.map((e) => JSON.stringify(e)),
      JSON.stringify(this.closedManifest ?? this.manifest),
      ...[...this.attachments].map(([k, v]) => `${k}\n${v.toString("utf8")}`),
    ].join("\n");
  }
}
