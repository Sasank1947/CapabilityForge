import type {
  BoundingBox,
  LocatorStrategyKind,
  SurfaceKind,
  TargetDescriptor,
  TargetFingerprint,
} from "../artifact/schema.js";

/**
 * Opaque handle to a control on the current screen. Produced by `observe()` (as
 * `ObservedElement.ref`) or `resolve()`, and valid only until the next navigation
 * or `observe()` call.
 */
export type ElementRef = string;

export interface ObservedElement {
  ref: ElementRef;
  role: string;
  name: string;
  /** Text of the nearest label-like cell/element when the control has no accessible name of its own. */
  labelText?: string;
  text?: string;
  /** Current value of editable controls; surfaces must mask values of password fields. */
  value?: string;
  tag?: string;
  framePath: string[];
  bbox?: BoundingBox;
  states: {
    disabled?: boolean;
    checked?: boolean;
    focused?: boolean;
    editable?: boolean;
  };
}

export interface FrameInfo {
  path: string[];
  url: string;
  name?: string;
  /** Document title of the frame (framesets keep the meaningful title inside frames). */
  title?: string;
}

export interface Observation {
  url: string;
  title: string;
  frames: FrameInfo[];
  /** Interactive and label-bearing elements in document order across all frames. */
  elements: ObservedElement[];
  /** Visible text per frame, keyed by framePath joined with "/" ("" for top). Used by text conditions and classifiers. */
  textByFrame: Record<string, string>;
  /** Stable hash of the structural snapshot (excluding values); equal hashes mean "same screen". */
  snapshotHash: string;
  capturedAt: string;
  /** Set when the a11y tree was too poor and a vision fallback screenshot was taken. */
  screenshotPath?: string;
}

export interface ObserveOptions {
  includeScreenshot?: boolean;
  maxElements?: number;
}

export interface StrategyAttempt {
  strategyIndex: number;
  strategyKind: LocatorStrategyKind;
  matches: number;
}

export type Resolution =
  | {
      ok: true;
      ref: ElementRef;
      strategyIndex: number;
      strategyKind: LocatorStrategyKind;
      attempts: StrategyAttempt[];
      fingerprint: TargetFingerprint;
    }
  | {
      ok: false;
      reason: "not_found" | "ambiguous" | "frame_not_found";
      attempts: StrategyAttempt[];
    };

export interface ResolveOptions {
  /** Values substituted into `{{name}}` placeholders in strategy text. */
  templateValues?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Concrete, surface-level actions. Parameters and secrets are already resolved to
 * literal values here; `sensitive` tells the surface and evidence layer to mask them.
 */
export type SurfaceAction =
  | { type: "navigate"; url: string }
  | { type: "click"; ref: ElementRef }
  | { type: "type"; ref: ElementRef; text: string; clear: boolean; sensitive: boolean }
  | { type: "select"; ref: ElementRef; option: string; sensitive: boolean }
  | { type: "check"; ref: ElementRef; checked: boolean }
  | { type: "press"; key: string; ref?: ElementRef };

export type SurfaceActionType = SurfaceAction["type"];

export interface ActionOutcome {
  ok: boolean;
  error?: string;
  urlAfter: string;
  durationMs: number;
}

export type ExtractRead = { read: "text" } | { read: "value" } | { read: "attribute"; attribute: string };

export interface ScreenshotOptions {
  path?: string;
  fullPage?: boolean;
  /** Elements to paint over before capture. */
  maskRefs?: ElementRef[];
  /** Literal values whose containing inputs/cells must be masked before capture. */
  maskValues?: string[];
}

/**
 * Perceive-and-act seam. The recorded flow only ever talks to this interface, so a
 * DesktopSurface (UIA/AX) or VisionSurface can replace the Playwright implementation.
 */
export interface Surface {
  readonly kind: SurfaceKind;
  observe(options?: ObserveOptions): Promise<Observation>;
  resolve(target: TargetDescriptor, options?: ResolveOptions): Promise<Resolution>;
  act(action: SurfaceAction): Promise<ActionOutcome>;
  extract(ref: ElementRef, read: ExtractRead): Promise<string>;
  screenshot(options?: ScreenshotOptions): Promise<Buffer>;
  currentUrl(): Promise<string>;
  close(): Promise<void>;
}
