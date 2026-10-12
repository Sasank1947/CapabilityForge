import type {
  ActionOutcome,
  ExtractRead,
  Observation,
  ObserveOptions,
  Resolution,
  ResolveOptions,
  ScreenshotOptions,
  Surface,
  SurfaceAction,
} from "../surface/types.js";
import type { TargetDescriptor } from "../artifact/schema.js";
import type { SessionController } from "./controller.js";
import type { Controller } from "./types.js";

/**
 * Surface wrapper that rejects `act` unless `actor` currently holds the
 * SessionController lease. Perception (observe / resolve / screenshot) stays
 * available so resume re-classification can run while the engine is RESUMING.
 */
export class LeasedSurface implements Surface {
  readonly kind: Surface["kind"];

  constructor(
    readonly inner: Surface,
    private readonly controller: SessionController,
    private readonly actor: Exclude<Controller, null>,
  ) {
    this.kind = inner.kind;
  }

  observe(options?: ObserveOptions): Promise<Observation> {
    return this.inner.observe(options);
  }

  resolve(target: TargetDescriptor, options?: ResolveOptions): Promise<Resolution> {
    return this.inner.resolve(target, options);
  }

  async act(action: SurfaceAction): Promise<ActionOutcome> {
    this.controller.assertCanAct(this.actor);
    return this.inner.act(action);
  }

  extract(ref: Parameters<Surface["extract"]>[0], read: ExtractRead): Promise<string> {
    return this.inner.extract(ref, read);
  }

  screenshot(options?: ScreenshotOptions): Promise<Buffer> {
    return this.inner.screenshot(options);
  }

  currentUrl(): Promise<string> {
    return this.inner.currentUrl();
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
