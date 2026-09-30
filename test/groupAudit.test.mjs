// Mock test for src/groupAudit.ts (runs against the compiled dist/groupAudit.js).
// Run: npx tsc && node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerGroupAuditTools } from "../dist/groupAudit.js";

// ── Fixtures ──
const groups = {
  G1: { ClientGroupKey: "G1", FullName: "Willow Group", Members: [{ ContactKey: "C1" }, { OrganizationKey: "O1" }, { ContactKey: "C3" }] },
  G2: { ClientGroupKey: "G2", FullName: "Other Group", Members: [{ ContactKey: "C3" }, { OrganizationKey: "O2" }] },
};
const work = () => ({
  W1: { WorkItemKey: "W1", Title: "ITR", ClientKey: "C1", ClientName: "Cam", ClientType: "Contact", PrimaryStatus: "InProgress", AssigneeEmailAddress: "a@x.au", WorkTemplateTile: "ITR Template", StartDate: "2026-09-01" },
  W2: { WorkItemKey: "W2", Title: "BAS", ClientKey: "O1", ClientName: "Org One", ClientType: "Organization", PrimaryStatus: "Planned", AssigneeEmailAddress: "b@x.au", WorkTemplateTile: "BAS Template" },
  W3: { WorkItemKey: "W3", Title: "Tax plan", ClientKey: "C3", ClientName: "Cat", ClientType: "Contact", PrimaryStatus: "Waiting", AssigneeEmailAddress: "a@x.au", WorkTemplateTile: "ITR Template" },
  W4: { WorkItemKey: "W4", Title: "Wrong", ClientKey: "C1", ClientName: "Cam", ClientType: "Contact", PrimaryStatus: "ReadyToStart", RelatedClientGroupKey: "G2", AssigneeEmailAddress: "a@x.au" },
  W5: { WorkItemKey: "W5", Title: "Solo", ClientKey: "C9", ClientName: "Solo Pty", ClientType: "Organization", PrimaryStatus: "InProgress", AssigneeEmailAddress: "b@x.au" },
  W6: { WorkItemKey: "W6", Title: "Group work", ClientKey: "G1", ClientName: "Willow Group", ClientType: "ClientGroup", PrimaryStatus: "Planned" },
  W7: { WorkItemKey: "W7", Title: "Fine", ClientKey: "O2", ClientName: "Org Two", ClientType: "Organization", PrimaryStatus: "Planned", RelatedClientGroupKey: "G2" },
  W8: { WorkItemKey: "W8", Title: "Done", ClientKey: "C1", ClientName: "Cam", ClientType: "Contact", PrimaryStatus: "Completed", CompletedDate: "2026-08-15T00:00:00Z", WorkTemplateTile: "Old Template" },
});

const DISPLAY = { InProgress: "In Progress", ReadyToStart: "Ready To Start" };
let store, puts, ignorePutFor, first429;

function reset() { store = work(); puts = []; ignorePutFor = new Set(); first429 = true; }

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const path = u.pathname.replace("/v3", "");
  const method = opts.method ?? "GET";
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  if (path === "/clientgroups") {
    if (first429) { first429 = false; return new Response("slow down", { status: 429, headers: { "Retry-After": "0" } }); }
    return json({ value: Object.values(groups).map(({ Members, ...g }) => g) });
  }
  const g = path.match(/^\/clientgroups\/(\w+)$/);
  if (g) return json({ "@odata.context": "x", ...groups[g[1]] });

  if (path === "/workitems") {
    const f = u.searchParams.get("$filter") ?? "";
    const status = f.match(/PrimaryStatus eq '([^']+)'/)[1];
    const since = f.match(/CompletedDate ge (\S+)/)?.[1];
    const rows = Object.values(store).filter(w => (DISPLAY[w.PrimaryStatus] ?? w.PrimaryStatus) === status && (!since || w.CompletedDate >= since));
    return json({ value: rows });
  }
  const w = path.match(/^\/workitems\/(\w+)$/);
  if (w && method === "GET") return json({ "@odata.context": "ctx", ...store[w[1]] });
  if (w && method === "PUT") {
    const body = JSON.parse(opts.body);
    puts.push(body);
    if (!["Planned", "Ready To Start", "In Progress", "Waiting", "Completed"].includes(body.PrimaryStatus)) return json({ error: "bad status" }, 400);
    if (!ignorePutFor.has(w[1])) store[w[1]] = { ...store[w[1]], RelatedClientGroupKey: body.RelatedClientGroupKey, ClientGroupKey: body.ClientGroupKey };
    return new Response(null, { status: 204 });
  }
  return json({ error: `unmocked ${method} ${path}` }, 404);
};

async function connect() {
  const server = new McpServer({ name: "t", version: "0" });
  registerGroupAuditTools(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    return JSON.parse(r.content[0].text);
  };
}

test("audit classifies every category", async () => {
  reset();
  const call = await connect();
  const r = await call("audit_work_client_groups", { includeStandalone: true, completedSince: "2026-07-01", refreshMembership: true });

  assert.equal(r.summary.skippedClientGroupWork, 1);
  assert.equal(r.summary.clientGroups, 2);
  assert.equal(r.summary.missingGroup, 3); // W1, W2, W8 (completed since)
  assert.equal(r.missingGroup.length, 1);
  assert.equal(r.missingGroup[0].groupKey, "G1");
  assert.deepEqual(r.missingGroup[0].items.map(i => i.workKey).sort(), ["W1", "W2", "W8"]);
  const w1 = r.missingGroup[0].items.find(i => i.workKey === "W1");
  assert.deepEqual(Object.keys(w1).sort(), ["assignee", "client", "clientKey", "clientType", "startDate", "status", "template", "title", "workKey"]);
  assert.deepEqual(r.missingByTemplate.find(t => t.template === "ITR Template"), { template: "ITR Template", count: 1 });
  assert.equal(r.missingByTemplate.length, 3);

  assert.equal(r.ambiguous.length, 1);
  assert.equal(r.ambiguous[0].workKey, "W3");
  assert.deepEqual(r.ambiguous[0].candidateGroups.map(g => g.groupKey).sort(), ["G1", "G2"]);

  assert.equal(r.wrongGroup.length, 1);
  assert.equal(r.wrongGroup[0].workKey, "W4");
  assert.equal(r.wrongGroup[0].workGroupName, "Other Group");

  assert.deepEqual(r.standalone, [{ clientKey: "C9", client: "Solo Pty", clientType: "Organization", openItems: 1, itemsScanned: 1 }]);
  assert.equal(r.summary.ok, 2); // W7 correct group, W5 standalone
});

test("audit defaults to open statuses and filters by assignee", async () => {
  reset();
  const call = await connect();
  const r = await call("audit_work_client_groups", { assigneeEmail: "A@X.AU", refreshMembership: true });
  assert.equal(r.summary.missingGroup, 1); // W1 only; W8 (completed) not scanned by default
  assert.equal(r.ambiguous.length, 1);
  assert.equal(r.wrongGroup.length, 1);
  assert.equal(r.standalone, undefined);
  assert.equal(Object.keys(r.summary.scannedByStatus).length, 4);
});

test("set_work_client_group: dry run, already_set, refused", async () => {
  reset();
  const call = await connect();
  await call("audit_work_client_groups", { refreshMembership: true });
  const r = await call("set_work_client_group", {
    reason: "test",
    items: [
      { workKey: "W1", clientGroupKey: "G1" },
      { workKey: "W7", clientGroupKey: "G2" },
      { workKey: "W5", clientGroupKey: "G1" },
      { workKey: "W1", clientGroupKey: "NOPE" },
    ],
  });
  assert.equal(r.dryRun, true);
  assert.deepEqual(r.results.map(x => x.status), ["would_update", "already_set", "refused", "refused"]);
  assert.deepEqual(r.tally, { would_update: 1, already_set: 1, refused: 2 });
  assert.equal(puts.length, 0, "dry run must not PUT");
});

test("set_work_client_group: verified write and not_persisted", async () => {
  reset();
  const call = await connect();
  ignorePutFor.add("W2");
  const r = await call("set_work_client_group", {
    reason: "test live", dryRun: false,
    items: [{ workKey: "W1", clientGroupKey: "G1" }, { workKey: "W2", clientGroupKey: "G1" }, { workKey: "W4", clientGroupKey: "G1" }],
  });
  assert.deepEqual(r.results.map(x => x.status), ["verified", "not_persisted", "verified"]);
  assert.match(r.results[1].note, /Change Client/);

  const p1 = puts.find(p => p.WorkItemKey === "W1");
  assert.equal(p1.PrimaryStatus, "In Progress");
  assert.equal(p1.RelatedClientGroupKey, "G1");
  assert.equal(p1.ClientGroupKey, "G1");
  assert.ok(!Object.keys(p1).some(k => k.startsWith("@odata")));
  assert.equal(puts.find(p => p.WorkItemKey === "W4").PrimaryStatus, "Ready To Start");
  assert.equal(store.W1.RelatedClientGroupKey, "G1");
});
