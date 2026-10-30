// Client portal upload watch. Karbon notifies us when a client completes a
// request, but not when they drop a file in the portal's general upload area,
// and there is no file webhook. So: on a timer, list every client's shared files
// (GET /v3/FileList/{EntityType}, newest first) and email info@ about any file
// that wasn't there last time.
//
// Limits (docs/KarbonAPI.json, FileListItem):
// - No "uploaded by". IsShared is always true for client uploads, but it is also
//   true for files staff shared with the client, so those will show up too.
// - FileList covers Contacts, Organizations and Work items only, not client groups.
// - Files on work items (request/client task uploads) are left out by default:
//   Karbon already notifies those.
import fs from "fs";
import { z } from "zod";
import { kget, mapLimit, odataString, pageAll, qs, text } from "./karbon.js";
const KINDS = {
    Contact: { path: "/Contacts", key: "ContactKey" },
    Organization: { path: "/Organizations", key: "OrganizationKey" },
};
const FILE_PAGE = 20;
const CONCURRENCY = 3;
// Shared, non-archived files on one client created after `since`. Newest first,
// so stop paging at the first older file.
async function filesSince(kind, key, since, includeWorkItemFiles) {
    const filter = ["IsShared eq true", "IsArchived eq false", ...(includeWorkItemFiles ? [] : [`Source eq ${odataString(kind)}`])].join(" and ");
    const out = [];
    for (let skip = 0;; skip += FILE_PAGE) {
        const body = (await kget(`/FileList/${kind}${qs({ EntityKey: key, $filter: filter, $top: FILE_PAGE, $skip: skip || undefined })}`) ?? {});
        const files = body.Attachments ?? [];
        for (const f of files) {
            if (new Date(String(f.DateCreated)).getTime() <= since.getTime())
                return out;
            out.push(f);
        }
        const total = typeof body.TotalCount === "number" ? body.TotalCount : 0;
        if (files.length < FILE_PAGE || skip + FILE_PAGE >= total)
            return out;
    }
}
export async function scanUploads(o) {
    const result = { scanned: {}, uploads: [], errors: [] };
    for (const kind of o.kinds ?? ["Contact", "Organization"]) {
        const k = KINDS[kind];
        const clients = (await pageAll(k.path, { $filter: o.contactType ? `ContactType eq ${odataString(o.contactType)}` : undefined }, { maxRecords: 20_000 })).value;
        result.scanned[kind] = clients.length;
        await mapLimit(clients, CONCURRENCY, async (c) => {
            const entityKey = String(c[k.key] ?? "");
            if (!entityKey)
                return;
            try {
                for (const f of await filesSince(kind, entityKey, o.since, !!o.includeWorkItemFiles)) {
                    result.uploads.push({
                        kind, entityKey, entityName: String(c.FullName ?? entityKey),
                        fileKey: String(f.FileContextKey), fileName: String(f.FileName ?? ""),
                        fileSize: typeof f.FileSize === "number" ? f.FileSize : null,
                        mimeType: typeof f.MimeType === "string" ? f.MimeType : null,
                        source: typeof f.Source === "string" ? f.Source : null,
                        dateCreated: String(f.DateCreated),
                    });
                }
            }
            catch (e) {
                result.errors.push({ kind, entityKey, error: e instanceof Error ? e.message : String(e) });
            }
        });
    }
    result.uploads.sort((a, b) => a.dateCreated.localeCompare(b.dateCreated));
    return result;
}
export async function sendMail(cfg, subject, html) {
    const tokenRes = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
    });
    const token = (await tokenRes.json().catch(() => ({})));
    if (!tokenRes.ok || !token.access_token)
        throw new Error(`Graph token request failed (${tokenRes.status}): ${token.error_description ?? "no access_token"}`);
    const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.from)}/sendMail`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.access_token}` },
        body: JSON.stringify({
            message: { subject, body: { contentType: "HTML", content: html }, toRecipients: cfg.to.map(address => ({ emailAddress: { address } })) },
            saveToSentItems: true,
        }),
    });
    if (!res.ok)
        throw new Error(`Graph sendMail failed (${res.status}): ${await res.text()}`);
}
const esc = (s) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const size = (n) => n === null ? "" : n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
const sydney = (iso) => new Date(iso).toLocaleString("en-AU", { timeZone: "Australia/Sydney", day: "2-digit", month: "short", hour: "numeric", minute: "2-digit" });
// links: URL templates with {key}, e.g. KARBON_CONTACT_URL. Missing → no link.
export function alertEmail(uploads, links = {}) {
    const byClient = new Map();
    for (const u of uploads)
        byClient.set(`${u.kind}:${u.entityKey}`, [...(byClient.get(`${u.kind}:${u.entityKey}`) ?? []), u]);
    const names = [...byClient.values()].map(us => us[0].entityName);
    const subject = `Client portal: ${uploads.length} new file${uploads.length === 1 ? "" : "s"} from ${names.length === 1 ? names[0] : `${names.length} clients`}`;
    const rows = [...byClient.values()].map(us => {
        const u0 = us[0];
        const tpl = links[u0.kind];
        const name = tpl ? `<a href="${esc(tpl.replace("{key}", encodeURIComponent(u0.entityKey)))}">${esc(u0.entityName)}</a>` : esc(u0.entityName);
        const files = us.map(u => `<li>${esc(u.fileName)} <span style="color:#666">(${size(u.fileSize)}, ${sydney(u.dateCreated)})</span></li>`).join("");
        return `<p><b>${name}</b> <span style="color:#666">${u0.kind}</span></p><ul>${files}</ul>`;
    }).join("");
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px">
<p>These files appeared in Karbon client portals since the last check. Open the client's Documents in Karbon to file them.</p>
${rows}
<p style="color:#666;font-size:12px">Karbon doesn't say who uploaded a file, so a file a staff member shared to the portal can also appear here. Uploads made through requests aren't included: Karbon notifies those already.</p>
</div>`;
    return { subject, html };
}
const OVERLAP_MS = 15 * 60 * 1000;
const ALERTED_TTL_MS = 3 * 24 * 60 * 60 * 1000;
export function readState(file) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    }
    catch {
        return null;
    }
}
function writeState(file, state) {
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
}
// One pass. The watermark only moves after the email has gone (or there was
// nothing to send), so a failed send is retried on the next pass.
export async function runUploadWatch(cfg, deps = {}) {
    const now = (deps.now ?? (() => new Date()))();
    const state = readState(cfg.stateFile) ?? { watermark: new Date(now.getTime() - cfg.initialLookbackMinutes * 60_000).toISOString(), alerted: {} };
    const since = new Date(new Date(state.watermark).getTime() - OVERLAP_MS);
    const scan = await (deps.scan ?? scanUploads)({ since, contactType: cfg.contactType });
    const newUploads = scan.uploads.filter(u => !state.alerted[u.fileKey]);
    let emailed = false;
    if (newUploads.length) {
        const { subject, html } = alertEmail(newUploads, cfg.links);
        await (deps.send ?? sendMail)(cfg.mail, subject, html);
        emailed = true;
    }
    for (const u of newUploads)
        state.alerted[u.fileKey] = u.dateCreated;
    for (const [k, d] of Object.entries(state.alerted))
        if (now.getTime() - new Date(d).getTime() > ALERTED_TTL_MS)
            delete state.alerted[k];
    state.watermark = now.toISOString();
    writeState(cfg.stateFile, state);
    console.log(JSON.stringify({ uploadWatch: "run", at: now.toISOString(), since: since.toISOString(), scanned: scan.scanned, found: scan.uploads.length, new: newUploads.length, emailed, errors: scan.errors.length }));
    if (scan.errors.length)
        console.log(JSON.stringify({ uploadWatch: "errors", sample: scan.errors.slice(0, 5) }));
    return { newUploads, emailed, errors: scan.errors.length };
}
export function watchConfigFromEnv(env = process.env) {
    if (env.UPLOAD_WATCH_ENABLED !== "true")
        return null;
    const missing = ["GRAPH_TENANT_ID", "GRAPH_CLIENT_ID", "GRAPH_CLIENT_SECRET", "UPLOAD_ALERT_FROM"].filter(k => !env[k]);
    if (missing.length) {
        console.log(`Upload watch not started: missing ${missing.join(", ")}`);
        return null;
    }
    return {
        stateFile: env.UPLOAD_WATCH_STATE_FILE || "./upload-watch-state.json",
        intervalMinutes: Number(env.UPLOAD_WATCH_INTERVAL_MINUTES) || 30,
        initialLookbackMinutes: Number(env.UPLOAD_WATCH_INITIAL_LOOKBACK_MINUTES) || 60,
        contactType: env.UPLOAD_WATCH_CONTACT_TYPE || undefined,
        mail: {
            tenantId: env.GRAPH_TENANT_ID, clientId: env.GRAPH_CLIENT_ID, clientSecret: env.GRAPH_CLIENT_SECRET,
            from: env.UPLOAD_ALERT_FROM,
            to: (env.UPLOAD_ALERT_TO || "info@dreamaccounting.com.au").split(",").map(s => s.trim()).filter(Boolean),
        },
        links: { Contact: env.KARBON_CONTACT_URL || undefined, Organization: env.KARBON_ORGANIZATION_URL || undefined },
    };
}
export function startUploadWatch(cfg) {
    let running = false;
    const tick = async () => {
        if (running)
            return;
        running = true;
        try {
            await runUploadWatch(cfg);
        }
        catch (e) {
            console.log(JSON.stringify({ uploadWatch: "failed", error: e instanceof Error ? e.message : String(e) }));
        }
        finally {
            running = false;
        }
    };
    console.log(`Upload watch every ${cfg.intervalMinutes} min → ${cfg.mail.to.join(", ")}`);
    setTimeout(tick, 60_000);
    setInterval(tick, cfg.intervalMinutes * 60_000);
}
// ── Tool ─────────────────────────────────────────────────────────────────────
export function registerUploadWatchTools(s) {
    s.tool("list_recent_client_uploads", "Files clients can see (IsShared) that appeared on Contacts/Organizations in the last N hours: what the portal upload watch emails about. Read-only, sends nothing. Scans every client, so it takes a few minutes. includeWorkItemFiles adds files attached through requests/work items.", {
        sinceHours: z.number().min(0.25).max(24 * 31).optional().default(24),
        include: z.array(z.enum(["Contact", "Organization"])).optional().default(["Contact", "Organization"]),
        contactType: z.string().optional().describe("Only clients of this contact type, e.g. Client"),
        includeWorkItemFiles: z.boolean().optional().default(false),
    }, async (a) => {
        const since = new Date(Date.now() - a.sinceHours * 3_600_000);
        const r = await scanUploads({ since, kinds: [...new Set(a.include)], contactType: a.contactType, includeWorkItemFiles: a.includeWorkItemFiles });
        return text({ since: since.toISOString(), scanned: r.scanned, found: r.uploads.length, uploads: r.uploads, ...(r.errors.length ? { errors: r.errors.slice(0, 20), errorCount: r.errors.length } : {}) });
    });
}
