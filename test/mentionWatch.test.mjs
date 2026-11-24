// Dream Claude @mentions in Karbon: webhook → fetch note → queue → iMac pulls.
// Karbon is mocked by replacing fetch. Run: npm test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { mentionsBot, parseEvents, handleEvents, ensureSubscription, loadState, startMentionWatch, mentionConfigFromEnv } from "../dist/mentionWatch.js";
import { clientConfig } from "../dist/karbon.js";

clientConfig.sleep = async () => {};
console.log = () => {};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const realFetch = globalThis.fetch;
let notes, subs, posted;

const cfg = () => ({
  webhookSecret: "s".repeat(20), queueToken: "q".repeat(20), publicUrl: "https://example.test",
  userKey: "41d3VtRw8HxQ", name: "Dream Claude", staffDomain: "dreamaccounting.com.au",
  botEmail: "dreamclaude@dreamaccounting.com.au",
  stateFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mw-")), "state.json"),
  subscribe: true, practiceKey: "YJVCJnwyxrT",
});

beforeEach(() => {
  notes = {};
  subs = {};
  posted = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.hostname !== "api.karbonhq.com") return realFetch(url, opts);
    const p = decodeURIComponent(u.pathname);
    let m;
    if ((m = p.match(/^\/v3\/Notes\/(.+)$/))) return notes[m[1]] ? json(notes[m[1]]) : json({ error: { message: "nope" } }, 404);
    if ((m = p.match(/^\/v3\/WebhookSubscriptions\/(.+)$/))) return subs[m[1]] ? json(subs[m[1]]) : json({ error: { message: "nope" } }, 404);
    if (p === "/v3/WebhookSubscriptions" && opts.method === "POST") { const b = JSON.parse(opts.body); posted.push(b); subs[b.WebhookType] = b; return json(b, 201); }
    return json({}, 404);
  };
});

const later = (mins) => new Date(Date.now() + mins * 60000).toISOString();

test("mentionsBot: user key or @name, not plain talk", () => {
  const c = { userKey: "41d3VtRw8HxQ", name: "Dream Claude" };
  assert.equal(mentionsBot('<span data-key="41d3VtRw8HxQ">Dream Claude</span> check this', c), true);
  assert.equal(mentionsBot("<p>@Dream&nbsp;Claude can you check the BAS?</p>", c), true);
  assert.equal(mentionsBot("<p>@dream claude hi</p>", c), true);
  assert.equal(mentionsBot("<p>Dream Claude did this yesterday</p>", c), false);
  assert.equal(mentionsBot("<p>@Dream Claudette</p>", c), false);
});

test("parseEvents: single and batch payloads", () => {
  assert.deepEqual(parseEvents({ ResourcePermaKey: "N1", ResourceType: "Note", ActionType: "Inserted" }), [{ key: "N1", type: "Note", action: "Inserted", parentKey: null }]);
  assert.equal(parseEvents({ BatchId: "x", Events: [{ ResourcePermaKey: "A", ResourceType: "Note", ActionType: "Updated" }, { ResourcePermaKey: "B", ResourceType: "Note", ActionType: "Deleted" }] }).length, 2);
  assert.deepEqual(parseEvents({}), []);
});

test("queues a staff mention in a new note once, with thread and work link", async () => {
  const c = cfg();
  const s = loadState(c.stateFile);
  notes.N1 = {
    Id: "N1", Subject: "BAS query", Body: "<p>@Dream Claude what's the BAS due date?</p>",
    CreatedDate: later(1), AuthorEmailAddress: "tamieka@dreamaccounting.com.au",
    Timelines: [{ EntityType: "WorkItem", EntityKey: "W123" }], Comments: [],
  };
  const out = await handleEvents({ ResourcePermaKey: "N1", ResourceType: "Note", ActionType: "Inserted" }, s, c);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "note:N1");
  assert.equal(out[0].seq, 1);
  assert.equal(out[0].text, "@Dream Claude what's the BAS due date?");
  assert.equal(out[0].timelines[0].link, "https://app2.karbonhq.com/YJVCJnwyxrT/work/W123");
  // Same event again (e.g. a later edit) doesn't queue it twice.
  assert.equal((await handleEvents({ ResourcePermaKey: "N1", ResourceType: "Note", ActionType: "Updated" }, s, c)).length, 0);
  // State survives a restart.
  assert.equal(loadState(c.stateFile).queue.length, 1);
});

test("queues a mention in a new comment; skips old, non-staff and Dream Claude's own", async () => {
  const c = cfg();
  const s = loadState(c.stateFile);
  notes.N2 = {
    Id: "N2", Subject: "Docs", Body: "<p>Waiting on docs</p>", CreatedDate: later(-600),
    AuthorEmailAddress: "andrea@dreamaccounting.com.au", Timelines: [],
    Comments: [
      { CommentKey: "C0", CommentBody: "@Dream Claude old one", CreatedDate: later(-600), AuthorEmailAddress: "andrea@dreamaccounting.com.au" },
      { CommentKey: "C1", CommentBody: "@Dream Claude chase this", CreatedDate: later(1), AuthorEmailAddress: "client@gmail.com" },
      { CommentKey: "C2", CommentBody: "@Dream Claude done", CreatedDate: later(1), AuthorEmailAddress: "dreamclaude@dreamaccounting.com.au" },
      { CommentKey: "C3", CommentBody: "@Dream Claude please summarise", CreatedDate: later(2), AuthorEmailAddress: "manish@dreamaccounting.com.au" },
    ],
  };
  const out = await handleEvents({ ResourcePermaKey: "N2", ResourceType: "Note", ActionType: "Updated" }, s, c);
  assert.deepEqual(out.map(m => m.id), ["comment:C3"]);
  assert.equal(out[0].thread.length, 5);
  assert.equal(out[0].authorEmail, "manish@dreamaccounting.com.au");
});

test("a failed note fetch is logged, not thrown", async () => {
  const c = cfg();
  const s = loadState(c.stateFile);
  const out = await handleEvents({ ResourcePermaKey: "missing", ResourceType: "Note", ActionType: "Inserted" }, s, c);
  assert.equal(out.length, 0);
  assert.match(s.events.at(-1).result, /^error/);
});

test("subscription: creates when missing, never overwrites someone else's", async () => {
  const c = cfg();
  const s = loadState(c.stateFile);
  assert.equal(await ensureSubscription(s, c), "created");
  assert.equal(posted[0].TargetUrl, `https://example.test/karbon/webhook/${c.webhookSecret}`);
  assert.equal(await ensureSubscription(s, c), "active");
  subs.Note = { TargetUrl: "https://zapier.example/hook", WebhookType: "Note" };
  assert.match(await ensureSubscription(s, c), /^CONFLICT/);
  assert.equal(posted.length, 1);
});

test("config: off by default, needs long secrets", () => {
  assert.equal(mentionConfigFromEnv({}), null);
  assert.equal(mentionConfigFromEnv({ MENTION_WATCH_ENABLED: "true", MENTION_WEBHOOK_SECRET: "short", MENTION_QUEUE_TOKEN: "q".repeat(20) }), null);
  const c = mentionConfigFromEnv({ MENTION_WATCH_ENABLED: "true", MENTION_WEBHOOK_SECRET: "s".repeat(20), MENTION_QUEUE_TOKEN: "q".repeat(20), RAILWAY_PUBLIC_DOMAIN: "x.up.railway.app" });
  assert.equal(c.publicUrl, "https://x.up.railway.app");
});

test("HTTP: webhook needs the secret, queue needs the token", async () => {
  const c = cfg();
  const w = startMentionWatch(c, { timers: false });
  notes.N9 = { Id: "N9", Subject: "", Body: "@Dream Claude hi", CreatedDate: later(1), AuthorEmailAddress: "hayley@dreamaccounting.com.au", Timelines: [], Comments: [] };
  const srv = http.createServer(async (req, res) => { if (!(await w.route(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const ev = JSON.stringify({ ResourcePermaKey: "N9", ResourceType: "Note", ActionType: "Inserted" });
    assert.equal((await realFetch(`${base}/karbon/webhook/wrong-secret-xxxxx`, { method: "POST", body: ev })).status, 404);
    assert.equal((await realFetch(`${base}/karbon/webhook/${c.webhookSecret}`, { method: "POST", body: ev })).status, 200);
    await new Promise(r => setTimeout(r, 50));
    assert.equal((await realFetch(`${base}/dream-claude/mentions`)).status, 401);
    assert.equal((await realFetch(`${base}/dream-claude/mentions`, { headers: { Authorization: "Bearer wrong" } })).status, 401);
    const got = await (await realFetch(`${base}/dream-claude/mentions?after=0`, { headers: { Authorization: `Bearer ${c.queueToken}` } })).json();
    assert.equal(got.items.length, 1);
    assert.equal(got.lastSeq, 1);
    const none = await (await realFetch(`${base}/dream-claude/mentions?after=1`, { headers: { Authorization: `Bearer ${c.queueToken}` } })).json();
    assert.equal(none.items.length, 0);
  } finally {
    srv.close();
  }
});

test("a note and its comment tagging together get one answer, with a contact link", async () => {
  const c = cfg();
  const s = loadState(c.stateFile);
  notes.N3 = {
    Id: "N3", Subject: "Test", Body: "<p>@Dream Claude can you see this</p>", CreatedDate: later(1),
    AuthorEmailAddress: "andrea@dreamaccounting.com.au", Timelines: [{ EntityType: "Contact", EntityKey: "K1" }],
    Comments: [{ CommentKey: "C1", CommentBody: "@Dream Claude", CreatedDate: later(2), AuthorEmailAddress: "andrea@dreamaccounting.com.au" }],
  };
  const out = await handleEvents({ ResourcePermaKey: "N3", ResourceType: "Note", ActionType: "Inserted" }, s, c);
  assert.deepEqual(out.map(m => m.id), ["comment:C1"]);
  assert.equal(out[0].mentioned, true);
  assert.equal(out[0].timelines[0].link, "https://app2.karbonhq.com/YJVCJnwyxrT#/contacts/K1");
  assert.equal((await handleEvents({ ResourcePermaKey: "N3", ResourceType: "Note", ActionType: "Updated" }, s, c)).length, 0);
});

test("NoteComment event: an untagged 'yes' in Dream Claude's thread is queued; other threads aren't", async () => {
  const c = cfg();
  const s = loadState(c.stateFile);
  notes.N4 = {
    Id: "N4", Subject: "Fix", Body: "<p>@Dream Claude update the deadline</p>", CreatedDate: later(1),
    AuthorEmailAddress: "andrea@dreamaccounting.com.au", Timelines: [], Comments: [],
  };
  await handleEvents({ ResourcePermaKey: "N4", ResourceType: "Note", ActionType: "Inserted" }, s, c);
  notes.N4.Comments = [
    { CommentKey: "B1", CommentBody: "I'll change it to 30/11/2026. Reply yes to go ahead.", CreatedDate: later(2), AuthorEmailAddress: "dreamclaude@dreamaccounting.com.au" },
    { CommentKey: "Y1", CommentBody: "yes", CreatedDate: later(3), AuthorEmailAddress: "andrea@dreamaccounting.com.au" },
  ];
  const out = await handleEvents({ ResourcePermaKey: "Y1", ResourceType: "NoteComment", ActionType: "Inserted", ParentEntityType: "Note", ParentEntityKey: "N4" }, s, c);
  assert.deepEqual(out.map(m => [m.id, m.mentioned]), [["comment:Y1", false]]);
  assert.equal(out[0].thread.length, 3);

  notes.N5 = {
    Id: "N5", Subject: "Other", Body: "<p>Tamieka, please chase</p>", CreatedDate: later(1),
    AuthorEmailAddress: "andrea@dreamaccounting.com.au", Timelines: [],
    Comments: [{ CommentKey: "Z1", CommentBody: "done", CreatedDate: later(2), AuthorEmailAddress: "tamieka@dreamaccounting.com.au" }],
  };
  assert.equal((await handleEvents({ ResourcePermaKey: "Z1", ResourceType: "NoteComment", ActionType: "Inserted", ParentEntityKey: "N5" }, s, c)).length, 0);
});
