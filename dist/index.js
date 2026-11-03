import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import http from "http";
import { randomUUID } from "crypto";
import { createServer } from "./server.js";
import { startUploadWatch, watchConfigFromEnv } from "./uploadWatch.js";
// Tools live in src/server.ts; the Karbon client (auth, retries, paging,
// write verification) in src/karbon.ts. This file is only the HTTP transport.
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
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
// Client portal upload watch: off unless UPLOAD_WATCH_ENABLED=true (see README).
const watchConfig = watchConfigFromEnv();
if (watchConfig)
    startUploadWatch(watchConfig);
