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
async function kFetch(path, opts = {}) {
    const res = await fetch(`${BASE}${path}`, {
        ...opts,
        headers: { "Content-Type": "application/json", AccessKey: TOKEN, Authorization: `Bearer ${GB_KEY}`, ...(opts.headers ?? {}) },
    });
    if (!res.ok)
        throw new Error(`Karbon ${res.status}: ${await res.text()}`);
    return res.json();
}
function qs(params) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params))
        if (v !== undefined)
            p.set(k, String(v));
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
    s.tool("get_contact", "Get a single contact by key", { contactKey: z.string() }, async ({ contactKey }) => ({ content: [{ type: "text", text: JSON.stringify(await kFetch(`/contacts/${contactKey}`), null, 2) }] }));
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
    s.tool("get_organization", "Get a single organization by key", { organizationKey: z.string() }, async ({ organizationKey }) => ({ content: [{ type: "text", text: JSON.stringify(await kFetch(`/organizations/${organizationKey}`), null, 2) }] }));
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
    s.tool("get_client_group", "Get a single client group by key", { clientGroupKey: z.string() }, async ({ clientGroupKey }) => ({ content: [{ type: "text", text: JSON.stringify(await kFetch(`/clientgroups/${clientGroupKey}`), null, 2) }] }));
    // ── WORK ITEMS ────────────────────────────────────────────────────────────
    s.tool("list_work", "List work items from Karbon", {
        filter: z.string().optional().describe("e.g. \"WorkStatus eq 'InProgress'\" or \"PrimaryStatus eq 'Planned'\""),
        top: z.number().optional().default(20), skip: z.number().optional().default(0),
    }, async ({ filter, top, skip }) => {
        const q = qs({ $top: top, $skip: skip, ...(filter ? { $filter: filter } : {}) });
        return { content: [{ type: "text", text: JSON.stringify(await kFetch(`/workitems${q}`), null, 2) }] };
    });
    s.tool("get_work", "Get a single work item by key", { workKey: z.string() }, async ({ workKey }) => ({ content: [{ type: "text", text: JSON.stringify(await kFetch(`/workitems/${workKey}`), null, 2) }] }));
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
    s.tool("list_work_tasks", "List tasks within a work item", { workKey: z.string() }, async ({ workKey }) => ({ content: [{ type: "text", text: JSON.stringify(await kFetch(`/workitems/${workKey}/tasks`), null, 2) }] }));
    s.tool("update_task", "Update a task within a work item", {
        workKey: z.string(), taskKey: z.string(),
        isCompleted: z.boolean().optional(), assigneeKey: z.string().optional(), dueDate: z.string().optional(),
    }, async ({ workKey, taskKey, ...f }) => ({ content: [{ type: "text", text: JSON.stringify(await kFetch(`/workitems/${workKey}/tasks/${taskKey}`, { method: "PATCH", body: JSON.stringify(f) }), null, 2) }] }));
    // ── WORK TEMPLATES ────────────────────────────────────────────────────────
    s.tool("list_work_templates", "List available work templates", { top: z.number().optional().default(20) }, async ({ top }) => ({ content: [{ type: "text", text: JSON.stringify(await kFetch(`/worktemplates?$top=${top}`), null, 2) }] }));
    // ── TIMESHEETS & TIME ENTRIES ─────────────────────────────────────────────
    s.tool("list_timesheets", "List timesheets — optionally filter by date range, user or work item", {
        filter: z.string().optional().describe("OData filter e.g. \"StartDate ge 2026-01-01T00:00:00Z\" or \"UserKey eq 'abc'\""),
        includeTimeEntries: z.boolean().optional().default(false).describe("Set true to include individual time entries"),
        top: z.number().optional().default(20), skip: z.number().optional().default(0),
    }, async ({ filter, includeTimeEntries, top, skip }) => {
        const params = { $top: top, $skip: skip };
        if (filter)
            params.$filter = filter;
        if (includeTimeEntries)
            params.$expand = "TimeEntries";
        return { content: [{ type: "text", text: JSON.stringify(await kFetch(`/timesheets${qs(params)}`), null, 2) }] };
    });
    s.tool("get_timesheet", "Get a single timesheet with its time entries", {
        timesheetKey: z.string(), includeTimeEntries: z.boolean().optional().default(true),
    }, async ({ timesheetKey, includeTimeEntries }) => {
        const q = includeTimeEntries ? "?$expand=TimeEntries" : "";
        return { content: [{ type: "text", text: JSON.stringify(await kFetch(`/timesheets/${timesheetKey}${q}`), null, 2) }] };
    });
    // ── NOTES ─────────────────────────────────────────────────────────────────
    s.tool("get_note", "Get a single note by its ID", { noteId: z.string() }, async ({ noteId }) => ({ content: [{ type: "text", text: JSON.stringify(await kFetch(`/notes/${noteId}`), null, 2) }] }));
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
        const params = { $top: top, $skip: skip };
        if (orderBy)
            params.$orderby = orderBy;
        return { content: [{ type: "text", text: JSON.stringify(await kFetch(`/invoices${qs(params)}`), null, 2) }] };
    });
    s.tool("get_invoice", "Get a single invoice with line items and payments", { invoiceKey: z.string() }, async ({ invoiceKey }) => ({ content: [{ type: "text", text: JSON.stringify(await kFetch(`/invoices/${invoiceKey}?$expand=LineItems,Payments`), null, 2) }] }));
    // ── ESTIMATE SUMMARIES ────────────────────────────────────────────────────
    s.tool("get_estimate_summary", "Get budget vs actual time estimates for a work item", { workItemKey: z.string() }, async ({ workItemKey }) => ({ content: [{ type: "text", text: JSON.stringify(await kFetch(`/estimatesummaries/${workItemKey}`), null, 2) }] }));
    // ── TENANT SETTINGS ───────────────────────────────────────────────────────
    s.tool("get_tenant_settings", "Get your Karbon account settings — work types, work statuses, contact types", {}, async () => ({ content: [{ type: "text", text: JSON.stringify(await kFetch("/tenantsettings"), null, 2) }] }));
    // ── USERS ─────────────────────────────────────────────────────────────────
    s.tool("list_users", "List users in your Karbon account", {
        filter: z.string().optional().describe("e.g. \"Name eq 'Jane Smith'\""),
        top: z.number().optional().default(50),
    }, async ({ filter, top }) => {
        const q = qs({ $top: top, ...(filter ? { $filter: filter } : {}) });
        return { content: [{ type: "text", text: JSON.stringify(await kFetch(`/users${q}`), null, 2) }] };
    });
    s.tool("get_user", "Get details for a single user", { userId: z.string() }, async ({ userId }) => ({ content: [{ type: "text", text: JSON.stringify(await kFetch(`/users/${userId}`), null, 2) }] }));
    s.tool("list_team_members", "List team members (simplified user list)", { top: z.number().optional().default(50) }, async ({ top }) => ({ content: [{ type: "text", text: JSON.stringify(await kFetch(`/users?$top=${top}`), null, 2) }] }));
    // ── DASHBOARD & SEARCH ────────────────────────────────────────────────────
    s.tool("get_work_summary", "Get a dashboard summary of work across all statuses", {}, async () => {
        const statuses = ["Planned", "ReadyToStart", "InProgress", "Waiting", "Completed"];
        const results = {};
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
    return s;
}
// ── HTTP server with session management ──────────────────────────────────────
const sessions = new Map();
const httpServer = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    if (req.method === "OPTIONS") {
        res.writeHead(200);
        res.end();
        return;
    }
    if (req.url === "/health") {
        res.writeHead(200);
        res.end("OK");
        return;
    }
    if (req.url === "/mcp" || req.url?.startsWith("/mcp?")) {
        const sessionId = req.headers["mcp-session-id"];
        if (req.method === "POST") {
            const chunks = [];
            await new Promise(r => { req.on("data", c => chunks.push(c)); req.on("end", r); });
            let parsed;
            try {
                parsed = JSON.parse(Buffer.concat(chunks).toString());
            }
            catch {
                res.writeHead(400);
                res.end("Bad JSON");
                return;
            }
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
            if (!session) {
                res.writeHead(400);
                res.end("No session");
                return;
            }
            await session.transport.handleRequest(req, res, parsed);
            return;
        }
        if (req.method === "GET") {
            if (!sessionId || !sessions.has(sessionId)) {
                res.writeHead(400);
                res.end("No session");
                return;
            }
            await sessions.get(sessionId).transport.handleRequest(req, res);
            return;
        }
        if (req.method === "DELETE") {
            if (sessionId)
                sessions.delete(sessionId);
            res.writeHead(200);
            res.end();
            return;
        }
    }
    res.writeHead(404);
    res.end("Not found");
});
httpServer.listen(PORT, () => console.log(`Karbon MCP server running on port ${PORT}`));
