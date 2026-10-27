import { z } from "zod";
import { kget, pageAll, mapLimit, getTenantSettings, verifiedWrite, odataString, text, KarbonError, expectUnchanged, } from "./karbon.js";
import { cardPutBody, CARD_FIELDS } from "./businessCards.js";
import { clearMembershipCache } from "./groupAudit.js";
// Description, contact type, client group members and the compact client list.
//
// Description (EntityDescription.Text) and ContactType can only be changed by a
// whole-record PUT on /v3/Contacts/{key} or /v3/Organizations/{key}; PATCH accepts
// name fields only. The PUT is built from a fresh GET with just the documented
// request fields, BusinessCards omitted (which leaves the cards untouched), then
// read back to check the change and that nothing else moved.
//
// Client group membership is only writable by a whole-group PUT carrying the
// full Members list, so add/remove read the group, edit the list, PUT it back
// and check the members and every other group field afterwards.
//
// The list endpoints don't return EntityDescription, so showing descriptions
// costs one GET per record.
const enc = encodeURIComponent;
const reasonParam = z.string().trim().min(1).describe("Why this change is being made — required for auditability");
const entityTypeParam = z.enum(["Contact", "Organization"]);
// PUT request fields from docs/KarbonAPI.json (BusinessCards left out on purpose).
const KINDS = {
    Contact: {
        path: "/Contacts", key: "ContactKey",
        putFields: ["FirstName", "MiddleName", "LastName", "PreferredName", "Salutation", "Suffix", "RestrictionLevel", "ClientOwner", "ClientManager", "ContactType", "UserDefinedIdentifier", "EntityDescription", "AccountingDetail", "ClientTeam"],
    },
    Organization: {
        path: "/Organizations", key: "OrganizationKey",
        putFields: ["FullName", "ClientOwner", "ClientManager", "ContactType", "UserDefinedIdentifier", "RestrictionLevel", "AccountingDetail", "EntityDescription", "ClientTeam"],
    },
};
const GROUP_PUT_FIELDS = ["FullName", "ClientOwner", "ClientManager", "ContactType", "UserDefinedIdentifier", "RestrictionLevel", "PrimaryContact", "EntityDescription"];
const s0 = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
// ── Description text ─────────────────────────────────────────────────────────
export const descriptionOf = (r) => s0(r?.EntityDescription?.Text);
const decodeEntities = (s) => s
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
// For comparing what was sent with what reads back: Karbon may store the text as
// HTML or change line endings, so tags are dropped and whitespace collapsed.
export const normDescription = (s) => decodeEntities(s.replace(/<br\s*\/?>|<\/p>/gi, "\n").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
const urlsIn = (s) => s.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
// Already there if every link in the new text is in the existing description, or
// (for text without links) the whole text is.
export function alreadyPresent(existing, add) {
    const plain = decodeEntities(existing);
    const urls = urlsIn(add);
    if (urls.length)
        return urls.every(u => plain.includes(u));
    return normDescription(plain).includes(normDescription(add));
}
export function combineDescription(existing, add, mode, separator) {
    if (mode === "replace" || !existing.trim())
        return add;
    return mode === "prepend" ? `${add}${separator}${existing}` : `${existing}${separator}${add}`;
}
// Adds `Description` to each row (one GET per row, 5 at a time).
export async function addDescriptions(rows, kind) {
    const k = KINDS[kind];
    await mapLimit(rows, 5, async (row) => {
        const key = s0(row[k.key]);
        if (!key) {
            row.Description = null;
            return;
        }
        try {
            row.Description = descriptionOf((await kget(`${k.path}/${enc(key)}`) ?? {})) || null;
        }
        catch (e) {
            row.Description = null;
            row.DescriptionError = e.message;
        }
    });
}
// ── Whole-record PUT for a Contact or Organization ───────────────────────────
function entityPutBody(kind, cur, key) {
    const k = KINDS[kind];
    const body = { [k.key]: key };
    for (const f of k.putFields)
        if (f in cur)
            body[f] = cur[f];
    return body;
}
// Fields that must read back unchanged after the PUT (everything we didn't change).
const stableFields = (kind, changed) => [...KINDS[kind].putFields, "BusinessCards"].filter(f => !changed.includes(f));
async function putEntity(o) {
    const path = `${KINDS[o.kind].path}/${enc(o.key)}`;
    let changes = {};
    const w = await verifiedWrite({
        tool: o.tool, reason: o.reason,
        read: async () => (await kget(`${path}?$expand=BusinessCards,ClientTeam`) ?? {}),
        build: (cur) => {
            changes = o.change(cur);
            return { method: "PUT", path, body: { ...entityPutBody(o.kind, cur, o.key), ...changes } };
        },
        verify: (after, before) => {
            const f = o.check(after, changes);
            expectUnchanged(f, before, after, stableFields(o.kind, Object.keys(changes)));
            return f;
        },
    });
    return w;
}
const writeStatus = (w) => w.ok ? "verified" : w.status !== null && w.status < 300 ? "not_persisted" : "error";
const memberKey = (m) => s0(m.ContactKey) || s0(m.OrganizationKey);
const membersOf = (g) => (g.Members ?? [])
    .filter(m => m && memberKey(m))
    .map(m => ({ ContactKey: s0(m.ContactKey) || null, OrganizationKey: s0(m.OrganizationKey) || null }));
const memberSet = (ms) => JSON.stringify(ms.map(m => `${m.ContactKey ? "C" : "O"}:${memberKey(m)}`).sort());
function groupPutBody(cur, key, members) {
    const body = { ClientGroupKey: key };
    for (const f of GROUP_PUT_FIELDS)
        if (f in cur)
            body[f] = cur[f];
    body.Members = members;
    // Send the card back as it is when the GET included it; otherwise leave it out.
    const card = cur.BusinessCard;
    if (card && s0(card.BusinessCardKey))
        body.BusinessCard = cardPutBody(card, s0(card.BusinessCardKey));
    return body;
}
function groupUnchanged(f, before, after) {
    expectUnchanged(f, before, after, GROUP_PUT_FIELDS);
    const b = (before.BusinessCard ?? null), a = (after.BusinessCard ?? null);
    if (b)
        for (const [field, norm] of Object.entries(CARD_FIELDS)) {
            if (norm(b[field]) !== norm(a?.[field]))
                f.push(`BusinessCard.${field} changed unexpectedly: was ${JSON.stringify(b[field] ?? null)}, now ${JSON.stringify(a?.[field] ?? null)}`);
        }
}
async function nameOf(m) {
    const kind = m.ContactKey ? "Contact" : "Organization";
    const key = memberKey(m);
    try {
        const r = (await kget(`${KINDS[kind].path}/${enc(key)}`) ?? {});
        const name = kind === "Organization" ? s0(r.FullName)
            : [s0(r.PreferredName) || s0(r.FirstName), s0(r.LastName)].filter(Boolean).join(" ");
        return { memberType: kind, key, name: name || null, contactType: r.ContactType ?? null };
    }
    catch (e) {
        return { memberType: kind, key, name: null, error: e.message };
    }
}
async function changeMembers(o) {
    const path = `/ClientGroups/${enc(o.groupKey)}`;
    const first = (await kget(path) ?? {});
    const { members: target, noop } = o.edit(membersOf(first));
    const base = { clientGroupKey: o.groupKey, groupName: first.FullName ?? null, reason: o.reason };
    if (noop)
        return { ok: true, status: noop, ...base, members: membersOf(first) };
    if (o.dryRun)
        return { ok: true, status: "would_update", ...base, membersBefore: membersOf(first), membersAfter: target };
    let expected = target;
    const w = await verifiedWrite({
        tool: o.tool, reason: o.reason,
        read: async () => (await kget(path) ?? {}),
        build: (cur) => {
            expected = o.edit(membersOf(cur)).members;
            return { method: "PUT", path, body: groupPutBody(cur, o.groupKey, expected) };
        },
        verify: (after, before) => {
            const f = [];
            if (memberSet(membersOf(after)) !== memberSet(expected))
                f.push(`Members: expected ${memberSet(expected)}, got ${memberSet(membersOf(after))}`);
            groupUnchanged(f, before, after);
            return f;
        },
    });
    clearMembershipCache();
    return {
        ok: w.ok, status: writeStatus(w), httpStatus: w.status, ...base,
        ...(w.conflictRetries ? { conflictRetries: w.conflictRetries } : {}),
        ...(w.error ? { error: w.error } : {}),
        ...(w.failures.length ? { failures: w.failures } : {}),
        membersBefore: membersOf(w.before), membersAfter: w.after ? membersOf(w.after) : null,
    };
}
// ── Tools ────────────────────────────────────────────────────────────────────
export function registerClientRecordTools(s) {
    s.tool("update_description", "Write the Description on a Contact or Organization. Default mode 'prepend' puts the new text at the top and keeps everything already there (e.g. a HubSpot link); 'append' adds it at the end; 'replace' overwrites. Skips the write if the text is already there (for text with links: every link is already in the description), so re-running is safe. Karbon only accepts this through a whole-record PUT, so the record is read, the description changed, sent back without BusinessCards (cards untouched), then read back to confirm the new description and that no other field moved. Status: already_present | would_update | verified | not_persisted | error. Requires a `reason`.", {
        entityType: entityTypeParam,
        key: z.string().describe("ContactKey or OrganizationKey"),
        text: z.string().trim().min(1).describe("The line to add, e.g. a SharePoint or Ignition link"),
        mode: z.enum(["prepend", "append", "replace"]).optional().default("prepend"),
        separator: z.string().optional().default("\n").describe("Placed between the new text and the existing description. Default: a line break."),
        skipIfPresent: z.boolean().optional().default(true).describe("Don't write if the text (or every link in it) is already in the description"),
        dryRun: z.boolean().optional().default(false).describe("Show the before/after text without writing"),
        reason: reasonParam,
    }, async (a) => {
        const kind = a.entityType;
        const cur = (await kget(`${KINDS[kind].path}/${enc(a.key)}`) ?? {});
        const before = descriptionOf(cur);
        const base = { entityType: kind, key: a.key, reason: a.reason, mode: a.mode };
        if (a.skipIfPresent && (a.mode === "replace" ? normDescription(before) === normDescription(a.text) : alreadyPresent(before, a.text))) {
            return text({ ok: true, status: "already_present", ...base, description: before });
        }
        if (a.dryRun)
            return text({ ok: true, status: "would_update", ...base, before, after: combineDescription(before, a.text, a.mode, a.separator) });
        let sent = "";
        const w = await putEntity({
            tool: "update_description", kind, key: a.key, reason: a.reason,
            change: (c) => {
                const existing = descriptionOf(c);
                // On a 409 retry someone may have added it meanwhile; don't add it twice.
                sent = a.skipIfPresent && a.mode !== "replace" && alreadyPresent(existing, a.text) ? existing : combineDescription(existing, a.text, a.mode, a.separator);
                return { EntityDescription: { ...(c.EntityDescription ?? {}), Text: sent } };
            },
            check: (after) => normDescription(descriptionOf(after)) === normDescription(sent) ? [] : [`Description: expected ${JSON.stringify(sent)}, got ${JSON.stringify(descriptionOf(after))}`],
        });
        return text({
            ok: w.ok, status: writeStatus(w), httpStatus: w.status, ...base,
            ...(w.conflictRetries ? { conflictRetries: w.conflictRetries } : {}),
            ...(w.error ? { error: w.error } : {}),
            ...(w.failures.length ? { failures: w.failures } : {}),
            before: descriptionOf(w.before), after: w.after ? descriptionOf(w.after) : null,
        });
    });
    s.tool("set_contact_type", "Change the contact type (status) of a Contact or Organization, e.g. Client, Inactive, Let go, Deregistered. The value must be one of the account's ContactTypes from TenantSettings (matched without regard to case). Whole-record PUT without BusinessCards, then read back to confirm the type and that nothing else moved. Status: already_set | verified | not_persisted | error. Requires a `reason`.", {
        entityType: entityTypeParam,
        key: z.string().describe("ContactKey or OrganizationKey"),
        contactType: z.string().trim().min(1),
        reason: reasonParam,
    }, async (a) => {
        const ts = await getTenantSettings();
        const valid = (ts.ContactTypes ?? []).map(t => (typeof t === "string" ? t : s0(t?.Name))).filter(Boolean);
        const match = valid.find(t => t.toLowerCase() === a.contactType.toLowerCase());
        if (!match)
            return text({ ok: false, error: `'${a.contactType}' isn't a contact type in this Karbon account. Nothing was changed.`, validContactTypes: valid });
        const kind = a.entityType;
        const cur = (await kget(`${KINDS[kind].path}/${enc(a.key)}`) ?? {});
        const base = { entityType: kind, key: a.key, reason: a.reason };
        if (s0(cur.ContactType).toLowerCase() === match.toLowerCase())
            return text({ ok: true, status: "already_set", ...base, contactType: cur.ContactType });
        const w = await putEntity({
            tool: "set_contact_type", kind, key: a.key, reason: a.reason,
            change: () => ({ ContactType: match }),
            check: (after) => s0(after.ContactType).toLowerCase() === match.toLowerCase() ? [] : [`ContactType: expected ${JSON.stringify(match)}, got ${JSON.stringify(after.ContactType ?? null)}`],
        });
        return text({
            ok: w.ok, status: writeStatus(w), httpStatus: w.status, ...base,
            ...(w.conflictRetries ? { conflictRetries: w.conflictRetries } : {}),
            ...(w.error ? { error: w.error } : {}),
            ...(w.failures.length ? { failures: w.failures } : {}),
            before: w.before.ContactType ?? null, after: w.after?.ContactType ?? null,
        });
    });
    s.tool("list_client_group_members", "List a client group's members with their keys and type (Contact or Organization). With resolveNames (default) each member's name and contact type are looked up (one GET per member).", {
        clientGroupKey: z.string(),
        resolveNames: z.boolean().optional().default(true),
    }, async ({ clientGroupKey, resolveNames }) => {
        const g = (await kget(`/ClientGroups/${enc(clientGroupKey)}`) ?? {});
        const members = membersOf(g);
        return text({
            clientGroupKey, groupName: g.FullName ?? null, count: members.length,
            members: resolveNames ? await mapLimit(members, 5, nameOf)
                : members.map(m => ({ memberType: m.ContactKey ? "Contact" : "Organization", key: memberKey(m) })),
        });
    });
    s.tool("add_client_group_member", "Add a Contact or Organization to a client group. Karbon only accepts this as a whole-group PUT, so the group is read, the member added to the list, sent back, then read back to confirm the full member list and that no other group field moved. Status: already_member | would_update | verified | not_persisted | error. Requires a `reason`.", {
        clientGroupKey: z.string(),
        memberType: entityTypeParam,
        memberKey: z.string().describe("ContactKey or OrganizationKey"),
        dryRun: z.boolean().optional().default(false),
        reason: reasonParam,
    }, async (a) => {
        try {
            await kget(`${KINDS[a.memberType].path}/${enc(a.memberKey)}`);
        }
        catch (e) {
            if (e instanceof KarbonError && e.status === 404)
                return text({ ok: false, error: `No ${a.memberType} with key ${a.memberKey}. Nothing was changed.` });
            throw e;
        }
        const add = a.memberType === "Contact" ? { ContactKey: a.memberKey, OrganizationKey: null } : { ContactKey: null, OrganizationKey: a.memberKey };
        return text(await changeMembers({
            tool: "add_client_group_member", groupKey: a.clientGroupKey, reason: a.reason, dryRun: a.dryRun,
            edit: (ms) => ms.some(m => memberKey(m) === a.memberKey) ? { members: ms, noop: "already_member" } : { members: [...ms, add] },
        }));
    });
    s.tool("remove_client_group_member", "Remove a Contact or Organization from a client group (the contact or organization itself is not changed). Whole-group PUT with the member left out, then read back to confirm the full member list and that no other group field moved. Status: not_member | would_update | verified | not_persisted | error. Requires a `reason`.", {
        clientGroupKey: z.string(),
        memberKey: z.string().describe("ContactKey or OrganizationKey"),
        dryRun: z.boolean().optional().default(false),
        reason: reasonParam,
    }, async (a) => text(await changeMembers({
        tool: "remove_client_group_member", groupKey: a.clientGroupKey, reason: a.reason, dryRun: a.dryRun,
        edit: (ms) => ms.some(m => memberKey(m) === a.memberKey)
            ? { members: ms.filter(m => memberKey(m) !== a.memberKey) }
            : { members: ms, noop: "not_member" },
    })));
    s.tool("list_all_clients", "Every Contact and/or Organization in one call, compact: columns + rows (kind, key, name, contactType, email, and description when asked). Pages through everything internally. contactType filters on Karbon's side. includeDescription (or either description filter) adds one GET per record, so it is slow for the whole list — narrow with contactType where you can.", {
        include: z.array(entityTypeParam).optional().default(["Contact", "Organization"]),
        contactType: z.string().optional().describe("Only this contact type, e.g. Client"),
        includeDescription: z.boolean().optional().default(false),
        descriptionContains: z.string().optional().describe("Only rows whose description contains this (case-insensitive), e.g. sharepoint.com"),
        descriptionNotContains: z.string().optional().describe("Only rows whose description does NOT contain this (case-insensitive) — e.g. to find records still missing a link"),
        maxRecords: z.number().int().min(1).max(10000).optional().default(5000).describe("Safety cap per kind"),
    }, async (a) => {
        const withDesc = a.includeDescription || !!a.descriptionContains || !!a.descriptionNotContains;
        const columns = ["kind", "key", "name", "contactType", "email", ...(withDesc ? ["description"] : [])];
        const rows = [];
        const counts = {};
        const truncated = [];
        for (const kind of [...new Set(a.include)]) {
            const k = KINDS[kind];
            const p = await pageAll(k.path, { $filter: a.contactType ? `ContactType eq ${odataString(a.contactType)}` : undefined }, { maxRecords: a.maxRecords });
            if (p.nextLink)
                truncated.push(kind);
            if (withDesc)
                await addDescriptions(p.value, kind);
            let n = 0;
            for (const r of p.value) {
                const desc = s0(r.Description);
                if (a.descriptionContains && !desc.toLowerCase().includes(a.descriptionContains.toLowerCase()))
                    continue;
                if (a.descriptionNotContains && desc.toLowerCase().includes(a.descriptionNotContains.toLowerCase()))
                    continue;
                rows.push([kind, r[k.key] ?? null, r.FullName ?? null, r.ContactType ?? null, r.EmailAddress ?? null, ...(withDesc ? [desc || null] : [])]);
                n++;
            }
            counts[kind] = { read: p.value.length, returned: n };
        }
        return text({
            counts, columns, rows,
            ...(truncated.length ? { truncated, note: `Stopped at maxRecords for ${truncated.join(", ")}; raise maxRecords to read the rest.` } : {}),
        });
    });
}
