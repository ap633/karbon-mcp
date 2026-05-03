import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import http from "http";
import { randomUUID } from "crypto";

const BASE = "https://api.karbonhq.com/v3";
const TOKEN = process.env.KARBON_ACCESS_KEY ?? "";
const GB_KEY = process.env.KARBON_GB_KEY ?? "";
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

async function kFetch(path: string, opts: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", AccessKey: TOKEN, Authorization: `Bearer ${GB_KEY}`, ...(opts.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Karbon ${res.status}: ${await res.text()}`);
  return res.json();
}

function qs(params: Record<string, string | number | undefined>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) p.set(k, String(v));
  return p.toString() ? `?${p}` : "";
}

function createServer() {
  const s = new McpServer({ name: "karbon-mcp", version: "2.0.0" });

  // ── CONTACTS ──────────────────────────────────────────────────────────────
  s.tool("list_contacts", "List contacts/clients from Karbon", {
    filter: z.string().optional().describe("OData filter e.g. \"ContactType eq 'Client'\""),
    top: z.number().optional().default(20), skip: z.number().optional().default(0),
  }, async ({ filter, top, skip }) => {
    const q = qs({ $top: top, $skip: skip, ...(filter ? { $filter: filter } : {}) });
    return { content: [{ type: "text", text: JSON.stringify(await kFetch(`/contacts${q}`), null, 2) }] };
  });

  s.tool("get_contact", "Get a single contact by key", { contactKey: z.string() }, async ({ contactKey }) =>
    ({ content: [{ type: "text", text: JSON.stringify(await kFetch(`/contacts/${contactKey}`), null, 2) }] }));

  s.tool("create_contact", "Create a new contact", {
    firstName: z.string(), lastName: z.string(),
    email: z.string().optional(), contactType: z.string().optional().default("Client"),
    clientOwner: z.string().optional(), clientManager: z.string().optional(),
  }, async (body) => ({ content: [{ type: "text", text: JSON.stringify(await kFetch("/contacts", { method: "POST", body: JSON.stringify({ FirstName: body.firstName, LastName: body.lastName, ContactType: body.contactType, ClientOwner: body.clientOwner, ClientManager: body.clientManager }) }), null, 2) }] }));

  s.tool("update_contact", "Update an existing contact", {
    contactKey: z.string(), firstName: z.string().optional(), lastName: z.string().optional(),
    salutation: z.string().optional(), preferredName: z.string().optional(),
  }, async ({ contactKey, ...f }) => ({ content: [{ type: "text", text: JSON.stringify(await kFetch(`/contacts/${contactKey}`, { method: "PATCH", body: JSON.stringify(f) }), null, 2) }] }));

  // ── ORGANIZATIONS ─────────────────────────────────────────────────────────
  s.tool("list_organizations", "List organizations from Karbon", {
    filter: z.string().optional(), top: z.number().optional().default(20), skip: z.number().optional().default(0),
  }, async ({ filter, top, skip }) => {
    const q = qs({ $top: top, $skip: skip, ...(filter ? { $filter: filter } : {}) });
    return { content: [{ type: "text", text: JSON.stringify(await kFetch(`/organizations${q}`), null, 2) }] };
  });

  s.tool("get_organization", "Get a single organization by key", { organizationKey: z.string() }, async ({ organizationKey }) =>
    ({ content: [{ type: "text", text: JSON.stringify(await kFetch(`/organizations/${organizationKey}`), null, 2) }] }));

  s.tool("create_organization", "Create a new organization", {
    fullName: z.string(), contactType: z.string().optional().default("Client"),
    clientOwner: z.string().optional(), clientManager: z.string().optional(),
  }, async (body) => ({ content: [{ type: "text", text: JSON.stringify(await kFetch("/organizations", { method: "POST", body: JSON.stringify({ FullName: body.fullName, ContactType: body.contactType, ClientOwner: body.clientOwner, ClientManager: body.clientManager }) }), null, 2) }] }));

  // ── CLIENT GROUPS ─────────────────────────────────────────────────────────
  s.tool("list_client_groups", "List client groups from Karbon", {
    filter: z.string().optional(), top: z.number().optional().default(20), skip: z.number().optional().default(0),
  }, async ({ filter, top, skip }) => {
    const q = qs({ $top: top, $skip: skip, ...(filter ? { $filter: filter } : {}) });
    return { content: [{ type: "text", text: JSON.stringify(await kFetch(`/clientgroups${q}`), null, 2) }] };
  });

  s.tool("get_client_group", "Get a single client group by key", { clientGroupKey: z.string() }, async ({ clientGroupKey }) =>
    ({ content: [{ type: "text", text: JSON.stringify(await kFetch(`/clientgroups/${clientGroupKey}`), null, 2) }] }));

  // ── WORK ITEMS ────────────────────────────────────────────────────────────
  s.tool("list_work", "List work items from Karbon", {
    filter: z.string().optional().describe("e.g. \"WorkStatus eq 'InProgress'\" or \"PrimaryStatus eq 'Planned'\""),
    top: z.number().optional().default(20), skip: z.number().optional().default(0),
  }, async ({ filter, top, skip }) => {
    const q = qs({ $top: top, $skip: skip, ...(filter ? { $filter: filter } : {}) });
    return { content: [{ type: "text", text: JSON.stringify(await kFetch(`/workitems${q}`), null, 2) }] };
  });

  s.tool("get_work", "Get a single work item by key", { workKey: z.string() }, async ({ workKey }) =>
    ({ content: [{ type: "text", text: JSON.stringify(await kFetch(`/workitems/${workKey}`), null, 2) }] }));

  s.tool("create_work", "Create a new work item", {
    title: z.string(), clientKey: z.string(), clientType: z.enum(["Contact", "Organization", "ClientGroup"]),
    assigneeEmail: z.string().optional(), workType: z.string().optional(),
    startDate: z.string().optional(), dueDate: z.string().optional(),
    workTemplateKey: z.string().optional(),
  }, async (b) => ({ content: [{ type: "text", text: JSON.stringify(await kFetch("/workitems", { method: "POST", body: JSON.stringify({ Title: b.title, ClientKey: b.clientKey, ClientType: b.clientType, AssigneeEmailAddress: b.assigneeEmail, WorkType: b.workType, StartDate: b.startDate, DueDate: b.dueDate, WorkTemplateKey: b.workTemplateKey }) }), null, 2) }] }));

  s.tool("update_work_status", "Update the primary status of a work item", {
    workKey: z.string(), primaryStatus: z.enum(["Planned", "ReadyToStart", "InProgress", "Waiting", "Completed"]),
  }, async ({ workKey, primaryStatus }) => ({ content: [{ type: "text", text: JSON.stringify(await kFetch(`/workitems/${workKey}`, { method: "PUT", body: JSON.stringify({ PrimaryStatus: primaryStatus }) }), null, 2) }] }));

  s.tool("update_work_deadline", "Update the deadline date of a work item", {
    workKey: z.string(), deadlineDate: z.string().describe("ISO 8601 date e.g. 2026-06-30"),
  }, async ({ workKey, deadlineDate }) => ({ content: [{ type: "text", text: JSON.stringify(await kFetch(`/workitems/${workKey}`, { method: "PATCH", body: JSON.stringify({ DeadlineDate: deadlineDate }) }), null, 2) }] }));

  s.tool("list_work_tasks", "List tasks within a work item", { workKey: z.string() }, async ({ workKey }) =>
    ({ content: [{ type: "text", text: JSON.stringify(await kFetch(`/workitems/${workKey}/tasks`), null, 2) }] }));

  s.tool("update_task", "Update a task within a work item", {
    workKey: z.string(), taskKey: z.string(),
    isCompleted: z.boolean().optional(), assigneeKey: z.string().optional(), dueDate: z.string().optional(),
  }, async ({ workKey, taskKey, ...f }) => ({ content: [{ type: "text", text: JSON.stringify(await kFetch(`/workitems/${workKey}/tasks/${taskKey}`, { method: "PATCH", body: JSON.stringify(f) }), null, 2) }] }));

  // ── WORK TEMPLATES ────────────────────────────────────────────────────────
  s.tool("list_work_templates", "List available work templates", { top: z.number().optional().default(20) }, async ({ top }) =>
    ({ content: [{ type: "text", text: JSON.stringify(await kFetch(`/worktemplates?$top=${top}`), null, 2) }] }));

  // ── TIMESHEETS & TIME ENTRIES ─────────────────────────────────────────────
  s.tool("list_timesheets", "List timesheets — optionally filter by date range, user or work item", {
    filter: z.string().optional().describe("OData filter e.g. \"StartDate ge 2026-01-01T00:00:00Z\" or \"UserKey eq 'abc'\""),
    includeTimeEntries: z.boolean().optional().default(false).describe("Set true to include individual time entries"),
    top: z.number().optional().default(20), skip: z.number().optional().default(0),
  }, async ({ filter, includeTimeEntries, top, skip }) => {
    const params: Record<string, string | number> = { $top: top, $skip: skip };
    if (filter) params.$filter = filter;
    if (includeTimeEntries) params.$expand = "TimeEntries";
    return { content: [{ type: "text", text: JSON.stringify(await kFetch(`/timesheets${qs(params)}`), null, 2) }] };
  });

  s.tool("get_timesheet", "Get a single timesheet with its time entries", {
    timesheetKey: z.string(), includeTimeEntries: z.boolean().optional().default(true),
  }, async ({ timesheetKey, includeTimeEntries }) => {
    const q = includeTimeEntries ? "?$expand=TimeEntries" : "";
    return { content: [{ type: "text", text: JSON.stringify(await kFetch(`/timesheets/${timesheetKey}${q}`), null, 2) }] };
  });

  // ── NOTES ─────────────────────────────────────────────────────────────────
  s.tool("get_note", "Get a single note by its ID", { noteId: z.string() }, async ({ noteId }) =>
    ({ content: [{ type: "text", text: JSON.stringify(await kFetch(`/notes/${noteId}`), null, 2) }] }));

  s.tool("create_note", "Create a note and link it to a work item, contact, or organization", {
    subject: z.string(), body: z.string(),
    authorEmail: z.string().describe("Email of the Karbon user creating the note"),
    assigneeEmail: z.string().optional(),
    entityType: z.enum(["WorkItem", "Contact", "Organization", "ClientGroup"]).optional(),
    entityKey: z.string().optional(),
    dueDate: z.string().optional(),
  }, async (b) => {
    const timelines = b.entityType && b.entityKey ? [{ EntityType: b.entityType, EntityKey: b.entityKey }] : [];
    return { content: [{ type: "text", text: JSON.stringify(await kFetch("/notes", { method: "POST", body: JSON.stringify({ Subject: b.subject, Body: b.body, AuthorEmailAddress: b.authorEmail, AssigneeEmailAddress: b.assigneeEmail, DueDate: b.dueDate, Timelines: timelines }) }), null, 2) }] };
  });

  // ── INVOICES ──────────────────────────────────────────────────────────────
  s.tool("list_invoices", "List invoices from Karbon", {
    top: z.number().optional().default(20), skip: z.number().optional().default(0),
    orderBy: z.string().optional().describe("e.g. 'InvoiceDate desc'"),
  }, async ({ top, skip, orderBy }) => {
    const params: Record<string, string | number> = { $top: top, $skip: skip };
    if (orderBy) params.$orderby = orderBy;
    return { content: [{ type: "text", text: JSON.stringify(await kFetch(`/invoices${qs(params)}`), null, 2) }] };
  });

  s.tool("get_invoice", "Get a single invoice with line items and payments", { invoiceKey: z.string() }, async ({ invoiceKey }) =>
    ({ content: [{ type: "text", text: JSON.stringify(await kFetch(`/invoices/${invoiceKey}?$expand=LineItems,Payments`), null, 2) }] }));

  // ── ESTIMATE SUMMARIES ────────────────────────────────────────────────────
  s.tool("get_estimate_summary", "Get budget vs actual time estimates for a work item", { workItemKey: z.string() }, async ({ workItemKey }) =>
    ({ content: [{ type: "text", text: JSON.stringify(await kFetch(`/estimatesummaries/${workItemKey}`), null, 2) }] }));

  // ── TENANT SETTINGS ───────────────────────────────────────────────────────
  s.tool("get_tenant_settings", "Get your Karbon account settings — work types, work statuses, contact types", {}, async () =>
    ({ content: [{ type: "text", text: JSON.stringify(await kFetch("/tenantsettings"), null, 2) }] }));

  // ── USERS ─────────────────────────────────────────────────────────────────
  s.tool("list_users", "List users in your Karbon account", {
    filter: z.string().optional().describe("e.g. \"Name eq 'Jane Smith'\""),
    top: z.number().optional().default(50),
  }, async ({ filter, top }) => {
    const q = qs({ $top: top, ...(filter ? { $filter: filter } : {}) });
    return { content: [{ type: "text", text: JSON.stringify(await kFetch(`/users${q}`), null, 2) }] };
  });

  s.tool("get_user", "Get details for a single user", { userId: z.string() }, async ({ userId }) =>
    ({ content: [{ type: "text", text: JSON.stringify(await kFetch(`/users/${userId}`), null, 2) }] }));

  s.tool("list_team_members", "List team members (simplified user list)", { top: z.number().optional().default(50) }, async ({ top }) =>
    ({ content: [{ type: "text", text: JSON.stringify(await kFetch(`/users?$top=${top}`), null, 2) }] }));

  // ── DASHBOARD & SEARCH ────────────────────────────────────────────────────
  s.tool("get_work_summary", "Get a dashboard summary of work across all statuses", {}, async () => {
    const statuses = ["Planned", "ReadyToStart", "InProgress", "Waiting", "Completed"];
    const results: Record<string, unknown> = {};
    await Promise.all(statuses.map(async (st) => {
      results[st] = await kFetch(`/workitems?$filter=PrimaryStatus eq '${st}'&$top=100&$select=Title,WorkType,PrimaryStatus,DueDate,AssigneeEmailAddress,ClientName`);
    }));
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  });

  s.tool("search_karbon", "Search contacts, organizations and work items by keyword", { query: z.string() }, async ({ query }) => {
    const enc = encodeURIComponent(query);
    const [contacts, orgs, work] = await Promise.all([
      kFetch(`/contacts?$filter=contains(FullName,'${enc}')&$top=10`),
      kFetch(`/organizations?$filter=contains(FullName,'${enc}')&$top=10`),
      kFetch(`/workitems?$filter=contains(Title,'${enc}')&$top=10`),
    ]);
    return { content: [{ type: "text", text: JSON.stringify({ contacts, organizations: orgs, work }, null, 2) }] };
  });

  // ── ESTIMATE SUMMARY: PREVIEW-ONLY ──────────────────────────────────────
  // Karbon's documented v3 API does not expose a write endpoint for
  // EstimateSummaries — they can only be edited in the Karbon UI.
  // This tool fetches the current rows, matches by Role/TaskType, and shows
  // before/after EstimateMinutes so you can see exactly what to change manually.
  s.tool("preview_karbon_estimate_summary_update", "Preview proposed EstimateMinutes changes on a Karbon Work Item's Estimate Summary, matching by RoleKey/TaskTypeKey (preferred) or RoleName/TaskTypeName. NO WRITES — Karbon's documented API does not allow updating EstimateSummary rows; this is a read-only diff to support manual edits in the Karbon UI.", {
    workItemKey: z.string(),
    estimates: z.array(z.object({
      roleName: z.string().optional(),
      roleKey: z.string().optional(),
      taskTypeName: z.string().optional(),
      taskTypeKey: z.string().optional(),
      estimateMinutes: z.number(),
    })).min(1),
    reason: z.string().describe("Reason for the proposed change — for auditability/notes"),
  }, async ({ workItemKey, estimates, reason }) => {
    if (!reason || !reason.trim()) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "`reason` is required and must be non-empty." }, null, 2) }] };
    }
    for (const e of estimates) {
      const hasRole = e.roleKey || e.roleName;
      const hasTask = e.taskTypeKey || e.taskTypeName;
      if (!hasRole && !hasTask) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Each estimate entry must include at least one of roleKey/roleName or taskTypeKey/taskTypeName for matching." }, null, 2) }] };
      }
    }

    // Fetch current estimate summary
    const current = await kFetch(`/estimatesummaries/${workItemKey}`) as Record<string, unknown>;
    const rowsRaw = (current.value as unknown[] | undefined)
      ?? (current.EstimateSummaries as unknown[] | undefined)
      ?? (Array.isArray(current) ? current as unknown[] : undefined);
    const rows = (rowsRaw ?? []) as Record<string, unknown>[];

    // Match each requested estimate to a row
    const matches = estimates.map((e) => {
      let idx = -1;
      if (e.roleKey || e.taskTypeKey) {
        idx = rows.findIndex((r) =>
          (e.roleKey ? r.RoleKey === e.roleKey : true) &&
          (e.taskTypeKey ? r.TaskTypeKey === e.taskTypeKey : true)
        );
      }
      if (idx === -1 && (e.roleName || e.taskTypeName)) {
        idx = rows.findIndex((r) =>
          (e.roleName ? (r.RoleName === e.roleName || r.Role === e.roleName) : true) &&
          (e.taskTypeName ? (r.TaskTypeName === e.taskTypeName || r.TaskType === e.taskTypeName) : true)
        );
      }
      return { input: e, row: idx >= 0 ? rows[idx] : null };
    });

    const matchedRows = matches
      .filter((m) => m.row !== null)
      .map((m) => {
        const before = m.row as Record<string, unknown>;
        const beforeMinutes = (before.EstimateMinutes ?? null) as number | null;
        const afterMinutes = m.input.estimateMinutes;
        return {
          roleKey: before.RoleKey ?? null,
          roleName: before.RoleName ?? before.Role ?? null,
          taskTypeKey: before.TaskTypeKey ?? null,
          taskTypeName: before.TaskTypeName ?? before.TaskType ?? null,
          before: { EstimateMinutes: beforeMinutes, ActualMinutes: before.ActualMinutes ?? null, HourlyRate: before.HourlyRate ?? null },
          after:  { EstimateMinutes: afterMinutes,  ActualMinutes: before.ActualMinutes ?? null, HourlyRate: before.HourlyRate ?? null },
          delta: beforeMinutes !== null ? afterMinutes - beforeMinutes : null,
        };
      });

    const unmatched = matches.filter((m) => m.row === null).map((m) => m.input);

    return { content: [{ type: "text", text: JSON.stringify({
      ok: true,
      preview: true,
      writable: false,
      message: "Karbon's documented v3 API does not expose a write endpoint for EstimateSummaries. No changes were made. Apply these edits manually in the Karbon UI.",
      reason,
      workItemKey,
      matchedRows,
      unmatched,
    }, null, 2) }] };
  });

  // ── SAFE FEE & BUDGET UPDATE ────────────────────────────────────────────
  // Updates FeeSettings and/or budget on a Karbon Work Item, then re-fetches
  // the item and verifies the values actually persisted. Returns success only
  // when the GET-after-PUT confirms the change.
  s.tool("update_karbon_workitem_fee_budget", "Safely update FeeSettings and/or budget on a Karbon Work Item. Fetches the existing item, modifies only the requested fields, preserves all others, PUTs the update, then GETs again to verify the values persisted. Returns success only on verified persistence. Requires a `reason` for auditability.", {
    workItemKey: z.string(),
    feeType: z.string().optional().describe("e.g. 'Fixed', 'TimeAndMaterials', 'NotBillable'"),
    feeValue: z.number().optional().describe("Numeric fee amount; pairs with feeType when relevant"),
    estimatedBudgetMinutes: z.number().optional().describe("Estimated budget in minutes"),
    reason: z.string().describe("Reason for the change — required for auditability"),
  }, async ({ workItemKey, feeType, feeValue, estimatedBudgetMinutes, reason }) => {
    if (feeType === undefined && feeValue === undefined && estimatedBudgetMinutes === undefined) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "No changes requested. Provide at least one of: feeType, feeValue, estimatedBudgetMinutes." }, null, 2) }] };
    }
    if (!reason || !reason.trim()) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "`reason` is required and must be non-empty." }, null, 2) }] };
    }

    // Helper: pull whichever budget field Karbon actually populates
    const readBudget = (obj: Record<string, unknown>): number | null => {
      const v = (obj.EstimatedBudgetMinutes ?? obj.EstimatedBudget) as number | null | undefined;
      return v === undefined ? null : v;
    };

    // 1. Fetch current work item
    const current = await kFetch(`/workitems/${workItemKey}`) as Record<string, unknown>;
    const beforeFeeSettings = current.FeeSettings ?? null;
    const beforeBudget = readBudget(current);

    // 2. Build payload preserving every existing field
    const payload: Record<string, unknown> = { ...current };
    delete payload["@odata.context"];
    delete payload["@odata.type"];
    // Ensure WorkItemKey is explicit in the payload as well as the URL
    payload.WorkItemKey = workItemKey;

    // 3. Only modify FeeSettings and budget
    if (feeType !== undefined || feeValue !== undefined) {
      const existingFee = (current.FeeSettings as Record<string, unknown> | null | undefined) ?? {};
      payload.FeeSettings = {
        ...existingFee,
        ...(feeType !== undefined ? { FeeType: feeType } : {}),
        ...(feeValue !== undefined ? { FeeValue: feeValue } : {}),
      };
    }
    if (estimatedBudgetMinutes !== undefined) {
      // Karbon's documented field appears to be EstimatedBudgetMinutes (PascalCase).
      // Set both names to be safe across API versions; whichever Karbon uses wins.
      payload.EstimatedBudgetMinutes = estimatedBudgetMinutes;
      payload.EstimatedBudget = estimatedBudgetMinutes;
    }

    // 4. PUT the update — capture raw error body if Karbon rejects
    const url = `${BASE}/workitems/${encodeURIComponent(workItemKey)}`;
    const requestBody = JSON.stringify(payload);
    // TEMPORARY DEBUG: log the raw request body to stderr (no headers, no tokens).
    // Remove once the budget write is confirmed working.
    console.error(`[debug update_karbon_workitem_fee_budget] PUT ${url} body=${requestBody}`);

    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        AccessKey: TOKEN,
        Authorization: `Bearer ${GB_KEY}`,
        Accept: "application/json",
      },
      body: requestBody,
    });
    const respText = await res.text();
    if (!res.ok) {
      return { content: [{ type: "text", text: JSON.stringify({
        ok: false,
        stage: "PUT",
        status: res.status,
        error: respText,
        before: { FeeSettings: beforeFeeSettings, EstimatedBudgetMinutes: beforeBudget },
      }, null, 2) }] };
    }

    // 5. Verify by re-fetching — Karbon's PUT often returns 204, so we cannot
    //    trust the PUT response body. Only persisted values are reported.
    const verified = await kFetch(`/workitems/${workItemKey}`) as Record<string, unknown>;
    const afterFeeSettings = (verified.FeeSettings ?? null) as Record<string, unknown> | null;
    const afterBudget = readBudget(verified);

    const failures: string[] = [];
    if (estimatedBudgetMinutes !== undefined && afterBudget !== estimatedBudgetMinutes) {
      failures.push(`EstimatedBudgetMinutes did not persist: expected=${estimatedBudgetMinutes} actual=${afterBudget}`);
    }
    if (feeType !== undefined && (afterFeeSettings?.FeeType ?? null) !== feeType) {
      failures.push(`FeeSettings.FeeType did not persist: expected=${feeType} actual=${String(afterFeeSettings?.FeeType ?? null)}`);
    }
    if (feeValue !== undefined && (afterFeeSettings?.FeeValue ?? null) !== feeValue) {
      failures.push(`FeeSettings.FeeValue did not persist: expected=${feeValue} actual=${String(afterFeeSettings?.FeeValue ?? null)}`);
    }

    if (failures.length > 0) {
      return { content: [{ type: "text", text: JSON.stringify({
        ok: false,
        stage: "verification",
        putStatus: res.status,
        message: "Karbon accepted the PUT but the requested values did not persist on re-fetch.",
        failures,
        reason,
        workItemKey,
        before: { FeeSettings: beforeFeeSettings, EstimatedBudgetMinutes: beforeBudget },
        after:  { FeeSettings: afterFeeSettings,  EstimatedBudgetMinutes: afterBudget },
      }, null, 2) }] };
    }

    return { content: [{ type: "text", text: JSON.stringify({
      ok: true,
      verified: true,
      putStatus: res.status,
      reason,
      workItemKey,
      before: { FeeSettings: beforeFeeSettings, EstimatedBudgetMinutes: beforeBudget },
      after:  { FeeSettings: afterFeeSettings,  EstimatedBudgetMinutes: afterBudget },
    }, null, 2) }] };
  });

  return s;
}

// ── HTTP server with session management ──────────────────────────────────────
const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: ReturnType<typeof createServer> }>();

const httpServer = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  // ── TEMPORARY: Karbon Work Item debug endpoint ──────────────────────
  // Fetches a single Karbon Work Item so the raw JSON can be inspected.
  // REMOVE once inspection is complete. Does not log sensitive data.
  {
    const m = req.url ? req.url.match(/^\/test-karbon-workitem\/([^/?#]+)/) : null;
    if (m) {
      if (req.method !== "GET") {
        res.writeHead(405, { "Allow": "GET" });
        res.end("Method Not Allowed");
        return;
      }
      try {
        const workItemKey = decodeURIComponent(m[1]);
        const upstream = await fetch(`https://api.karbonhq.com/v3/WorkItems/${encodeURIComponent(workItemKey)}`, {
          method: "GET",
          headers: {
            AccessKey: process.env.KARBON_ACCESS_KEY ?? "",
            Authorization: `Bearer ${process.env.KARBON_GB_KEY ?? ""}`,
            Accept: "application/json",
          },
        });
        const body = await upstream.text();
        const ct = upstream.headers.get("content-type") ?? "application/json";
        res.writeHead(upstream.status, { "Content-Type": ct });
        res.end(body);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to fetch Karbon Work Item", message: (err as Error).message }));
      }
      return;
    }
  }
  // ── END TEMPORARY ───────────────────────────────────────────────────

  if (req.url === "/health") { res.writeHead(200); res.end("OK"); return; }

  if (req.url === "/mcp" || req.url?.startsWith("/mcp?")) {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      await new Promise<void>(r => { req.on("data", c => chunks.push(c)); req.on("end", r); });
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString()); } catch { res.writeHead(400); res.end("Bad JSON"); return; }

      let session = sessionId ? sessions.get(sessionId) : undefined;
      if (!session && isInitializeRequest(parsed)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => { sessions.set(id, { transport, server: srv }); },
        });
        const srv = createServer();
        await srv.connect(transport);
        session = { transport, server: srv };
        await transport.handleRequest(req, res, parsed);
        return;
      }
      if (!session) { res.writeHead(400); res.end("No session"); return; }
      await session.transport.handleRequest(req, res, parsed);
      return;
    }
    if (req.method === "GET") {
      if (!sessionId || !sessions.has(sessionId)) { res.writeHead(400); res.end("No session"); return; }
      await sessions.get(sessionId)!.transport.handleRequest(req, res);
      return;
    }
    if (req.method === "DELETE") { if (sessionId) sessions.delete(sessionId); res.writeHead(200); res.end(); return; }
  }

  res.writeHead(404); res.end("Not found");
});

httpServer.listen(PORT, () => console.log(`Karbon MCP server running on port ${PORT}`));