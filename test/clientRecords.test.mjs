// Client record tests: description write, contact type, group members,
// update_contact email/phone, includeDescription and list_all_clients.
// Karbon is mocked by replacing fetch. Run: npm test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { clientConfig, clearTenantCache } from "../dist/karbon.js";
import { alreadyPresent, normDescription } from "../dist/clientRecords.js";

clientConfig.sleep = async () => {};
console.log = () => {};

let db, log, queue, flags;
const HUBSPOT = "https://app.hubspot.com/contacts/1/company/2";
const SP = "https://dreamaccounting.sharepoint.com/sites/Clients/Shared%20Documents/Smith";

function reset() {
  clearTenantCache();
  log = [];
  queue = [];
  flags = { ignorePuts: false, htmlDescriptions: false, dropOnPut: null };
  db = {
    Contacts: {
      C1: {
        ContactKey: "C1", FirstName: "Jo", MiddleName: null, LastName: "Smith", PreferredName: null, Salutation: "Ms", Suffix: null,
        ClientOwner: "andrea@dream.au", ClientManager: "sam@dream.au", ContactType: "Client", UserDefinedIdentifier: null, RestrictionLevel: "Public",
        AvatarUrl: "https://x/avatar", EntityDescription: { Text: HUBSPOT }, AccountingDetail: { BirthDate: "1980-01-01T00:00:00Z", Notes: "n" },
        ClientTeam: [{ MemberKey: "U1", MemberType: "User", RoleType: "Manager" }],
        BusinessCards: [{ BusinessCardKey: "BC1", EntityType: "Contact", EntityKey: "C1", IsPrimaryCard: true, EmailAddresses: ["jo@client.au"], WebSites: [], PhoneNumbers: [{ PhoneNumberKey: "PN1", Number: "0412 345 678", CountryCode: "AU", Label: "Mobile" }], Addresses: [] }],
      },
      C2: { ContactKey: "C2", FirstName: "Al", LastName: "Nocard", ContactType: "Client", EntityDescription: null, BusinessCards: [] },
    },
    Organizations: {
      O1: { OrganizationKey: "O1", FullName: "Smith Pty Ltd", ClientOwner: "andrea@dream.au", ClientManager: null, ContactType: "Client", RestrictionLevel: "Public", EntityDescription: null, AccountingDetail: { LegalName: "Smith Pty Ltd" }, ClientTeam: [], BusinessCards: [{ BusinessCardKey: "BCO", EntityType: "Organization", EntityKey: "O1" }] },
      O2: { OrganizationKey: "O2", FullName: "JHA Trust", ContactType: "Client", EntityDescription: { Text: `${SP}\n${HUBSPOT}` } },
    },
    groups: {
      G1: {
        ClientGroupKey: "G1", FullName: "Smith Group", ClientOwner: "andrea@dream.au", ClientManager: null, ContactType: "Client", RestrictionLevel: "Public",
        PrimaryContact: "Jo Smith", EntityDescription: { Text: "family" }, LastModifiedDateTime: "2026-01-01T00:00:00Z",
        Members: [{ ContactKey: "C1", OrganizationKey: null }],
        BusinessCard: { BusinessCardKey: "BCG", EntityType: "ClientGroup", EntityKey: "G1", IsPrimaryCard: true, EmailAddresses: ["g@x.au"], WebSites: [], PhoneNumbers: [{ PhoneNumberKey: "PG", Number: "02 1111 2222", CountryCode: "AU", Label: "Work" }], Addresses: [] },
      },
    },
    cards: {},
  };
  db.cards.BC1 = db.Contacts.C1.BusinessCards[0];
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const noContent = () => new Response(null, { status: 204 });
const once = (method, re, respond) => queue.push({ method, re, respond });
const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !["BusinessCards", "ClientTeam"].includes(k)));

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const method = opts.method ?? "GET";
  const path = decodeURIComponent(u.pathname).replace(/^\/v3/i, "");
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  log.push({ method, path, url: u, body });
  const qi = queue.findIndex(q => q.method === method && q.re.test(path));
  if (qi >= 0) return queue.splice(qi, 1)[0].respond();

  let m;
  if (path === "/TenantSettings") return json({ ContactTypes: ["Client", "Inactive", "Let go", "Deregistered", "Prospect"] });
  if ((m = path.match(/^\/(Contacts|Organizations)$/))) {
    const filter = u.searchParams.get("$filter") ?? "";
    const want = filter.match(/ContactType eq '(.*)'/)?.[1];
    const rows = Object.values(db[m[1]]).filter(r => !want || r.ContactType === want)
      .map(r => ({ [m[1] === "Contacts" ? "ContactKey" : "OrganizationKey"]: r.ContactKey ?? r.OrganizationKey, FullName: r.FullName ?? `${r.FirstName} ${r.LastName}`, ContactType: r.ContactType, EmailAddress: "e@x.au" }));
    return json({ value: rows });
  }
  if ((m = path.match(/^\/(Contacts|Organizations)\/(\w+)$/))) {
    const rec = db[m[1]][m[2]];
    if (!rec) return json({ error: { code: "4004", message: "not found" } }, 404);
    if (method === "GET") {
      const expand = (u.searchParams.get("$expand") ?? "").split(",");
      const out = { "@odata.context": "ctx", ...strip(rec) };
      if (expand.includes("BusinessCards")) out.BusinessCards = rec.BusinessCards;
      if (expand.includes("ClientTeam")) out.ClientTeam = rec.ClientTeam;
      if (flags.htmlDescriptions && out.EntityDescription?.Text) out.EntityDescription = { Text: `<p>${out.EntityDescription.Text.split("\n").join("</p><p>").replace(/&/g, "&amp;")}</p>` };
      return json(out);
    }
    if (method === "PUT") {
      if ("BusinessCards" in body || "AvatarUrl" in body || "LastModifiedDateTime" in body || Object.keys(body).some(k => k.startsWith("@odata"))) return json({ error: { code: "4001", message: "unsupported field" } }, 400);
      if (flags.ignorePuts) return noContent();
      const next = { ...rec, ...body };
      if (flags.dropOnPut) delete next[flags.dropOnPut];
      db[m[1]][m[2]] = next;
      return noContent();
    }
    if (method === "PATCH") { Object.assign(rec, body); return noContent(); }
  }
  if ((m = path.match(/^\/ClientGroups\/(\w+)$/))) {
    const g = db.groups[m[1]];
    if (!g) return json({ error: { code: "4004", message: "not found" } }, 404);
    if (method === "GET") return json({ "@odata.context": "ctx", ...g });
    if (method === "PUT") {
      if (body.ClientGroupKey !== m[1] || !Array.isArray(body.Members) || "LastModifiedDateTime" in body) return json({ error: { code: "4000", message: "bad body" } }, 400);
      if ((body.BusinessCard?.PhoneNumbers ?? []).some(p => "PhoneNumberKey" in p)) return json({ error: { code: "4001", message: "Unsupported option" } }, 400);
      if (flags.ignorePuts) return noContent();
      db.groups[m[1]] = { ...g, ...body, BusinessCard: body.BusinessCard ? { ...body.BusinessCard, PhoneNumbers: body.BusinessCard.PhoneNumbers.map((p, i) => ({ PhoneNumberKey: `N${i}`, ...p })) } : g.BusinessCard };
      return noContent();
    }
  }
  if ((m = path.match(/^\/BusinessCards\/(\w+)$/))) {
    const card = db.cards[m[1]];
    if (method === "GET") return json(card);
    if (method === "PUT") { db.cards[m[1]] = { ...body, PhoneNumbers: body.PhoneNumbers.map(p => ({ PhoneNumberKey: "NEW", ...p })) }; return noContent(); }
  }
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

// ── update_description ───────────────────────────────────────────────────────
test("prepend puts the link above the existing HubSpot link and keeps every other field", async () => {
  const r = await call("update_description", { entityType: "Contact", key: "C1", text: SP, reason: "test" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.status, "verified");
  assert.equal(db.Contacts.C1.EntityDescription.Text, `${SP}\n${HUBSPOT}`);
  const body = puts()[0].body;
  assert.equal(body.ContactKey, "C1");
  assert.ok(!("BusinessCards" in body) && !("AvatarUrl" in body));
  assert.deepEqual(body.ClientTeam, db.Contacts.C1.ClientTeam);
  assert.deepEqual(body.AccountingDetail, { BirthDate: "1980-01-01T00:00:00Z", Notes: "n" });
  assert.equal(body.ContactType, "Client");
});

test("re-running with the same link writes nothing", async () => {
  const r = await call("update_description", { entityType: "Organization", key: "O2", text: SP, reason: "test" });
  assert.equal(r.status, "already_present");
  assert.equal(puts().length, 0);
});

test("an empty description just gets the new text; append and dryRun work", async () => {
  const dry = await call("update_description", { entityType: "Organization", key: "O1", text: SP, dryRun: true, reason: "test" });
  assert.equal(dry.status, "would_update");
  assert.equal(dry.after, SP);
  assert.equal(puts().length, 0);
  const r = await call("update_description", { entityType: "Organization", key: "O1", text: SP, reason: "test" });
  assert.equal(r.status, "verified");
  assert.equal(db.Organizations.O1.EntityDescription.Text, SP);
  assert.equal(puts()[0].body.OrganizationKey, "O1");
  const r2 = await call("update_description", { entityType: "Organization", key: "O1", text: "Ignition: 123", mode: "append", reason: "test" });
  assert.equal(r2.status, "verified");
  assert.equal(db.Organizations.O1.EntityDescription.Text, `${SP}\nIgnition: 123`);
});

test("a PUT that returns 204 but doesn't save is reported as not_persisted", async () => {
  flags.ignorePuts = true;
  const r = await call("update_description", { entityType: "Contact", key: "C1", text: SP, reason: "test" });
  assert.equal(r.ok, false);
  assert.equal(r.status, "not_persisted");
  assert.match(r.failures.join(), /Description: expected/);
});

test("a field lost in the PUT is reported even though the description saved", async () => {
  flags.dropOnPut = "AccountingDetail";
  const r = await call("update_description", { entityType: "Contact", key: "C1", text: SP, reason: "test" });
  assert.equal(r.ok, false);
  assert.match(r.failures.join(), /AccountingDetail changed unexpectedly/);
});

test("description stored back as HTML still verifies, and duplicate check sees through &amp;", async () => {
  flags.htmlDescriptions = true;
  const r = await call("update_description", { entityType: "Contact", key: "C1", text: `${SP}?a=1&b=2`, reason: "test" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const again = await call("update_description", { entityType: "Contact", key: "C1", text: `${SP}?a=1&b=2`, reason: "test" });
  assert.equal(again.status, "already_present");
  assert.equal(alreadyPresent(`<p>${HUBSPOT}</p>`, HUBSPOT), true);
  assert.equal(normDescription("<p>a</p><p>b</p>"), normDescription("a\nb"));
});

// ── set_contact_type ─────────────────────────────────────────────────────────
test("set_contact_type matches the tenant's list without regard to case and verifies", async () => {
  const r = await call("set_contact_type", { entityType: "Organization", key: "O1", contactType: "inactive", reason: "test" });
  assert.equal(r.status, "verified", JSON.stringify(r));
  assert.equal(db.Organizations.O1.ContactType, "Inactive");
  assert.equal(puts()[0].body.ContactType, "Inactive");
  const again = await call("set_contact_type", { entityType: "Organization", key: "O1", contactType: "Inactive", reason: "test" });
  assert.equal(again.status, "already_set");
  const bad = await call("set_contact_type", { entityType: "Contact", key: "C1", contactType: "Gone", reason: "test" });
  assert.equal(bad.ok, false);
  assert.ok(bad.validContactTypes.includes("Let go"));
  assert.equal(puts().length, 1);
});

// ── client group members ─────────────────────────────────────────────────────
test("list_client_group_members returns keys, types and names", async () => {
  db.groups.G1.Members.push({ ContactKey: null, OrganizationKey: "O1" });
  const r = await call("list_client_group_members", { clientGroupKey: "G1" });
  assert.equal(r.count, 2);
  assert.deepEqual(r.members.map(m => [m.memberType, m.key, m.name]), [["Contact", "C1", "Jo Smith"], ["Organization", "O1", "Smith Pty Ltd"]]);
});

test("add_client_group_member sends the full member list and keeps the group's card and fields", async () => {
  const r = await call("add_client_group_member", { clientGroupKey: "G1", memberType: "Organization", memberKey: "O1", reason: "test" });
  assert.equal(r.status, "verified", JSON.stringify(r));
  const body = puts()[0].body;
  assert.deepEqual(body.Members, [{ ContactKey: "C1", OrganizationKey: null }, { ContactKey: null, OrganizationKey: "O1" }]);
  assert.equal(body.FullName, "Smith Group");
  assert.equal(body.BusinessCard.BusinessCardKey, "BCG");
  assert.ok(!("PhoneNumberKey" in body.BusinessCard.PhoneNumbers[0]));
  const again = await call("add_client_group_member", { clientGroupKey: "G1", memberType: "Organization", memberKey: "O1", reason: "test" });
  assert.equal(again.status, "already_member");
  assert.equal(puts().length, 1);
});

test("add refuses an unknown member key without writing", async () => {
  const r = await call("add_client_group_member", { clientGroupKey: "G1", memberType: "Contact", memberKey: "NOPE", reason: "test" });
  assert.equal(r.ok, false);
  assert.equal(puts().length, 0);
});

test("remove_client_group_member: dry run, remove, then not_member", async () => {
  db.groups.G1.Members.push({ ContactKey: null, OrganizationKey: "O1" });
  const dry = await call("remove_client_group_member", { clientGroupKey: "G1", memberKey: "C1", dryRun: true, reason: "test" });
  assert.equal(dry.status, "would_update");
  assert.equal(puts().length, 0);
  const r = await call("remove_client_group_member", { clientGroupKey: "G1", memberKey: "C1", reason: "test" });
  assert.equal(r.status, "verified", JSON.stringify(r));
  assert.deepEqual(db.groups.G1.Members, [{ ContactKey: null, OrganizationKey: "O1" }]);
  const again = await call("remove_client_group_member", { clientGroupKey: "G1", memberKey: "C1", reason: "test" });
  assert.equal(again.status, "not_member");
});

test("a group PUT that doesn't save is not_persisted", async () => {
  flags.ignorePuts = true;
  const r = await call("add_client_group_member", { clientGroupKey: "G1", memberType: "Organization", memberKey: "O1", reason: "test" });
  assert.equal(r.status, "not_persisted");
  assert.match(r.failures.join(), /Members: expected/);
});

// ── update_contact email / phone ─────────────────────────────────────────────
test("update_contact changes the middle name and the primary card's email and phone", async () => {
  const r = await call("update_contact", { contactKey: "C1", middleName: "Ann", addEmailAddresses: ["jo@new.au"], upsertPhoneNumbers: [{ number: "0400 111 222", label: "Mobile" }], reason: "test" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(db.Contacts.C1.MiddleName, "Ann");
  assert.deepEqual(db.cards.BC1.EmailAddresses, ["jo@client.au", "jo@new.au"]);
  assert.equal(db.cards.BC1.PhoneNumbers[0].Number, "0400 111 222");
});

test("update_contact with email but no business card changes nothing", async () => {
  const r = await call("update_contact", { contactKey: "C2", firstName: "Alan", addEmailAddresses: ["al@x.au"], reason: "test" });
  assert.equal(r.ok, false);
  assert.match(r.error, /no Business Card/);
  assert.equal(db.Contacts.C2.FirstName, "Al");
});

// ── listing with descriptions ────────────────────────────────────────────────
test("list_organizations includeDescription adds Description per row", async () => {
  const r = await call("list_organizations", { includeDescription: true });
  assert.deepEqual(r.value.map(o => [o.OrganizationKey, o.Description]), [["O1", null], ["O2", `${SP}\n${HUBSPOT}`]]);
  const plain = await call("list_organizations", {});
  assert.ok(!("Description" in plain.value[0]));
});

test("list_all_clients returns compact rows and filters on description", async () => {
  const r = await call("list_all_clients", {});
  assert.deepEqual(r.columns, ["kind", "key", "name", "contactType", "email"]);
  assert.equal(r.rows.length, 4);
  const missing = await call("list_all_clients", { include: ["Organization"], descriptionNotContains: "sharepoint.com" });
  assert.deepEqual(missing.rows.map(x => x[1]), ["O1"]);
  assert.equal(missing.columns.at(-1), "description");
  await call("list_all_clients", { contactType: "Client", include: ["Contact"] });
  assert.match(log.at(-1).url.searchParams.get("$filter"), /ContactType eq 'Client'/);
});
