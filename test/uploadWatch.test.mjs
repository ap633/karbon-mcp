// Client portal upload watch: scanning FileList for new shared files, the alert
// email, and the watermark/dedupe state between runs. Karbon and Graph are
// mocked by replacing fetch.
// Run: npm test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { scanUploads, runUploadWatch, alertEmail, watchConfigFromEnv } from "../dist/uploadWatch.js";
import { clientConfig } from "../dist/karbon.js";

clientConfig.sleep = async () => {};
console.log = () => {};

const API = "https://api.karbonhq.com/v3";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const contacts = [{ ContactKey: "C1", FullName: "Jane Smith" }, { ContactKey: "C2", FullName: "Bob Jones" }];
const orgs = [{ OrganizationKey: "O1", FullName: "Smith Pty Ltd" }];
let files, log, mail;

const file = (key, date, extra = {}) => ({ FileContextKey: key, FileName: `${key}.pdf`, FileSize: 20480, MimeType: "application/pdf", Source: "Contact", DateCreated: date, IsShared: true, IsArchived: false, ...extra });

beforeEach(() => {
  log = [];
  mail = [];
  files = { C1: [], C2: [], O1: [] };
});

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.hostname === "login.microsoftonline.com") return json({ access_token: "tok" });
  if (u.hostname === "graph.microsoft.com") { mail.push({ url: u, body: JSON.parse(opts.body) }); return new Response(null, { status: 202 }); }
  const p = decodeURIComponent(u.pathname).replace(/^\/v3/i, "");
  log.push(u);
  if (p === "/Contacts") return json({ value: contacts });
  if (p === "/Organizations") return json({ value: orgs });
  const m = p.match(/^\/FileList\/(Contact|Organization)$/);
  if (m) {
    const key = u.searchParams.get("EntityKey");
    const filter = u.searchParams.get("$filter") ?? "";
    let rows = files[key].filter(f => f.IsShared && !f.IsArchived);
    const src = filter.match(/Source eq '(\w+)'/);
    if (src) rows = rows.filter(f => f.Source === src[1]);
    rows = [...rows].sort((a, b) => b.DateCreated.localeCompare(a.DateCreated));
    const top = Number(u.searchParams.get("$top")), skip = Number(u.searchParams.get("$skip") ?? 0);
    return json({ EntityKey: key, EntityType: m[1], TotalCount: rows.length, Attachments: rows.slice(skip, skip + top) });
  }
  return json({ message: "not mocked" }, 404);
};

test("scan finds only shared files newer than since, and leaves out work-item files", async () => {
  files.C1 = [file("new1", "2026-10-30T02:00:00Z"), file("old1", "2026-10-29T00:00:00Z"), file("wi", "2026-10-30T03:00:00Z", { Source: "WorkItem" })];
  files.O1 = [file("orgnew", "2026-10-30T01:00:00Z", { Source: "Organization" })];
  const r = await scanUploads({ since: new Date("2026-10-30T00:00:00Z") });
  assert.deepEqual(r.uploads.map(u => u.fileKey), ["orgnew", "new1"]);
  assert.equal(r.uploads[1].entityName, "Jane Smith");
  assert.deepEqual(r.scanned, { Contact: 2, Organization: 1 });
  const fl = log.find(u => u.pathname.endsWith("/FileList/Contact"));
  assert.equal(fl.searchParams.get("$filter"), "IsShared eq true and IsArchived eq false and Source eq 'Contact'");
});

test("includeWorkItemFiles drops the Source filter", async () => {
  files.C1 = [file("wi", "2026-10-30T03:00:00Z", { Source: "WorkItem" })];
  const r = await scanUploads({ since: new Date("2026-10-30T00:00:00Z"), kinds: ["Contact"], includeWorkItemFiles: true });
  assert.deepEqual(r.uploads.map(u => u.fileKey), ["wi"]);
});

test("scan pages past 20 files when they are all new", async () => {
  files.C2 = Array.from({ length: 45 }, (_, i) => file(`f${i}`, new Date(Date.UTC(2026, 9, 30, 1, i)).toISOString()));
  const r = await scanUploads({ since: new Date("2026-10-30T00:00:00Z"), kinds: ["Contact"] });
  assert.equal(r.uploads.length, 45);
});

test("contactType filters the client list on Karbon's side", async () => {
  await scanUploads({ since: new Date(), kinds: ["Contact"], contactType: "Client" });
  assert.equal(log.find(u => u.pathname.endsWith("/Contacts")).searchParams.get("$filter"), "ContactType eq 'Client'");
});

test("email groups files by client and links when a URL template is set", () => {
  const { subject, html } = alertEmail([
    { kind: "Contact", entityKey: "C1", entityName: "Jane <Smith>", fileKey: "a", fileName: "a.pdf", fileSize: 20480, mimeType: null, source: "Contact", dateCreated: "2026-10-30T01:00:00Z" },
    { kind: "Contact", entityKey: "C1", entityName: "Jane <Smith>", fileKey: "b", fileName: "b.pdf", fileSize: 3_145_728, mimeType: null, source: "Contact", dateCreated: "2026-10-30T02:00:00Z" },
  ], { Contact: "https://app.example/contacts/{key}" });
  assert.equal(subject, "Client portal: 2 new files from Jane <Smith>");
  assert.match(html, /href="https:\/\/app.example\/contacts\/C1">Jane &lt;Smith&gt;<\/a>/);
  assert.match(html, /3\.0 MB/);
});

function cfg(stateFile) {
  return {
    stateFile, intervalMinutes: 30, initialLookbackMinutes: 60, links: {},
    mail: { tenantId: "t", clientId: "c", clientSecret: "s", from: "info@dreamaccounting.com.au", to: ["info@dreamaccounting.com.au"] },
  };
}
const tmpState = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "uw-")), "state.json");

test("first run looks back initialLookbackMinutes, emails once, and does not repeat on the next run", async () => {
  const stateFile = tmpState();
  files.C1 = [file("recent", "2026-10-30T09:40:00Z"), file("tooOld", "2026-10-30T07:00:00Z")];
  const r1 = await runUploadWatch(cfg(stateFile), { now: () => new Date("2026-10-30T10:00:00Z") });
  assert.deepEqual(r1.newUploads.map(u => u.fileKey), ["recent"]);
  assert.equal(mail.length, 1);
  assert.equal(mail[0].url.pathname, "/v1.0/users/info%40dreamaccounting.com.au/sendMail");
  assert.equal(mail[0].body.message.toRecipients[0].emailAddress.address, "info@dreamaccounting.com.au");

  // Next run: "recent" is inside the overlap window but already alerted; a new file is.
  files.C2 = [file("later", "2026-10-30T10:10:00Z")];
  const r2 = await runUploadWatch(cfg(stateFile), { now: () => new Date("2026-10-30T10:30:00Z") });
  assert.deepEqual(r2.newUploads.map(u => u.fileKey), ["later"]);
  assert.equal(mail.length, 2);

  const r3 = await runUploadWatch(cfg(stateFile), { now: () => new Date("2026-10-30T11:00:00Z") });
  assert.equal(r3.newUploads.length, 0);
  assert.equal(mail.length, 2, "nothing new, no email");
});

test("a failed send leaves the watermark alone so the next run retries", async () => {
  const stateFile = tmpState();
  files.C1 = [file("x", "2026-10-30T09:50:00Z")];
  await assert.rejects(runUploadWatch(cfg(stateFile), { now: () => new Date("2026-10-30T10:00:00Z"), send: async () => { throw new Error("graph down"); } }));
  assert.equal(fs.existsSync(stateFile), false);
  const r = await runUploadWatch(cfg(stateFile), { now: () => new Date("2026-10-30T10:30:00Z") });
  assert.deepEqual(r.newUploads.map(u => u.fileKey), ["x"]);
});

test("config is off unless enabled, and needs the Graph settings", () => {
  assert.equal(watchConfigFromEnv({}), null);
  assert.equal(watchConfigFromEnv({ UPLOAD_WATCH_ENABLED: "true" }), null);
  const c = watchConfigFromEnv({ UPLOAD_WATCH_ENABLED: "true", GRAPH_TENANT_ID: "t", GRAPH_CLIENT_ID: "c", GRAPH_CLIENT_SECRET: "s", UPLOAD_ALERT_FROM: "info@dreamaccounting.com.au" });
  assert.deepEqual(c.mail.to, ["info@dreamaccounting.com.au"]);
  assert.equal(c.intervalMinutes, 30);
});
