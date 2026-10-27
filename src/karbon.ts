// Shared Karbon API client. Every tool goes through here so that auth, rate
// limiting, concurrency conflicts, paging and write verification behave the
// same way everywhere.
//
// Rules (docs/KARBON_API.md, docs/KarbonAPI.json):
// - Two headers on every request: Authorization: Bearer {token} and AccessKey.
// - 429: wait the delay given in the message ("Try again in 10 seconds"), then retry.
// - 409 code 4020: re-fetch, reapply the change, retry (at most twice), then fail clearly.
// - Paging: $top ≤ 100 and follow @odata.nextLink; never increment $skip.
// - Writes can return 204 / ok without persisting, so every write is read back.
// - PrimaryStatus: $filter only matches the spaced form ("In Progress"); responses
//   use either form depending on the endpoint.

export const BASE = "https://api.karbonhq.com/v3";
const API_ORIGIN = new URL(BASE).origin;
const TOKEN = process.env.KARBON_ACCESS_KEY ?? "";
const GB_KEY = process.env.KARBON_GB_KEY ?? "";

export const PAGE_SIZE = 100;
export const DEFAULT_429_DELAY_MS = 10_000;
const MAX_ATTEMPTS = 5;
const MAX_CONFLICT_RETRIES = 2;
const TENANT_TTL_MS = 10 * 60 * 1000;

export type Rec = Record<string, unknown>;

// Overridable so tests don't wait out real rate-limit delays.
export const clientConfig = {
  sleep: (ms: number) => new Promise<void>(r => setTimeout(r, ms)),
};

export class KarbonError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null = null, readonly body: unknown = null) {
    super(message);
  }
}

export type KarbonResponse = { status: number; body: unknown; headers: Headers };

// Path relative to BASE, or an absolute URL already pointing at the Karbon API
// (an @odata.nextLink or OData-EntityId). Absolute URLs elsewhere are refused so
// the credentials are never sent to another host.
function resolveUrl(pathOrUrl: string): string {
  if (!/^https?:\/\//i.test(pathOrUrl)) return `${BASE}${pathOrUrl}`;
  if (new URL(pathOrUrl).origin !== API_ORIGIN) throw new KarbonError(`Refusing to call non-Karbon URL: ${pathOrUrl}`, 0);
  return pathOrUrl;
}

export function rateLimitDelayMs(body: string, retryAfter: string | null): number {
  const m = body.match(/(\d+(?:\.\d+)?)\s*sec/i);
  if (m) return Math.round(Number(m[1]) * 1000);
  if (retryAfter !== null && retryAfter !== "") {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return secs * 1000;
  }
  return DEFAULT_429_DELAY_MS;
}

function parseBody(text: string): unknown {
  if (!text.trim()) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function errorDetails(body: unknown): { code: string | null; message: string | null } {
  const err = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  if (err && typeof err === "object") return { code: err.code != null ? String(err.code) : null, message: err.message != null ? String(err.message) : null };
  const msg = (body as { message?: unknown } | null)?.message;
  return { code: null, message: typeof msg === "string" ? msg : null };
}

export async function karbonRequest(pathOrUrl: string, opts: RequestInit = {}): Promise<KarbonResponse> {
  const url = resolveUrl(pathOrUrl);
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      ...opts,
      headers: { "Content-Type": "application/json", Accept: "application/json", AccessKey: TOKEN, Authorization: `Bearer ${GB_KEY}`, ...(opts.headers ?? {}) },
    });
    const text = await res.text();
    if (res.status === 429 && attempt < MAX_ATTEMPTS) {
      await clientConfig.sleep(rateLimitDelayMs(text, res.headers.get("retry-after")));
      continue;
    }
    if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
      await clientConfig.sleep(Math.min(500 * 2 ** (attempt - 1), 8_000));
      continue;
    }
    const body = parseBody(text);
    if (!res.ok) {
      const { code, message } = errorDetails(body);
      throw new KarbonError(`Karbon ${res.status}${code ? ` (${code})` : ""}: ${message ?? text}`, res.status, code, body);
    }
    return { status: res.status, body, headers: res.headers };
  }
}

export async function kget(pathOrUrl: string): Promise<unknown> {
  return (await karbonRequest(pathOrUrl)).body;
}

export async function ksend(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<KarbonResponse> {
  return karbonRequest(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

// OData string literal: single quotes are doubled.
export const odataString = (s: string) => `'${s.replace(/'/g, "''")}'`;

// ── Paging ───────────────────────────────────────────────────────────────────

export type Page = { value: Rec[]; nextLink: string | null; count: number | null };

// Fetch pages by following @odata.nextLink until there are none left or at least
// maxRecords rows have been read. Whole pages are kept (a partial page would make
// the returned nextLink skip rows), so the result can exceed maxRecords by up to
// one page. Pass `from` (a nextLink from an earlier call) to continue.
//
// skipFallback: for endpoints that return @odata.count but no @odata.nextLink
// (GET /v3/WorkTemplates), step $skip forward until count is reached. The links
// it builds are returned as nextLink too, so callers continue the same way.
export async function pageAll(path: string, params: Record<string, string | number | boolean | undefined> = {}, opts: { maxRecords?: number; pageSize?: number; from?: string; skipFallback?: boolean } = {}): Promise<Page> {
  const maxRecords = opts.maxRecords ?? Infinity;
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? PAGE_SIZE, PAGE_SIZE, Number.isFinite(maxRecords) ? maxRecords : PAGE_SIZE));
  let url: string | null = opts.from ?? `${path}${qs({ ...params, $top: pageSize })}`;
  const value: Rec[] = [];
  let count: number | null = null;
  while (url) {
    const body = (await kget(url) ?? {}) as Rec;
    if (count === null && typeof body["@odata.count"] === "number") count = body["@odata.count"] as number;
    // GET /v3/Payments documents its array as "values" (its example uses "value").
    const rows = (body.value ?? body.values) as Rec[] | undefined ?? [];
    value.push(...rows);
    const current: string = url;
    url = typeof body["@odata.nextLink"] === "string" ? body["@odata.nextLink"] as string : null;
    if (!url && opts.skipFallback && rows.length && typeof body["@odata.count"] === "number") {
      const next = new URL(/^https?:\/\//i.test(current) ? current : `${BASE}${current}`);
      const skip = Number(next.searchParams.get("$skip") ?? 0) + rows.length;
      if (skip < (body["@odata.count"] as number)) {
        next.searchParams.set("$skip", String(skip));
        url = next.toString();
      }
    }
    if (value.length >= maxRecords) break;
  }
  return { value, nextLink: url, count };
}

// The shape list tools return: OData-style so existing callers keep working.
export function pageResult(p: Page): Rec {
  return {
    ...(p.count !== null ? { "@odata.count": p.count } : {}),
    returned: p.value.length,
    value: p.value,
    ...(p.nextLink ? { "@odata.nextLink": p.nextLink, more: "More records exist: call again with nextLink set to @odata.nextLink." } : {}),
  };
}

// Run fn over items with at most `limit` in flight, keeping input order.
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ── PrimaryStatus ────────────────────────────────────────────────────────────

export const PRIMARY_STATUSES = ["Planned", "Ready To Start", "In Progress", "Waiting", "Completed"] as const;
export type PrimaryStatus = typeof PRIMARY_STATUSES[number];

const statusId = (s: string) => s.replace(/\s+/g, "").toLowerCase();
const SPACED = new Map(PRIMARY_STATUSES.map(s => [statusId(s), s]));

// "InProgress" / "in progress" / "In Progress" → "In Progress". Unknown values pass through.
export function toSpacedStatus<T>(s: T): T | PrimaryStatus {
  if (typeof s !== "string") return s;
  return SPACED.get(statusId(s)) ?? s;
}

// Compare PrimaryStatus values from any endpoint (list = spaced, single GET/PUT = no-space).
export function sameStatus(a: unknown, b: unknown): boolean {
  return typeof a === "string" && typeof b === "string" && statusId(a) === statusId(b);
}

// Rewrite PrimaryStatus values inside a $filter to the spaced form: the no-space
// form isn't rejected, it silently matches nothing.
export function normalizeStatusFilter(filter: string): string {
  return filter.replace(/(PrimaryStatus\s+eq\s+')((?:[^']|'')*)(')/gi, (_m, pre: string, val: string, post: string) => `${pre}${toSpacedStatus(val)}${post}`);
}

// ── Tenant settings (cached) ─────────────────────────────────────────────────

type TenantSettings = Rec & { WorkStatuses?: Rec[]; WorkTypes?: Rec[] };
let tenantCache: { at: number; value: TenantSettings } | null = null;

export async function getTenantSettings(refresh = false): Promise<TenantSettings> {
  if (!refresh && tenantCache && Date.now() - tenantCache.at < TENANT_TTL_MS) return tenantCache.value;
  const value = (await kget("/TenantSettings") ?? {}) as TenantSettings;
  tenantCache = { at: Date.now(), value };
  return value;
}

export function clearTenantCache() { tenantCache = null; }

const lc = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");

// Secondary statuses Karbon will keep for this PrimaryStatus AND this WorkType.
// TenantSettings lists secondaries under each primary (WorkStatuses[].Children) and,
// separately, the secondary status keys each WorkType allows
// (WorkTypes[].AvailableStatuses.secondary). A value has to be in both.
export function validSecondaryStatuses(ts: TenantSettings, primary: string, workType: unknown): { names: string[]; workTypeFound: boolean } {
  const primaryEntry = (ts.WorkStatuses ?? []).find(ws => sameStatus(ws.Name, primary));
  const children = ((primaryEntry?.Children as Rec[] | undefined) ?? []).filter(c => typeof c.Name === "string");
  const wt = (ts.WorkTypes ?? []).find(w => lc(w.Name) === lc(workType) && lc(workType) !== "");
  if (!wt) return { names: children.map(c => c.Name as string), workTypeFound: false };
  const avail = (wt.AvailableStatuses ?? {}) as Rec;
  const allowed = new Set(((avail.secondary ?? avail.Secondary ?? []) as unknown[]).map(v => String(v)));
  const names = children.filter(c => allowed.has(String(c.WorkStatusKey)) || allowed.has(String(c.Name))).map(c => c.Name as string);
  return { names, workTypeFound: true };
}

// ── Writes: conflict retry + read-back verification ──────────────────────────

export type WriteRequest = { method: "POST" | "PUT" | "PATCH" | "DELETE"; path: string; body?: unknown };

export type VerifiedWrite = {
  ok: boolean;
  verified: boolean;
  status: number | null;
  conflictRetries: number;
  before: Rec;
  after: Rec | null;
  failures: string[];
  error?: string;
  code?: string | null;
};

// Read current state, build the write from it, send it, then read back and check.
// On 409 (code 4020) the whole read → build → write cycle is repeated, up to
// MAX_CONFLICT_RETRIES more times. Success is reported only when `verify` finds
// no failures in the read-back, whatever the write itself returned.
export async function verifiedWrite(opts: {
  tool: string;
  reason: string;
  read: () => Promise<Rec>;
  build: (current: Rec) => WriteRequest;
  readBack?: (res: KarbonResponse, before: Rec) => Promise<Rec>;
  verify: (after: Rec, before: Rec) => string[];
}): Promise<VerifiedWrite> {
  let before: Rec = {};
  for (let attempt = 0; ; attempt++) {
    before = await opts.read();
    const req = opts.build(before);
    let res: KarbonResponse;
    try {
      res = await ksend(req.method, req.path, req.body);
    } catch (e) {
      if (e instanceof KarbonError && e.status === 409) {
        if (attempt < MAX_CONFLICT_RETRIES) continue;
        return { ok: false, verified: false, status: 409, conflictRetries: attempt, before, after: null, failures: [], code: e.code,
          error: `Karbon reported a concurrency conflict (409${e.code ? ` code ${e.code}` : ""}) on ${attempt + 1} attempts: someone else is editing this record. Nothing was changed by this call; try again shortly.` };
      }
      if (e instanceof KarbonError) {
        return { ok: false, verified: false, status: e.status, conflictRetries: attempt, before, after: null, failures: [], code: e.code, error: e.message };
      }
      throw e;
    }
    const after = opts.readBack ? await opts.readBack(res, before) : await opts.read();
    const failures = opts.verify(after, before);
    const ok = failures.length === 0;
    console.log(JSON.stringify({ audit: opts.tool, path: req.path, method: req.method, status: res.status, verified: ok, failures, reason: opts.reason, at: new Date().toISOString() }));
    return {
      ok, verified: ok, status: res.status, conflictRetries: attempt, before, after, failures,
      ...(ok ? {} : { error: `Karbon returned ${res.status} but the change did not read back: ${failures.join("; ")}` }),
    };
  }
}

// ── Comparison helpers for verify() ──────────────────────────────────────────

export const day = (v: unknown): string | null => (typeof v === "string" && v ? v.slice(0, 10) : null);

export function expectEqual(failures: string[], field: string, expected: unknown, actual: unknown, cmp: (a: unknown, b: unknown) => boolean = (a, b) => a === b) {
  if (!cmp(expected, actual)) failures.push(`${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual ?? null)}`);
}

export const eqCaseless = (a: unknown, b: unknown) => (a ?? null) === (b ?? null) || (typeof a === "string" && typeof b === "string" && a.trim().toLowerCase() === b.trim().toLowerCase());
export const eqDay = (a: unknown, b: unknown) => day(a) === day(b);
export const eqMoney = (a: unknown, b: unknown) => (a ?? null) === (b ?? null) || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 0.005);

// Fields that must not move as a side effect of a whole-resource PUT.
export function expectUnchanged(failures: string[], before: Rec, after: Rec, fields: string[]) {
  for (const f of fields) {
    if (JSON.stringify(before[f] ?? null) !== JSON.stringify(after[f] ?? null)) {
      failures.push(`${f} changed unexpectedly: was ${JSON.stringify(before[f] ?? null)}, now ${JSON.stringify(after[f] ?? null)}`);
    }
  }
}

// Body for a WorkItem PUT: the current item with OData annotations removed, the
// key in PascalCase, and PrimaryStatus in the spaced form (accepted in bodies).
// The whole item is sent back so nothing we didn't mean to touch is wiped.
export function workItemPutBody(current: Rec, workItemKey: string): Rec {
  const body: Rec = {};
  for (const [k, v] of Object.entries(current)) if (!k.startsWith("@odata")) body[k] = v;
  body.WorkItemKey = workItemKey;
  if (body.PrimaryStatus !== undefined) body.PrimaryStatus = toSpacedStatus(body.PrimaryStatus);
  return body;
}

export const WORK_ITEM_STABLE_FIELDS = ["Title", "ClientKey", "ClientType", "AssigneeEmailAddress", "StartDate", "DueDate", "DeadlineDate", "WorkType"];

export const text = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }] });
