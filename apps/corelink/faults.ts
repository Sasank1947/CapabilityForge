export const FAULT_NAMES = [
  "not_found",
  "validation_error",
  "permission_denied",
  "session_expired",
  "surprise_dialog",
  "slow_load",
  "server_error",
] as const;

export type FaultName = (typeof FAULT_NAMES)[number];

export interface FaultSpec {
  name: FaultName;
  /** Tenant-relative route, e.g. "/search". Trailing "*" means prefix match. */
  route?: string;
  method?: string;
  /** slow_load delay override in ms. */
  ms?: number;
}

export interface ArmedFault extends FaultSpec {
  /** Remaining applications; null = until cleared. */
  remaining: number | null;
}

export type FaultSource = "header" | "cookie" | "admin";

/** Routes rendered in the main frame (the ones a flow actually works on). */
const CONTENT_ROUTES = new Set(["/main", "/search", "/member", "/subacct", "/subacct/commit", "/unavail"]);

const DEFAULT_SCOPE: Record<FaultName, (method: string, rel: string) => boolean> = {
  not_found: (m, r) => (m === "POST" && r === "/search") || (m === "GET" && r === "/member"),
  validation_error: (m, r) => m === "POST" && r === "/subacct",
  permission_denied: (_m, r) => r === "/subacct" || r === "/subacct/commit",
  session_expired: (_m, r) => CONTENT_ROUTES.has(r),
  surprise_dialog: (_m, r) => CONTENT_ROUTES.has(r),
  slow_load: (_m, r) => CONTENT_ROUTES.has(r),
  server_error: (_m, r) => CONTENT_ROUTES.has(r),
};

/** Where a fault can take effect at all when explicitly routed. */
const CAPABLE: Record<FaultName, (method: string, rel: string) => boolean> = {
  not_found: DEFAULT_SCOPE.not_found,
  validation_error: DEFAULT_SCOPE.validation_error,
  permission_denied: (_m, r) => r !== "/login" && r !== "/logout",
  session_expired: (_m, r) => r !== "/login" && r !== "/logout",
  surprise_dialog: (_m, r) => r !== "/logout",
  slow_load: () => true,
  server_error: () => true,
};

export function isFaultName(s: string): s is FaultName {
  return (FAULT_NAMES as readonly string[]).includes(s);
}

export function normalizeRoute(route: string, prefix: string): string {
  let r = route.trim();
  if (!r.startsWith("/")) r = `/${r}`;
  if (prefix && (r === prefix || r.startsWith(`${prefix}/`))) r = r.slice(prefix.length) || "/";
  return r;
}

/**
 * Grammar: `<name>[:<ms>][@[METHOD]<route>]`, e.g. `not_found`, `slow_load:1500`,
 * `surprise_dialog@/member`, `server_error@POST/search`, `slow_load:4000@/subacct*`.
 */
export function parseFaultSpec(raw: string | undefined, prefix: string): FaultSpec | null {
  if (!raw) return null;
  const s = raw.trim();
  const m = /^([a-z_]+)(?::(\d+))?(?:@([A-Z]+)?(\/?.*))?$/.exec(s);
  if (!m) return null;
  const name = m[1] ?? "";
  if (!isFaultName(name)) return null;
  const spec: FaultSpec = { name };
  if (m[2]) spec.ms = Number(m[2]);
  if (m[3]) spec.method = m[3];
  if (m[4]) spec.route = normalizeRoute(m[4], prefix);
  return spec;
}

function routeMatches(route: string, rel: string): boolean {
  return route.endsWith("*") ? rel.startsWith(route.slice(0, -1)) : rel === route;
}

export function faultApplies(spec: FaultSpec, method: string, rel: string): boolean {
  if (spec.method && spec.method !== method) return false;
  if (spec.route) return routeMatches(spec.route, rel) && CAPABLE[spec.name](method, rel);
  return DEFAULT_SCOPE[spec.name](method, rel);
}

export function describeFault(spec: FaultSpec): string {
  let s: string = spec.name;
  if (spec.ms !== undefined) s += `:${spec.ms}`;
  if (spec.route || spec.method) s += `@${spec.method ?? ""}${spec.route ?? ""}`;
  return s;
}
