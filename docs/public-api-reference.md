# Iverto Attend API — v1 reference

For developers integrating payroll, ERP, access-control or HR systems with Iverto Attend.

**Base URL:** `https://api.iverto.ai/v1` (until that host is live: `https://<your Iverto host>/att/v1/public`).

---

## Authentication

An org admin creates a key in **Settings → API & integrations**. The key is shown once:

```
Authorization: Bearer ivk_live_XXXXXXXXXXXX_…
```

- Server-to-server only. Requests carrying an `Origin` header (browsers) are refused with `403 BROWSER_NOT_ALLOWED`.
- Keys in query strings are never accepted.
- A key works only for the permissions, sites and IP addresses it was given, within the limits Iverto set for your organisation.
- Check what a key can do: `GET /me`.

## Errors

Every error is [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) `application/problem+json`. Switch on `code`; `title` may change.

```json
{ "type": "https://developers.iverto.ai/errors/INSUFFICIENT_PERMISSION", "title": "This key lacks the employees:read permission",
  "status": 403, "code": "INSUFFICIENT_PERMISSION", "requestId": "4f6c…", "errors": { "required": "employees:read" } }
```

| Status | Codes |
|---|---|
| 400 | `VALIDATION_FAILED`, `INVALID_CURSOR`, `RANGE_TOO_LARGE`, `IDEMPOTENCY_KEY_REQUIRED`, `TOO_MANY_RECORDS` |
| 401 | `INVALID_API_KEY`, `API_KEY_REVOKED`, `API_KEY_EXPIRED`, `SIGNATURE_REQUIRED`, `INVALID_SIGNATURE`, `SIGNATURE_EXPIRED`, `SIGNATURE_REPLAYED`, `SIGNING_KEY_NOT_SET` |
| 402 | `CREDITS_EXHAUSTED`, `KEY_CREDIT_CAP_REACHED` |
| 403 | `BROWSER_NOT_ALLOWED`, `INSUFFICIENT_PERMISSION`, `BLOCKED_BY_POLICY`, `IP_NOT_ALLOWED`, `IP_ALLOWLIST_REQUIRED`, `API_KEY_DISABLED`, `API_KEY_PENDING_APPROVAL`, `API_DISABLED`, `TENANT_SUSPENDED` |
| 404 | `NOT_FOUND`, `EMPLOYEE_NOT_FOUND` (also for records outside the key's sites) |
| 409 | `DUPLICATE`, `ALREADY_DECIDED`, `IDEMPOTENCY_IN_PROGRESS`, `JOB_LIMIT_REACHED` |
| 410 | `SYNC_CURSOR_EXPIRED` |
| 422 | `IDEMPOTENCY_KEY_REUSED` |
| 429 | `RATE_LIMITED`, `DAILY_QUOTA_EXCEEDED`, `CONCURRENCY_LIMIT`, `TOO_MANY_AUTH_FAILURES` |
| 503 | `API_UNAVAILABLE`, `CREDITS_UNAVAILABLE` |

Quote `requestId` (also the `X-Request-Id` header) when contacting support.

## Rate limits and credits

Limits apply per key and per organisation (all keys together), plus a daily quota and a cap on concurrent requests.

```
RateLimit-Policy: "key";q=300;w=60, "org";q=600;w=60, "day";q=200000;w=86400
RateLimit: "key";r=287;t=0
Retry-After: 3            (on 429)
X-Credits-Remaining: 9940 (when your organisation uses credits)
```

Back off on `429` for `Retry-After` seconds. Daily quotas reset at 00:00 UTC. A `304 Not Modified` costs no credits.

## Conventions

- JSON, camelCase. Every documented field is always present (`null` when empty).
- Instants are RFC 3339 UTC (`2026-12-01T09:30:00.000Z`); calendar dates are `YYYY-MM-DD`.
- Decimal quantities (leave days) are strings: `"1.5"`.
- IDs are opaque strings up to 64 characters.
- Enum values may be added: treat unknown values gracefully.
- Every object has `object` (e.g. `"employee"`).

## Pagination and incremental sync

Every list returns:

```json
{ "object": "list", "data": [ … ], "hasMore": true, "nextCursor": "eyJ0Ijo…" }
```

Parameters: `limit` (1–200, default 50), `cursor`, `updatedSince` (RFC 3339, inclusive).

Lists are ordered by last change, so the same call is a **sync feed**:

1. First sync: page through with `cursor` until `hasMore` is `false`.
2. Store the last `nextCursor`. Later, call again with it to receive only what changed since, including deletions:
   ```json
   { "object": "employee", "id": "…", "deleted": true, "deletedAt": "2026-12-03T10:00:00.000Z" }
   ```
3. Delivery is **at-least-once**: upsert by `id`. Deletions ignore list filters.
4. A cursor not used for 90 days (or an `updatedSince` older than 90 days) returns `410 SYNC_CURSOR_EXPIRED`: run a full sync.

Send `If-None-Match` with a previous `ETag` to get `304` when nothing changed.

## Punches from terminals

Each punch carries `employeeId` (Iverto's id; map it to your system with `GET /employees`, which returns `employeeCode` and `externalId`), `punchedAt` (when the person punched, by the terminal's clock) and `direction`: `in`, `out`, or `unknown` for two-way gates, where the attendance engine pairs first in and last out. `attendance-days` has the computed `firstIn`, `lastOut` and status.

Terminals keep working offline and upload their backlog when they reconnect. Those punches keep their original `punchedAt`, with a later `receivedAt`. So:

- **History:** `GET /punches?from=…&to=…` filters on `punchedAt`, for any period.
- **Not missing late uploads:** sync with `cursor` / `updatedSince`. They follow when Iverto stored or changed a punch, so a punch uploaded today for last Tuesday still arrives in today's sync. A plain `from`/`to` poll over "the last hour" would miss it.
- **Real time:** subscribe to `punch.created`. It fires when Iverto stores the punch (for a backlog, on reconnect), usually within a few seconds; check `punchedAt` for when it happened. A punch from a person the terminal doesn't know yet has `employeeId: null` until they are matched; the sync feed then returns it again with the id.

## Writes and idempotency

Every `POST` needs an `Idempotency-Key` header (any unique string ≤ 200 chars). Retrying with the same key within 24 h returns the original response; reusing it with a different body returns `422`.

## Permissions

| Permission | Allows |
|---|---|
| `org:read` | sites, departments |
| `employees:read` | employees (`pii` only on keys with PII access) |
| `punches:read` / `punches:write` | list / record punches |
| `attendance:read` | attendance days |
| `leave:read` | leave types, requests, balances |
| `leave:approve` | approve / reject leave requests (may need Iverto approval) |
| `employees:write` | bulk create / update employees (PII fields only on keys with PII access) |
| `reports:generate` | generate report files |

## Operations

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/me` | — | The key, its effective permissions and limits |
| GET | `/sites` | `org:read` | sync feed |
| GET | `/departments` | `org:read` | sync feed |
| GET | `/employees` | `employees:read` | filters: `status`, `siteId`, `departmentId`, `externalId`, `employeeCode` |
| GET | `/employees/{id}` | `employees:read` | |
| GET | `/punches` | `punches:read` | filters: `employeeId`, `siteId`, `from`, `to` (instants) |
| POST | `/punches` | `punches:write` | `{ employeeId, punchedAt, direction: "in"\|"out", reason }` → 201 punch (source `MANUAL`) |
| GET | `/attendance-days` | `attendance:read` | filters: `employeeId`, `siteId`, `from`, `to` (dates, ≤ 93 days apart) |
| GET | `/leave-types` | `leave:read` | sync feed |
| GET | `/leave-requests` | `leave:read` | filters: `employeeId`, `status`, `from`, `to` (overlap) |
| GET | `/leave-requests/{id}` | `leave:read` | |
| POST | `/leave-requests/{id}/approve` | `leave:approve` | `{ note? }`. Counts as a manager's approval: types that need HR approval stay `PENDING` for HR |
| POST | `/leave-requests/{id}/reject` | `leave:approve` | `{ note }` (≥ 3 chars) |
| GET | `/leave-balances` | `leave:read` | `year` (leave year, default current), `employeeId`; paged by employee |
| GET | `/events` | — | the event log (below); only event types the key's permissions cover; no credits |
| POST | `/employees/bulk` | `employees:write` | `202` + job; see Jobs |
| POST | `/reports` | `reports:generate` | `202` + job; see Jobs |
| GET | `/jobs` | — | jobs of the types your permissions cover, newest first (`type`, `cursor`) |
| GET | `/jobs/{id}` | — | one job; report jobs include a fresh download URL |

## Webhooks

An org admin adds an endpoint in **Settings → API & integrations → Webhooks**: a public `https://` URL and the event types to receive. The signing secret (`whsec_…`) is shown once.

| Event | When | Needs |
|---|---|---|
| `punch.created` | a punch is recorded (terminal, mobile, web or API) | `punches:read` |
| `attendance.day.finalized` | an employee's day closes | `attendance:read` |
| `attendance.day.updated` | a closed day changes (correction, recompute) | `attendance:read` |
| `leave.request.created` | a leave request is submitted | `leave:read` |
| `leave.request.decided` | approved, rejected or cancelled (`data.status`) | `leave:read` |
| `employee.created` / `employee.updated` / `employee.exited` | employee lifecycle | `employees:read` |
| `job.completed` | a bulk or report job finishes (`data.type`, `data.status`) | — |
| `api.alert` | a usage alert for your organisation (`data.type`, `data.level`, `data.message`, `data.apiKeyId`) | — |
| `ping` | the "Send test event" button | — |

"Needs" is the module your organisation's Iverto policy must allow for the endpoint to receive that type. New event types may be added; ignore ones you don't know.

Each delivery is a `POST` with a thin envelope — ids only, never personal data; fetch the record with your API key:

```json
{ "id": "evt_4c1f…", "type": "leave.request.decided", "createdAt": "2026-12-01T09:30:00.000Z", "apiVersion": "2026-12-01",
  "data": { "object": "leave_request", "id": "cmw…", "employeeId": "cmw…", "leaveTypeId": "cmw…", "status": "APPROVED" } }
```

**Verify every request** ([Standard Webhooks](https://www.standardwebhooks.com/); any of its libraries works). Headers: `webhook-id` (= `id`), `webhook-timestamp` (Unix seconds), `webhook-signature` (`v1,<base64>`, space-separated when more than one). Compute `base64(HMAC-SHA256(base64decode(secret without "whsec_"), "{webhook-id}.{webhook-timestamp}.{raw body}"))`, accept if it equals any `v1,` value, and reject timestamps more than 5 minutes old.

- **Respond** with any `2xx` within 10 seconds; do the work afterwards. Redirects are not followed.
- **Retries:** after 5 s, 30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 6 h, 12 h and 24 h (11 attempts, ≈ 2 days). Answering `410 Gone` disables the endpoint at once; 3 days of failures disable it too, and your admins are notified. Re-enable it and use **Replay** to resend the missed window.
- **At-least-once, unordered:** deduplicate on `webhook-id` (replays and retries keep it); order by `createdAt` or fetch the latest object.
- **Rotation:** after "Rotate secret" the new secret signs at once and the old one also signs for 24 hours.

## Request signing (optional)

An Ed25519 signature on each request proves it came from the holder of your private key, so a leaked API key alone is useless. An admin pastes the **public** key on the API key (Settings → API & integrations → edit key), as base64 of the 32 raw bytes or PEM, and can tick **Refuse unsigned requests**.

Send two headers:

```
Iverto-Timestamp: 1764140400
Iverto-Signature: base64( Ed25519( METHOD + "\n" + PATH + "\n" + TIMESTAMP + "\n" + hex(sha256(BODY)) ) )
```

`PATH` is the path and query string as sent, starting `/v1` (`/v1/punches?limit=50`); `BODY` is the exact bytes you send (empty for `GET`). The timestamp must be within 5 minutes of Iverto's clock, and each signature is accepted once. Ed25519 signatures are deterministic, so two identical requests in the same second count as a replay: space them out or vary the query.

```js
// Node.js 18+
import { createHash, createPrivateKey, sign } from 'node:crypto';
const key = createPrivateKey(process.env.IVERTO_SIGNING_KEY_PEM);
function signedHeaders(method, path, body = '') {
  const ts = String(Math.floor(Date.now() / 1000));
  const payload = `${method}\n${path}\n${ts}\n${createHash('sha256').update(body).digest('hex')}`;
  return { 'Iverto-Timestamp': ts, 'Iverto-Signature': sign(null, Buffer.from(payload), key).toString('base64') };
}
// Generate a pair once: openssl genpkey -algorithm ed25519 -out private.pem && openssl pkey -in private.pem -pubout
```

```python
# Python (cryptography)
import base64, hashlib, time
from cryptography.hazmat.primitives.serialization import load_pem_private_key
key = load_pem_private_key(open("private.pem", "rb").read(), password=None)
def signed_headers(method, path, body=b""):
    ts = str(int(time.time()))
    payload = f"{method}\n{path}\n{ts}\n{hashlib.sha256(body).hexdigest()}".encode()
    return {"Iverto-Timestamp": ts, "Iverto-Signature": base64.b64encode(key.sign(payload)).decode()}
```

Errors: `SIGNATURE_REQUIRED` (the key requires it), `INVALID_SIGNATURE`, `SIGNATURE_EXPIRED` (timestamp), `SIGNATURE_REPLAYED`, `SIGNING_KEY_NOT_SET` (headers sent, no public key registered).

## Usage alerts

Iverto checks every hour and tells your organisation's admins (in the app and by email) and the key's creator about: requests being rate limited, the daily quota or monthly credits passing the threshold Iverto set (80% by default) or running out, a key expiring within 7 days, a key unused for 60 days, a sudden rise in failed requests, many refused requests or a new IP address on a key without an allowlist, and a webhook failing for over an hour. At most one of each per key per day. They are listed under Settings → API & integrations → Alerts, and sent as `api.alert` events.

Keys unused for 90 days are **disabled** automatically (the period is set by Iverto). An admin can re-enable a disabled key; nothing else about it changes.

## Changelog

| Version | Changes |
|---|---|
| `2026-12-01` | First version: organisation, employees, punches, attendance days, leave; incremental sync; webhooks and the event log; bulk employee upsert and report jobs; optional Ed25519 request signing; usage alerts and `api.alert`. |

Additions (new fields, operations, event types or enum values) can arrive at any time within a version; anything that would break an integration gets a new version and a notice.

## Event log

`GET /events` returns the same envelopes, oldest first, for the last 30 days — for consumers that poll instead of receiving webhooks, or that missed deliveries. Parameters: `limit` (1–200), `cursor`, `since` (RFC 3339, start when there is no cursor), `type`. Store `nextCursor` and call again with it; when nothing is new you get an empty page and the same cursor. A position older than 30 days returns `410 SYNC_CURSOR_EXPIRED`. Events are recorded while your organisation has an active API key or webhook endpoint.

## Jobs

Bulk writes and reports run in the background. The `POST` returns `202 Accepted` with a job; poll `GET /jobs/{id}` (every few seconds) or subscribe to `job.completed`.

```json
{ "object": "job", "id": "cmw…", "type": "employees.bulk_upsert", "status": "partially_succeeded",
  "progress": { "processed": 4, "total": 4 },
  "result": { "summary": { "created": 2, "updated": 1, "unchanged": 0, "failed": 1, "skipped": 0 },
              "rows": [ { "index": 3, "status": "failed", "id": null, "errors": [ { "field": "joinedOn", "message": "…" } ] } ] },
  "error": null, "createdAt": "…", "startedAt": "…", "completedAt": "…", "expiresAt": "…" }
```

`status`: `queued`, `running`, `succeeded`, `partially_succeeded`, `failed` (with `error.code`). A key sees the jobs of the types its permissions cover (any key of your organisation). Jobs are kept 30 days.

### Bulk employee upsert — `POST /employees/bulk`

```json
{ "records": [
    { "employeeCode": "E104", "externalId": "hris-104", "fullName": "Priya Sharma", "joinedOn": "2026-04-01", "siteId": "cmw…",
      "departmentId": "cmw…", "managerEmployeeCode": "E100", "designation": "Sales Executive" },
    { "externalId": "hris-77", "designation": "Team Lead" } ],
  "validateOnly": false, "onInvalid": "skip" }
```

- Up to 1,000 records per request (your organisation's limit), one bulk job at a time per organisation (`409 JOB_LIMIT_REACHED`). `Idempotency-Key` required.
- Each record is matched by `employeeCode`, or by `externalId` when the code is left out. An unknown code creates an employee; `fullName`, `joinedOn` and `siteId` are then required.
- Fields: `fullName`, `joinedOn`, `siteId`, `departmentId`, `managerEmployeeCode` (an existing employee or another record in the request), `designation`, `employmentType`, `mobilePunch`, `email`, `phone`, `probationEndOn`, `confirmedOn`, `noticePeriodDays`, `externalId`. Keys with PII access may also send date of birth, gender, addresses, emergency contact, `pan`, `aadhaarLast4`, `uan`, `esicNumber` and bank fields. A field left out is kept; `null` clears it.
- Values are validated exactly like the CSV import in the web app. Malformed records (unknown field, wrong type) are refused with `400` before any job starts.
- Per-record `status`: `created`, `updated`, `unchanged` (nothing to change, nothing written), `failed` (with `errors`), `skipped`.
- `validateOnly: true` reports what would happen without writing. `onInvalid: "reject"` writes nothing if any record is invalid (the job fails with `VALIDATION_FAILED`); the default `"skip"` applies the valid ones.
- A site-restricted key can only create employees in, and update employees of, its sites.
- Writes are audited with the key as the actor and emit `employee.created` / `employee.updated`.

### Reports — `POST /reports`

```json
{ "type": "muster-roll", "format": "pdf", "filters": { "dateFrom": "2026-11-01", "dateTo": "2026-11-30", "siteIds": ["cmw…"], "groupBy": "department" } }
```

Types: `daily-summary`, `muster-roll`, `payable-days`, `timesheet`, `punch-log`, `late-early`, `overtime`, `leave`, `absenteeism`. Format `csv` or `pdf`. Optional filters: `siteIds`, `departmentIds`, `employeeIds`, `groupBy` (`none`, `department`, `site`). Each type has its own maximum date range. A site-restricted key's report covers its sites only. When the job succeeds, `result` has `downloadUrl` (valid 15 minutes, minted on every `GET /jobs/{id}`; `null` in `GET /jobs`), `urlExpiresAt`, `sha256`, `rowCount` and `format`. Files are deleted after your organisation's report retention (`result.expired: true`).

### Example

```bash
curl https://api.iverto.ai/v1/employees?limit=100 \
  -H "Authorization: Bearer $IVERTO_API_KEY"

curl -X POST https://api.iverto.ai/v1/punches \
  -H "Authorization: Bearer $IVERTO_API_KEY" -H "Idempotency-Key: gate-7-2026-12-01T09:02:11Z-E104" \
  -H "Content-Type: application/json" \
  -d '{"employeeId":"cmw…","punchedAt":"2026-12-01T03:32:11Z","direction":"in","reason":"Gate 7 reader"}'
```
