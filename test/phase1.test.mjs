// Phase 1 tests: shared client behaviour (429, 409, nextLink paging, read-back
// verification) and the audited tools. Karbon is mocked by replacing fetch.
// Run: npm test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { clientConfig, clearTenantCache, normalizeStatusFilter, rateLimitDelayMs, pageAll, toSpacedStatus } from "../dist/karbon.js";

const sleeps = [];
clientConfig.sleep = async (ms) => { sleeps.push(ms); };
console.log = () => {}; // silence audit lines

// ── Mock Karbon ──────────────────────────────────────────────────────────────
const SPACED = { InProgress: "In Progress", ReadyToStart: "Ready To Start" };
const NOSPACE = (s) => (s ?? "").replace(/\s+/g, "");
const API = "https://api.karbonhq.com/v3";

let db, log, queue, flags;

function reset() {
  sleeps.length = 0;
  clearTenantCache();
  log = [];
  queue = [];
  flags = { ignoreWorkPuts: false, budgetByAmount: false };
  db = {
    tenant: {
      WorkStatuses: [
        { Name: "InProgress", Type: "Primary", Children: [
          { Name: "Send client requests", Type: "Secondary", WorkStatusKey: "S1" },
          { Name: "In review", Type: "Secondary", WorkStatusKey: "S2" },
        ] },
        { Name: "Waiting", Type: "Primary", Children: [{ Name: "Waiting on client", Type: "Secondary", WorkStatusKey: "S3" }] },
        { Name: "Planned", Type: "Primary", Children: [] },
        { Name: "Completed", Type: "Primary", Children: [] },
      ],
      WorkTypes: [
        { Name: "Tax", WorkTypeKey: "T1", AvailableStatuses: { primary: [], secondary: ["S1", "S3"] } },
        { Name: "Payroll", WorkTypeKey: "T2", AvailableStatuses: { primary: [], secondary: ["S2"] } },
      ],
    },
    work: {
      W1: { WorkItemKey: "W1", Title: "ITR 2026", ClientKey: "C1", ClientType: "Contact", AssigneeEmailAddress: "a@x.au", StartDate: "2026-07-01T00:00:00Z", DueDate: "2026-10-31T00:00:00Z", DeadlineDate: null, WorkType: "Tax", PrimaryStatus: "Planned", SecondaryStatus: null, FeeSettings: { FeeType: "TimeAndMaterials", FeeValue: null }, UserRoleAssignments: [] },
      W2: { WorkItemKey: "W2", Title: "Payroll", ClientKey: "O1", ClientType: "Organization", AssigneeEmailAddress: "b@x.au", StartDate: "2026-07-01T00:00:00Z", DueDate: null, DeadlineDate: null, WorkType: "Payroll", PrimaryStatus: "InProgress", SecondaryStatus: "In review", FeeSettings: { FeeType: "FixedFee", FeeValue: 500 }, UserRoleAssignments: [] },
      W3: { WorkItemKey: "W3", Title: "BAS", ClientKey: "O1", ClientType: "Organization", AssigneeEmailAddress: "b@x.au", StartDate: "2026-08-01T00:00:00Z", WorkType: "Tax", PrimaryStatus: "InProgress", SecondaryStatus: null },
    },
    rows: {
      W1: [
        { EstimateSummaryKey: "E-OVERALL", UserKey: null, RoleKey: null, TaskTypeName: "None", EstimateMinutes: 60, EstimateAmount: 150, HourlyRate: 150, ActualMinutes: 0 },
        { EstimateSummaryKey: "0-LOGGED", UserKey: "U1", RoleKey: null, TaskTypeName: "Admin", EstimateMinutes: null, ActualMinutes: 30 },
      ],
    },
    contacts: { C1: { ContactKey: "C1", FirstName: "Cam", LastName: "Lee", PreferredName: null } },
    orgs: { O1: { OrganizationKey: "O1", FullName: "Org One", ClientOwner: "a@x.au", ClientManager: "b@x.au", ContactType: "Client", BusinessCards: [{ BusinessCardKey: "BC1", EmailAddresses: ["o@o.au"] }], ClientTeam: [{ UserKey: "U1" }], AccountingDetail: { Abn: "1" } } },
  };
}

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const noContent = (headers = {}) => new Response(null, { status: 204, headers });
const conflict = () => json({ error: { code: "4020", message: "The resource was modified by another request. Refetch the latest version and retry." } }, 409);
const rateLimited = () => json({ statusCode: "429", message: "Rate limit is exceeded. Try again in 10 seconds." }, 429);

// Queue a one-off response for the next request matching method + path regex.
const once = (method, re, respond) => queue.push({ method, re, respond });

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const method = opts.method ?? "GET";
  const path = decodeURIComponent(u.pathname).replace(/^\/v3/i, "");
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  log.push({ method, path, url: u, body, headers: opts.headers });
  const qi = queue.findIndex(q => q.method === method && q.re.test(path));
  if (qi >= 0) return queue.splice(qi, 1)[0].respond();

  let m;
  if (/^\/tenantsettings$/i.test(path)) return json(db.tenant);

  if (/^\/workitems$/i.test(path) && method === "GET") {
    const f = u.searchParams.get("$filter") ?? "";
    const st = f.match(/PrimaryStatus eq '([^']+)'/)?.[1];
    // Karbon: only the spaced form matches; the no-space form silently returns nothing.
    let rows = Object.values(db.work).map(w => ({ ...w, PrimaryStatus: SPACED[w.PrimaryStatus] ?? w.PrimaryStatus }));
    if (st) rows = rows.filter(w => w.PrimaryStatus === st);
    const top = Number(u.searchParams.get("$top") ?? 100);
    const skip = Number(u.searchParams.get("$skip") ?? 0);
    const page = rows.slice(skip, skip + top);
    const next = skip + top < rows.length ? (() => { const n = new URL(u); n.searchParams.set("$skip", String(skip + top)); return n.toString(); })() : undefined;
    return json({ "@odata.count": rows.length, value: page, ...(next ? { "@odata.nextLink": next } : {}) });
  }

  if ((m = path.match(/^\/workitems(?:\/|\(')(\w+)(?:'\))?$/i))) {
    const w = db.work[m[1]];
    if (!w) return json({ error: { code: "4004", message: "not found" } }, 404);
    if (method === "GET") return json({ "@odata.context": "ctx", ...w });
    if (method === "PATCH") {
      const allowed = ["Title", "Description", "StartDate", "DueDate", "DeadlineDate", "AssigneeEmailAddress", "WorkType", "UserRoleAssignments"];
      if (Object.keys(body).some(k => !allowed.includes(k))) return json({ error: { code: "4002", message: "bad property" } }, 400);
      Object.assign(w, body);
      return noContent();
    }
    if (method === "PUT") {
      if (body.WorkItemKey !== m[1]) return json({ error: { code: "4000", message: "WorkItemKey missing" } }, 400);
      for (const k of ["AssigneeEmailAddress", "Title", "ClientKey", "ClientType", "StartDate"]) if (!body[k]) return json({ error: { code: "4000", message: `${k} required` } }, 400);
      if (flags.ignoreWorkPuts) return noContent(); // the silent failure: 204, nothing written
      const ps = NOSPACE(body.PrimaryStatus);
      const primary = db.tenant.WorkStatuses.find(s => s.Name === ps);
      const wt = db.tenant.WorkTypes.find(t => t.Name === body.WorkType);
      const sec = primary?.Children.find(c => c.Name === body.SecondaryStatus && wt?.AvailableStatuses.secondary.includes(c.WorkStatusKey));
      db.work[m[1]] = { ...w, PrimaryStatus: ps, SecondaryStatus: sec ? sec.Name : null, FeeSettings: body.FeeSettings };
      return noContent();
    }
  }

  if ((m = path.match(/^\/estimatesummaries\/(\w+)$/i))) return json({ value: db.rows[m[1]] ?? [] });

  if ((m = path.match(/^\/workitems(?:\/|\(')(\w+)(?:'\))?\/estimatesummaries(?:\/|\(')([\w-]+)(?:'\))?$/i))) {
    const rows = db.rows[m[1]] ?? [];
    const row = rows.find(r => r.EstimateSummaryKey === m[2]);
    if (!row) return json({ error: { code: "4004", message: "not found" } }, 404);
    if (method === "GET") return json(row);
    if (method === "PATCH") {
      if (flags.budgetByAmount && body.EstimateMinutes !== undefined) return json({ error: { code: "4022", message: "This estimate is budgeted by amount." } }, 422);
      Object.assign(row, body);
      if (body.HourlyRate !== undefined) row.EstimateSummaryKey = `${m[2]}-R`;
      return noContent({ "OData-EntityId": `${API}/WorkItems('${m[1]}')/EstimateSummaries('${row.EstimateSummaryKey}')` });
    }
  }

  if (/^\/individualtimeentries$/i.test(path)) return json({ value: [] });

  if ((m = path.match(/^\/contacts\/(\w+)$/i))) {
    const c = db.contacts[m[1]];
    if (method === "GET") return json({ "@odata.context": "ctx", ...c });
    if (method === "PATCH") { Object.assign(c, body); return noContent(); }
  }

  if ((m = path.match(/^\/organizations\/(\w+)$/i))) {
    const o = db.orgs[m[1]];
    if (method === "GET") return json({ "@odata.context": "ctx", ...o });
    if (method === "PUT") { db.orgs[m[1]] = { ...o, ...body }; return noContent(); }
  }

  return json({ error: { code: "4004", message: `unmocked ${method} ${path}` }, }, 404);
};

let call, client;
async function connect() {
  const server = createServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const t = r.content[0].text;
    try { return JSON.parse(t); } catch { return { raw: t, isError: r.isError }; }
  };
}

beforeEach(async () => { reset(); await connect(); });

const puts = () => log.filter(l => l.method === "PUT");

// ── Helpers ──────────────────────────────────────────────────────────────────
test("normalizeStatusFilter rewrites no-space PrimaryStatus values", () => {
  assert.equal(normalizeStatusFilter("PrimaryStatus eq 'InProgress'"), "PrimaryStatus eq 'In Progress'");
  assert.equal(normalizeStatusFilter("primarystatus eq 'readytostart' and AssigneeEmailAddress eq 'a@x.au'"), "primarystatus eq 'Ready To Start' and AssigneeEmailAddress eq 'a@x.au'");
  assert.equal(normalizeStatusFilter("Title eq 'InProgress'"), "Title eq 'InProgress'");
  assert.equal(toSpacedStatus("Waiting"), "Waiting");
});

test("rateLimitDelayMs reads the delay from the message", () => {
  assert.equal(rateLimitDelayMs('{"message":"Rate limit is exceeded. Try again in 10 seconds."}', null), 10_000);
  assert.equal(rateLimitDelayMs("slow down", "3"), 3_000);
  assert.equal(rateLimitDelayMs("slow down", null), 10_000);
});

// ── PrimaryStatus filter (no-space form) ─────────────────────────────────────
test("list_work: a no-space PrimaryStatus filter is normalised and returns rows", async () => {
  const r = await call("list_work", { filter: "PrimaryStatus eq 'InProgress'" });
  assert.equal(r.filterUsed, "PrimaryStatus eq 'In Progress'");
  assert.deepEqual(r.value.map(w => w.WorkItemKey).sort(), ["W2", "W3"]);
  assert.equal(log[0].url.searchParams.get("$filter"), "PrimaryStatus eq 'In Progress'");
});

test("list_work: primaryStatus parameter accepts either spelling", async () => {
  const r = await call("list_work", { primaryStatus: "inprogress", filter: "AssigneeEmailAddress eq 'b@x.au'" });
  assert.equal(r.filterUsed, "PrimaryStatus eq 'In Progress' and (AssigneeEmailAddress eq 'b@x.au')");
  const bad = await call("list_work", { primaryStatus: "Doing" });
  assert.equal(bad.ok, false);
});

// ── Paging ───────────────────────────────────────────────────────────────────
test("pageAll follows @odata.nextLink with $top ≤ 100 and never builds $skip itself", async () => {
  const p = await pageAll("/workitems", {}, { pageSize: 1 });
  assert.equal(p.value.length, 3);
  assert.equal(p.nextLink, null);
  assert.equal(log.length, 3);
  assert.equal(log[0].url.searchParams.get("$top"), "1");
  assert.equal(log[0].url.searchParams.get("$skip"), null);
  assert.equal(log[1].url.searchParams.get("$skip"), "1"); // taken from nextLink
});

test("list tools stop at maxRecords and hand back @odata.nextLink to continue", async () => {
  const r = await call("list_work", { maxRecords: 2 });
  assert.equal(r.returned, 2);
  assert.ok(r["@odata.nextLink"]);
  assert.equal(log[0].url.searchParams.get("$top"), "2");
  const r2 = await call("list_work", { nextLink: r["@odata.nextLink"] });
  assert.equal(r2.returned, 1);
  assert.equal(r2["@odata.nextLink"], undefined);
});

test("a nextLink pointing at another host is refused", async () => {
  const r = await call("list_work", { nextLink: "https://evil.example.com/v3/WorkItems?$skip=100" });
  assert.match(r.raw, /non-Karbon URL/);
  assert.equal(log.length, 0);
});

// ── 429 ──────────────────────────────────────────────────────────────────────
test("429: waits the delay given in the message, then retries", async () => {
  once("GET", /^\/workitems\/W1$/i, rateLimited);
  const r = await call("get_work", { workKey: "W1" });
  assert.equal(r.WorkItemKey, "W1");
  assert.deepEqual(sleeps, [10_000]);
  assert.equal(log.length, 2);
});

// ── 409 ──────────────────────────────────────────────────────────────────────
test("409: re-fetches, reapplies and retries the write", async () => {
  once("PUT", /^\/workitems\/W1$/i, conflict);
  const r = await call("update_work_status", { workKey: "W1", primaryStatus: "In Progress", secondaryStatus: "Send client requests", reason: "test" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.conflictRetries, 1);
  assert.equal(puts().length, 2);
  // re-fetch before each attempt: initial validation GET + 2 attempt GETs + read-back
  assert.equal(log.filter(l => l.method === "GET" && /^\/workitems\/W1$/i.test(l.path)).length, 4);
});

test("409 that keeps happening fails clearly after 3 attempts", async () => {
  for (let i = 0; i < 3; i++) once("PUT", /^\/workitems\/W1$/i, conflict);
  const r = await call("update_karbon_workitem_fee_budget", { workItemKey: "W1", feeType: "FixedFee", feeValue: 900, reason: "test" });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.match(r.error, /concurrency conflict/);
  assert.equal(puts().length, 3);
});

// ── Silent failure: success response, nothing persisted ──────────────────────
test("fee write: 204 with no change on read-back is reported as a failure", async () => {
  flags.ignoreWorkPuts = true;
  const r = await call("update_karbon_workitem_fee_budget", { workItemKey: "W1", feeType: "FixedFee", feeValue: 900, reason: "test" });
  assert.equal(r.status, 204);
  assert.equal(r.ok, false);
  assert.equal(r.verified, false);
  assert.ok(r.failures.some(f => f.startsWith("FeeSettings.FeeType")));
});

test("status write: 204 with no change on read-back is reported as a failure", async () => {
  flags.ignoreWorkPuts = true;
  const r = await call("update_work_status", { workKey: "W1", primaryStatus: "Waiting", reason: "test" });
  assert.equal(r.ok, false);
  assert.ok(r.failures.some(f => f.startsWith("PrimaryStatus")));
});

test("contact PATCH: 204 with no change on read-back is reported as a failure", async () => {
  once("PATCH", /^\/contacts\/C1$/i, () => noContent());
  const r = await call("update_contact", { contactKey: "C1", preferredName: "Cammy", reason: "test" });
  assert.equal(r.ok, false);
  assert.deepEqual(log.find(l => l.method === "PATCH").body, { PreferredName: "Cammy" });
});

// ── update_work_status / SecondaryStatus ──────────────────────────────────────
test("update_work_status: valid secondary is sent, PUT carries required fields and the key", async () => {
  const r = await call("update_work_status", { workKey: "W1", primaryStatus: "InProgress", secondaryStatus: "send client requests", reason: "test" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.after, { PrimaryStatus: "InProgress", SecondaryStatus: "Send client requests" });
  const body = puts()[0].body;
  assert.equal(body.WorkItemKey, "W1");
  assert.equal(body.PrimaryStatus, "In Progress");
  assert.equal(body.SecondaryStatus, "Send client requests");
  assert.deepEqual(body.FeeSettings, { FeeType: "TimeAndMaterials", FeeValue: null });
  assert.ok(!Object.keys(body).some(k => k.startsWith("@odata")));
});

test("update_work_status: secondary valid for the primary but not the WorkType is refused with the valid list", async () => {
  const r = await call("update_work_status", { workKey: "W1", primaryStatus: "In Progress", secondaryStatus: "In review", reason: "test" });
  assert.equal(r.ok, false);
  assert.deepEqual(r.validSecondaryStatuses, ["Send client requests"]);
  assert.equal(puts().length, 0);
});

test("update_work_status: SecondaryStatus coming back null is a failure", async () => {
  once("PUT", /^\/workitems\/W1$/i, () => { db.work.W1 = { ...db.work.W1, PrimaryStatus: "InProgress", SecondaryStatus: null }; return noContent(); });
  const r = await call("update_work_status", { workKey: "W1", primaryStatus: "In Progress", secondaryStatus: "Send client requests", reason: "test" });
  assert.equal(r.ok, false);
  assert.ok(r.failures.some(f => /SecondaryStatus came back null/.test(f)));
});

test("update_work_status: an existing secondary that's invalid for the new primary is cleared and noted", async () => {
  const r = await call("update_work_status", { workKey: "W2", primaryStatus: "Waiting", reason: "test" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(puts()[0].body.SecondaryStatus, null);
  assert.match(r.notes[0], /will be cleared/);
});

test("update_work_status requires a reason", async () => {
  const r = await call("update_work_status", { workKey: "W1", primaryStatus: "Waiting" });
  assert.equal(r.isError, true);
  assert.equal(puts().length, 0);
});

// ── Fee settings ─────────────────────────────────────────────────────────────
test("fee: TimeAndMaterials / NonBillable send FeeValue null; FixedFee needs a value", async () => {
  const r = await call("update_karbon_workitem_fee_budget", { workItemKey: "W2", feeType: "NonBillable", reason: "test" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(puts()[0].body.FeeSettings, { FeeType: "NonBillable", FeeValue: null });
  assert.equal(puts()[0].body.PrimaryStatus, "In Progress");
  const missing = await call("update_karbon_workitem_fee_budget", { workItemKey: "W1", feeType: "FixedFee", reason: "test" });
  assert.match(missing.error, /feeValue is required/);
  const extra = await call("update_karbon_workitem_fee_budget", { workItemKey: "W1", feeType: "TimeAndMaterials", feeValue: 10, reason: "test" });
  assert.match(extra.error, /must be omitted/);
});

// ── Estimate summaries ───────────────────────────────────────────────────────
test("estimate: HourlyRate change follows OData-EntityId to the reissued key", async () => {
  const r = await call("update_karbon_estimate_minutes", { workItemKey: "W1", hourlyRate: 200, reason: "test" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.estimateSummaryKey, "E-OVERALL-R");
  assert.equal(r.previousEstimateSummaryKey, "E-OVERALL");
  assert.equal(r.after.HourlyRate, 200);
  assert.ok(log.some(l => l.method === "GET" && /EstimateSummaries\('E-OVERALL-R'\)/i.test(l.path)));
});

test("estimate: minutes on an amount-budgeted firm gives a clear hint", async () => {
  flags.budgetByAmount = true;
  const r = await call("update_karbon_estimate_minutes", { workItemKey: "W1", estimateMinutes: 90, reason: "test" });
  assert.equal(r.ok, false);
  assert.equal(r.status, 422);
  assert.match(r.hint, /send estimateAmount/);
});

test("estimate: refuses 0- rows and both minutes and amount together", async () => {
  const r0 = await call("update_karbon_estimate_minutes", { workItemKey: "W1", estimateMinutes: 10, estimateSummaryKey: "0-LOGGED", reason: "test" });
  assert.match(r0.error, /read-only/);
  const both = await call("update_karbon_estimate_minutes", { workItemKey: "W1", estimateMinutes: 10, estimateAmount: 5, reason: "test" });
  assert.match(both.error, /not both/);
  assert.equal(log.filter(l => l.method === "PATCH").length, 0);
});

test("estimate: minutes write verified on read-back", async () => {
  const r = await call("update_karbon_estimate_minutes", { workItemKey: "W1", estimateMinutes: 919, reason: "test" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(log.find(l => l.method === "PATCH").body, { EstimateMinutes: 919 });
  assert.equal(r.after.EstimateMinutes, 919);
});

// ── Time entries ─────────────────────────────────────────────────────────────
test("list_time_entries builds the documented filters and orderby", async () => {
  const r = await call("list_time_entries", { workItemKey: "W1", userKey: "U1", roleName: "O'Brien", dateFrom: "2026-07-01", dateBefore: "2026-08-01T00:00:00Z", orderBy: "Date desc" });
  assert.equal(r.filterUsed, "WorkItemKey eq 'W1' and UserKey eq 'U1' and RoleName eq 'O''Brien' and Date ge 2026-07-01T00:00:00Z and Date lt 2026-08-01T00:00:00Z");
  assert.equal(log[0].url.searchParams.get("$orderby"), "Date desc");
  assert.equal(log[0].url.searchParams.get("$top"), "100");
});

// ── Organizations ────────────────────────────────────────────────────────────
test("update_organization: owner change PUTs the merged record without BusinessCards", async () => {
  const r = await call("update_organization", { organizationKey: "O1", clientOwner: "c@x.au", reason: "test" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const body = puts()[0].body;
  assert.equal(body.OrganizationKey, "O1");
  assert.equal(body.ClientOwner, "c@x.au");
  assert.equal(body.ClientManager, "b@x.au");
  assert.equal(body.BusinessCards, undefined);
  assert.deepEqual(body.ClientTeam, [{ UserKey: "U1" }]);
});

// ── Removed tools / descriptions ─────────────────────────────────────────────
test("tool list: task tools removed, timesheets deprecated, every write needs a reason", async () => {
  const { tools } = await client.listTools();
  const names = tools.map(t => t.name);
  assert.ok(!names.includes("list_work_tasks"));
  assert.ok(!names.includes("update_task"));
  for (const n of ["list_timesheets", "get_timesheet"]) assert.match(tools.find(t => t.name === n).description, /^DEPRECATED.*list_time_entries/);
  const writes = ["create_contact", "update_contact", "create_organization", "update_organization", "create_client_group", "update_client_group", "create_work", "update_work", "update_work_status", "update_work_deadline", "create_note", "update_karbon_estimate_minutes", "update_karbon_workitem_fee_budget", "set_work_client_group"];
  for (const n of writes) assert.ok(tools.find(t => t.name === n).inputSchema.required.includes("reason"), `${n} must require reason`);
});
