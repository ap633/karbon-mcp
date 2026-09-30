import { z } from "zod";
// Client-group audit tooling.
//
// A work item's client group (RelatedClientGroupKey / ClientGroupKey) is set once
// at creation, so work created for a group member often has no group and is
// missing from group views. These tools find and (carefully) fix those items.
//
// Karbon API constraints this module works around:
// - /workitems rejects $filter on RelatedClientGroupKey (4002), so we filter client-side.
// - `ne` is not allowed in $filter; statuses are queried one at a time with display values.
// - Group membership is only on GET /clientgroups/{key} (Members[]), not on the list.
// - GET returns camelCase PrimaryStatus ("InProgress") but PUT only accepts display format.
// - Some writes return 204 with an empty body.
// - Writes can silently fail, so every write is verified by a GET read-back.
const BASE = "https://api.karbonhq.com/v3";
const TOKEN = process.env.KARBON_ACCESS_KEY ?? "";
const GB_KEY = process.env.KARBON_GB_KEY ?? "";
const PAGE_SIZE = 100;
const MAX_ATTEMPTS = 5;
const MEMBERSHIP_TTL_MS = 10 * 60 * 1000;
const OPEN_STATUSES = ["Planned", "Ready To Start", "In Progress", "Waiting"];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// ── Fetch helper: retries 429/5xx with backoff (honours Retry-After), tolerates empty bodies ──
async function kf(path, opts = {}) {
    for (let attempt = 1;; attempt++) {
        const res = await fetch(`${BASE}${path}`, {
            ...opts,
            headers: { "Content-Type": "application/json", Accept: "application/json", AccessKey: TOKEN, Authorization: `Bearer ${GB_KEY}`, ...(opts.headers ?? {}) },
        });
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < MAX_ATTEMPTS) {
            await sleep(retryDelayMs(res.headers.get("retry-after"), attempt));
            continue;
        }
        const text = await res.text();
        if (!res.ok)
            throw new Error(`Karbon ${res.status}: ${text}`);
        if (!text.trim())
            return null;
        try {
            return JSON.parse(text);
        }
        catch {
            return text;
        }
    }
}
function retryDelayMs(retryAfter, attempt) {
    if (retryAfter) {
        const secs = Number(retryAfter);
        if (Number.isFinite(secs))
            return Math.min(secs * 1000, 60_000);
        const at = Date.parse(retryAfter);
        if (!Number.isNaN(at))
            return Math.min(Math.max(at - Date.now(), 0), 60_000);
    }
    return Math.min(500 * 2 ** (attempt - 1), 8_000) + Math.floor(Math.random() * 250);
}
async function pageAll(path, filter) {
    const out = [];
    for (let skip = 0;; skip += PAGE_SIZE) {
        const f = filter ? `&$filter=${encodeURIComponent(filter)}` : "";
        const page = await kf(`${path}?$top=${PAGE_SIZE}&$skip=${skip}${f}`);
        const rows = page?.value ?? [];
        out.push(...rows);
        if (rows.length < PAGE_SIZE)
            return out;
    }
}
async function mapLimit(items, limit, fn) {
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
// ── Field accessors (Karbon naming varies between list and detail payloads) ──
const str = (v) => (typeof v === "string" && v.trim() ? v : null);
const workGroupKey = (w) => str(w.RelatedClientGroupKey) ?? str(w.ClientGroupKey);
const memberKey = (m) => str(m.ContactKey) ?? str(m.OrganizationKey) ?? str(m.ClientKey);
const groupName = (g) => str(g.FullName) ?? str(g.Name) ?? str(g.ClientGroupName) ?? "(unnamed group)";
const templateOf = (w) => str(w.WorkTemplateTile) ?? str(w.WorkTemplateTitle) ?? str(w.WorkTemplateKey) ?? "(no template)";
const STATUS_DISPLAY = {
    Planned: "Planned", ReadyToStart: "Ready To Start", InProgress: "In Progress", Waiting: "Waiting", Completed: "Completed",
};
// GET returns "InProgress"; PUT only accepts "In Progress".
export function toDisplayStatus(s) {
    if (typeof s !== "string")
        return s;
    return STATUS_DISPLAY[s] ?? STATUS_DISPLAY[s.replace(/\s+/g, "")] ?? s;
}
let membershipCache = null;
async function loadMembership(refresh = false) {
    if (!refresh && membershipCache && Date.now() - membershipCache.loadedAt < MEMBERSHIP_TTL_MS)
        return membershipCache;
    const groups = await pageAll("/clientgroups");
    const groupNames = new Map();
    const byClient = new Map();
    const errors = [];
    await mapLimit(groups, 5, async (g) => {
        const key = str(g.ClientGroupKey) ?? str(g.Key);
        if (!key)
            return;
        try {
            const detail = (await kf(`/clientgroups/${encodeURIComponent(key)}`) ?? {});
            const name = groupName(detail) === "(unnamed group)" ? groupName(g) : groupName(detail);
            groupNames.set(key, name);
            for (const m of detail.Members ?? []) {
                const ck = memberKey(m);
                if (!ck)
                    continue;
                const list = byClient.get(ck) ?? [];
                if (!list.some(x => x.groupKey === key))
                    list.push({ groupKey: key, groupName: name });
                byClient.set(ck, list);
            }
        }
        catch (e) {
            groupNames.set(key, groupName(g));
            errors.push({ groupKey: key, error: e.message });
        }
    });
    const result = { byClient, groupNames, loadedAt: Date.now(), errors };
    // Don't cache a partial map: missing members would misclassify work as standalone/wrongGroup.
    membershipCache = errors.length ? null : result;
    return result;
}
const isMember = (ms, clientKey, groupKey) => !!clientKey && (ms.byClient.get(clientKey) ?? []).some(g => g.groupKey === groupKey);
const toItem = (w) => ({
    workKey: str(w.WorkItemKey) ?? str(w.WorkKey),
    title: str(w.Title),
    client: str(w.ClientName),
    clientKey: str(w.ClientKey),
    clientType: str(w.ClientType),
    status: str(w.PrimaryStatus),
    assignee: str(w.AssigneeEmailAddress) ?? str(w.AssigneeName),
    template: templateOf(w),
    startDate: str(w.StartDate),
});
const isCompleted = (status) => (status ?? "").replace(/\s+/g, "") === "Completed";
export function registerGroupAuditTools(server) {
    server.tool("audit_work_client_groups", "READ-ONLY. Find work items whose client group is missing or wrong. Loads every client group's members, scans work by status (default: the four open statuses), and returns only exceptions: missingGroup (client is in exactly one group; grouped by group), missingByTemplate (which creation path leaks), ambiguous (client in 2+ groups), wrongGroup (work's group doesn't contain the client) and optionally standalone clients. Fix with set_work_client_group.", {
        statuses: z.array(z.enum(OPEN_STATUSES)).optional().describe("Open statuses to scan (display values). Default: all four open statuses."),
        completedSince: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD. Also scan Completed work with CompletedDate on/after this date."),
        assigneeEmail: z.string().optional().describe("Only include work assigned to this email (case-insensitive)."),
        includeStandalone: z.boolean().optional().default(false).describe("Also list clients with ungrouped work who belong to no group."),
        refreshMembership: z.boolean().optional().default(false).describe("Force a reload of group membership (otherwise cached for 10 minutes)."),
    }, async ({ statuses, completedSince, assigneeEmail, includeStandalone, refreshMembership }) => {
        const ms = await loadMembership(refreshMembership);
        const filters = (statuses?.length ? statuses : [...OPEN_STATUSES])
            .map(s => ({ label: s, filter: `PrimaryStatus eq '${s}'` }));
        if (completedSince)
            filters.push({ label: `Completed since ${completedSince}`, filter: `PrimaryStatus eq 'Completed' and CompletedDate ge ${completedSince}T00:00:00Z` });
        const pages = await mapLimit(filters, 2, f => pageAll("/workitems", f.filter));
        const seen = new Set();
        const work = [];
        const scannedByStatus = {};
        pages.forEach((rows, i) => {
            scannedByStatus[filters[i].label] = rows.length;
            for (const w of rows) {
                const k = str(w.WorkItemKey) ?? str(w.WorkKey);
                if (k && seen.has(k))
                    continue;
                if (k)
                    seen.add(k);
                work.push(w);
            }
        });
        const email = assigneeEmail?.trim().toLowerCase();
        const missing = new Map();
        const byTemplate = new Map();
        const ambiguous = [];
        const wrongGroup = [];
        const standalone = new Map();
        let skippedGroupClient = 0, filteredOut = 0, ok = 0;
        for (const w of work) {
            if (email && (str(w.AssigneeEmailAddress) ?? "").toLowerCase() !== email) {
                filteredOut++;
                continue;
            }
            if (str(w.ClientType) === "ClientGroup") {
                skippedGroupClient++;
                continue;
            }
            const item = toItem(w);
            const clientGroups = item.clientKey ? ms.byClient.get(item.clientKey) ?? [] : [];
            const gk = workGroupKey(w);
            if (gk) {
                if (isMember(ms, item.clientKey, gk))
                    ok++;
                else
                    wrongGroup.push({ ...item, workGroupKey: gk, workGroupName: ms.groupNames.get(gk) ?? null, clientGroups });
            }
            else if (clientGroups.length === 1) {
                const g = clientGroups[0];
                const bucket = missing.get(g.groupKey) ?? { ...g, items: [] };
                bucket.items.push(item);
                missing.set(g.groupKey, bucket);
                byTemplate.set(item.template, (byTemplate.get(item.template) ?? 0) + 1);
            }
            else if (clientGroups.length > 1) {
                ambiguous.push({ ...item, candidateGroups: clientGroups });
            }
            else {
                ok++;
                if (includeStandalone && item.clientKey) {
                    const s = standalone.get(item.clientKey) ?? { clientKey: item.clientKey, client: item.client, clientType: item.clientType, openItems: 0, itemsScanned: 0 };
                    s.itemsScanned++;
                    if (!isCompleted(item.status))
                        s.openItems++;
                    standalone.set(item.clientKey, s);
                }
            }
        }
        const missingGroup = [...missing.values()]
            .map(b => ({ groupKey: b.groupKey, groupName: b.groupName, count: b.items.length, items: b.items }))
            .sort((a, b) => b.count - a.count);
        const missingByTemplate = [...byTemplate.entries()]
            .map(([template, count]) => ({ template, count }))
            .sort((a, b) => b.count - a.count);
        const missingCount = missingGroup.reduce((n, g) => n + g.count, 0);
        const result = {
            summary: {
                scanned: work.length,
                scannedByStatus,
                ...(email ? { assigneeEmail: email, filteredOutByAssignee: filteredOut } : {}),
                skippedClientGroupWork: skippedGroupClient,
                ok,
                missingGroup: missingCount,
                missingGroupGroups: missingGroup.length,
                ambiguous: ambiguous.length,
                wrongGroup: wrongGroup.length,
                ...(includeStandalone ? { standaloneClients: standalone.size } : {}),
                clientGroups: ms.groupNames.size,
                groupedClients: ms.byClient.size,
                membershipLoadedAt: new Date(ms.loadedAt).toISOString(),
                ...(ms.errors.length ? { membershipErrors: ms.errors, warning: "Some group details failed to load; results may misclassify members of those groups. Re-run with refreshMembership." } : {}),
            },
            missingGroup,
            missingByTemplate,
            ambiguous,
            wrongGroup,
        };
        if (includeStandalone)
            result.standalone = [...standalone.values()].sort((a, b) => b.openItems - a.openItems);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
    });
    server.tool("set_work_client_group", "WRITE (guarded). Set the client group on existing work items. Defaults to dryRun=true. Refuses unless the work's client is a member of the target group. Full-PUTs the item with RelatedClientGroupKey/ClientGroupKey set, then re-reads to verify. Per-item status: already_set | refused | would_update | verified | not_persisted | error. Requires a `reason`.", {
        items: z.array(z.object({ workKey: z.string(), clientGroupKey: z.string() })).min(1).max(50),
        reason: z.string().describe("Why this change is being made — required for auditability"),
        dryRun: z.boolean().optional().default(true).describe("Default true: report what would change without writing."),
    }, async ({ items, reason, dryRun }) => {
        if (!reason?.trim()) {
            return { content: [{ type: "text", text: JSON.stringify({ error: "`reason` is required and must be non-empty." }) }] };
        }
        const ms = await loadMembership();
        const results = await mapLimit(items, 3, async ({ workKey, clientGroupKey }) => {
            const base = { workKey, clientGroupKey, groupName: ms.groupNames.get(clientGroupKey) ?? null };
            try {
                const current = (await kf(`/workitems/${encodeURIComponent(workKey)}`) ?? {});
                const before = workGroupKey(current);
                const info = { ...base, title: str(current.Title), client: str(current.ClientName), clientKey: str(current.ClientKey), before };
                if (before === clientGroupKey)
                    return { ...info, status: "already_set" };
                if (str(current.ClientType) === "ClientGroup")
                    return { ...info, status: "refused", note: "Work's client is itself a client group." };
                if (!ms.groupNames.has(clientGroupKey))
                    return { ...info, status: "refused", note: "Unknown client group key." };
                if (!isMember(ms, info.clientKey, clientGroupKey))
                    return { ...info, status: "refused", note: "Client is not a member of the target group." };
                if (dryRun)
                    return { ...info, status: "would_update" };
                const payload = {};
                for (const [k, v] of Object.entries(current))
                    if (!k.startsWith("@odata"))
                        payload[k] = v;
                payload.WorkItemKey = workKey;
                payload.PrimaryStatus = toDisplayStatus(current.PrimaryStatus);
                payload.RelatedClientGroupKey = clientGroupKey;
                payload.ClientGroupKey = clientGroupKey;
                await kf(`/workitems/${encodeURIComponent(workKey)}`, { method: "PUT", body: JSON.stringify(payload) });
                const after = workGroupKey((await kf(`/workitems/${encodeURIComponent(workKey)}`) ?? {}));
                console.log(JSON.stringify({ audit: "set_work_client_group", workKey, before, after, target: clientGroupKey, reason, at: new Date().toISOString() }));
                if (after === clientGroupKey)
                    return { ...info, after, status: "verified" };
                return { ...info, after, status: "not_persisted", note: "Karbon accepted the PUT but the group did not change. Use Change Client in the Karbon UI for this item." };
            }
            catch (e) {
                return { ...base, status: "error", error: e.message };
            }
        });
        const tally = {};
        for (const r of results)
            tally[r.status] = (tally[r.status] ?? 0) + 1;
        return { content: [{ type: "text", text: JSON.stringify({ dryRun, reason, tally, results }) }] };
    });
}
