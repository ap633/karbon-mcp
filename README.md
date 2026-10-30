# karbon-mcp

Dream Accounting's MCP server for the Karbon practice-management API (v3). It runs on Railway as the `karbon-mcp` service and serves Streamable HTTP at `/mcp`. `/health` returns `OK`.

## Sources of truth

- [docs/KARBON_API.md](docs/KARBON_API.md): Karbon's agent guide (copied from https://karbonhq.github.io/karbon-api-reference/KARBON_API.md)
- [docs/KarbonAPI.json](docs/KarbonAPI.json): the OpenAPI spec (copied from https://karbonhq.github.io/karbon-api-reference/KarbonAPI.json)

Only endpoints listed in the spec are used. Never derive endpoints from `/v3/$metadata`. Refresh both copies when Karbon updates them.

## Layout

| File | What it does |
| --- | --- |
| `src/index.ts` | HTTP transport and sessions only |
| `src/server.ts` | `createServer()`, which registers every tool |
| `src/karbon.ts` | Shared Karbon client: auth, 429/409 handling, paging, PrimaryStatus helpers, TenantSettings cache, verified writes |
| `src/groupAudit.ts` | Client-group audit tools |
| `src/customFields.ts` | Custom field definitions and values |
| `src/businessCards.ts` | Business card read and verified update |
| `src/clientRecords.ts` | Description and contact type writes, client group members, `list_all_clients` |
| `src/uploadWatch.ts` | Client portal upload watch (timer + email) and `list_recent_client_uploads` |
| `test/*.test.mjs` | Mocked-Karbon tests, run against `dist/` |

`dist/` is committed. Railway builds with `npx tsc` (see `nixpacks.toml`).

## Environment

| Variable | Sent as |
| --- | --- |
| `KARBON_GB_KEY` | `Authorization: Bearer …` |
| `KARBON_ACCESS_KEY` | `AccessKey: …` |
| `PORT` | HTTP port (default 3000) |

The upload watch has its own settings: see [Client portal upload watch](#client-portal-upload-watch).

## How every call behaves

- **Paging.** List tools request `$top` ≤ 100 (10 for `/WorkTemplates`, Karbon's limit there) and follow `@odata.nextLink`. They never build `$skip` themselves, except for `/WorkTemplates` (see below). `maxRecords` (default 100) caps how much is read. If more records exist, the result includes `@odata.nextLink`; pass it back as `nextLink` to continue. A nextLink is only followed if it points at `api.karbonhq.com`.
- **429.** The client waits the delay given in Karbon's message ("Try again in 10 seconds"), falling back to `Retry-After`, then 10 seconds. It retries up to 5 attempts in total. 5xx errors are retried with backoff.
- **409 (code 4020).** Writes re-fetch the record, reapply the change and retry, at most twice more. If the conflict persists, the tool fails with a clear message.
- **Verified writes.** Every write reads the record back and returns `ok: true` only if the change persisted. A `204` with no change is reported as `ok: false` with `failures`. Each write tool requires a `reason`, and an audit line is logged.
- **Whole-resource PUTs** (work items, organizations) GET the current record first, send it back with only the requested change, and include the PascalCase key (`WorkItemKey`, `OrganizationKey`). Organization PUTs omit `BusinessCards`, which leaves the cards untouched, and check that cards, client team and other fields are unchanged afterwards.
- **PrimaryStatus.** `$filter` only matches the spaced form (`'In Progress'`, `'Ready To Start'`). Status values in filters are normalised to that form. Responses use either form, depending on the endpoint, and are compared without regard to spacing.

## Tools

### Contacts
| Tool | Notes |
| --- | --- |
| `list_contacts` | filter, orderBy, paging; `includeDescription` adds each Description (one GET per row) |
| `get_contact` | optional `expand`: BusinessCards, ClientTeam, ClientAccess, ServiceTypes (off by default because `$expand` adds latency) |
| `get_contact_by_identifier` | by UserDefinedIdentifier; optional BusinessCards |
| `create_contact` | write: `reason` + read-back |
| `update_contact` | write: name fields by PATCH (FirstName, MiddleName, LastName, PreferredName, Salutation, Suffix); emails and phones on the contact's primary Business Card (same options as `update_business_card`). The card is found before anything is written. |

### Organizations
| Tool | Notes |
| --- | --- |
| `list_organizations` | filter, orderBy, paging; `includeDescription` as for contacts |
| `get_organization` | optional `expand`: BusinessCards, ClientTeam, Contacts, ServiceTypes (off by default) |
| `get_organization_by_identifier` | |
| `create_organization` | write |
| `update_organization` | write: FullName by PATCH; ClientOwner / ClientManager by a merged PUT that leaves BusinessCards untouched |

### Contacts and organizations: description, type, full list
| Tool | Notes |
| --- | --- |
| `update_description` | write: Description (`EntityDescription.Text`) on a Contact or Organization. Mode `prepend` (default) puts the new line at the top and keeps the rest; `append`; `replace`. Skips the write if the text, or every link in it, is already there, so re-running is safe. `dryRun` shows before/after. Whole-record PUT without BusinessCards, then checks the new text and that no other field moved. Status: already_present, would_update, verified, not_persisted, error. |
| `set_contact_type` | write: ContactType (Client, Inactive, Let go, …) on a Contact or Organization, checked against TenantSettings. Whole-record PUT as above. |
| `list_all_clients` | every Contact and/or Organization in one call as `columns` + `rows` (kind, key, name, contactType, email). `contactType` filters in Karbon. `includeDescription`, `descriptionContains` or `descriptionNotContains` add the description (one GET per record, so slow across everything). |

### Client groups
| Tool | Notes |
| --- | --- |
| `list_client_groups` | filter (FullName eq), paging |
| `get_client_group` | includes Members |
| `get_client_group_by_identifier` | |
| `create_client_group` | write |
| `update_client_group` | write: FullName only (the only field Karbon's PATCH accepts) |
| `list_client_group_members` | members with key, type (Contact/Organization) and, by default, name and contact type |
| `add_client_group_member`, `remove_client_group_member` | write: whole-group PUT with the edited Members list; the group's other fields and BusinessCard are sent back as read and checked afterwards. `dryRun` available. Status: already_member / not_member, would_update, verified, not_persisted, error. |
| `audit_work_client_groups` | read-only audit of work items with missing or wrong client groups |
| `set_work_client_group` | write (guarded, dry run by default) |

### Work items
| Tool | Notes |
| --- | --- |
| `list_work` | `primaryStatus` (either spelling), filter (PrimaryStatus normalised), orderBy, paging |
| `get_work` | |
| `get_work_summary` | count and items per PrimaryStatus |
| `create_work` | write: assignee and start date required |
| `update_work` | write (PATCH): Title, Description, StartDate, DueDate, DeadlineDate, AssigneeEmailAddress, WorkType |
| `update_work_deadline` | write (PATCH) |
| `update_work_status` | write (PUT): PrimaryStatus plus SecondaryStatus checked against TenantSettings for both the PrimaryStatus and the WorkType; fails if SecondaryStatus reads back null |
| `update_karbon_workitem_fee_budget` | write (PUT): FeeSettings `FixedFee` + value, or `TimeAndMaterials` / `NonBillable` with value null |
| `list_work_templates`, `get_work_template` | list reads 10 per request (Karbon rejects `$top` above 10 on `/WorkTemplates` with 4002). Karbon sends `@odata.count` but no `@odata.nextLink` here, so the tool steps `$skip` until the count is reached or `maxRecords` is hit, and returns a `$skip` link as `@odata.nextLink` to continue |

### Budgets (Estimate Summaries)
| Tool | Notes |
| --- | --- |
| `get_estimate_summary` | |
| `update_karbon_estimate_minutes` | write (PATCH): EstimateMinutes **or** EstimateAmount (per the firm's Time and Budget setting), and/or HourlyRate. Follows `OData-EntityId` if the key is reissued. Refuses `0-` keys. |
| `preview_karbon_estimate_summary_update` | read-only diff |

### Business cards
| Tool | Notes |
| --- | --- |
| `get_business_card` | by BusinessCardKey (find it with `get_contact` / `get_organization` and `expand: ["BusinessCards"]`) |
| `update_business_card` | write: pass only what changes. Lists can be replaced whole, or edited: add/remove emails, upsert/remove phones and addresses by label. Phone labels: Work, Mobile, Office, Fax, Home, Other. Address labels: Physical, Mailing, Legal, Home. Country codes are ISO 3166-1 alpha-2 (default AU). Reads the card, merges, PUTs it with BusinessCardKey/EntityType/EntityKey, then checks the changes and that nothing else on the card moved. |

### Custom fields
| Tool | Notes |
| --- | --- |
| `list_custom_fields` | definitions: Key, Name, Type, visibility, ListOptions |
| `get_custom_field_values` | values for a Contact or Organization key; `resolveColleagues` turns Colleague UserKeys into names and emails (one `GET /v3/Users/{key}` per user) |
| `set_custom_field_values` | write: pass only the fields to change (by key or name). Values are checked by type: list options must match, Colleague takes UserKeys or emails, `null`/`[]` clears. Reads the full set, merges, PUTs, then checks the changes **and** that every other field kept its value. |
| `create_custom_field` | write: list types need `listOptions`; refuses an existing name |
| `delete_custom_field` | **destructive** write: removes the field and its values from every client. Needs `confirm: true`; without it, the tool shows what would be deleted. |

### Time
| Tool | Notes |
| --- | --- |
| `list_time_entries` | TimesheetKey, EntityKey, WorkItemKey, ClientKey, UserKey, RoleName, TaskTypeName (eq); Date eq / gt / ge / lt / le; orderBy `Date` / `Date desc` |
| `get_time_entry` | |
| `list_timesheets`, `get_timesheet` | **deprecated by Karbon**; use `list_time_entries` |

### Notes, invoices, settings, users
| Tool | Notes |
| --- | --- |
| `get_note`, `create_note` | create is a write |
| `get_comment` | |
| `list_invoices`, `get_invoice` | |
| `list_payments`, `get_payment` | read-only; paged by nextLink |
| `get_tenant_settings` | also refreshes the cache used to validate SecondaryStatus |
| `list_users`, `get_user`, `list_team_members` | |
| `search_karbon` | first 10 contacts, organizations and work items matching a keyword |

### Client portal uploads
| Tool | Notes |
| --- | --- |
| `list_recent_client_uploads` | Shared files that appeared on Contacts/Organizations in the last `sinceHours` (default 24). Read-only; scans every client, so it takes a few minutes. `includeWorkItemFiles` adds files attached through requests. |

### Removed
- `list_work_tasks`, `update_task`: API v3 has no work-item task endpoint, so both returned 404.

## Client portal upload watch

Karbon notifies us when a client completes a request, but not when they upload a file through the portal's general upload area, and it has no file webhook. The watch fills that gap. Every `UPLOAD_WATCH_INTERVAL_MINUTES` it lists each Contact's and Organization's files (`GET /v3/FileList/{EntityType}`, filtered to `IsShared eq true and IsArchived eq false and Source eq '<kind>'`, newest first). It then sends one email listing any file it hasn't reported before, grouped by client.

- **What it can't tell.** Karbon doesn't record who uploaded a file. Client uploads are always `IsShared`, but so are files staff share to the portal, so those appear too.
- **Not included.** Files on work items (request uploads), because Karbon already notifies those. Client groups aren't covered either, because `FileList` doesn't support them.
- **State.** `UPLOAD_WATCH_STATE_FILE` holds a watermark plus the file keys already emailed (kept 3 days). Each scan looks back 15 minutes past the watermark, so a file landing mid-scan isn't missed, and the key list stops it being emailed twice. The watermark only moves after the email has gone, so a failed send is retried on the next run. Put the file on a Railway volume. Without one, every redeploy starts fresh and looks back `UPLOAD_WATCH_INITIAL_LOOKBACK_MINUTES`.
- **Load.** One FileList call per client per run, three at a time, with the shared 429 handling.

| Variable | Default | What it's for |
| --- | --- | --- |
| `UPLOAD_WATCH_ENABLED` | off | `true` to start the watch |
| `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET` | — | Entra app with the **Mail.Send** application permission (admin consented) |
| `UPLOAD_ALERT_FROM` | — | Mailbox the email is sent from, e.g. `info@dreamaccounting.com.au` |
| `UPLOAD_ALERT_TO` | `info@dreamaccounting.com.au` | Comma-separated recipients |
| `UPLOAD_WATCH_INTERVAL_MINUTES` | 30 | |
| `UPLOAD_WATCH_STATE_FILE` | `./upload-watch-state.json` | Point at the volume, e.g. `/data/upload-watch-state.json` |
| `UPLOAD_WATCH_INITIAL_LOOKBACK_MINUTES` | 60 | How far back the first run (no state file) looks |
| `UPLOAD_WATCH_CONTACT_TYPE` | all | e.g. `Client` to scan only clients |
| `KARBON_CONTACT_URL`, `KARBON_ORGANIZATION_URL` | none | Link template for the client name in the email, with `{key}`, e.g. copy a contact's URL from the browser and swap its key for `{key}` |

Setup:
1. In Entra (Azure) → App registrations, create an app (e.g. "Karbon upload alerts"). Add the Microsoft Graph application permission `Mail.Send` and grant admin consent, then create a client secret. To stop the app sending as anyone else, restrict it to the sending mailbox with an Exchange application access policy (or RBAC for Applications).
2. In Railway, attach a volume to the `karbon-mcp` service (e.g. at `/data`) and set the variables above.
3. Redeploy. The log shows `Upload watch every 30 min → …`, then one `{"uploadWatch":"run",…}` line per run with counts.

## Karbon API limits (don't build around these)

These come from Karbon's spec and from live use. There is no workaround in the API, so don't try to add one.

- **Filters.** Contacts and Organizations accept only `eq`, `contains` and `and` in `$filter`. `or` and `startswith` are rejected. Client groups accept `FullName eq` only. Work items reject `ne` and filtering on `RelatedClientGroupKey`.
- **Descriptions aren't in list results.** `GET /Contacts` and `GET /Organizations` don't return `EntityDescription`, so showing descriptions costs one GET per record.
- **Description, contact type and group members need a whole-record PUT.** PATCH accepts name fields only (Contacts) or `FullName` only (Organizations, Client groups).
- **Notes.** Only `GET /Notes/{id}` and `POST /Notes`. There is no way to list, search or bulk-read notes.
- **Work-item tasks.** No endpoint. Any task tool will 404.
- **Merging duplicates.** No merge endpoint. Merge on the Karbon screen.
- **Email and phone** live on Business Cards, not on the Contact or Organization record.
- **Work templates.** `/WorkTemplates` allows `$top` ≤ 10 and returns no `@odata.nextLink`, only `@odata.count`. `$skip` is documented as max 100 but works beyond it in practice (checked live: 126 templates).
- **Group membership** is only on `GET /ClientGroups/{key}`, not in the group list.

## Tests

```bash
npm test
```

This compiles, then runs the mocked-Karbon tests. They cover: a write that reports success but doesn't persist, 409 and 429 retries, PrimaryStatus filters given in the no-space form, nextLink paging, SecondaryStatus validation, the estimate-key reissue, fee rules, and custom-field merge, validation and delete confirmation, business card merge/validation, and the description, contact type, group member, contact email/phone and list-everything tools.

## Deploying

Railway deploys from `main`. Changes go through a PR and review first.
