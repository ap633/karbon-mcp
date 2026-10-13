import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { kget, pageAll, verifiedWrite, workItemPutBody, toSpacedStatus, type Rec } from "./karbon.js";

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
// - GET returns no-space PrimaryStatus ("InProgress"); PUT bodies are sent the spaced form.
// - Writes can silently fail, so every write is verified by a GET read-back.
// Auth, 429/409 handling, nextLink paging and verification come from ./karbon.ts.

const MEMBERSHIP_TTL_MS = 10 * 60 * 1000;

const OPEN_STATUSES = ["Planned", "Ready To Start", "In Progress", "Waiting"] as const;

const kf = kget;
const pageAllRows = async (path: string, filter?: string): Promise<Rec[]> =>
  (await pageAll(path, filter ? { $filter: filter } : {})).value;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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

// ── Field accessors (Karbon naming varies between list and detail payloads) ──
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const workGroupKey = (w: Rec) => str(w.RelatedClientGroupKey) ?? str(w.ClientGroupKey);
const memberKey = (m: Rec) => str(m.ContactKey) ?? str(m.OrganizationKey) ?? str(m.ClientKey);
const groupName = (g: Rec) => str(g.FullName) ?? str(g.Name) ?? str(g.ClientGroupName) ?? "(unnamed group)";
const templateOf = (w: Rec) => str(w.WorkTemplateTile) ?? str(w.WorkTemplateTitle) ?? str(w.WorkTemplateKey) ?? "(no template)";

// Kept for existing imports; see toSpacedStatus in ./karbon.ts.
export const toDisplayStatus = toSpacedStatus;

// ── Membership map: clientKey → groups (cached in module scope) ──
type GroupRef = { groupKey: string; groupName: string };
type Membership = {
  byClient: Map<string, GroupRef[]>;
  groupNames: Map<string, string>;
  loadedAt: number;
  errors: { groupKey: string; error: string }[];
};

let membershipCache: Membership | null = null;

async function loadMembership(refresh = false): Promise<Membership> {
  if (!refresh && membershipCache && Date.now() - membershipCache.loadedAt < MEMBERSHIP_TTL_MS) return membershipCache;

  const groups = await pageAllRows("/clientgroups");
  const groupNames = new Map<string, string>();
  const byClient = new Map<string, GroupRef[]>();
  const errors: Membership["errors"] = [];

  await mapLimit(groups, 5, async (g) => {
    const key = str(g.ClientGroupKey) ?? str(g.Key);
    if (!key) return;
    try {
      const detail = (await kf(`/clientgroups/${encodeURIComponent(key)}`) ?? {}) as Rec;
      const name = groupName(detail) === "(unnamed group)" ? groupName(g) : groupName(detail);
      groupNames.set(key, name);
      for (const m of (detail.Members as Rec[] | undefined) ?? []) {
        const ck = memberKey(m);
        if (!ck) continue;
        const list = byClient.get(ck) ?? [];
        if (!list.some(x => x.groupKey === key)) list.push({ groupKey: key, groupName: name });
        byClient.set(ck, list);
      }
    } catch (e) {
      groupNames.set(key, groupName(g));
      errors.push({ groupKey: key, error: (e as Error).message });
    }
  });

  const result: Membership = { byClient, groupNames, loadedAt: Date.now(), errors };
  // Don't cache a partial map: missing members would misclassify work as standalone/wrongGroup.
  membershipCache = errors.length ? null : result;
  return result;
}

const isMember = (ms: Membership, clientKey: string | null, groupKey: string) =>
  !!clientKey && (ms.byClient.get(clientKey) ?? []).some(g => g.groupKey === groupKey);

// ── Audit ──
type AuditItem = {
  workKey: string | null; title: string | null; client: string | null; clientKey: string | null;
  clientType: string | null; status: string | null; assignee: string | null; template: string; startDate: string | null;
};

const toItem = (w: Rec): AuditItem => ({
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

const isCompleted = (status: string | null) => (status ?? "").replace(/\s+/g, "") === "Completed";

export function registerGroupAuditTools(server: McpServer) {
  server.tool("audit_work_client_groups", "READ-ONLY. Find work items whose client group is missing or wrong. Loads every client group's members, scans work by status (default: the four open statuses), and returns only exceptions: missingGroup (client is in exactly one group; grouped by group), missingByTemplate (which creation path leaks), ambiguous (client in 2+ groups), wrongGroup (work's group doesn't contain the client) and optionally standalone clients. Fix with set_work_client_group.", {
    statuses: z.array(z.enum(OPEN_STATUSES)).optional().describe("Open statuses to scan (display values). Default: all four open statuses."),
    completedSince: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD. Also scan Completed work with CompletedDate on/after this date."),
    assigneeEmail: z.string().optional().describe("Only include work assigned to this email (case-insensitive)."),
    includeStandalone: z.boolean().optional().default(false).describe("Also list clients with ungrouped work who belong to no group."),
    refreshMembership: z.boolean().optional().default(false).describe("Force a reload of group membership (otherwise cached for 10 minutes)."),
  }, async ({ statuses, completedSince, assigneeEmail, includeStandalone, refreshMembership }) => {
    const ms = await loadMembership(refreshMembership);

    const filters: { label: string; filter: string }[] = (statuses?.length ? statuses : [...OPEN_STATUSES])
      .map(s => ({ label: s, filter: `PrimaryStatus eq '${s}'` }));
    if (completedSince) filters.push({ label: `Completed since ${completedSince}`, filter: `PrimaryStatus eq 'Completed' and CompletedDate ge ${completedSince}T00:00:00Z` });

    const pages = await mapLimit(filters, 2, f => pageAllRows("/workitems", f.filter));
    const seen = new Set<string>();
    const work: Rec[] = [];
    const scannedByStatus: Record<string, number> = {};
    pages.forEach((rows, i) => {
      scannedByStatus[filters[i].label] = rows.length;
      for (const w of rows) {
        const k = str(w.WorkItemKey) ?? str(w.WorkKey);
        if (k && seen.has(k)) continue;
        if (k) seen.add(k);
        work.push(w);
      }
    });

    const email = assigneeEmail?.trim().toLowerCase();
    const missing = new Map<string, { groupKey: string; groupName: string; items: AuditItem[] }>();
    const byTemplate = new Map<string, number>();
    const ambiguous: (AuditItem & { candidateGroups: GroupRef[] })[] = [];
    const wrongGroup: (AuditItem & { workGroupKey: string; workGroupName: string | null; clientGroups: GroupRef[] })[] = [];
    const standalone = new Map<string, { clientKey: string; client: string | null; clientType: string | null; openItems: number; itemsScanned: number }>();
    let skippedGroupClient = 0, filteredOut = 0, ok = 0;

    for (const w of work) {
      if (email && (str(w.AssigneeEmailAddress) ?? "").toLowerCase() !== email) { filteredOut++; continue; }
      if (str(w.ClientType) === "ClientGroup") { skippedGroupClient++; continue; }

      const item = toItem(w);
      const clientGroups = item.clientKey ? ms.byClient.get(item.clientKey) ?? [] : [];
      const gk = workGroupKey(w);

      if (gk) {
        if (isMember(ms, item.clientKey, gk)) ok++;
        else wrongGroup.push({ ...item, workGroupKey: gk, workGroupName: ms.groupNames.get(gk) ?? null, clientGroups });
      } else if (clientGroups.length === 1) {
        const g = clientGroups[0];
        const bucket = missing.get(g.groupKey) ?? { ...g, items: [] };
        bucket.items.push(item);
        missing.set(g.groupKey, bucket);
        byTemplate.set(item.template, (byTemplate.get(item.template) ?? 0) + 1);
      } else if (clientGroups.length > 1) {
        ambiguous.push({ ...item, candidateGroups: clientGroups });
      } else {
        ok++;
        if (includeStandalone && item.clientKey) {
          const s = standalone.get(item.clientKey) ?? { clientKey: item.clientKey, client: item.client, clientType: item.clientType, openItems: 0, itemsScanned: 0 };
          s.itemsScanned++;
          if (!isCompleted(item.status)) s.openItems++;
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

    const result: Rec = {
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
    if (includeStandalone) result.standalone = [...standalone.values()].sort((a, b) => b.openItems - a.openItems);

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
        const current = (await kf(`/workitems/${encodeURIComponent(workKey)}`) ?? {}) as Rec;
        const before = workGroupKey(current);
        const info = { ...base, title: str(current.Title), client: str(current.ClientName), clientKey: str(current.ClientKey), before };

        if (before === clientGroupKey) return { ...info, status: "already_set" };
        if (str(current.ClientType) === "ClientGroup") return { ...info, status: "refused", note: "Work's client is itself a client group." };
        if (!ms.groupNames.has(clientGroupKey)) return { ...info, status: "refused", note: "Unknown client group key." };
        if (!isMember(ms, info.clientKey, clientGroupKey)) return { ...info, status: "refused", note: "Client is not a member of the target group." };
        if (dryRun) return { ...info, status: "would_update" };

        const path = `/workitems/${encodeURIComponent(workKey)}`;
        const w = await verifiedWrite({
          tool: "set_work_client_group", reason,
          read: async () => (await kf(path) ?? {}) as Rec,
          build: (cur) => ({ method: "PUT", path, body: { ...workItemPutBody(cur, workKey), RelatedClientGroupKey: clientGroupKey, ClientGroupKey: clientGroupKey } }),
          verify: (afterRec) => (workGroupKey(afterRec) === clientGroupKey ? [] : [`client group is ${workGroupKey(afterRec) ?? "empty"}`]),
        });
        const after = w.after ? workGroupKey(w.after) : null;
        if (w.ok) return { ...info, after, status: "verified" };
        if (w.after) return { ...info, after, status: "not_persisted", note: "Karbon accepted the PUT but the group did not change. Use Change Client in the Karbon UI for this item." };
        return { ...info, status: "error", error: w.error };
      } catch (e) {
        return { ...base, status: "error", error: (e as Error).message };
      }
    });

    const tally: Record<string, number> = {};
    for (const r of results) tally[r.status] = (tally[r.status] ?? 0) + 1;
    return { content: [{ type: "text", text: JSON.stringify({ dryRun, reason, tally, results }) }] };
  });
}
