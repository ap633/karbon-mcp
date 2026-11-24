// Dream Claude @mentions in Karbon.
//
// Karbon doesn't email a user when they're @mentioned (tested 12 Nov 2026: the
// mention only lands in their Triage), so Dream Claude can't see Karbon tags by
// watching its mailbox. Instead:
//
//   1. Karbon pushes Note events (Inserted / Updated) to
//      POST /karbon/webhook/<MENTION_WEBHOOK_SECRET>.
//   2. We fetch the note (GET /v3/Notes/{id}, which includes its comments) and
//      queue any new note body or comment that @mentions Dream Claude, written
//      by a Dream staff member.
//   3. The iMac listener collects the queue over an outbound call:
//      GET /dream-claude/mentions?after=<seq> with Authorization: Bearer <MENTION_QUEUE_TOKEN>.
//      Nothing on the iMac is open to the internet.
//
// Karbon allows one subscription per webhook type, so we never overwrite a Note
// subscription pointing somewhere else. We check it at most every 3.5 hours and
// only create it when Karbon says it's gone (404), per Karbon's rules.
//
// Off unless MENTION_WATCH_ENABLED=true.
import fs from "fs";
import { timingSafeEqual } from "crypto";
import { kget, ksend, KarbonError } from "./karbon.js";
const MAX_QUEUE = 200;
const MAX_SEEN = 5000;
const MAX_EVENTS = 50;
const SUBSCRIPTION_CHECK_MS = 3.5 * 3600 * 1000;
export function mentionConfigFromEnv(env = process.env) {
    if (env.MENTION_WATCH_ENABLED !== "true")
        return null;
    const webhookSecret = env.MENTION_WEBHOOK_SECRET ?? "";
    const queueToken = env.MENTION_QUEUE_TOKEN ?? "";
    if (webhookSecret.length < 16 || queueToken.length < 16) {
        console.log("Mention watch NOT started: MENTION_WEBHOOK_SECRET and MENTION_QUEUE_TOKEN must each be at least 16 characters.");
        return null;
    }
    const domain = env.MENTION_PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : "");
    return {
        webhookSecret,
        queueToken,
        publicUrl: domain ? domain.replace(/\/+$/, "") : null,
        userKey: env.MENTION_USER_KEY || "41d3VtRw8HxQ",
        name: env.MENTION_NAME || "Dream Claude",
        staffDomain: (env.MENTION_STAFF_DOMAIN || "dreamaccounting.com.au").toLowerCase(),
        botEmail: (env.MENTION_BOT_EMAIL || "dreamclaude@dreamaccounting.com.au").toLowerCase(),
        stateFile: env.MENTION_STATE_FILE || "/data/mention-state.json",
        subscribe: env.MENTION_SUBSCRIBE !== "false",
        practiceKey: env.KARBON_PRACTICE_KEY || "YJVCJnwyxrT",
    };
}
// ---------- text helpers ----------
export function htmlToText(html) {
    return String(html ?? "")
        .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
        .replace(/<li[^>]*>/gi, "• ")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
// A mention either carries Dream Claude's Karbon user key in the HTML, or reads
// "@Dream Claude" in the text. Plain talk about Dream Claude (no @) doesn't count.
export function mentionsBot(rawHtml, cfg) {
    const raw = String(rawHtml ?? "");
    if (cfg.userKey && raw.includes(cfg.userKey))
        return true;
    const words = cfg.name.trim().split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    return new RegExp(`@\\s*${words}\\b`, "i").test(htmlToText(raw));
}
function timelineLink(entityType, entityKey, practiceKey) {
    const base = `https://app2.karbonhq.com/${practiceKey}`;
    if (/^work/i.test(entityType))
        return `${base}/work/${entityKey}`;
    return null;
}
// ---------- state ----------
function freshState() {
    return { startedAt: new Date().toISOString(), nextSeq: 1, seen: [], queue: [], events: [], subscription: { checkedAt: null, status: "not checked" } };
}
export function loadState(file) {
    try {
        const s = JSON.parse(fs.readFileSync(file, "utf8"));
        return { ...freshState(), ...s };
    }
    catch {
        return freshState();
    }
}
function saveState(file, s) {
    try {
        s.seen = s.seen.slice(-MAX_SEEN);
        s.queue = s.queue.slice(-MAX_QUEUE);
        s.events = s.events.slice(-MAX_EVENTS);
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
        fs.renameSync(tmp, file);
    }
    catch (e) {
        console.log("Mention watch: could not save state:", e.message);
    }
}
export function parseEvents(body) {
    const b = (body ?? {});
    const list = Array.isArray(b.Events) ? b.Events : [b];
    return list
        .filter(e => e && typeof e.ResourcePermaKey === "string")
        .map(e => ({ key: String(e.ResourcePermaKey), type: String(e.ResourceType ?? ""), action: String(e.ActionType ?? "") }));
}
function isStaff(email, cfg) {
    const e = email.trim().toLowerCase();
    return !!e && e !== cfg.botEmail && e.endsWith(`@${cfg.staffDomain}`);
}
export async function processNote(noteId, s, cfg) {
    const note = (await kget(`/Notes/${encodeURIComponent(noteId)}`) ?? {});
    const timelines = (note.Timelines ?? []).map(t => {
        const entityType = String(t.EntityType ?? ""), entityKey = String(t.EntityKey ?? "");
        return { entityType, entityKey, link: timelineLink(entityType, entityKey, cfg.practiceKey) };
    });
    const subject = String(note.Subject ?? "");
    const items = [
        { id: `note:${noteId}`, kind: "note", commentKey: null, raw: String(note.Body ?? ""), authorEmail: String(note.AuthorEmailAddress ?? ""), createdDate: String(note.CreatedDate ?? "") },
        ...(note.Comments ?? []).map(c => ({
            id: `comment:${c.CommentKey}`, kind: "comment", commentKey: String(c.CommentKey ?? ""),
            raw: String(c.CommentBody ?? ""), authorEmail: String(c.AuthorEmailAddress ?? ""), createdDate: String(c.CreatedDate ?? ""),
        })),
    ];
    const thread = items.map(i => ({ kind: i.kind, authorEmail: i.authorEmail, createdDate: i.createdDate, text: htmlToText(i.raw) }));
    const seen = new Set(s.seen);
    const out = [];
    for (const i of items) {
        if (seen.has(i.id))
            continue;
        // Only things written after the watch started, so turning it on doesn't replay old tags.
        if (!i.createdDate || Date.parse(i.createdDate) < Date.parse(s.startedAt))
            continue;
        if (!isStaff(i.authorEmail, cfg))
            continue;
        if (!mentionsBot(i.raw, cfg))
            continue;
        s.seen.push(i.id);
        seen.add(i.id);
        const m = {
            seq: s.nextSeq++, id: i.id, kind: i.kind, noteId, commentKey: i.commentKey,
            authorEmail: i.authorEmail, createdDate: i.createdDate, text: htmlToText(i.raw), subject,
            timelines, thread, queuedAt: new Date().toISOString(),
        };
        s.queue.push(m);
        out.push(m);
    }
    return out;
}
export async function handleEvents(body, s, cfg) {
    const out = [];
    for (const ev of parseEvents(body)) {
        let result = "ignored";
        try {
            if (/^note$/i.test(ev.type) && /^(inserted|updated)$/i.test(ev.action)) {
                const found = await processNote(ev.key, s, cfg);
                out.push(...found);
                result = found.length ? `queued ${found.map(f => f.id).join(", ")}` : "no new mention";
            }
        }
        catch (e) {
            result = `error: ${e.message.slice(0, 200)}`;
        }
        s.events.push({ at: new Date().toISOString(), type: ev.type, action: ev.action, key: ev.key, result });
        console.log(`Mention watch: ${ev.type} ${ev.action} ${ev.key} → ${result}`);
    }
    saveState(cfg.stateFile, s);
    return out;
}
// ---------- webhook subscription upkeep ----------
export async function ensureSubscription(s, cfg) {
    const target = cfg.publicUrl ? `${cfg.publicUrl}/karbon/webhook/${cfg.webhookSecret}` : null;
    let status;
    try {
        let existing = null;
        try {
            existing = (await kget("/WebhookSubscriptions/Note"));
        }
        catch (e) {
            if (!(e instanceof KarbonError && e.status === 404))
                throw e;
        }
        if (existing) {
            const url = String(existing.TargetUrl ?? "");
            status = url === target ? "active" : `CONFLICT: Karbon's Note webhook already points elsewhere (${url.replace(/\/karbon\/webhook\/.*/, "/karbon/webhook/…")}); not overwritten`;
        }
        else if (!cfg.subscribe) {
            status = "missing (MENTION_SUBSCRIBE=false, so not created)";
        }
        else if (!target) {
            status = "missing, and no public URL to subscribe (set MENTION_PUBLIC_URL)";
        }
        else {
            await ksend("POST", "/WebhookSubscriptions", { TargetUrl: target, WebhookType: "Note" });
            status = "created";
        }
    }
    catch (e) {
        status = `check failed: ${e.message.slice(0, 200)}`;
    }
    s.subscription = { checkedAt: new Date().toISOString(), status };
    saveState(cfg.stateFile, s);
    console.log(`Mention watch: Note webhook ${status}`);
    return status;
}
// ---------- HTTP routes ----------
function sameSecret(a, b) {
    const x = Buffer.from(a), y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", c => { size += c.length; if (size > 1_000_000) {
            req.destroy();
            reject(new Error("too large"));
        }
        else
            chunks.push(c); });
        req.on("end", () => resolve(Buffer.concat(chunks).toString()));
        req.on("error", reject);
    });
}
export function startMentionWatch(cfg, opts = {}) {
    const s = loadState(cfg.stateFile);
    saveState(cfg.stateFile, s);
    let chain = Promise.resolve();
    if (opts.timers !== false) {
        const check = () => { chain = chain.then(() => ensureSubscription(s, cfg)).catch(() => { }); };
        check();
        setInterval(check, SUBSCRIPTION_CHECK_MS).unref();
        console.log(`Mention watch on: queuing Karbon @${cfg.name} mentions since ${s.startedAt}`);
    }
    const route = async (req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        if (url.pathname.startsWith("/karbon/webhook/")) {
            if (req.method !== "POST" || !sameSecret(url.pathname.slice("/karbon/webhook/".length), cfg.webhookSecret)) {
                res.writeHead(404);
                res.end("Not found");
                return true;
            }
            let body;
            try {
                body = JSON.parse(await readBody(req));
            }
            catch {
                res.writeHead(400);
                res.end("Bad JSON");
                return true;
            }
            // Answer straight away so Karbon never times out and cancels the subscription.
            res.writeHead(200);
            res.end("OK");
            chain = chain.then(() => handleEvents(body, s, cfg)).catch(e => console.log("Mention watch error:", e.message));
            return true;
        }
        if (url.pathname === "/dream-claude/mentions") {
            const auth = String(req.headers.authorization ?? "");
            if (req.method !== "GET" || !auth.startsWith("Bearer ") || !sameSecret(auth.slice(7), cfg.queueToken)) {
                res.writeHead(401);
                res.end("Unauthorized");
                return true;
            }
            const after = Number(url.searchParams.get("after") ?? 0) || 0;
            const payload = { lastSeq: s.nextSeq - 1, items: s.queue.filter(m => m.seq > after) };
            if (url.searchParams.get("debug") === "1")
                Object.assign(payload, { startedAt: s.startedAt, subscription: s.subscription, events: s.events });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(payload));
            return true;
        }
        return false;
    };
    return { route, state: s };
}
