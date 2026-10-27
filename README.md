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
| `test/*.test.mjs` | Mocked-Karbon tests, run against `dist/` |

`dist/` is committed. Railway builds with `npx tsc` (see `nixpacks.toml`).

## Environment

| Variable | Sent as |
| --- | --- |
| `KARBON_GB_KEY` | `Authorization: Bearer …` |
| `KARBON_ACCESS_KEY` | `AccessKey: …` |
| `PORT` | HTTP port (default 3000) |

## How every call behaves

- **Paging.** List tools request `$top` ≤ 100 and follow `@odata.nextLink`. They never build `$skip` themselves. `maxRecords` (default 100) caps how much is read. If more records exist, the result includes `@odata.nextLink`; pass it back as `nextLink` to continue. A nextLink is only followed if it points at `api.karbonhq.com`.
- **429.** The client waits the delay given in Karbon's message ("Try again in 10 seconds"), falling back to `Retry-After`, then 10 seconds. It retries up to 5 attempts in total. 5xx errors are retried with backoff.
- **409 (code 4020).** Writes re-fetch the record, reapply the change and retry, at most twice more. If the conflict persists, the tool fails with a clear message.
- **Verified writes.** Every write reads the record back and returns `ok: true` only if the change persisted. A `204` with no change is reported as `ok: false` with `failures`. Each write tool requires a `reason`, and an audit line is logged.
- **Whole-resource PUTs** (work items, organizations) GET the current record first, send it back with only the requested change, and include the PascalCase key (`WorkItemKey`, `OrganizationKey`). Organization PUTs omit `BusinessCards`, which leaves the cards untouched, and check that cards, client team and other fields are unchanged afterwards.
- **PrimaryStatus.** `$filter` only matches the spaced form (`'In Progress'`, `'Ready To Start'`). Status values in filters are normalised to that form. Responses use either form, depending on the endpoint, and are compared without regard to spacing.

## Tools

### Contacts
| Tool | Notes |
| --- | --- |
| `list_contacts` | filter, orderBy, paging |
| `get_contact` | |
| `get_contact_by_identifier` | by UserDefinedIdentifier; optional BusinessCards |
| `create_contact` | write: `reason` + read-back |
| `update_contact` | write (PATCH): FirstName, MiddleName, LastName, PreferredName, Salutation, Suffix |

### Organizations
| Tool | Notes |
| --- | --- |
| `list_organizations` | filter, orderBy, paging |
| `get_organization` | |
| `get_organization_by_identifier` | |
| `create_organization` | write |
| `update_organization` | write: FullName by PATCH; ClientOwner / ClientManager by a merged PUT that leaves BusinessCards untouched |

### Client groups
| Tool | Notes |
| --- | --- |
| `list_client_groups` | filter (FullName eq), paging |
| `get_client_group` | includes Members |
| `get_client_group_by_identifier` | |
| `create_client_group` | write |
| `update_client_group` | write: FullName only (the only field Karbon's PATCH accepts) |
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
| `list_work_templates`, `get_work_template` | |

### Budgets (Estimate Summaries)
| Tool | Notes |
| --- | --- |
| `get_estimate_summary` | |
| `update_karbon_estimate_minutes` | write (PATCH): EstimateMinutes **or** EstimateAmount (per the firm's Time and Budget setting), and/or HourlyRate. Follows `OData-EntityId` if the key is reissued. Refuses `0-` keys. |
| `preview_karbon_estimate_summary_update` | read-only diff |

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
| `get_tenant_settings` | also refreshes the cache used to validate SecondaryStatus |
| `list_users`, `get_user`, `list_team_members` | |
| `search_karbon` | first 10 contacts, organizations and work items matching a keyword |

### Removed
- `list_work_tasks`, `update_task`: API v3 has no work-item task endpoint, so both returned 404.

## Tests

```bash
npm test
```

This compiles, then runs the mocked-Karbon tests. They cover: a write that reports success but doesn't persist, 409 and 429 retries, PrimaryStatus filters given in the no-space form, nextLink paging, SecondaryStatus validation, the estimate-key reissue, fee rules, and custom-field merge, validation and delete confirmation.

## Deploying

Railway deploys from `main`. Changes go through a PR and review first.
