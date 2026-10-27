import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerGroupAuditTools } from "./groupAudit.js";
import { registerCustomFieldTools } from "./customFields.js";
import {
  kget, pageAll, pageResult, qs, odataString, text, KarbonError,
  PRIMARY_STATUSES, toSpacedStatus, sameStatus, normalizeStatusFilter,
  getTenantSettings, validSecondaryStatuses,
  verifiedWrite, workItemPutBody, WORK_ITEM_STABLE_FIELDS,
  expectEqual, expectUnchanged, eqCaseless, eqDay, eqMoney,
  type Rec, type KarbonResponse,
} from "./karbon.js";

// All Karbon calls go through src/karbon.ts (auth headers, 429 / 409 handling,
// @odata.nextLink paging, read-back verification). Endpoints are taken from
// docs/KarbonAPI.json only.

const enc = encodeURIComponent;
// Key literal inside an OData path, e.g. (UserDefinedIdentifier='x'): quotes stay literal, value is escaped and encoded.
const keyLit = (v: string) => `'${enc(v.replace(/'/g, "''"))}'`;

// ── Shared parameter shapes ──────────────────────────────────────────────────
const listParams = {
  maxRecords: z.number().int().min(1).max(2000).optional().default(100)
    .describe("Stop after about this many records (read in whole pages of up to 100, following @odata.nextLink). Default 100."),
  nextLink: z.string().optional()
    .describe("Continue an earlier listing: pass the @odata.nextLink it returned. Filters are already inside the link, so other parameters are ignored."),
};
const reasonParam = z.string().trim().min(1).describe("Why this change is being made — required for auditability");

const listing = (path: string, params: Record<string, string | number | boolean | undefined>, maxRecords: number, nextLink?: string) =>
  pageAll(path, params, { maxRecords, from: nextLink }).then(pageResult);

const writeResult = (w: Awaited<ReturnType<typeof verifiedWrite>>, extra: Rec = {}) => text({
  ok: w.ok, verified: w.verified, status: w.status, ...extra,
  ...(w.conflictRetries ? { conflictRetries: w.conflictRetries } : {}),
  ...(w.error ? { error: w.error } : {}),
  ...(w.failures.length ? { failures: w.failures } : {}),
});

const err = (error: string, extra: Rec = {}) => text({ ok: false, error, ...extra });

// Read-back for a POST: GET the created record by the key in the response.
const createdReadBack = (keyField: string, getPath: (key: string) => string) => async (res: KarbonResponse): Promise<Rec> => {
  const key = (res.body as Rec | null)?.[keyField];
  if (typeof key !== "string" || !key) return {};
  return (await kget(getPath(key)) ?? {}) as Rec;
};

const pick = (o: Rec, fields: string[]) => Object.fromEntries(fields.map(f => [f, o[f] ?? null]));

export function createServer() {
  const s = new McpServer({ name: "karbon-mcp", version: "2.2.0" });

  // ── CONTACTS ──────────────────────────────────────────────────────────────
  s.tool("list_contacts", "List contacts (people) from Karbon. Follows @odata.nextLink up to maxRecords; returns @odata.nextLink if more exist.", {
    filter: z.string().optional().describe("OData filter on FullName, EmailAddress, PhoneNumber, ContactType or ExternalKey, e.g. \"ContactType eq 'Client'\" or \"contains(FullName,'Smith')\""),
    orderBy: z.enum(["FullName", "FullName desc", "LastModifiedDateTime", "LastModifiedDateTime desc"]).optional(),
    ...listParams,
  }, async ({ filter, orderBy, maxRecords, nextLink }) =>
    text(await listing("/Contacts", { $filter: filter, $orderby: orderBy }, maxRecords, nextLink)));

  s.tool("get_contact", "Get a single contact by key", { contactKey: z.string() }, async ({ contactKey }) =>
    text(await kget(`/Contacts/${enc(contactKey)}`)));

  s.tool("create_contact", "Create a new contact, then read it back to confirm it exists. Requires a `reason`.", {
    firstName: z.string(), lastName: z.string(),
    contactType: z.string().optional().default("Client"),
    clientOwner: z.string().optional().describe("Email address (or UserKey) of an existing team member"),
    clientManager: z.string().optional().describe("Email address (or UserKey) of an existing team member"),
    reason: reasonParam,
  }, async (b) => {
    const w = await verifiedWrite({
      tool: "create_contact", reason: b.reason,
      read: async () => ({}),
      build: () => ({ method: "POST", path: "/Contacts", body: { FirstName: b.firstName, LastName: b.lastName, ContactType: b.contactType, ClientOwner: b.clientOwner, ClientManager: b.clientManager } }),
      readBack: createdReadBack("ContactKey", k => `/Contacts/${enc(k)}`),
      verify: (after) => {
        const f: string[] = [];
        if (!after.ContactKey) return ["created contact could not be read back"];
        expectEqual(f, "FirstName", b.firstName, after.FirstName);
        expectEqual(f, "LastName", b.lastName, after.LastName);
        return f;
      },
    });
    return writeResult(w, { reason: b.reason, contactKey: w.after?.ContactKey ?? null, after: w.after });
  });

  // Karbon's Contact PATCH accepts only FirstName, MiddleName, LastName,
  // PreferredName, Salutation, Suffix and RestrictionLevel.
  s.tool("update_contact", "Update a contact's name fields (FirstName, MiddleName, LastName, PreferredName, Salutation, Suffix) via PATCH, then read back to confirm. Requires a `reason`.", {
    contactKey: z.string(),
    firstName: z.string().optional(), middleName: z.string().optional(), lastName: z.string().optional(),
    preferredName: z.string().optional(), salutation: z.string().optional(), suffix: z.string().optional(),
    reason: reasonParam,
  }, async ({ contactKey, reason, ...f }) => {
    const body: Rec = {};
    const map: Record<string, string> = { firstName: "FirstName", middleName: "MiddleName", lastName: "LastName", preferredName: "PreferredName", salutation: "Salutation", suffix: "Suffix" };
    for (const [k, v] of Object.entries(f)) if (v !== undefined) body[map[k]] = v;
    if (!Object.keys(body).length) return err("No fields provided to update.");
    const path = `/Contacts/${enc(contactKey)}`;
    const w = await verifiedWrite({
      tool: "update_contact", reason,
      read: async () => (await kget(path) ?? {}) as Rec,
      build: () => ({ method: "PATCH", path, body }),
      verify: (after) => { const fl: string[] = []; for (const [k, v] of Object.entries(body)) expectEqual(fl, k, v, after[k]); return fl; },
    });
    return writeResult(w, { reason, contactKey, before: pick(w.before, Object.keys(body)), after: w.after && pick(w.after, Object.keys(body)) });
  });

  s.tool("get_contact_by_identifier", "Look up a contact by your own UserDefinedIdentifier (external key)", {
    identifier: z.string().describe("Your UserDefinedIdentifier for the contact"),
    expandBusinessCards: z.boolean().optional().default(false).describe("Include BusinessCards (emails, phones, addresses)"),
  }, async ({ identifier, expandBusinessCards }) =>
    text(await kget(`/Contacts/GetContactByUserDefinedIdentifier(UserDefinedIdentifier=${keyLit(identifier)})${expandBusinessCards ? "?$expand=BusinessCards" : ""}`)));

  // ── ORGANIZATIONS ─────────────────────────────────────────────────────────
  s.tool("list_organizations", "List organizations from Karbon. Follows @odata.nextLink up to maxRecords; returns @odata.nextLink if more exist.", {
    filter: z.string().optional().describe("OData filter on FullName, EmailAddress, ContactType or ExternalKey"),
    orderBy: z.enum(["FullName", "FullName desc", "LastModifiedDateTime", "LastModifiedDateTime desc"]).optional(),
    ...listParams,
  }, async ({ filter, orderBy, maxRecords, nextLink }) =>
    text(await listing("/Organizations", { $filter: filter, $orderby: orderBy }, maxRecords, nextLink)));

  s.tool("get_organization", "Get a single organization by key", { organizationKey: z.string() }, async ({ organizationKey }) =>
    text(await kget(`/Organizations/${enc(organizationKey)}`)));

  s.tool("create_organization", "Create a new organization, then read it back to confirm it exists. Requires a `reason`.", {
    fullName: z.string(), contactType: z.string().optional().default("Client"),
    clientOwner: z.string().optional().describe("Email address (or UserKey) of an existing team member"),
    clientManager: z.string().optional().describe("Email address (or UserKey) of an existing team member"),
    reason: reasonParam,
  }, async (b) => {
    const w = await verifiedWrite({
      tool: "create_organization", reason: b.reason,
      read: async () => ({}),
      build: () => ({ method: "POST", path: "/Organizations", body: { FullName: b.fullName, ContactType: b.contactType, ClientOwner: b.clientOwner, ClientManager: b.clientManager } }),
      readBack: createdReadBack("OrganizationKey", k => `/Organizations/${enc(k)}`),
      verify: (after) => {
        if (!after.OrganizationKey) return ["created organization could not be read back"];
        const f: string[] = []; expectEqual(f, "FullName", b.fullName, after.FullName); return f;
      },
    });
    return writeResult(w, { reason: b.reason, organizationKey: w.after?.OrganizationKey ?? null, after: w.after });
  });

  // PATCH only accepts FullName (and RestrictionLevel). ClientOwner/ClientManager
  // need a full PUT: GET current (with BusinessCards and ClientTeam expanded so we
  // can check they survive), send it back without BusinessCards (omitting them
  // leaves cards untouched), then verify the change and that nothing else moved.
  s.tool("update_organization", "Update an organization's FullName (PATCH) and/or ClientOwner / ClientManager (full PUT that preserves every other field and leaves Business Cards untouched), then read back to confirm. Requires a `reason`.", {
    organizationKey: z.string(),
    fullName: z.string().optional(),
    clientOwner: z.string().email().optional().describe("Email address of an existing team member"),
    clientManager: z.string().email().optional().describe("Email address of an existing team member"),
    reason: reasonParam,
  }, async ({ organizationKey, fullName, clientOwner, clientManager, reason }) => {
    const changes: Rec = {};
    if (fullName !== undefined) changes.FullName = fullName;
    if (clientOwner !== undefined) changes.ClientOwner = clientOwner;
    if (clientManager !== undefined) changes.ClientManager = clientManager;
    if (!Object.keys(changes).length) return err("No fields provided to update.");
    const path = `/Organizations/${enc(organizationKey)}`;
    const needsPut = clientOwner !== undefined || clientManager !== undefined;
    const w = await verifiedWrite({
      tool: "update_organization", reason,
      read: async () => (await kget(needsPut ? `${path}?$expand=BusinessCards,ClientTeam` : path) ?? {}) as Rec,
      build: (current) => {
        if (!needsPut) return { method: "PATCH", path, body: changes };
        const body: Rec = {};
        for (const [k, v] of Object.entries(current)) {
          if (k.startsWith("@odata") || ["BusinessCards", "Contacts", "LastModifiedDateTime"].includes(k)) continue;
          body[k] = v;
        }
        return { method: "PUT", path, body: { ...body, OrganizationKey: organizationKey, ...changes } };
      },
      verify: (after, before) => {
        const f: string[] = [];
        for (const [k, v] of Object.entries(changes)) expectEqual(f, k, v, after[k], eqCaseless);
        if (needsPut) expectUnchanged(f, before, after, ["BusinessCards", "ClientTeam", "AccountingDetail", "ContactType", "UserDefinedIdentifier", "RestrictionLevel", "EntityDescription"].filter(x => !(x in changes)));
        return f;
      },
    });
    return writeResult(w, { reason, organizationKey, method: needsPut ? "PUT" : "PATCH", before: pick(w.before, Object.keys(changes)), after: w.after && pick(w.after, Object.keys(changes)) });
  });

  s.tool("get_organization_by_identifier", "Look up an organization by your own UserDefinedIdentifier", {
    identifier: z.string(),
    expandBusinessCards: z.boolean().optional().default(false),
  }, async ({ identifier, expandBusinessCards }) =>
    text(await kget(`/Organizations/GetOrganizationByUserDefinedIdentifier(UserDefinedIdentifier=${keyLit(identifier)})${expandBusinessCards ? "?$expand=BusinessCards" : ""}`)));

  // ── CLIENT GROUPS ─────────────────────────────────────────────────────────
  s.tool("list_client_groups", "List client groups from Karbon. Follows @odata.nextLink up to maxRecords; returns @odata.nextLink if more exist.", {
    filter: z.string().optional().describe("OData filter on FullName (eq only)"),
    ...listParams,
  }, async ({ filter, maxRecords, nextLink }) =>
    text(await listing("/ClientGroups", { $filter: filter }, maxRecords, nextLink)));

  s.tool("get_client_group", "Get a single client group by key (includes Members)", { clientGroupKey: z.string() }, async ({ clientGroupKey }) =>
    text(await kget(`/ClientGroups/${enc(clientGroupKey)}`)));

  s.tool("create_client_group", "Create a new client group, then read it back to confirm it exists. Requires a `reason`.", {
    fullName: z.string(),
    clientOwner: z.string().optional().describe("Email address (or UserKey) of an existing team member"),
    clientManager: z.string().optional().describe("Email address (or UserKey) of an existing team member"),
    reason: reasonParam,
  }, async (b) => {
    const w = await verifiedWrite({
      tool: "create_client_group", reason: b.reason,
      read: async () => ({}),
      build: () => ({ method: "POST", path: "/ClientGroups", body: { FullName: b.fullName, ClientOwner: b.clientOwner, ClientManager: b.clientManager } }),
      readBack: createdReadBack("ClientGroupKey", k => `/ClientGroups/${enc(k)}`),
      verify: (after) => {
        if (!after.ClientGroupKey) return ["created client group could not be read back"];
        const f: string[] = []; expectEqual(f, "FullName", b.fullName, after.FullName); return f;
      },
    });
    return writeResult(w, { reason: b.reason, clientGroupKey: w.after?.ClientGroupKey ?? null, after: w.after });
  });

  // Karbon's ClientGroup PATCH only supports FullName. Owner/manager changes need a
  // full PUT that must carry Members and BusinessCard, which this tool doesn't do.
  s.tool("update_client_group", "Rename a client group (PATCH FullName — the only field Karbon's PATCH accepts), then read back to confirm. Owner/manager changes aren't supported here. Requires a `reason`.", {
    clientGroupKey: z.string(),
    fullName: z.string(),
    reason: reasonParam,
  }, async ({ clientGroupKey, fullName, reason }) => {
    const path = `/ClientGroups/${enc(clientGroupKey)}`;
    const w = await verifiedWrite({
      tool: "update_client_group", reason,
      read: async () => (await kget(path) ?? {}) as Rec,
      build: () => ({ method: "PATCH", path, body: { FullName: fullName } }),
      verify: (after) => { const f: string[] = []; expectEqual(f, "FullName", fullName, after.FullName); return f; },
    });
    return writeResult(w, { reason, clientGroupKey, before: { FullName: w.before.FullName ?? null }, after: w.after && { FullName: w.after.FullName ?? null } });
  });

  s.tool("get_client_group_by_identifier", "Look up a client group by your own UserDefinedIdentifier", {
    identifier: z.string(),
  }, async ({ identifier }) =>
    text(await kget(`/ClientGroups/GetClientGroupByUserDefinedIdentifier(UserDefinedIdentifier=${keyLit(identifier)})`)));

  // ── WORK ITEMS ────────────────────────────────────────────────────────────
  s.tool("list_work", "List work items. PrimaryStatus values in the filter are normalised to the spaced form Karbon's $filter needs ('In Progress', 'Ready To Start'); the no-space form silently returns nothing. Follows @odata.nextLink up to maxRecords; returns @odata.nextLink if more exist.", {
    primaryStatus: z.string().optional().describe("Planned, Ready To Start, In Progress, Waiting or Completed (either spelling). ANDed with filter."),
    filter: z.string().optional().describe("OData filter on AssigneeEmailAddress, ClientKey, PrimaryStatus, Title, WorkScheduleKey, WorkStatus, WorkTemplateKey, WorkType (eq; contains on text fields) or StartDate (ge/le), e.g. \"AssigneeEmailAddress eq 'jo@firm.com'\""),
    orderBy: z.enum(["StartDate", "StartDate desc", "DeadlineDate", "DeadlineDate desc"]).optional(),
    ...listParams,
  }, async ({ primaryStatus, filter, orderBy, maxRecords, nextLink }) => {
    const parts: string[] = [];
    if (primaryStatus) {
      const st = toSpacedStatus(primaryStatus);
      if (!(PRIMARY_STATUSES as readonly string[]).includes(st)) return err(`Unknown primaryStatus '${primaryStatus}'. Use one of: ${PRIMARY_STATUSES.join(", ")}.`);
      parts.push(`PrimaryStatus eq '${st}'`);
    }
    if (filter) parts.push(parts.length ? `(${normalizeStatusFilter(filter)})` : normalizeStatusFilter(filter));
    const $filter = parts.join(" and ") || undefined;
    const result = await listing("/WorkItems", { $filter, $orderby: orderBy }, maxRecords, nextLink);
    return text({ ...(nextLink ? {} : { filterUsed: $filter ?? null }), ...result });
  });

  s.tool("get_work", "Get a single work item by key. Note: single-item responses give PrimaryStatus without spaces ('InProgress').", { workKey: z.string() }, async ({ workKey }) =>
    text(await kget(`/WorkItems/${enc(workKey)}`)));

  s.tool("create_work", "Create a new work item, then read it back to confirm it exists. Requires a `reason`.", {
    title: z.string(), clientKey: z.string(), clientType: z.enum(["Contact", "Organization", "ClientGroup"]),
    assigneeEmail: z.string().describe("Required by Karbon"),
    startDate: z.string().describe("Required by Karbon. ISO 8601, e.g. 2026-07-01T00:00:00Z"),
    workType: z.string().optional(), dueDate: z.string().optional(),
    workTemplateKey: z.string().optional(),
    reason: reasonParam,
  }, async (b) => {
    const w = await verifiedWrite({
      tool: "create_work", reason: b.reason,
      read: async () => ({}),
      build: () => ({ method: "POST", path: "/WorkItems", body: { Title: b.title, ClientKey: b.clientKey, ClientType: b.clientType, AssigneeEmailAddress: b.assigneeEmail, WorkType: b.workType, StartDate: b.startDate, DueDate: b.dueDate, WorkTemplateKey: b.workTemplateKey } }),
      readBack: createdReadBack("WorkItemKey", k => `/WorkItems/${enc(k)}`),
      verify: (after) => {
        if (!after.WorkItemKey) return ["created work item could not be read back"];
        const f: string[] = [];
        expectEqual(f, "Title", b.title, after.Title);
        expectEqual(f, "ClientKey", b.clientKey, after.ClientKey);
        expectEqual(f, "StartDate", b.startDate, after.StartDate, eqDay);
        return f;
      },
    });
    return writeResult(w, { reason: b.reason, workItemKey: w.after?.WorkItemKey ?? null, after: w.after });
  });

  // WorkItem PATCH accepts only Title, Description, StartDate, DueDate,
  // DeadlineDate, AssigneeEmailAddress, WorkType (and UserRoleAssignments).
  const patchWork = async (tool: string, workKey: string, body: Rec, reason: string) => {
    const path = `/WorkItems/${enc(workKey)}`;
    const dates = new Set(["StartDate", "DueDate", "DeadlineDate"]);
    const w = await verifiedWrite({
      tool, reason,
      read: async () => (await kget(path) ?? {}) as Rec,
      build: () => ({ method: "PATCH", path, body }),
      verify: (after) => {
        const f: string[] = [];
        for (const [k, v] of Object.entries(body)) {
          expectEqual(f, k, v, after[k], dates.has(k) ? eqDay : k === "AssigneeEmailAddress" || k === "WorkType" ? eqCaseless : undefined);
        }
        return f;
      },
    });
    return writeResult(w, { reason, workKey, before: pick(w.before, Object.keys(body)), after: w.after && pick(w.after, Object.keys(body)) });
  };

  s.tool("update_work", "Update editable fields on a work item via PATCH (Title, Description, StartDate, DueDate, DeadlineDate, AssigneeEmailAddress, WorkType), then read back to confirm. Does not change status or fees — use update_work_status / update_karbon_workitem_fee_budget. Requires a `reason`.", {
    workKey: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    startDate: z.string().optional().describe("ISO 8601 e.g. 2026-07-01T00:00:00Z"),
    dueDate: z.string().nullable().optional().describe("ISO 8601, or null to clear"),
    deadlineDate: z.string().nullable().optional().describe("ISO 8601, or null to clear"),
    assigneeEmail: z.string().optional(),
    workType: z.string().optional(),
    reason: reasonParam,
  }, async ({ workKey, reason, ...f }) => {
    const body: Rec = {};
    if (f.title !== undefined) body.Title = f.title;
    if (f.description !== undefined) body.Description = f.description;
    if (f.startDate !== undefined) body.StartDate = f.startDate;
    if (f.dueDate !== undefined) body.DueDate = f.dueDate;
    if (f.deadlineDate !== undefined) body.DeadlineDate = f.deadlineDate;
    if (f.assigneeEmail !== undefined) body.AssigneeEmailAddress = f.assigneeEmail;
    if (f.workType !== undefined) body.WorkType = f.workType;
    if (!Object.keys(body).length) return err("No fields provided to update.");
    return patchWork("update_work", workKey, body, reason);
  });

  s.tool("update_work_deadline", "Update the deadline date of a work item via PATCH, then read back to confirm. Requires a `reason`.", {
    workKey: z.string(), deadlineDate: z.string().describe("ISO 8601 date e.g. 2026-06-30"),
    reason: reasonParam,
  }, async ({ workKey, deadlineDate, reason }) => patchWork("update_work_deadline", workKey, { DeadlineDate: deadlineDate }, reason));

  // PrimaryStatus/SecondaryStatus can't be PATCHed: full PUT of the current item.
  // SecondaryStatus must be listed in TenantSettings for both the target
  // PrimaryStatus and the item's WorkType, otherwise Karbon accepts it and drops it.
  s.tool("update_work_status", "Set a work item's PrimaryStatus and optionally SecondaryStatus. SecondaryStatus is checked against TenantSettings for the target PrimaryStatus AND the item's WorkType (invalid values are refused with the valid list). Fetches the item, preserves all fields, PUTs it back, then reads back to confirm. If secondaryStatus is omitted, the current one is kept only if still valid. Requires a `reason`.", {
    workKey: z.string(),
    primaryStatus: z.string().describe("Planned, Ready To Start, In Progress, Waiting or Completed (either spelling)"),
    secondaryStatus: z.string().nullable().optional().describe("A secondary status valid for this PrimaryStatus and the item's WorkType; null to clear. Omit to keep the current one if still valid."),
    reason: reasonParam,
  }, async ({ workKey, primaryStatus, secondaryStatus, reason }) => {
    const target = toSpacedStatus(primaryStatus);
    if (!(PRIMARY_STATUSES as readonly string[]).includes(target)) return err(`Unknown primaryStatus '${primaryStatus}'. Use one of: ${PRIMARY_STATUSES.join(", ")}.`);
    const path = `/WorkItems/${enc(workKey)}`;
    const current = (await kget(path) ?? {}) as Rec;

    const resolve = async (refresh: boolean) => validSecondaryStatuses(await getTenantSettings(refresh), target, current.WorkType);
    let valid = await resolve(false);
    const notes: string[] = [];
    let secondary: string | null;
    if (secondaryStatus === undefined) {
      const existing = typeof current.SecondaryStatus === "string" && current.SecondaryStatus ? current.SecondaryStatus : null;
      secondary = existing && valid.names.find(n => eqCaseless(n, existing)) || null;
      if (existing && !secondary) notes.push(`Current SecondaryStatus '${existing}' isn't valid for ${target} / ${String(current.WorkType ?? "no WorkType")}, so it will be cleared.`);
    } else if (secondaryStatus === null || secondaryStatus.trim() === "") {
      secondary = null;
    } else {
      let match = valid.names.find(n => eqCaseless(n, secondaryStatus));
      if (!match) { valid = await resolve(true); match = valid.names.find(n => eqCaseless(n, secondaryStatus)); }
      if (!match) {
        return err(`SecondaryStatus '${secondaryStatus}' isn't valid for PrimaryStatus '${target}' and WorkType '${String(current.WorkType ?? "")}'. Karbon would accept it and silently drop it.`,
          { workKey, primaryStatus: target, workType: current.WorkType ?? null, validSecondaryStatuses: valid.names });
      }
      secondary = match;
    }
    if (!valid.workTypeFound) notes.push(`WorkType '${String(current.WorkType ?? "")}' wasn't found in TenantSettings; SecondaryStatus was checked against the PrimaryStatus only.`);

    const w = await verifiedWrite({
      tool: "update_work_status", reason,
      read: async () => (await kget(path) ?? {}) as Rec,
      build: (cur) => ({ method: "PUT", path, body: { ...workItemPutBody(cur, workKey), PrimaryStatus: target, SecondaryStatus: secondary } }),
      verify: (after, before) => {
        const f: string[] = [];
        expectEqual(f, "PrimaryStatus", target, after.PrimaryStatus, sameStatus);
        if (secondary) {
          if (after.SecondaryStatus == null) f.push(`SecondaryStatus came back null (expected '${secondary}')`);
          else expectEqual(f, "SecondaryStatus", secondary, after.SecondaryStatus, eqCaseless);
        } else if (after.SecondaryStatus != null) {
          f.push(`SecondaryStatus expected to be cleared, got ${JSON.stringify(after.SecondaryStatus)}`);
        }
        expectUnchanged(f, before, after, WORK_ITEM_STABLE_FIELDS);
        return f;
      },
    });
    return writeResult(w, {
      reason, workKey,
      before: pick(w.before, ["PrimaryStatus", "SecondaryStatus"]),
      after: w.after && pick(w.after, ["PrimaryStatus", "SecondaryStatus"]),
      ...(notes.length ? { notes } : {}),
    });
  });

  // ── WORK TEMPLATES ────────────────────────────────────────────────────────
  s.tool("list_work_templates", "List work templates. Follows @odata.nextLink up to maxRecords.", {
    filter: z.string().optional().describe("OData eq filter on Title, WorkTypeKey, etc."),
    ...listParams,
  }, async ({ filter, maxRecords, nextLink }) =>
    text(await listing("/WorkTemplates", { $filter: filter }, maxRecords, nextLink)));

  s.tool("get_work_template", "Get a single work template by key", { workTemplateKey: z.string() }, async ({ workTemplateKey }) =>
    text(await kget(`/WorkTemplates/${enc(workTemplateKey)}`)));

  // ── TIMESHEETS (deprecated) & TIME ENTRIES ────────────────────────────────
  s.tool("list_timesheets", "DEPRECATED by Karbon — use list_time_entries instead (per-day, per-task logged time). Timesheets aggregate time to the timesheet period (weekly by default).", {
    filter: z.string().optional().describe("OData filter e.g. \"StartDate gt 2026-01-01T00:00:00Z\" or \"WorkItemKeys/any(x: x in ('k1','k2'))\""),
    includeTimeEntries: z.boolean().optional().default(false).describe("Set true to include individual time entries"),
    ...listParams,
  }, async ({ filter, includeTimeEntries, maxRecords, nextLink }) =>
    text(await listing("/Timesheets", { $filter: filter, $expand: includeTimeEntries ? "TimeEntries" : undefined }, maxRecords, nextLink)));

  s.tool("get_timesheet", "DEPRECATED by Karbon — use list_time_entries with timesheetKey instead. Gets a single timesheet with its time entries.", {
    timesheetKey: z.string(), includeTimeEntries: z.boolean().optional().default(true),
  }, async ({ timesheetKey, includeTimeEntries }) =>
    text(await kget(`/Timesheets/${enc(timesheetKey)}${includeTimeEntries ? "?$expand=TimeEntries" : ""}`)));

  const isoDate = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00Z` : d);
  s.tool("list_time_entries", "List individual (non-aggregated) time entries: one record per user/day/task. This replaces the deprecated timesheet tools. Filters are ANDed. Follows @odata.nextLink up to maxRecords.", {
    timesheetKey: z.string().optional(), entityKey: z.string().optional(), workItemKey: z.string().optional(),
    clientKey: z.string().optional(), userKey: z.string().optional(),
    roleName: z.string().optional(), taskTypeName: z.string().optional(),
    dateOn: z.string().optional().describe("Date eq (YYYY-MM-DD or ISO date-time)"),
    dateFrom: z.string().optional().describe("Date ge — on or after"),
    dateTo: z.string().optional().describe("Date le — on or before"),
    dateAfter: z.string().optional().describe("Date gt — strictly after"),
    dateBefore: z.string().optional().describe("Date lt — strictly before"),
    filter: z.string().optional().describe("Extra raw OData filter, ANDed with the above"),
    orderBy: z.enum(["Date", "Date desc"]).optional(),
    ...listParams,
  }, async (a) => {
    const parts: string[] = [];
    const eqs: [string, string | undefined][] = [["TimesheetKey", a.timesheetKey], ["EntityKey", a.entityKey], ["WorkItemKey", a.workItemKey], ["ClientKey", a.clientKey], ["UserKey", a.userKey], ["RoleName", a.roleName], ["TaskTypeName", a.taskTypeName]];
    for (const [f, v] of eqs) if (v !== undefined) parts.push(`${f} eq ${odataString(v)}`);
    const dates: [string, string | undefined][] = [["eq", a.dateOn], ["ge", a.dateFrom], ["le", a.dateTo], ["gt", a.dateAfter], ["lt", a.dateBefore]];
    for (const [op, v] of dates) if (v !== undefined) parts.push(`Date ${op} ${isoDate(v)}`);
    if (a.filter) parts.push(parts.length ? `(${a.filter})` : a.filter);
    const $filter = parts.join(" and ") || undefined;
    const result = await listing("/IndividualTimeEntries", { $filter, $orderby: a.orderBy }, a.maxRecords, a.nextLink);
    return text({ ...(a.nextLink ? {} : { filterUsed: $filter ?? null }), ...result });
  });

  s.tool("get_time_entry", "Get a single individual time entry by key", { timeEntryKey: z.string() }, async ({ timeEntryKey }) =>
    text(await kget(`/IndividualTimeEntries/${enc(timeEntryKey)}`)));

  // ── NOTES & COMMENTS ──────────────────────────────────────────────────────
  s.tool("get_note", "Get a single note by its ID", { noteId: z.string() }, async ({ noteId }) =>
    text(await kget(`/Notes/${enc(noteId)}`)));

  s.tool("create_note", "Create a note and link it to a work item, contact, organization or client group, then read it back to confirm. Requires a `reason`.", {
    subject: z.string(), body: z.string().describe("HTML supported"),
    authorEmail: z.string().describe("Email of the Karbon user creating the note"),
    assigneeEmail: z.string().optional(),
    entityType: z.enum(["WorkItem", "Contact", "Organization", "ClientGroup"]).optional(),
    entityKey: z.string().optional(),
    dueDate: z.string().optional(),
    reason: reasonParam,
  }, async (b) => {
    const timelines = b.entityType && b.entityKey ? [{ EntityType: b.entityType, EntityKey: b.entityKey }] : [];
    const w = await verifiedWrite({
      tool: "create_note", reason: b.reason,
      read: async () => ({}),
      build: () => ({ method: "POST", path: "/Notes", body: { Subject: b.subject, Body: b.body, AuthorEmailAddress: b.authorEmail, AssigneeEmailAddress: b.assigneeEmail, DueDate: b.dueDate, Timelines: timelines } }),
      readBack: createdReadBack("Id", k => `/Notes/${enc(k)}`),
      verify: (after) => {
        if (!after.Id) return ["created note could not be read back"];
        const f: string[] = []; expectEqual(f, "Subject", b.subject, after.Subject); return f;
      },
    });
    return writeResult(w, { reason: b.reason, noteId: w.after?.Id ?? null });
  });

  s.tool("get_comment", "Get a single comment by key", { commentKey: z.string() }, async ({ commentKey }) =>
    text(await kget(`/Comments(${keyLit(commentKey)})`)));

  // ── INVOICES ──────────────────────────────────────────────────────────────
  s.tool("list_invoices", "List invoices. Follows @odata.nextLink up to maxRecords.", {
    invoiceStatus: z.enum(["Approved", "AwaitingPayment", "Paid", "Exported", "Voided"]).optional(),
    orderBy: z.string().optional().describe("InvoiceDate, CreatedAt, UpdatedAt or InvoiceNumber, optionally with ' desc'"),
    ...listParams,
  }, async ({ invoiceStatus, orderBy, maxRecords, nextLink }) =>
    text(await listing("/Invoices", { $filter: invoiceStatus ? `InvoiceStatus eq '${invoiceStatus}'` : undefined, $orderby: orderBy }, maxRecords, nextLink)));

  s.tool("get_invoice", "Get a single invoice with line items and payments", { invoiceKey: z.string() }, async ({ invoiceKey }) =>
    text(await kget(`/Invoices/${enc(invoiceKey)}?$expand=LineItems,Payments`)));

  // ── ESTIMATE SUMMARIES ────────────────────────────────────────────────────
  s.tool("get_estimate_summary", "Get budget vs actual time estimates (Estimate Summaries) for a work item", { workItemKey: z.string() }, async ({ workItemKey }) =>
    text(await kget(`/EstimateSummaries/${enc(workItemKey)}`)));

  // PATCH /WorkItems/{key}/EstimateSummaries/{summaryKey} accepts EstimateMinutes,
  // EstimateAmount and HourlyRate. Only one of minutes/amount is allowed, and which
  // one depends on the firm's Time and Budget setting (422 if wrong). Changing
  // HourlyRate can reissue the key, so the read-back follows OData-EntityId.
  // Rows whose key starts "0-" are logged time without an estimate: read-only.
  s.tool("update_karbon_estimate_minutes", "Update an existing Karbon Work Item budget (Estimate Summary) row: EstimateMinutes OR EstimateAmount (whichever your firm's Time and Budget setting uses), and/or HourlyRate. Then re-reads to verify, following a reissued key if HourlyRate changed. Targets the overall budget row (no user, no role) unless estimateSummaryKey is given. Cannot create rows. Refuses rows whose key starts '0-' (logged time, read-only). Requires a `reason`.", {
    workItemKey: z.string(),
    estimateMinutes: z.number().int().min(0).max(599_999_940).optional().describe("Budgeted minutes, e.g. 919 for 15h19m. For firms that budget by time."),
    estimateAmount: z.number().min(0).max(99_999_999).optional().describe("Budgeted amount. For firms that budget by amount. Not with estimateMinutes."),
    hourlyRate: z.number().min(0).max(99_999_999).optional().describe("Hourly rate. Changing it can reissue the row's key."),
    estimateSummaryKey: z.string().optional().describe("A specific row to update. Omit to use the overall (no user, no role) budget row."),
    reason: reasonParam,
  }, async ({ workItemKey, estimateMinutes, estimateAmount, hourlyRate, estimateSummaryKey, reason }) => {
    if (estimateMinutes !== undefined && estimateAmount !== undefined) return err("Send estimateMinutes OR estimateAmount, not both: Karbon accepts only the one matching your firm's Time and Budget setting.");
    if (estimateMinutes === undefined && estimateAmount === undefined && hourlyRate === undefined) return err("Nothing to change: provide estimateMinutes, estimateAmount or hourlyRate.");

    type Row = Rec & { EstimateSummaryKey: string };
    const readRows = async (): Promise<Row[]> => (((await kget(`/EstimateSummaries/${enc(workItemKey)}`)) as { value?: Row[] } | null)?.value ?? []);
    const rows = await readRows();
    let target: Row | undefined;
    if (estimateSummaryKey) {
      target = rows.find(r => r.EstimateSummaryKey === estimateSummaryKey);
      if (!target) return err("No budget row with that key on this work item.", { rows });
    } else {
      const overall = rows.filter(r => !String(r.EstimateSummaryKey).startsWith("0-") && !r.UserKey && !r.RoleKey);
      if (overall.length !== 1) {
        return err(overall.length === 0
          ? "This work item has no overall budget row (no user, no role). Add a budget line in Karbon first — the API cannot create one."
          : "More than one overall budget row; pass estimateSummaryKey to choose.", { rows });
      }
      target = overall[0];
    }
    if (String(target.EstimateSummaryKey).startsWith("0-")) {
      return err("That row is logged time without an estimate (key starts '0-'); Karbon treats it as read-only. Assign an estimate in Karbon first.", { rows });
    }

    const key = target.EstimateSummaryKey;
    const rowPath = (k: string) => `/WorkItems/${enc(workItemKey)}/EstimateSummaries/${enc(k)}`;
    const body: Rec = {};
    if (estimateMinutes !== undefined) body.EstimateMinutes = estimateMinutes;
    if (estimateAmount !== undefined) body.EstimateAmount = estimateAmount;
    if (hourlyRate !== undefined) body.HourlyRate = hourlyRate;
    let newKey = key;

    const w = await verifiedWrite({
      tool: "update_karbon_estimate_minutes", reason,
      read: async () => (await readRows()).find(r => r.EstimateSummaryKey === key) ?? {},
      build: () => ({ method: "PATCH", path: rowPath(key), body }),
      readBack: async (res) => {
        const loc = res.headers.get("OData-EntityId");
        if (loc) {
          const m = loc.match(/EstimateSummaries(?:\('([^']+)'\)|\/([^/?#]+))/);
          if (m) newKey = decodeURIComponent(m[1] ?? m[2]);
          try { return (await kget(loc) ?? {}) as Rec; } catch (e) { if (!(e instanceof KarbonError)) throw e; }
        }
        try { return (await kget(rowPath(newKey)) ?? {}) as Rec; } catch (e) { if (!(e instanceof KarbonError)) throw e; }
        return (await readRows()).find(r => r.EstimateSummaryKey === newKey) ?? {};
      },
      verify: (after) => {
        const f: string[] = [];
        if (estimateMinutes !== undefined) expectEqual(f, "EstimateMinutes", estimateMinutes, after.EstimateMinutes);
        if (estimateAmount !== undefined) expectEqual(f, "EstimateAmount", estimateAmount, after.EstimateAmount, eqMoney);
        if (hourlyRate !== undefined) expectEqual(f, "HourlyRate", hourlyRate, after.HourlyRate, eqMoney);
        return f;
      },
    });

    const fields = ["EstimateMinutes", "EstimateAmount", "HourlyRate"];
    let hint: string | undefined;
    if (w.status === 422) {
      hint = estimateMinutes !== undefined
        ? "Karbon refused the change (422). Most likely your firm budgets by amount: send estimateAmount instead of estimateMinutes. Other causes: the work item is completed, the WIP lock date blocks a rate change, or HourlyRate was set on a non-billable estimate."
        : estimateAmount !== undefined
          ? "Karbon refused the change (422). Most likely your firm budgets by time: send estimateMinutes instead of estimateAmount. Other causes: the work item is completed, the WIP lock date blocks a rate change, or HourlyRate was set on a non-billable estimate."
          : "Karbon refused the change (422): the work item may be completed, the WIP lock date may block the rate change, rate plans may not be enabled, or the estimate is non-billable.";
    }
    return writeResult(w, {
      reason, workItemKey,
      estimateSummaryKey: newKey,
      ...(newKey !== key ? { previousEstimateSummaryKey: key, note: "Karbon reissued the EstimateSummaryKey; use the new key from now on." } : {}),
      taskType: target.TaskTypeName ?? null,
      before: pick(target, fields),
      after: w.after && pick(w.after, fields),
      ...(hint ? { hint } : {}),
    });
  });

  // ── ESTIMATE SUMMARY: PREVIEW ───────────────────────────────────────────
  // Read-only diff of proposed changes across several rows, for review before
  // writing. update_karbon_estimate_minutes performs a single-row write.
  s.tool("preview_karbon_estimate_summary_update", "Preview proposed EstimateMinutes changes on a Karbon Work Item's Estimate Summary, matching by RoleKey/TaskTypeKey (preferred) or RoleName/TaskTypeName. NO WRITES — a read-only diff for review. To write one row, use update_karbon_estimate_minutes.", {
    workItemKey: z.string(),
    estimates: z.array(z.object({
      roleName: z.string().optional(),
      roleKey: z.string().optional(),
      taskTypeName: z.string().optional(),
      taskTypeKey: z.string().optional(),
      estimateMinutes: z.number(),
    })).min(1),
    reason: reasonParam,
  }, async ({ workItemKey, estimates, reason }) => {
    for (const e of estimates) {
      if (!(e.roleKey || e.roleName) && !(e.taskTypeKey || e.taskTypeName)) {
        return err("Each estimate entry must include at least one of roleKey/roleName or taskTypeKey/taskTypeName for matching.");
      }
    }
    const rows = (((await kget(`/EstimateSummaries/${enc(workItemKey)}`)) as { value?: Rec[] } | null)?.value ?? []);

    const matches = estimates.map((e) => {
      let idx = -1;
      if (e.roleKey || e.taskTypeKey) {
        idx = rows.findIndex(r => (e.roleKey ? r.RoleKey === e.roleKey : true) && (e.taskTypeKey ? r.TaskTypeKey === e.taskTypeKey : true));
      }
      if (idx === -1 && (e.roleName || e.taskTypeName)) {
        idx = rows.findIndex(r => (e.roleName ? r.RoleName === e.roleName : true) && (e.taskTypeName ? r.TaskTypeName === e.taskTypeName : true));
      }
      return { input: e, row: idx >= 0 ? rows[idx] : null };
    });

    const matchedRows = matches.filter(m => m.row !== null).map((m) => {
      const before = m.row as Rec;
      const beforeMinutes = (before.EstimateMinutes ?? null) as number | null;
      const afterMinutes = m.input.estimateMinutes;
      return {
        estimateSummaryKey: before.EstimateSummaryKey ?? null,
        readOnly: String(before.EstimateSummaryKey ?? "").startsWith("0-"),
        roleKey: before.RoleKey ?? null, roleName: before.RoleName ?? null,
        taskTypeKey: before.TaskTypeKey ?? null, taskTypeName: before.TaskTypeName ?? null,
        before: { EstimateMinutes: beforeMinutes, ActualMinutes: before.ActualMinutes ?? null, HourlyRate: before.HourlyRate ?? null },
        after: { EstimateMinutes: afterMinutes, ActualMinutes: before.ActualMinutes ?? null, HourlyRate: before.HourlyRate ?? null },
        delta: beforeMinutes !== null ? afterMinutes - beforeMinutes : null,
      };
    });

    return text({
      ok: true, preview: true, writable: false,
      message: "Preview only — no changes were made. To write a single row, use update_karbon_estimate_minutes.",
      reason, workItemKey, matchedRows,
      unmatched: matches.filter(m => m.row === null).map(m => m.input),
    });
  });

  // ── FEE SETTINGS ──────────────────────────────────────────────────────────
  // FeeSettings can only be set by a full WorkItem PUT. FeeType is FixedFee
  // (FeeValue = amount) or TimeAndMaterials / NonBillable (FeeValue must be null).
  s.tool("update_karbon_workitem_fee_budget", "Set a work item's fee: FixedFee with feeValue, or TimeAndMaterials / NonBillable (fee value cleared). Fetches the item, changes only FeeSettings, PUTs the whole item back, then reads back to verify. Budgets (time/amount estimates) are not set here — use update_karbon_estimate_minutes. Requires a `reason`.", {
    workItemKey: z.string(),
    feeType: z.enum(["FixedFee", "TimeAndMaterials", "NonBillable"]),
    feeValue: z.number().min(0).optional().describe("Required for FixedFee; must be omitted for TimeAndMaterials and NonBillable"),
    reason: reasonParam,
  }, async ({ workItemKey, feeType, feeValue, reason }) => {
    if (feeType === "FixedFee" && feeValue === undefined) return err("feeValue is required when feeType is FixedFee.");
    if (feeType !== "FixedFee" && feeValue !== undefined) return err(`feeValue must be omitted for ${feeType}: Karbon requires FeeValue to be null unless the fee is FixedFee.`);
    const fee = { FeeType: feeType, FeeValue: feeType === "FixedFee" ? feeValue! : null };
    const path = `/WorkItems/${enc(workItemKey)}`;
    const w = await verifiedWrite({
      tool: "update_karbon_workitem_fee_budget", reason,
      read: async () => (await kget(path) ?? {}) as Rec,
      build: (cur) => ({ method: "PUT", path, body: { ...workItemPutBody(cur, workItemKey), FeeSettings: fee } }),
      verify: (after, before) => {
        const f: string[] = [];
        const got = (after.FeeSettings ?? {}) as Rec;
        expectEqual(f, "FeeSettings.FeeType", fee.FeeType, got.FeeType ?? null);
        expectEqual(f, "FeeSettings.FeeValue", fee.FeeValue, got.FeeValue ?? null, eqMoney);
        expectEqual(f, "PrimaryStatus", before.PrimaryStatus, after.PrimaryStatus, (a, b) => (a ?? null) === (b ?? null) || sameStatus(a, b));
        expectUnchanged(f, before, after, WORK_ITEM_STABLE_FIELDS);
        return f;
      },
    });
    return writeResult(w, { reason, workItemKey, before: { FeeSettings: w.before.FeeSettings ?? null }, after: w.after && { FeeSettings: w.after.FeeSettings ?? null } });
  });

  // ── TENANT SETTINGS ───────────────────────────────────────────────────────
  s.tool("get_tenant_settings", "Get your Karbon account settings — work types, primary/secondary work statuses, contact types, service types", {}, async () =>
    text(await getTenantSettings(true)));

  // ── USERS ─────────────────────────────────────────────────────────────────
  s.tool("list_users", "List users in your Karbon account. Follows @odata.nextLink up to maxRecords.", {
    filter: z.string().optional().describe("e.g. \"Name eq 'Jane Smith'\" or \"EmailAddress eq 'jane@firm.com'\""),
    ...listParams,
  }, async ({ filter, maxRecords, nextLink }) =>
    text(await listing("/Users", { $filter: filter }, maxRecords, nextLink)));

  s.tool("get_user", "Get details for a single user", { userId: z.string() }, async ({ userId }) =>
    text(await kget(`/Users/${enc(userId)}`)));

  s.tool("list_team_members", "List team members (simplified user list)", listParams, async ({ maxRecords, nextLink }) =>
    text(await listing("/Users", {}, maxRecords, nextLink)));

  // ── DASHBOARD & SEARCH ────────────────────────────────────────────────────
  s.tool("get_work_summary", "Dashboard summary of work across all primary statuses: total count per status plus up to maxPerStatus items each.", {
    maxPerStatus: z.number().int().min(1).max(1000).optional().default(100),
  }, async ({ maxPerStatus }) => {
    const results: Rec = {};
    for (const st of PRIMARY_STATUSES) {
      const p = await pageAll("/WorkItems", { $filter: `PrimaryStatus eq '${st}'`, $count: true, $select: "WorkItemKey,Title,WorkType,PrimaryStatus,SecondaryStatus,DueDate,AssigneeEmailAddress,ClientName" }, { maxRecords: maxPerStatus });
      results[st] = pageResult(p);
    }
    return text(results);
  });

  s.tool("search_karbon", "Search contacts, organizations and work items by keyword (first 10 of each)", { query: z.string() }, async ({ query }) => {
    const lit = odataString(query);
    const [contacts, orgs, work] = await Promise.all([
      kget(`/Contacts${qs({ $filter: `contains(FullName,${lit})`, $top: 10 })}`),
      kget(`/Organizations${qs({ $filter: `contains(FullName,${lit})`, $top: 10 })}`),
      kget(`/WorkItems${qs({ $filter: `contains(Title,${lit})`, $top: 10 })}`),
    ]);
    return text({ contacts, organizations: orgs, work });
  });

  // ── CUSTOM FIELDS (src/customFields.ts) ───────────────────────────────────
  registerCustomFieldTools(s);

  // ── CLIENT GROUP AUDIT (src/groupAudit.ts) ────────────────────────────────
  registerGroupAuditTools(s);

  return s;
}

