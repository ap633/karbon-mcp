import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { kget, pageAll, qs, odataString, text, verifiedWrite, KarbonError, type Rec } from "./karbon.js";

// Custom fields (docs/KARBON_API.md › Custom Fields; Workflow 3).
//
// - Definitions: GET/POST /v3/CustomFields, DELETE /v3/CustomFields/{CustomFieldDefinitionKey}.
// - Values: GET/PUT /v3/CustomFieldValues/{EntityKey}; EntityKey is a Contact or
//   Organization key. The PUT replaces the entity's whole set, so writes read the
//   current set, merge in only the requested fields, PUT, then read back and check
//   both the changed fields and that every other field kept its value.
// - Every value is an array of strings, whatever the type. Colleague values are
//   UserKeys (the Users endpoint calls them Id).

const enc = encodeURIComponent;
const reasonParam = z.string().trim().min(1).describe("Why this change is being made — required for auditability");

export const FIELD_TYPES = ["Text", "Number", "Date", "Boolean", "Colleague", "ListSingleSelect", "ListMultipleSelect"] as const;
type FieldType = typeof FIELD_TYPES[number];
type Definition = { Key: string; Name: string; Type: FieldType; IsVisibleToContacts?: boolean; IsVisibleToOrganizations?: boolean; ListOptions?: string[] };
type FieldValue = { Key: string; Name: string; Type: FieldType; Value: string[] };

const lc = (s: unknown) => (typeof s === "string" ? s.trim().toLowerCase() : "");

async function listDefinitions(): Promise<Definition[]> {
  // The endpoint takes no paging parameters; follow nextLink if Karbon sends one.
  return (await pageAll("/CustomFields", {}, { from: "/CustomFields" })).value as unknown as Definition[];
}

async function readValues(entityKey: string): Promise<{ EntityKey: string; CustomFieldValues: FieldValue[] }> {
  const r = (await kget(`/CustomFieldValues/${enc(entityKey)}`) ?? {}) as Rec;
  return { EntityKey: (r.EntityKey as string) ?? entityKey, CustomFieldValues: ((r.CustomFieldValues as FieldValue[] | undefined) ?? []).map(v => ({ ...v, Value: v.Value ?? [] })) };
}

// ── Colleague resolution ─────────────────────────────────────────────────────
type UserRef = { UserKey: string; Name: string | null; EmailAddress: string | null; error?: string };

async function resolveUsers(keys: string[]): Promise<Map<string, UserRef>> {
  const out = new Map<string, UserRef>();
  for (const k of [...new Set(keys)]) {
    try {
      const u = (await kget(`/Users/${enc(k)}`) ?? {}) as Rec;
      out.set(k, { UserKey: k, Name: (u.Name as string) ?? null, EmailAddress: (u.EmailAddress as string) ?? null });
    } catch (e) {
      if (!(e instanceof KarbonError)) throw e;
      out.set(k, { UserKey: k, Name: null, EmailAddress: null, error: e.status === 404 ? "No user with this key" : e.message });
    }
  }
  return out;
}

const withColleagues = (values: FieldValue[], users: Map<string, UserRef>) =>
  values.map(v => (v.Type === "Colleague" ? { ...v, Colleagues: v.Value.map(k => users.get(k) ?? { UserKey: k, Name: null, EmailAddress: null }) } : v));

// An email or a UserKey → UserKey (checked to exist).
async function toUserKey(v: string): Promise<{ key?: string; error?: string }> {
  if (v.includes("@")) {
    const r = (await kget(`/Users${qs({ $filter: `EmailAddress eq ${odataString(v)}` })}`) ?? {}) as Rec;
    const rows = (r.value as Rec[] | undefined) ?? [];
    if (rows.length !== 1) return { error: rows.length ? `More than one user has the email '${v}'.` : `No Karbon user has the email '${v}'.` };
    return { key: rows[0].Id as string };
  }
  const u = (await resolveUsers([v])).get(v)!;
  return u.error ? { error: `Colleague '${v}': ${u.error}` } : { key: v };
}

// ── Value validation: input → Karbon's array-of-strings form ────────────────
type Input = string | number | boolean | string[] | null;

export async function toKarbonValue(def: Definition, input: Input): Promise<{ value?: string[]; error?: string }> {
  if (input === null || (Array.isArray(input) && input.length === 0) || input === "") return { value: [] };
  const many = Array.isArray(input) ? input : [input];
  const one = () => (many.length === 1 ? many[0] : undefined);
  const bad = (msg: string) => ({ error: `${def.Name} (${def.Type}): ${msg}` });

  switch (def.Type) {
    case "Text": {
      const v = one();
      if (typeof v !== "string") return bad("expects one text value.");
      if (v.length > 256) return bad("text is longer than 256 characters.");
      return { value: [v] };
    }
    case "Number": {
      const v = one();
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
      if (!Number.isFinite(n)) return bad(`'${String(v)}' isn't a number.`);
      return { value: [String(n)] };
    }
    case "Date": {
      const v = one();
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(v) || Number.isNaN(Date.parse(v))) return bad("expects a date as YYYY-MM-DD.");
      return { value: [v.slice(0, 10)] };
    }
    case "Boolean": {
      const v = one();
      const b = typeof v === "boolean" ? v : lc(v) === "true" ? true : lc(v) === "false" ? false : undefined;
      if (b === undefined) return bad("expects true or false.");
      return { value: [String(b)] };
    }
    case "Colleague": {
      const keys: string[] = [];
      for (const v of many) {
        if (typeof v !== "string") return bad("expects UserKeys or email addresses.");
        const r = await toUserKey(v.trim());
        if (r.error) return bad(r.error);
        keys.push(r.key!);
      }
      return { value: keys };
    }
    case "ListSingleSelect":
    case "ListMultipleSelect": {
      const opts = def.ListOptions ?? [];
      if (def.Type === "ListSingleSelect" && many.length !== 1) return bad("expects exactly one option.");
      const out: string[] = [];
      for (const v of many) {
        const match = opts.find(o => lc(o) === lc(String(v)));
        if (!match) return bad(`'${String(v)}' isn't an option. Valid options: ${opts.map(o => `'${o}'`).join(", ")}.`);
        if (!out.includes(match)) out.push(match);
      }
      return { value: out };
    }
  }
  return bad("unknown field type.");
}

// Compare values as Karbon may echo them (dates with a time part, "True" vs "true",
// multi-select in any order).
export function sameValue(type: FieldType, a: string[], b: string[]): boolean {
  const norm = (xs: string[]) => xs.map(x => {
    if (type === "Date") return x.slice(0, 10);
    if (type === "Boolean" || type === "ListSingleSelect" || type === "ListMultipleSelect") return x.trim().toLowerCase();
    if (type === "Number") return String(Number(x));
    return x;
  }).sort();
  return JSON.stringify(norm(a ?? [])) === JSON.stringify(norm(b ?? []));
}

export function registerCustomFieldTools(s: McpServer) {
  s.tool("list_custom_fields", "List the custom field definitions in this Karbon account: Key, Name, Type (Text, Number, Date, Boolean, Colleague, ListSingleSelect, ListMultipleSelect), whether visible on Contacts and/or Organizations, and ListOptions for list types.", {}, async () => {
    const defs = await listDefinitions();
    return text({ count: defs.length, value: defs });
  });

  s.tool("get_custom_field_values", "Get the custom field values for a Contact or Organization (EntityKey = ContactKey or OrganizationKey). Values are arrays of strings. Set resolveColleagues to turn Colleague UserKeys into names and emails.", {
    entityKey: z.string().describe("ContactKey or OrganizationKey"),
    resolveColleagues: z.boolean().optional().default(false).describe("Look up each Colleague UserKey via GET /v3/Users/{UserKey}. Adds a call per distinct user."),
  }, async ({ entityKey, resolveColleagues }) => {
    const cur = await readValues(entityKey);
    if (!resolveColleagues) return text(cur);
    const keys = cur.CustomFieldValues.filter(v => v.Type === "Colleague").flatMap(v => v.Value);
    return text({ ...cur, CustomFieldValues: withColleagues(cur.CustomFieldValues, await resolveUsers(keys)) });
  });

  s.tool("set_custom_field_values", "Set custom field values on a Contact or Organization. Pass only the fields to change (by key or name). Values are checked against the field type: list options must match, Colleague accepts UserKeys or emails, null or [] clears a field. Karbon's PUT replaces the whole set, so this reads the current values, merges in only these changes, PUTs, then reads back to confirm both the changes and that every other field kept its value. Requires a `reason`.", {
    entityKey: z.string().describe("ContactKey or OrganizationKey"),
    fields: z.array(z.object({
      key: z.string().optional().describe("Custom field Key (preferred)"),
      name: z.string().optional().describe("Custom field Name, if key isn't known"),
      value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]).describe("New value. Text/Number/Date (YYYY-MM-DD)/Boolean: single value. ListSingleSelect: one option. ListMultipleSelect / Colleague: array. null or [] clears."),
    })).min(1),
    reason: reasonParam,
  }, async ({ entityKey, fields, reason }) => {
    const defs = await listDefinitions();
    const changes = new Map<string, { def: Definition; value: string[] }>();
    const errors: string[] = [];
    for (const f of fields) {
      const def = f.key ? defs.find(d => d.Key === f.key) : defs.filter(d => lc(d.Name) === lc(f.name)).length === 1 ? defs.find(d => lc(d.Name) === lc(f.name)) : undefined;
      if (!def) {
        const dupes = f.name ? defs.filter(d => lc(d.Name) === lc(f.name)).length : 0;
        errors.push(!f.key && !f.name ? "Each field needs a key or a name." : dupes > 1 ? `More than one custom field is named '${f.name}'; pass its key.` : `No custom field with ${f.key ? `key '${f.key}'` : `name '${f.name}'`}.`);
        continue;
      }
      if (changes.has(def.Key)) { errors.push(`${def.Name} is listed more than once.`); continue; }
      const r = await toKarbonValue(def, f.value as Input);
      if (r.error) errors.push(r.error);
      else changes.set(def.Key, { def, value: r.value! });
    }
    if (errors.length) {
      return text({ ok: false, error: "Nothing was changed: some fields are invalid.", errors, fields: defs.map(d => ({ Key: d.Key, Name: d.Name, Type: d.Type, ...(d.ListOptions?.length ? { ListOptions: d.ListOptions } : {}) })) });
    }

    const path = `/CustomFieldValues/${enc(entityKey)}`;
    const w = await verifiedWrite({
      tool: "set_custom_field_values", reason,
      read: async () => (await readValues(entityKey)) as unknown as Rec,
      build: (cur) => {
        const current = (cur.CustomFieldValues as FieldValue[]);
        const merged: FieldValue[] = current.map(v => {
          const c = changes.get(v.Key);
          return c ? { Key: v.Key, Name: v.Name, Type: v.Type, Value: c.value } : { Key: v.Key, Name: v.Name, Type: v.Type, Value: v.Value };
        });
        for (const [key, c] of changes) if (!current.some(v => v.Key === key)) merged.push({ Key: key, Name: c.def.Name, Type: c.def.Type, Value: c.value });
        return { method: "PUT", path, body: { EntityKey: entityKey, CustomFieldValues: merged } };
      },
      verify: (after, before) => {
        const f: string[] = [];
        const a = after.CustomFieldValues as FieldValue[];
        const b = before.CustomFieldValues as FieldValue[];
        const valueOf = (xs: FieldValue[], k: string) => xs.find(v => v.Key === k)?.Value ?? [];
        for (const [key, c] of changes) {
          const got = valueOf(a, key);
          if (!sameValue(c.def.Type, c.value, got)) f.push(`${c.def.Name}: expected ${JSON.stringify(c.value)}, got ${JSON.stringify(got)}`);
        }
        for (const v of b) {
          if (changes.has(v.Key)) continue;
          const got = valueOf(a, v.Key);
          if (!sameValue(v.Type, v.Value, got)) f.push(`${v.Name} changed unexpectedly: was ${JSON.stringify(v.Value)}, now ${JSON.stringify(got)}`);
        }
        return f;
      },
    });

    const summary = [...changes.values()].map(c => {
      const before = (w.before.CustomFieldValues as FieldValue[] | undefined)?.find(v => v.Key === c.def.Key)?.Value ?? [];
      const after = (w.after?.CustomFieldValues as FieldValue[] | undefined)?.find(v => v.Key === c.def.Key)?.Value ?? null;
      return { key: c.def.Key, name: c.def.Name, type: c.def.Type, before, requested: c.value, after };
    });
    return text({
      ok: w.ok, verified: w.verified, status: w.status, reason, entityKey,
      ...(w.conflictRetries ? { conflictRetries: w.conflictRetries } : {}),
      ...(w.error ? { error: w.error } : {}),
      ...(w.failures.length ? { failures: w.failures } : {}),
      changes: summary,
    });
  });

  s.tool("create_custom_field", "Create a custom field definition for Contacts and/or Organizations, then read the definitions back to confirm. List types need listOptions; other types must not have them. Refuses a name that already exists. Requires a `reason`.", {
    name: z.string().trim().min(1).max(100),
    type: z.enum(FIELD_TYPES),
    isVisibleToContacts: z.boolean(),
    isVisibleToOrganizations: z.boolean(),
    listOptions: z.array(z.string().trim().min(1).max(256)).optional().describe("Required for ListSingleSelect / ListMultipleSelect"),
    reason: reasonParam,
  }, async ({ name, type, isVisibleToContacts, isVisibleToOrganizations, listOptions, reason }) => {
    const isList = type === "ListSingleSelect" || type === "ListMultipleSelect";
    if (isList && !listOptions?.length) return text({ ok: false, error: `${type} needs listOptions.` });
    if (!isList && listOptions?.length) return text({ ok: false, error: `listOptions only apply to list types, not ${type}.` });
    if (!isVisibleToContacts && !isVisibleToOrganizations) return text({ ok: false, error: "The field must be visible to Contacts, Organizations or both." });
    if (listOptions && new Set(listOptions.map(lc)).size !== listOptions.length) return text({ ok: false, error: "listOptions contains duplicates." });
    const existing = (await listDefinitions()).find(d => lc(d.Name) === lc(name));
    if (existing) return text({ ok: false, error: `A custom field named '${existing.Name}' already exists.`, existing });

    let createdKey: string | null = null;
    const w = await verifiedWrite({
      tool: "create_custom_field", reason,
      read: async () => ({}),
      build: () => ({ method: "POST", path: "/CustomFields", body: { Name: name, Type: type, IsVisibleToContacts: isVisibleToContacts, IsVisibleToOrganizations: isVisibleToOrganizations, ListOptions: listOptions ?? [] } }),
      readBack: async (res) => {
        createdKey = ((res.body as Rec | null)?.Key as string) ?? null;
        const defs = await listDefinitions();
        return (defs.find(d => (createdKey ? d.Key === createdKey : lc(d.Name) === lc(name))) ?? {}) as Rec;
      },
      verify: (after) => {
        if (!after.Key) return ["the new field isn't in the definitions list"];
        const f: string[] = [];
        if (after.Type !== type) f.push(`Type: expected ${type}, got ${String(after.Type)}`);
        if (lc(after.Name) !== lc(name)) f.push(`Name: expected ${name}, got ${String(after.Name)}`);
        if (isList && !sameValue("ListMultipleSelect", listOptions!, (after.ListOptions as string[]) ?? [])) f.push(`ListOptions: expected ${JSON.stringify(listOptions)}, got ${JSON.stringify(after.ListOptions ?? [])}`);
        return f;
      },
    });
    return text({ ok: w.ok, verified: w.verified, status: w.status, reason, ...(w.error ? { error: w.error } : {}), ...(w.failures.length ? { failures: w.failures } : {}), definition: w.after });
  });

  s.tool("delete_custom_field", "DESTRUCTIVE. Delete a custom field definition, which removes that field and its values from every Contact and Organization. With confirm=false (or omitted) nothing is deleted: it returns the definition that would be removed. Set confirm=true to delete, then the definitions are re-read to confirm it's gone. Requires a `reason`.", {
    customFieldKey: z.string().describe("The definition Key from list_custom_fields"),
    confirm: z.boolean().optional().default(false).describe("Must be true to actually delete"),
    reason: reasonParam,
  }, async ({ customFieldKey, confirm, reason }) => {
    const def = (await listDefinitions()).find(d => d.Key === customFieldKey);
    if (!def) return text({ ok: false, error: `No custom field with key '${customFieldKey}'.` });
    if (!confirm) {
      return text({ ok: false, deleted: false, wouldDelete: def, message: "Nothing deleted. This removes the field and its values from every Contact and Organization. Call again with confirm=true to delete." });
    }
    const w = await verifiedWrite({
      tool: "delete_custom_field", reason,
      read: async () => def as unknown as Rec,
      build: () => ({ method: "DELETE", path: `/CustomFields/${enc(customFieldKey)}` }),
      readBack: async () => ((await listDefinitions()).find(d => d.Key === customFieldKey) ?? {}) as Rec,
      verify: (after) => (after.Key ? ["the definition is still listed after DELETE"] : []),
    });
    return text({ ok: w.ok, verified: w.verified, deleted: w.ok, status: w.status, reason, deletedDefinition: def, ...(w.error ? { error: w.error } : {}), ...(w.failures.length ? { failures: w.failures } : {}) });
  });
}
