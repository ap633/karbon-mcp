// Phase 2 tests: custom field definitions and values. Karbon is mocked by
// replacing fetch. Run: npm test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { clientConfig } from "../dist/karbon.js";
import { sameValue } from "../dist/customFields.js";

const sleeps = [];
clientConfig.sleep = async (ms) => { sleeps.push(ms); };
console.log = () => {};

let db, log, queue, flags;

function reset() {
  sleeps.length = 0;
  log = [];
  queue = [];
  flags = { ignorePuts: false, putDropsOthers: false };
  db = {
    defs: [
      { Key: "F-IND", Name: "Industry", Type: "ListSingleSelect", IsVisibleToContacts: true, IsVisibleToOrganizations: true, ListOptions: ["Agriculture", "Professional Services"] },
      { Key: "F-SVC", Name: "Services", Type: "ListMultipleSelect", IsVisibleToContacts: true, IsVisibleToOrganizations: true, ListOptions: ["Tax", "BAS", "Payroll"] },
      { Key: "F-RM", Name: "Relationship Manager", Type: "Colleague", IsVisibleToContacts: true, IsVisibleToOrganizations: true, ListOptions: [] },
      { Key: "F-REV", Name: "Revenue", Type: "Number", IsVisibleToContacts: false, IsVisibleToOrganizations: true, ListOptions: [] },
      { Key: "F-EOFY", Name: "Year End", Type: "Date", IsVisibleToContacts: false, IsVisibleToOrganizations: true, ListOptions: [] },
      { Key: "F-GST", Name: "GST Registered", Type: "Boolean", IsVisibleToContacts: false, IsVisibleToOrganizations: true, ListOptions: [] },
      { Key: "F-NOTE", Name: "Notes", Type: "Text", IsVisibleToContacts: true, IsVisibleToOrganizations: true, ListOptions: [] },
    ],
    values: {
      O1: [
        { Key: "F-IND", Name: "Industry", Type: "ListSingleSelect", Value: ["Agriculture"] },
        { Key: "F-RM", Name: "Relationship Manager", Type: "Colleague", Value: ["U1"] },
        { Key: "F-REV", Name: "Revenue", Type: "Number", Value: ["1000000"] },
        { Key: "F-NOTE", Name: "Notes", Type: "Text", Value: ["Keep"] },
      ],
    },
    users: { U1: { Id: "U1", Name: "Jo Smith", EmailAddress: "jo@dream.au" }, U2: { Id: "U2", Name: "Sam Lee", EmailAddress: "sam@dream.au" } },
  };
}

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const noContent = () => new Response(null, { status: 204 });
const conflict = () => json({ error: { code: "4020", message: "The resource was modified by another request. Refetch the latest version and retry." } }, 409);
const rateLimited = () => json({ statusCode: "429", message: "Rate limit is exceeded. Try again in 10 seconds." }, 429);
const once = (method, re, respond) => queue.push({ method, re, respond });

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const method = opts.method ?? "GET";
  const path = decodeURIComponent(u.pathname).replace(/^\/v3/i, "");
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  log.push({ method, path, url: u, body });
  const qi = queue.findIndex(q => q.method === method && q.re.test(path));
  if (qi >= 0) return queue.splice(qi, 1)[0].respond();

  let m;
  if (path === "/CustomFields" && method === "GET") return json({ "@odata.count": db.defs.length, value: db.defs });
  if (path === "/CustomFields" && method === "POST") {
    const def = { Key: `F-NEW${db.defs.length}`, ...body };
    db.defs.push(def);
    return json(def, 201);
  }
  if ((m = path.match(/^\/CustomFields\/([\w-]+)$/)) && method === "DELETE") {
    const i = db.defs.findIndex(d => d.Key === m[1]);
    if (i < 0) return json({ error: { code: "4004", message: "not found" } }, 404);
    db.defs.splice(i, 1);
    return noContent();
  }
  if ((m = path.match(/^\/CustomFieldValues\/(\w+)$/))) {
    if (method === "GET") return json({ EntityKey: m[1], CustomFieldValues: db.values[m[1]] ?? [] });
    if (method === "PUT") {
      if (body.EntityKey !== m[1]) return json({ error: { code: "4000", message: "EntityKey" } }, 400);
      if (flags.ignorePuts) return noContent();
      db.values[m[1]] = flags.putDropsOthers ? body.CustomFieldValues.slice(0, 1) : body.CustomFieldValues;
      return noContent();
    }
  }
  if (path === "/Users") {
    const email = (u.searchParams.get("$filter") ?? "").match(/EmailAddress eq '([^']+)'/)?.[1];
    return json({ value: Object.values(db.users).filter(x => x.EmailAddress === email) });
  }
  if ((m = path.match(/^\/Users\/(\w+)$/))) return db.users[m[1]] ? json(db.users[m[1]]) : json({ error: { code: "4004", message: "not found" } }, 404);
  if (path === "/WorkItems") return json({ value: (u.searchParams.get("$filter") ?? "").includes("'In Progress'") ? [{ WorkItemKey: "W1", PrimaryStatus: "In Progress" }] : [] });
  return json({ error: { code: "4004", message: `unmocked ${method} ${path}` } }, 404);
};

let call, client;
beforeEach(async () => {
  reset();
  const server = createServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const t = r.content[0].text;
    try { return JSON.parse(t); } catch { return { raw: t, isError: r.isError }; }
  };
});

const puts = () => log.filter(l => l.method === "PUT");
const valueOf = (key) => db.values.O1.find(v => v.Key === key)?.Value;

// ── Reads ────────────────────────────────────────────────────────────────────
test("list_custom_fields returns the definitions", async () => {
  const r = await call("list_custom_fields", {});
  assert.equal(r.count, 7);
  assert.equal(r.value[0].Key, "F-IND");
});

test("get_custom_field_values resolves Colleague UserKeys only when asked", async () => {
  const plain = await call("get_custom_field_values", { entityKey: "O1" });
  assert.equal(plain.CustomFieldValues.find(v => v.Key === "F-RM").Colleagues, undefined);
  assert.equal(log.filter(l => l.path.startsWith("/Users")).length, 0);
  const r = await call("get_custom_field_values", { entityKey: "O1", resolveColleagues: true });
  assert.deepEqual(r.CustomFieldValues.find(v => v.Key === "F-RM").Colleagues, [{ UserKey: "U1", Name: "Jo Smith", EmailAddress: "jo@dream.au" }]);
});

// ── set_custom_field_values: merge, validation, verification ─────────────────
test("set merges only the requested fields into the full set and verifies", async () => {
  const r = await call("set_custom_field_values", { entityKey: "O1", reason: "test", fields: [
    { name: "industry", value: "professional services" },
    { key: "F-SVC", value: ["tax", "BAS"] },
    { key: "F-GST", value: true },
    { key: "F-EOFY", value: "2026-06-30" },
  ] });
  assert.equal(r.ok, true, JSON.stringify(r));
  const body = puts()[0].body;
  assert.equal(body.EntityKey, "O1");
  assert.deepEqual(body.CustomFieldValues.map(v => v.Key), ["F-IND", "F-RM", "F-REV", "F-NOTE", "F-SVC", "F-GST", "F-EOFY"]);
  assert.deepEqual(valueOf("F-IND"), ["Professional Services"]);
  assert.deepEqual(valueOf("F-SVC"), ["Tax", "BAS"]);
  assert.deepEqual(valueOf("F-GST"), ["true"]);
  assert.deepEqual(valueOf("F-NOTE"), ["Keep"]); // untouched
  assert.deepEqual(valueOf("F-RM"), ["U1"]);
});

test("Colleague accepts an email and stores the UserKey; null clears a field", async () => {
  const r = await call("set_custom_field_values", { entityKey: "O1", reason: "test", fields: [{ key: "F-RM", value: ["sam@dream.au"] }, { key: "F-NOTE", value: null }] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(valueOf("F-RM"), ["U2"]);
  assert.deepEqual(valueOf("F-NOTE"), []);
});

test("invalid values are refused with the valid options and nothing is written", async () => {
  const r = await call("set_custom_field_values", { entityKey: "O1", reason: "test", fields: [
    { key: "F-IND", value: "Mining" },
    { key: "F-REV", value: "lots" },
    { key: "F-RM", value: ["nobody@dream.au"] },
    { name: "Nope", value: "x" },
  ] });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /'Mining' isn't an option. Valid options: 'Agriculture', 'Professional Services'/);
  assert.match(r.errors[1], /isn't a number/);
  assert.match(r.errors[2], /No Karbon user has the email/);
  assert.match(r.errors[3], /No custom field with name 'Nope'/);
  assert.equal(puts().length, 0);
});

test("silent failure: PUT returns 204 but nothing changed → reported as failure", async () => {
  flags.ignorePuts = true;
  const r = await call("set_custom_field_values", { entityKey: "O1", reason: "test", fields: [{ key: "F-NOTE", value: "Changed" }] });
  assert.equal(r.status, 204);
  assert.equal(r.ok, false);
  assert.match(r.failures[0], /^Notes: expected \["Changed"\], got \["Keep"\]/);
});

test("a PUT that wipes other fields is reported as a failure", async () => {
  flags.putDropsOthers = true;
  const r = await call("set_custom_field_values", { entityKey: "O1", reason: "test", fields: [{ key: "F-IND", value: "Agriculture" }] });
  assert.equal(r.ok, false);
  assert.ok(r.failures.some(f => /Relationship Manager changed unexpectedly/.test(f)));
});

test("409: re-reads the values, re-merges and retries", async () => {
  once("PUT", /^\/CustomFieldValues\/O1$/, () => { db.values.O1.push({ Key: "F-GST", Name: "GST Registered", Type: "Boolean", Value: ["true"] }); return conflict(); });
  const r = await call("set_custom_field_values", { entityKey: "O1", reason: "test", fields: [{ key: "F-NOTE", value: "Changed" }] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.conflictRetries, 1);
  // The retry carries the field another writer added in between.
  assert.ok(puts()[1].body.CustomFieldValues.some(v => v.Key === "F-GST"));
  assert.deepEqual(valueOf("F-GST"), ["true"]);
});

test("429 on read: waits the given delay, then retries", async () => {
  once("GET", /^\/CustomFieldValues\/O1$/, rateLimited);
  const r = await call("get_custom_field_values", { entityKey: "O1" });
  assert.equal(r.EntityKey, "O1");
  assert.deepEqual(sleeps, [10_000]);
});

test("sameValue tolerates Karbon's echo formats", () => {
  assert.ok(sameValue("Date", ["2026-06-30"], ["2026-06-30T00:00:00Z"]));
  assert.ok(sameValue("Boolean", ["true"], ["True"]));
  assert.ok(sameValue("ListMultipleSelect", ["Tax", "BAS"], ["BAS", "Tax"]));
  assert.ok(sameValue("Number", ["1000"], ["1000.0"]));
  assert.ok(!sameValue("Text", ["a"], ["A"]));
});

// ── Definitions ──────────────────────────────────────────────────────────────
test("create_custom_field validates, refuses duplicates and verifies", async () => {
  assert.match((await call("create_custom_field", { name: "Tier", type: "ListSingleSelect", isVisibleToContacts: true, isVisibleToOrganizations: true, reason: "t" })).error, /needs listOptions/);
  assert.match((await call("create_custom_field", { name: "industry", type: "Text", isVisibleToContacts: true, isVisibleToOrganizations: true, reason: "t" })).error, /already exists/);
  const r = await call("create_custom_field", { name: "Tier", type: "ListSingleSelect", isVisibleToContacts: false, isVisibleToOrganizations: true, listOptions: ["A", "B"], reason: "t" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.definition.Name, "Tier");
  assert.equal(log.filter(l => l.method === "POST").length, 1);
});

test("delete_custom_field needs confirm=true and verifies the definition is gone", async () => {
  const preview = await call("delete_custom_field", { customFieldKey: "F-NOTE", reason: "t" });
  assert.equal(preview.deleted, false);
  assert.equal(preview.wouldDelete.Name, "Notes");
  assert.equal(log.filter(l => l.method === "DELETE").length, 0);

  once("DELETE", /^\/CustomFields\/F-NOTE$/, noContent); // 204 but still there
  const silent = await call("delete_custom_field", { customFieldKey: "F-NOTE", confirm: true, reason: "t" });
  assert.equal(silent.ok, false);
  assert.match(silent.failures[0], /still listed/);

  const r = await call("delete_custom_field", { customFieldKey: "F-NOTE", confirm: true, reason: "t" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(!db.defs.some(d => d.Key === "F-NOTE"));
});

test("every Phase 2 write tool requires a reason", async () => {
  const { tools } = await client.listTools();
  for (const n of ["set_custom_field_values", "create_custom_field", "delete_custom_field"]) {
    assert.ok(tools.find(t => t.name === n).inputSchema.required.includes("reason"), n);
  }
});

// ── Regression: PrimaryStatus in the no-space form ───────────────────────────
test("list_work still normalises a no-space PrimaryStatus filter", async () => {
  const r = await call("list_work", { filter: "PrimaryStatus eq 'InProgress'" });
  assert.equal(r.returned, 1);
  assert.equal(log[0].url.searchParams.get("$filter"), "PrimaryStatus eq 'In Progress'");
});
