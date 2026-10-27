// list_work_templates: /WorkTemplates rejects $top above 10, so the tool reads
// 10 at a time and follows @odata.nextLink. Karbon is mocked by replacing fetch.
// Run: npm test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { clientConfig } from "../dist/karbon.js";

clientConfig.sleep = async () => {};
console.log = () => {};

const API = "https://api.karbonhq.com/v3";
const templates = Array.from({ length: 25 }, (_, i) => ({ WorkTemplateKey: `T${i + 1}`, Title: `Template ${i + 1}` }));
const users = Array.from({ length: 3 }, (_, i) => ({ UserKey: `U${i + 1}` }));
let log;

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Pages like Karbon: rejects $top over the endpoint's limit with 4002, and
// returns a nextLink carrying the same $top and the next $skip.
function page(path, rows, limit, u) {
  const top = Number(u.searchParams.get("$top") ?? limit);
  if (top > limit) return json({ error: { code: "4002", message: `The limit of '${limit}' for Top query has been exceeded. The value from the incoming request is '${top}'.` } }, 400);
  const skip = Number(u.searchParams.get("$skip") ?? 0);
  const next = skip + top < rows.length ? `${API}${path}?$top=${top}&$skip=${skip + top}` : undefined;
  return json({ value: rows.slice(skip, skip + top), ...(next ? { "@odata.nextLink": next } : {}) });
}

globalThis.fetch = async (url) => {
  const u = new URL(url);
  const path = decodeURIComponent(u.pathname).replace(/^\/v3/i, "");
  log.push(u);
  if (path === "/WorkTemplates") return page(path, templates, 10, u);
  if (path === "/Users") return page(path, users, 100, u);
  return json({ error: { code: "4004", message: `unmocked ${path}` } }, 404);
};

let call;
beforeEach(async () => {
  log = [];
  const server = createServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const t = r.content[0].text;
    try { return JSON.parse(t); } catch { return { raw: t, isError: r.isError }; }
  };
});

test("list_work_templates sends $top=10 and follows nextLink to every template", async () => {
  const r = await call("list_work_templates", { maxRecords: 200 });
  assert.equal(r.returned, 25, JSON.stringify(r).slice(0, 300));
  assert.deepEqual(r.value.map(t => t.WorkTemplateKey), templates.map(t => t.WorkTemplateKey));
  assert.ok(!r["@odata.nextLink"]);
  assert.equal(log.length, 3);
  for (const u of log) assert.equal(u.searchParams.get("$top"), "10");
});

test("list_work_templates with the defaults doesn't hit the 4002 limit", async () => {
  const r = await call("list_work_templates", {});
  assert.equal(r.returned, 25);
  assert.equal(log[0].searchParams.get("$top"), "10");
});

test("list_work_templates stops at maxRecords and returns a nextLink to continue", async () => {
  const r = await call("list_work_templates", { maxRecords: 10 });
  assert.equal(r.returned, 10);
  assert.ok(r["@odata.nextLink"]);
  const r2 = await call("list_work_templates", { nextLink: r["@odata.nextLink"], maxRecords: 200 });
  assert.equal(r2.returned, 15);
  assert.equal(r2.value[0].WorkTemplateKey, "T11");
});

test("other list tools still ask for 100 per page", async () => {
  await call("list_users", {});
  assert.equal(log[0].searchParams.get("$top"), "100");
});
