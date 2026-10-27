// Dry run of update_client_group_description against the deployed server.
// Always sends dryRun: true, so it never writes to Karbon.
//
//   node scripts/group-description-dry-run.mjs "<text to add>" [clientGroupKey] [mode]
//
// Defaults: clientGroupKey 2Xq8GyctZGtl (Bottomley (Sarah) Group), mode prepend.
// Set KARBON_MCP_URL to point at another deployment.

const URL_ = process.env.KARBON_MCP_URL ?? "https://karbon-mcp-production.up.railway.app/mcp";
const [text, clientGroupKey = "2Xq8GyctZGtl", mode = "prepend"] = process.argv.slice(2);
if (!text) {
  console.error('Usage: node scripts/group-description-dry-run.mjs "<text to add>" [clientGroupKey] [mode]');
  process.exit(1);
}

let session = null;
async function rpc(body) {
  const res = await fetch(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) },
    body: JSON.stringify(body),
  });
  session ??= res.headers.get("mcp-session-id");
  const raw = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw}`);
  // Streamable HTTP may answer as SSE: take the last data: line.
  const data = raw.includes("data:") ? raw.split("\n").filter(l => l.startsWith("data:")).pop().slice(5) : raw;
  return data.trim() ? JSON.parse(data) : null;
}

await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "group-description-dry-run", version: "1" } } });
await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
const r = await rpc({
  jsonrpc: "2.0", id: 2, method: "tools/call",
  params: { name: "update_client_group_description", arguments: { clientGroupKey, text, mode, dryRun: true, reason: "dry run check" } },
});
if (r.error) { console.error(r.error); process.exit(1); }
const out = r.result.content[0].text;
try { console.log(JSON.stringify(JSON.parse(out), null, 2)); } catch { console.log(out); }
if (r.result.isError) process.exit(1);
