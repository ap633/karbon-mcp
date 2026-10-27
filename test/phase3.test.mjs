// Phase 3 tests: payments, business cards, $expand on contacts/organizations.
// Karbon is mocked by replacing fetch. Run: npm test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { clientConfig } from "../dist/karbon.js";

const sleeps = [];
clientConfig.sleep = async (ms) => { sleeps.push(ms); };
console.log = () => {};

let db, log, queue, flags;
const API = "https://api.karbonhq.com/v3";

function reset() {
  sleeps.length = 0;
  log = [];
  queue = [];
  flags = { ignorePuts: false, reformatPhones: false };
  db = {
    payments: Array.from({ length: 3 }, (_, i) => ({ PaymentKey: `P${i + 1}`, PaymentReference: `KPY-${1001 + i}`, PaymentType: "Payment", PaymentDate: "2026-09-01", GrossAmount: 100 * (i + 1), PaymentMethod: "Card" })),
    cards: {
      BC1: {
        BusinessCardKey: "BC1", EntityType: "Contact", EntityKey: "C1", IsPrimaryCard: true, OrganizationKey: "O1", RoleOrTitle: "Director",
        WebSites: ["dream.com.au"], EmailAddresses: ["jo@client.au"],
        PhoneNumbers: [{ PhoneNumberKey: "PN1", Number: "0412 345 678", CountryCode: "AU", Label: "Mobile" }, { PhoneNumberKey: "PN2", Number: "02 9999 0000", CountryCode: "AU", Label: "Work" }],
        Addresses: [{ AddressKey: "AK1", AddressLines: "1 Main St", City: "Sydney", StateProvinceCounty: "NSW", ZipCode: "2000", CountryCode: "AU", Label: "Physical" }],
        FacebookLink: null, LinkedInLink: "linkedin.com/jo", TwitterLink: null, SkypeLink: null,
      },
      BCO: { BusinessCardKey: "BCO", EntityType: "Organization", EntityKey: "O1", IsPrimaryCard: true, OrganizationKey: null, EmailAddresses: [], WebSites: [], PhoneNumbers: [], Addresses: [] },
    },
  };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const noContent = () => new Response(null, { status: 204 });
const conflict = () => json({ error: { code: "4020", message: "The resource was modified by another request. Refetch the latest version and retry." } }, 409);
const rateLimited = () => json({ statusCode: "429", message: "Rate limit is exceeded. Try again in 10 seconds." }, 429);
const once = (method, re, respond) => queue.push({ method, re, respond });
let keySeq = 0;

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const method = opts.method ?? "GET";
  const path = decodeURIComponent(u.pathname).replace(/^\/v3/i, "");
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  log.push({ method, path, url: u, body });
  const qi = queue.findIndex(q => q.method === method && q.re.test(path));
  if (qi >= 0) return queue.splice(qi, 1)[0].respond();

  let m;
  if (path === "/Payments") {
    // Spec: array documented as "values"; $skip capped at 100 — nextLink only.
    const top = Number(u.searchParams.get("$top") ?? 100);
    const skip = Number(u.searchParams.get("$skip") ?? 0);
    const next = skip + top < db.payments.length ? `${API}/Payments?$top=${top}&$skip=${skip + top}` : undefined;
    return json({ "@odata.count": db.payments.length, values: db.payments.slice(skip, skip + top), ...(next ? { "@odata.nextLink": next } : {}) });
  }
  if ((m = path.match(/^\/Payments\/(\w+)$/))) return json(db.payments.find(p => p.PaymentKey === m[1]));
  if ((m = path.match(/^\/BusinessCards\/(\w+)$/))) {
    const card = db.cards[m[1]];
    if (!card) return json({ error: { code: "4004", message: "not found" } }, 404);
    if (method === "GET") return json({ "@odata.context": "ctx", ...card });
    if (method === "PUT") {
      if (body.BusinessCardKey !== m[1] || !body.EntityType || !body.EntityKey) return json({ error: { code: "4000", message: "keys" } }, 400);
      if ((body.PhoneNumbers ?? []).some(p => "PhoneNumberKey" in p) || (body.Addresses ?? []).some(a => "AddressKey" in a)) return json({ error: { code: "4001", message: "Unsupported option" } }, 400);
      if (flags.ignorePuts) return noContent();
      db.cards[m[1]] = {
        ...body,
        PhoneNumbers: body.PhoneNumbers.map(p => ({ PhoneNumberKey: `NEW${++keySeq}`, ...p, Number: flags.reformatPhones ? p.Number.replace(/\s/g, "") : p.Number })),
        Addresses: body.Addresses.map(a => ({ AddressKey: `NEW${++keySeq}`, ...a })),
      };
      return noContent();
    }
  }
  if ((m = path.match(/^\/(Contacts|Organizations)\/(\w+)$/))) return json({ key: m[2], expand: u.searchParams.get("$expand") });
  if (path === "/WorkItems") return json({ value: (u.searchParams.get("$filter") ?? "").includes("'Ready To Start'") ? [{ WorkItemKey: "W1" }] : [] });
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
const card = () => db.cards.BC1;

// ── Payments ─────────────────────────────────────────────────────────────────
test("list_payments follows nextLink and reads the documented 'values' array", async () => {
  const r = await call("list_payments", { maxRecords: 2 });
  assert.equal(r.returned, 2);
  assert.ok(r["@odata.nextLink"]);
  const r2 = await call("list_payments", { nextLink: r["@odata.nextLink"] });
  assert.deepEqual(r2.value.map(p => p.PaymentKey), ["P3"]);
  assert.equal(log[0].url.searchParams.get("$top"), "2");
});

test("get_payment retries a 429 after the stated delay", async () => {
  once("GET", /^\/Payments\/P2$/, rateLimited);
  const r = await call("get_payment", { paymentKey: "P2" });
  assert.equal(r.GrossAmount, 200);
  assert.deepEqual(sleeps, [10_000]);
});

// ── $expand ──────────────────────────────────────────────────────────────────
test("get_contact / get_organization: expand is off by default and comma-joined when set", async () => {
  assert.equal((await call("get_contact", { contactKey: "C1" })).expand, null);
  assert.equal((await call("get_contact", { contactKey: "C1", expand: ["BusinessCards", "ClientTeam", "BusinessCards"] })).expand, "BusinessCards,ClientTeam");
  assert.equal((await call("get_organization", { organizationKey: "O1", expand: ["Contacts", "ServiceTypes"] })).expand, "Contacts,ServiceTypes");
  const bad = await call("get_organization", { organizationKey: "O1", expand: ["ClientAccess"] });
  assert.equal(bad.isError, true);
});

// ── update_business_card ─────────────────────────────────────────────────────
test("upserting one phone keeps everything else and sends the keys the PUT needs", async () => {
  const r = await call("update_business_card", { businessCardKey: "BC1", upsertPhoneNumbers: [{ number: "0400 000 111", label: "Mobile" }], addEmailAddresses: ["jo@other.au"], reason: "test" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const body = puts()[0].body;
  assert.equal(body.BusinessCardKey, "BC1");
  assert.equal(body.EntityType, "Contact");
  assert.equal(body.EntityKey, "C1");
  assert.equal(body.OrganizationKey, "O1");
  assert.deepEqual(body.PhoneNumbers, [{ Number: "0400 000 111", CountryCode: "AU", Label: "Mobile" }, { Number: "02 9999 0000", CountryCode: "AU", Label: "Work" }]);
  assert.deepEqual(body.EmailAddresses, ["jo@client.au", "jo@other.au"]);
  assert.equal(body.Addresses[0].City, "Sydney");
  assert.equal(body.LinkedInLink, "linkedin.com/jo");
  assert.ok(!Object.keys(body).some(k => k.startsWith("@odata")));
});

test("address upsert by label, country defaults to AU, phone reformatting by Karbon is tolerated", async () => {
  flags.reformatPhones = true;
  const r = await call("update_business_card", { businessCardKey: "BC1", upsertAddresses: [{ addressLines: "PO Box 1", city: "Sydney", stateProvinceCounty: "NSW", zipCode: "2001", label: "Mailing" }], reason: "test" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(card().Addresses.map(a => [a.Label, a.CountryCode]), [["Physical", "AU"], ["Mailing", "AU"]]);
});

test("labels and country codes are validated before anything is written", async () => {
  const badLabel = await call("update_business_card", { businessCardKey: "BC1", upsertPhoneNumbers: [{ number: "1", label: "Cell" }], reason: "test" });
  assert.equal(badLabel.isError, true);
  const badCountry = await call("update_business_card", { businessCardKey: "BC1", upsertAddresses: [{ city: "X", countryCode: "AUS", label: "Physical" }], reason: "test" });
  assert.match(badCountry.errors[0], /'AUS' isn't an ISO 3166-1 alpha-2/);
  const orgLink = await call("update_business_card", { businessCardKey: "BCO", organizationKey: "O9", reason: "test" });
  assert.match(orgLink.errors[0], /always null on an Organization/);
  assert.equal(puts().length, 0);
});

test("silent failure: PUT returns 204 but the card is unchanged → reported as failure", async () => {
  flags.ignorePuts = true;
  const r = await call("update_business_card", { businessCardKey: "BC1", roleOrTitle: "CFO", reason: "test" });
  assert.equal(r.status, 204);
  assert.equal(r.ok, false);
  assert.match(r.failures[0], /^RoleOrTitle: expected "CFO", got "Director"/);
});

test("a PUT that wipes another part of the card is reported as a failure", async () => {
  once("PUT", /^\/BusinessCards\/BC1$/, () => { db.cards.BC1 = { ...db.cards.BC1, RoleOrTitle: "CFO", Addresses: [] }; return noContent(); });
  const r = await call("update_business_card", { businessCardKey: "BC1", roleOrTitle: "CFO", reason: "test" });
  assert.equal(r.ok, false);
  assert.ok(r.failures.some(f => /^Addresses changed unexpectedly/.test(f)));
});

test("409: re-reads the card, reapplies the edit and retries", async () => {
  once("PUT", /^\/BusinessCards\/BC1$/, () => { db.cards.BC1.EmailAddresses = [...db.cards.BC1.EmailAddresses, "new@client.au"]; return conflict(); });
  const r = await call("update_business_card", { businessCardKey: "BC1", addEmailAddresses: ["jo@other.au"], reason: "test" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.conflictRetries, 1);
  assert.deepEqual(card().EmailAddresses, ["jo@client.au", "new@client.au", "jo@other.au"]);
});

test("upsert refuses when two existing entries share the label", async () => {
  db.cards.BC1.PhoneNumbers.push({ PhoneNumberKey: "PN3", Number: "0499 999 999", CountryCode: "AU", Label: "Mobile" });
  const r = await call("update_business_card", { businessCardKey: "BC1", upsertPhoneNumbers: [{ number: "0400 000 111", label: "Mobile" }], reason: "test" });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /2 phone numbers labelled Mobile/);
  assert.equal(puts().length, 0);
});

test("update_business_card requires a reason", async () => {
  const { tools } = await client.listTools();
  assert.ok(tools.find(t => t.name === "update_business_card").inputSchema.required.includes("reason"));
});

// ── Regression: PrimaryStatus in the no-space form ───────────────────────────
test("list_work normalises 'ReadyToStart' to 'Ready To Start'", async () => {
  const r = await call("list_work", { primaryStatus: "ReadyToStart" });
  assert.equal(r.returned, 1);
  assert.equal(log[0].url.searchParams.get("$filter"), "PrimaryStatus eq 'Ready To Start'");
});
