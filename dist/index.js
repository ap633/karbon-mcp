import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import http from "http";
const KARBON_API_BASE = "https://api.karbonhq.com/v3";
const KARBON_TOKEN = process.env.KARBON_ACCESS_KEY ?? "";
const KARBON_GB_KEY = process.env.KARBON_GB_KEY ?? "";
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
async function karbonFetch(path, options = {}) {
    const res = await fetch(`${KARBON_API_BASE}${path}`, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            AccessKey: KARBON_TOKEN,
            Authorization: `Bearer ${KARBON_GB_KEY}`,
            ...(options.headers ?? {}),
        },
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Karbon API error ${res.status}: ${text}`);
    }
    return res.json();
}
function createServer() {
    const server = new McpServer({ name: "karbon-mcp", version: "1.0.0" });
    server.tool("list_contacts", "List contacts/clients from Karbon", {
        filter: z.string().optional().describe("OData filter string"),
        top: z.number().optional().default(20),
        skip: z.number().optional().default(0),
    }, async ({ filter, top, skip }) => {
        const params = new URLSearchParams({ $top: String(top), $skip: String(skip) });
        if (filter)
            params.set("$filter", filter);
        const data = await karbonFetch(`/contacts?${params}`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    });
    server.tool("get_contact", "Get a single contact by their Karbon key", {
        contactKey: z.string(),
    }, async ({ contactKey }) => {
        const data = await karbonFetch(`/contacts/${contactKey}`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    });
    server.tool("create_contact", "Create a new contact in Karbon", {
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        companyName: z.string().optional(),
        email: z.string().optional(),
        contactType: z.enum(["Person", "Company"]).default("Person"),
    }, async (body) => {
        const data = await karbonFetch("/contacts", { method: "POST", body: JSON.stringify(body) });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    });
    server.tool("update_contact", "Update an existing contact in Karbon", {
        contactKey: z.string(),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        companyName: z.string().optional(),
        email: z.string().optional(),
    }, async ({ contactKey, ...fields }) => {
        const data = await karbonFetch(`/contacts/${contactKey}`, { method: "PATCH", body: JSON.stringify(fields) });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    });
    server.tool("list_work", "List work items from Karbon", {
        filter: z.string().optional(),
        top: z.number().optional().default(20),
        skip: z.number().optional().default(0),
    }, async ({ filter, top, skip }) => {
        const params = new URLSearchParams({ $top: String(top), $skip: String(skip) });
        if (filter)
            params.set("$filter", filter);
        const data = await karbonFetch(`/work?${params}`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    });
    server.tool("get_work", "Get a single work item by its key", {
        workKey: z.string(),
    }, async ({ workKey }) => {
        const data = await karbonFetch(`/work/${workKey}`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    });
    server.tool("create_work", "Create a new work item in Karbon", {
        title: z.string(),
        clientKey: z.string(),
        assigneeKey: z.string().optional(),
        dueDate: z.string().optional(),
        workTypeKey: z.string().optional(),
    }, async (body) => {
        const data = await karbonFetch("/work", { method: "POST", body: JSON.stringify(body) });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    });
    server.tool("update_work_status", "Update the status of a work item", {
        workKey: z.string(),
        status: z.enum(["Planned", "InProgress", "Completed", "Cancelled", "OnHold"]),
    }, async ({ workKey, status }) => {
        const data = await karbonFetch(`/work/${workKey}`, { method: "PATCH", body: JSON.stringify({ WorkStatus: status }) });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    });
    server.tool("list_work_tasks", "List tasks within a specific work item", {
        workKey: z.string(),
    }, async ({ workKey }) => {
        const data = await karbonFetch(`/work/${workKey}/tasks`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    });
    server.tool("update_task", "Update a task within a work item", {
        workKey: z.string(),
        taskKey: z.string(),
        isCompleted: z.boolean().optional(),
        assigneeKey: z.string().optional(),
        dueDate: z.string().optional(),
    }, async ({ workKey, taskKey, ...fields }) => {
        const data = await karbonFetch(`/work/${workKey}/tasks/${taskKey}`, { method: "PATCH", body: JSON.stringify(fields) });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    });
    server.tool("list_work_templates", "List available work templates in Karbon", {
        top: z.number().optional().default(20),
    }, async ({ top }) => {
        const data = await karbonFetch(`/workTemplates?$top=${top}`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    });
    server.tool("move_work_to_stage", "Move a work item to a different workflow stage", {
        workKey: z.string(),
        stageKey: z.string(),
    }, async ({ workKey, stageKey }) => {
        const data = await karbonFetch(`/work/${workKey}`, { method: "PATCH", body: JSON.stringify({ WorkflowStageKey: stageKey }) });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    });
    server.tool("list_team_members", "List team members in Karbon", {
        top: z.number().optional().default(50),
    }, async ({ top }) => {
        const data = await karbonFetch(`/teamMembers?$top=${top}`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    });
    server.tool("get_work_summary", "Get a summary of work across statuses", {}, async () => {
        const statuses = ["Planned", "InProgress", "OnHold"];
        const results = {};
        await Promise.all(statuses.map(async (s) => {
            const data = await karbonFetch(`/work?$filter=WorkStatus eq '${s}'&$top=100&$select=Title,WorkStatus,DueDate,AssigneeKey`);
            results[s] = data;
        }));
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    });
    server.tool("search_karbon", "Search across contacts and work items by keyword", {
        query: z.string(),
    }, async ({ query }) => {
        const encoded = encodeURIComponent(query);
        const [contacts, work] = await Promise.all([
            karbonFetch(`/contacts?$filter=contains(FullName,'${encoded}')&$top=10`),
            karbonFetch(`/work?$filter=contains(Title,'${encoded}')&$top=10`),
        ]);
        return { content: [{ type: "text", text: JSON.stringify({ contacts, work }, null, 2) }] };
    });
    return server;
}
const httpServer = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
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
    if (req.url === "/mcp") {
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
        });
        const server = createServer();
        await server.connect(transport);
        await transport.handleRequest(req, res);
        return;
    }
    res.writeHead(404);
    res.end("Not found");
});
httpServer.listen(PORT, () => {
    console.log(`Karbon MCP server running on port ${PORT}`);
});
