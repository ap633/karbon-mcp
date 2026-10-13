import { z } from "zod";
import { kget, text, verifiedWrite } from "./karbon.js";
// Business cards (docs/KARBON_API.md › Business Cards; Workflow 8).
//
// GET/PUT /v3/BusinessCards/{BusinessCardKey}. The PUT replaces the whole card,
// so the write reads the card, applies only the requested changes, PUTs the full
// card back (with BusinessCardKey, EntityType and EntityKey), then reads back and
// checks both the changes and that every other part of the card is unchanged.
//
// The request schema has no AddressKey / PhoneNumberKey, so they are left out of
// the PUT and ignored when comparing; Karbon may issue new ones.
const enc = encodeURIComponent;
const reasonParam = z.string().trim().min(1).describe("Why this change is being made — required for auditability");
export const PHONE_LABELS = ["Work", "Mobile", "Office", "Fax", "Home", "Other"];
export const ADDRESS_LABELS = ["Physical", "Mailing", "Legal", "Home"];
const DEFAULT_COUNTRY = "AU";
// ISO 3166-1 alpha-2.
const ISO_COUNTRIES = new Set(("AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
    "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
    "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
    "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT " +
    "MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW " +
    "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG " +
    "UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW").split(" "));
const phoneIn = z.object({
    number: z.string().trim().min(1).max(20),
    label: z.enum(PHONE_LABELS),
    countryCode: z.string().optional().describe(`ISO 3166-1 alpha-2, default ${DEFAULT_COUNTRY}`),
});
const addressIn = z.object({
    addressLines: z.string().max(200).optional(),
    city: z.string().max(100).optional(),
    stateProvinceCounty: z.string().max(100).optional().describe("e.g. NSW"),
    zipCode: z.string().max(20).optional(),
    countryCode: z.string().optional().describe(`ISO 3166-1 alpha-2, default ${DEFAULT_COUNTRY}`),
    label: z.enum(ADDRESS_LABELS),
});
function country(code, where, errors) {
    const c = (code ?? DEFAULT_COUNTRY).trim().toUpperCase();
    if (!ISO_COUNTRIES.has(c))
        errors.push(`${where}: '${code}' isn't an ISO 3166-1 alpha-2 country code (e.g. AU, NZ, GB, US).`);
    return c;
}
const toPhone = (p, errors) => ({ Number: p.number, CountryCode: country(p.countryCode, `Phone ${p.number}`, errors), Label: p.label });
const toAddress = (a, errors) => ({
    AddressLines: a.addressLines ?? null, City: a.city ?? null, StateProvinceCounty: a.stateProvinceCounty ?? null,
    ZipCode: a.zipCode ?? null, CountryCode: country(a.countryCode, `${a.label} address`, errors), Label: a.label,
});
// ── Comparison (keys ignored, phone numbers by digits, lists in any order) ──
const digits = (s) => String(s ?? "").replace(/\D/g, "");
const s0 = (v) => (v === undefined || v === null ? "" : String(v).trim());
const normPhone = (p) => JSON.stringify([digits(p.Number), s0(p.CountryCode).toUpperCase(), s0(p.Label)]);
const normAddress = (a) => JSON.stringify(["AddressLines", "City", "StateProvinceCounty", "ZipCode"].map(k => s0(a[k])).concat([s0(a.CountryCode).toUpperCase(), s0(a.Label)]));
const normStrings = (xs) => (xs ?? []).map(x => s0(x).toLowerCase());
const sortedJson = (xs) => JSON.stringify([...xs].sort());
export const CARD_FIELDS = {
    EmailAddresses: v => sortedJson(normStrings(v)),
    WebSites: v => sortedJson(normStrings(v)),
    PhoneNumbers: v => sortedJson((v ?? []).map(normPhone)),
    Addresses: v => sortedJson((v ?? []).map(normAddress)),
    IsPrimaryCard: v => String(!!v),
    OrganizationKey: v => s0(v),
    RoleOrTitle: v => s0(v),
    FacebookLink: v => s0(v),
    LinkedInLink: v => s0(v),
    TwitterLink: v => s0(v),
    SkypeLink: v => s0(v),
};
// Body for the PUT: the whole current card, minus OData annotations and the
// per-item keys the request schema doesn't have.
export function cardPutBody(cur, key) {
    const body = {};
    for (const [k, v] of Object.entries(cur))
        if (!k.startsWith("@odata"))
            body[k] = v;
    body.BusinessCardKey = key;
    body.PhoneNumbers = (cur.PhoneNumbers ?? []).map(({ PhoneNumberKey, ...p }) => p);
    body.Addresses = (cur.Addresses ?? []).map(({ AddressKey, ...a }) => a);
    return body;
}
export function registerBusinessCardTools(s) {
    s.tool("get_business_card", "Get a Business Card (emails, phones, addresses, websites, role, social links) by BusinessCardKey. Find the key with get_contact / get_organization and expand: ['BusinessCards'].", {
        businessCardKey: z.string(),
    }, async ({ businessCardKey }) => text(await kget(`/BusinessCards/${enc(businessCardKey)}`)));
    s.tool("update_business_card", `Change a Business Card. Pass only what should change; everything else on the card is kept. Lists can be replaced whole (emailAddresses, webSites, phoneNumbers, addresses) or edited: add/remove emails, upsert/remove phones and addresses by label. Phone labels: ${PHONE_LABELS.join(", ")}. Address labels: ${ADDRESS_LABELS.join(", ")}. Country codes are ISO 3166-1 alpha-2 and default to ${DEFAULT_COUNTRY}. Karbon's PUT replaces the whole card, so this reads it, merges, PUTs, then reads back to confirm the changes and that nothing else moved. Requires a \`reason\`.`, {
        businessCardKey: z.string(),
        emailAddresses: z.array(z.string().email()).optional().describe("Replace all email addresses"),
        addEmailAddresses: z.array(z.string().email()).optional(),
        removeEmailAddresses: z.array(z.string()).optional(),
        webSites: z.array(z.string()).optional().describe("Replace all websites"),
        phoneNumbers: z.array(phoneIn).optional().describe("Replace all phone numbers"),
        upsertPhoneNumbers: z.array(phoneIn).optional().describe("Set the phone with this label (replaces the existing one with that label, or adds it)"),
        removePhoneLabels: z.array(z.enum(PHONE_LABELS)).optional(),
        addresses: z.array(addressIn).optional().describe("Replace all addresses"),
        upsertAddresses: z.array(addressIn).optional().describe("Set the address with this label (replaces the existing one with that label, or adds it)"),
        removeAddressLabels: z.array(z.enum(ADDRESS_LABELS)).optional(),
        roleOrTitle: z.string().nullable().optional(),
        isPrimaryCard: z.boolean().optional(),
        organizationKey: z.string().nullable().optional().describe("Contact cards only: link the contact to this Organization (null to unlink). Always null on Organization cards."),
        facebookLink: z.string().optional(), linkedInLink: z.string().optional(), twitterLink: z.string().optional(), skypeLink: z.string().optional(),
        reason: reasonParam,
    }, async (a) => {
        const errors = [];
        if (a.emailAddresses && (a.addEmailAddresses || a.removeEmailAddresses))
            errors.push("Use emailAddresses (replace) or add/removeEmailAddresses, not both.");
        if (a.phoneNumbers && (a.upsertPhoneNumbers || a.removePhoneLabels))
            errors.push("Use phoneNumbers (replace) or upsertPhoneNumbers/removePhoneLabels, not both.");
        if (a.addresses && (a.upsertAddresses || a.removeAddressLabels))
            errors.push("Use addresses (replace) or upsertAddresses/removeAddressLabels, not both.");
        for (const list of [a.upsertPhoneNumbers, a.upsertAddresses]) {
            const labels = (list ?? []).map(x => x.label);
            if (new Set(labels).size !== labels.length)
                errors.push(`Each label can be upserted once: ${labels.join(", ")}.`);
        }
        // Convert and validate country codes up front.
        const phones = a.phoneNumbers?.map(p => toPhone(p, errors));
        const upPhones = a.upsertPhoneNumbers?.map(p => toPhone(p, errors));
        const addrs = a.addresses?.map(x => toAddress(x, errors));
        const upAddrs = a.upsertAddresses?.map(x => toAddress(x, errors));
        if (errors.length)
            return text({ ok: false, error: "Nothing was changed.", errors });
        const path = `/BusinessCards/${enc(a.businessCardKey)}`;
        // Applies the request to a freshly read card; also used on 409 retries.
        const apply = (cur) => {
            const errs = [];
            const changes = {};
            if (a.emailAddresses)
                changes.EmailAddresses = a.emailAddresses;
            if (a.addEmailAddresses || a.removeEmailAddresses) {
                const remove = new Set((a.removeEmailAddresses ?? []).map(e => e.trim().toLowerCase()));
                const list = (cur.EmailAddresses ?? []).filter(e => !remove.has(e.trim().toLowerCase()));
                for (const e of a.addEmailAddresses ?? [])
                    if (!list.some(x => x.toLowerCase() === e.toLowerCase()))
                        list.push(e);
                changes.EmailAddresses = list;
            }
            if (a.webSites)
                changes.WebSites = a.webSites;
            const upsert = (existing, up, remove, what) => {
                let list = existing.filter(x => !(remove ?? []).includes(x.Label));
                for (const item of up ?? []) {
                    const same = list.filter(x => x.Label === item.Label);
                    if (same.length > 1) {
                        errs.push(`The card has ${same.length} ${what}s labelled ${item.Label}; replace the whole list instead.`);
                        continue;
                    }
                    list = same.length ? list.map(x => (x.Label === item.Label ? item : x)) : [...list, item];
                }
                return list;
            };
            const strip = (xs, k) => xs.map(({ [k]: _drop, ...rest }) => rest);
            if (phones)
                changes.PhoneNumbers = phones;
            if (upPhones || a.removePhoneLabels)
                changes.PhoneNumbers = upsert(strip(cur.PhoneNumbers ?? [], "PhoneNumberKey"), upPhones, a.removePhoneLabels, "phone number");
            if (addrs)
                changes.Addresses = addrs;
            if (upAddrs || a.removeAddressLabels)
                changes.Addresses = upsert(strip(cur.Addresses ?? [], "AddressKey"), upAddrs, a.removeAddressLabels, "address");
            if (a.roleOrTitle !== undefined)
                changes.RoleOrTitle = a.roleOrTitle;
            if (a.isPrimaryCard !== undefined)
                changes.IsPrimaryCard = a.isPrimaryCard;
            if (a.organizationKey !== undefined) {
                if (cur.EntityType === "Organization" && a.organizationKey)
                    errs.push("OrganizationKey is always null on an Organization's card; it only links a Contact to an Organization.");
                else
                    changes.OrganizationKey = a.organizationKey;
            }
            for (const [k, f] of [["FacebookLink", a.facebookLink], ["LinkedInLink", a.linkedInLink], ["TwitterLink", a.twitterLink], ["SkypeLink", a.skypeLink]])
                if (f !== undefined)
                    changes[k] = f;
            return { changes, errors: errs };
        };
        // Check the request against the current card before writing anything.
        const first = apply((await kget(path) ?? {}));
        if (first.errors.length)
            return text({ ok: false, error: "Nothing was changed.", errors: first.errors });
        if (!Object.keys(first.changes).length)
            return text({ ok: false, error: "No changes requested." });
        let changes = first.changes;
        const w = await verifiedWrite({
            tool: "update_business_card", reason: a.reason,
            read: async () => (await kget(path) ?? {}),
            build: (cur) => {
                changes = apply(cur).changes;
                return { method: "PUT", path, body: { ...cardPutBody(cur, a.businessCardKey), ...changes } };
            },
            verify: (after, before) => {
                const f = [];
                for (const [field, norm] of Object.entries(CARD_FIELDS)) {
                    const expected = field in changes ? changes[field] : before[field];
                    if (norm(expected) !== norm(after[field])) {
                        f.push(field in changes
                            ? `${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(after[field] ?? null)}`
                            : `${field} changed unexpectedly: was ${JSON.stringify(before[field] ?? null)}, now ${JSON.stringify(after[field] ?? null)}`);
                    }
                }
                if (s0(after.EntityKey) !== s0(before.EntityKey))
                    f.push("EntityKey changed unexpectedly");
                return f;
            },
        });
        const fields = Object.keys(changes);
        const pick = (o) => o && Object.fromEntries(fields.map(k => [k, o[k] ?? null]));
        return text({
            ok: w.ok, verified: w.verified, status: w.status, reason: a.reason, businessCardKey: a.businessCardKey,
            entity: { EntityType: w.before.EntityType ?? null, EntityKey: w.before.EntityKey ?? null },
            ...(w.conflictRetries ? { conflictRetries: w.conflictRetries } : {}),
            ...(w.error ? { error: w.error } : {}),
            ...(w.failures.length ? { failures: w.failures } : {}),
            before: pick(w.before), after: pick(w.after),
        });
    });
}
