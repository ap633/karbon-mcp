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
// Overridable so tests don't wait out real rate-limit delays.
export const clientConfig = {
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
};
export class KarbonError extends Error {
    status;
    code;
    body;
    constructor(message, status, code = null, body = null) {
        super(message);
        this.status = status;
        this.code = code;
        this.body = body;
    }
}
// Path relative to BASE, or an absolute URL already pointing at the Karbon API
// (an @odata.nextLink or OData-EntityId). Absolute URLs elsewhere are refused so
// the credentials are never sent to another host.
function resolveUrl(pathOrUrl) {
    if (!/^https?:\/\//i.test(pathOrUrl))
        return `${BASE}${pathOrUrl}`;
    if (new URL(pathOrUrl).origin !== API_ORIGIN)
        throw new KarbonError(`Refusing to call non-Karbon URL: ${pathOrUrl}`, 0);
    return pathOrUrl;
}
export function rateLimitDelayMs(body, retryAfter) {
    const m = body.match(/(\d+(?:\.\d+)?)\s*sec/i);
    if (m)
        return Math.round(Number(m[1]) * 1000);
    if (retryAfter !== null && retryAfter !== "") {
        const secs = Number(retryAfter);
        if (Number.isFinite(secs))
            return secs * 1000;
    }
    return DEFAULT_429_DELAY_MS;
}
function parseBody(text) {
    if (!text.trim())
        return null;
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}
function errorDetails(body) {
    const err = body?.error;
    if (err && typeof err === "object")
        return { code: err.code != null ? String(err.code) : null, message: err.message != null ? String(err.message) : null };
    const msg = body?.message;
    return { code: null, message: typeof msg === "string" ? msg : null };
}
export async function karbonRequest(pathOrUrl, opts = {}) {
    const url = resolveUrl(pathOrUrl);
    for (let attempt = 1;; attempt++) {
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
export async function kget(pathOrUrl) {
    return (await karbonRequest(pathOrUrl)).body;
}
export async function ksend(method, path, body) {
    return karbonRequest(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
export function qs(params) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params))
        if (v !== undefined && v !== null && v !== "")
            p.set(k, String(v));
    const s = p.toString();
    return s ? `?${s}` : "";
}
// OData string literal: single quotes are doubled.
export const odataString = (s) => `'${s.replace(/'/g, "''")}'`;
// Fetch pages by following @odata.nextLink until there are none left or at least
// maxRecords rows have been read. Whole pages are kept (a partial page would make
// the returned nextLink skip rows), so the result can exceed maxRecords by up to
// one page. Pass `from` (a nextLink from an earlier call) to continue.
export async function pageAll(path, params = {}, opts = {}) {
    const maxRecords = opts.maxRecords ?? Infinity;
    const pageSize = Math.max(1, Math.min(opts.pageSize ?? PAGE_SIZE, PAGE_SIZE, Number.isFinite(maxRecords) ? maxRecords : PAGE_SIZE));
    let url = opts.from ?? `${path}${qs({ ...params, $top: pageSize })}`;
    const value = [];
    let count = null;
    while (url) {
        const body = (await kget(url) ?? {});
        if (count === null && typeof body["@odata.count"] === "number")
            count = body["@odata.count"];
        // GET /v3/Payments documents its array as "values" (its example uses "value").
        value.push(...((body.value ?? body.values) ?? []));
        url = typeof body["@odata.nextLink"] === "string" ? body["@odata.nextLink"] : null;
        if (value.length >= maxRecords)
            break;
    }
    return { value, nextLink: url, count };
}
// The shape list tools return: OData-style so existing callers keep working.
export function pageResult(p) {
    return {
        ...(p.count !== null ? { "@odata.count": p.count } : {}),
        returned: p.value.length,
        value: p.value,
        ...(p.nextLink ? { "@odata.nextLink": p.nextLink, more: "More records exist: call again with nextLink set to @odata.nextLink." } : {}),
    };
}
// Run fn over items with at most `limit` in flight, keeping input order.
export async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
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
export const PRIMARY_STATUSES = ["Planned", "Ready To Start", "In Progress", "Waiting", "Completed"];
const statusId = (s) => s.replace(/\s+/g, "").toLowerCase();
const SPACED = new Map(PRIMARY_STATUSES.map(s => [statusId(s), s]));
// "InProgress" / "in progress" / "In Progress" → "In Progress". Unknown values pass through.
export function toSpacedStatus(s) {
    if (typeof s !== "string")
        return s;
    return SPACED.get(statusId(s)) ?? s;
}
// Compare PrimaryStatus values from any endpoint (list = spaced, single GET/PUT = no-space).
export function sameStatus(a, b) {
    return typeof a === "string" && typeof b === "string" && statusId(a) === statusId(b);
}
// Rewrite PrimaryStatus values inside a $filter to the spaced form: the no-space
// form isn't rejected, it silently matches nothing.
export function normalizeStatusFilter(filter) {
    return filter.replace(/(PrimaryStatus\s+eq\s+')((?:[^']|'')*)(')/gi, (_m, pre, val, post) => `${pre}${toSpacedStatus(val)}${post}`);
}
let tenantCache = null;
export async function getTenantSettings(refresh = false) {
    if (!refresh && tenantCache && Date.now() - tenantCache.at < TENANT_TTL_MS)
        return tenantCache.value;
    const value = (await kget("/TenantSettings") ?? {});
    tenantCache = { at: Date.now(), value };
    return value;
}
export function clearTenantCache() { tenantCache = null; }
const lc = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "");
// Secondary statuses Karbon will keep for this PrimaryStatus AND this WorkType.
// TenantSettings lists secondaries under each primary (WorkStatuses[].Children) and,
// separately, the secondary status keys each WorkType allows
// (WorkTypes[].AvailableStatuses.secondary). A value has to be in both.
export function validSecondaryStatuses(ts, primary, workType) {
    const primaryEntry = (ts.WorkStatuses ?? []).find(ws => sameStatus(ws.Name, primary));
    const children = (primaryEntry?.Children ?? []).filter(c => typeof c.Name === "string");
    const wt = (ts.WorkTypes ?? []).find(w => lc(w.Name) === lc(workType) && lc(workType) !== "");
    if (!wt)
        return { names: children.map(c => c.Name), workTypeFound: false };
    const avail = (wt.AvailableStatuses ?? {});
    const allowed = new Set((avail.secondary ?? avail.Secondary ?? []).map(v => String(v)));
    const names = children.filter(c => allowed.has(String(c.WorkStatusKey)) || allowed.has(String(c.Name))).map(c => c.Name);
    return { names, workTypeFound: true };
}
// Read current state, build the write from it, send it, then read back and check.
// On 409 (code 4020) the whole read → build → write cycle is repeated, up to
// MAX_CONFLICT_RETRIES more times. Success is reported only when `verify` finds
// no failures in the read-back, whatever the write itself returned.
export async function verifiedWrite(opts) {
    let before = {};
    for (let attempt = 0;; attempt++) {
        before = await opts.read();
        const req = opts.build(before);
        let res;
        try {
            res = await ksend(req.method, req.path, req.body);
        }
        catch (e) {
            if (e instanceof KarbonError && e.status === 409) {
                if (attempt < MAX_CONFLICT_RETRIES)
                    continue;
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
export const day = (v) => (typeof v === "string" && v ? v.slice(0, 10) : null);
export function expectEqual(failures, field, expected, actual, cmp = (a, b) => a === b) {
    if (!cmp(expected, actual))
        failures.push(`${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual ?? null)}`);
}
export const eqCaseless = (a, b) => (a ?? null) === (b ?? null) || (typeof a === "string" && typeof b === "string" && a.trim().toLowerCase() === b.trim().toLowerCase());
export const eqDay = (a, b) => day(a) === day(b);
export const eqMoney = (a, b) => (a ?? null) === (b ?? null) || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 0.005);
// Fields that must not move as a side effect of a whole-resource PUT.
export function expectUnchanged(failures, before, after, fields) {
    for (const f of fields) {
        if (JSON.stringify(before[f] ?? null) !== JSON.stringify(after[f] ?? null)) {
            failures.push(`${f} changed unexpectedly: was ${JSON.stringify(before[f] ?? null)}, now ${JSON.stringify(after[f] ?? null)}`);
        }
    }
}
// Body for a WorkItem PUT: the current item with OData annotations removed, the
// key in PascalCase, and PrimaryStatus in the spaced form (accepted in bodies).
// The whole item is sent back so nothing we didn't mean to touch is wiped.
export function workItemPutBody(current, workItemKey) {
    const body = {};
    for (const [k, v] of Object.entries(current))
        if (!k.startsWith("@odata"))
            body[k] = v;
    body.WorkItemKey = workItemKey;
    if (body.PrimaryStatus !== undefined)
        body.PrimaryStatus = toSpacedStatus(body.PrimaryStatus);
    return body;
}
export const WORK_ITEM_STABLE_FIELDS = ["Title", "ClientKey", "ClientType", "AssigneeEmailAddress", "StartDate", "DueDate", "DeadlineDate", "WorkType"];
export const text = (o) => ({ content: [{ type: "text", text: JSON.stringify(o, null, 2) }] });
