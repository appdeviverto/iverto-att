# Iverto Attend API — v1 reference

Use this API to connect your payroll, ERP, HR or access-control system to Iverto Attend. Your system can read employees, punches, attendance and leave. It can also send data to Iverto Attend.

---

## Base URL

Send all requests to this base URL:

```
https://ivertovm.indiasouthcentral.cloudapp.azure.com/att/v1/public
```

Add the path of the operation to the end of the base URL. For example, `GET /employees` becomes:

```
https://ivertovm.indiasouthcentral.cloudapp.azure.com/att/v1/public/employees
```

All requests use HTTPS. The API does not accept HTTP.

## Quick start

Do these steps to make your first request.

1. Ask an admin of your organisation to create an API key. The admin goes to **Settings → API & integrations** and clicks **New API key**.
2. Copy the key. The app shows the key one time only.
3. Keep the key in a secret store on your server. Do not put the key in a browser app or a mobile app.
4. Send this request:

```bash
curl https://ivertovm.indiasouthcentral.cloudapp.azure.com/att/v1/public/me \
  -H "Authorization: Bearer $IVERTO_API_KEY"
```

5. Make sure that the response has status `200`. The response shows the permissions and the limits of your key.

## Authentication

Send your API key in the `Authorization` header of each request:

```
Authorization: Bearer ivk_live_XXXXXXXXXXXX_…
```

Obey these rules:

- Use the key only from a server. The API refuses requests from browsers (`403 BROWSER_NOT_ALLOWED`).
- Do not put the key in the URL. The API does not accept keys in the query string.
- A key can only do what the admin gave it: its permissions, its sites and its IP addresses.
- Iverto sets the maximum limits for your organisation. A key cannot go above these limits.

To see what your key can do, send `GET /me`.

## Data format

- All requests and responses use JSON. Field names use camelCase.
- Each response object has an `object` field. The field tells the type, for example `"employee"`.
- Each documented field is always in the response. An empty field has the value `null`.
- Times use the RFC 3339 format in UTC. Example: `2026-12-01T09:30:00.000Z`.
- Dates use the format `YYYY-MM-DD`. Example: `2026-12-01`.
- Decimal numbers are strings. Example: leave days `"1.5"`.
- IDs are strings of 64 characters or fewer. Do not try to read meaning from an ID.
- Iverto can add new values to a list of values (an enum). Make sure that your code accepts values that it does not know.

## Lists and synchronization

### Read a list

Each list operation returns this shape:

```json
{ "object": "list", "data": [ … ], "hasMore": true, "nextCursor": "eyJ0Ijo…" }
```

Use these query parameters:

| Parameter | Meaning |
|---|---|
| `limit` | Number of items on one page. From 1 to 200. The default is 50. |
| `cursor` | The `nextCursor` value from the previous page. |
| `updatedSince` | Get only items that changed at or after this time (RFC 3339). |

To read all items, do these steps:

1. Send the first request without `cursor`.
2. If `hasMore` is `true`, send the request again with `cursor` set to `nextCursor`.
3. Do step 2 again until `hasMore` is `false`.

### Keep your system up to date

The API sorts each list by the time of the last change. Thus you can use a list to get only the changes since your last request.

Do these steps:

1. Read the full list one time (see "Read a list").
2. Keep the last `nextCursor` value.
3. Later, send the same request with this `cursor`. You get only the items that changed after your last request.
4. Keep the new `nextCursor` value. Do step 3 again at each synchronization.

A deleted item comes back in this shape:

```json
{ "object": "employee", "id": "…", "deleted": true, "deletedAt": "2026-12-03T10:00:00.000Z" }
```

Obey these rules:

- The API can send the same item two times. Update the item by its `id`. Do not add it again.
- Deleted items come back even when you use list filters.
- A cursor expires after 90 days without use. An `updatedSince` value more than 90 days old also expires. You then get `410 SYNC_CURSOR_EXPIRED`. Read the full list again.

To save requests, send the `ETag` value from the previous response in the `If-None-Match` header. If nothing changed, you get `304 Not Modified`. A `304` response costs no credits.

## Punches from terminals

### The data in a punch

| Field | Meaning |
|---|---|
| `employeeId` | The Iverto ID of the employee. To find your own employee code, use `GET /employees`. It returns `employeeCode` and `externalId`. |
| `punchedAt` | The time when the person punched. The terminal clock gives this time. |
| `receivedAt` | The time when Iverto stored the punch. |
| `direction` | `in`, `out` or `unknown`. A terminal at a two-way gate sends `unknown`. |

For a two-way gate, Iverto calculates the first in and the last out. `GET /attendance-days` gives the calculated `firstIn`, `lastOut` and status for each day.

### Punches that arrive late

A terminal continues to record punches when it has no connection. When the connection comes back, the terminal sends all the stored punches. These punches keep the original `punchedAt` time. Their `receivedAt` time is later.

Use the correct method for your task:

| Task | Method |
|---|---|
| Get the punches of a past period | `GET /punches?from=…&to=…`. The filter uses `punchedAt`. |
| Get all new punches, also the late ones | Synchronize with `cursor` or `updatedSince` (see "Keep your system up to date"). These use the time when Iverto stored the punch. |
| Get each punch immediately | Use the `punch.created` webhook (see "Webhooks"). |

**CAUTION:** Do not use `from` and `to` to get "the punches of the last hour". You will not get the punches that arrive late.

A terminal can record a person that it does not know yet. That punch has `employeeId: null`. When an admin connects the person to an employee, the synchronization sends the punch again with the `employeeId`.

## Write requests

Each `POST` request must have an `Idempotency-Key` header. Use a new unique value for each new action (200 characters or fewer).

- If your request fails because of the network, send it again with the same key. You get the first response. The API does not do the action two times.
- The API keeps each key for 24 hours.
- Do not use the same key with a different body. You then get `422 IDEMPOTENCY_KEY_REUSED`.

## Errors

Each error response uses the RFC 9457 format (`application/problem+json`):

```json
{ "type": "https://developers.iverto.ai/errors/INSUFFICIENT_PERMISSION", "title": "This key lacks the employees:read permission",
  "status": 403, "code": "INSUFFICIENT_PERMISSION", "requestId": "4f6c…", "errors": { "required": "employees:read" } }
```

- Use the `code` field in your code. The `code` values do not change.
- Do not use the `title` field in your code. The text can change.
- When you contact support, give the `requestId`. The `X-Request-Id` header has the same value.

| Status | Code | What to do |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Correct the fields in `errors`. Then send the request again. |
| 400 | `INVALID_CURSOR` | Use a `nextCursor` value from a response. Do not change it. |
| 400 | `RANGE_TOO_LARGE` | Make the date range shorter. |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | Add an `Idempotency-Key` header to the `POST` request. |
| 400 | `TOO_MANY_RECORDS` | Send fewer records in one request. |
| 401 | `INVALID_API_KEY` | Make sure that the key is complete and correct. |
| 401 | `API_KEY_REVOKED` | The key does not work any more. Ask an admin for a new key. |
| 401 | `API_KEY_EXPIRED` | The key is past its expiry date. Ask an admin for a new key. |
| 401 | `SIGNATURE_REQUIRED` | This key needs signed requests. See "Request signing". |
| 401 | `INVALID_SIGNATURE` | The signature is not correct. Do the signing steps again. |
| 401 | `SIGNATURE_EXPIRED` | The `Iverto-Timestamp` value is more than 5 minutes from the server time. Correct your server clock. |
| 401 | `SIGNATURE_REPLAYED` | The API already accepted this signature. Make a new signature. |
| 401 | `SIGNING_KEY_NOT_SET` | The key has no signing key. Remove the signature headers, or ask an admin to add the public key. |
| 402 | `CREDITS_EXHAUSTED` | Your organisation used all its credits for this month. Contact Iverto. |
| 402 | `KEY_CREDIT_CAP_REACHED` | This key used its monthly credit limit. Ask an admin to change the limit. |
| 403 | `BROWSER_NOT_ALLOWED` | Send the request from a server, not from a browser. |
| 403 | `INSUFFICIENT_PERMISSION` | The key does not have the permission in `errors.required`. Ask an admin to add it. |
| 403 | `BLOCKED_BY_POLICY` | Iverto does not allow this action for your organisation. Contact Iverto. |
| 403 | `IP_NOT_ALLOWED` | Send the request from an IP address in the allowlist of the key. |
| 403 | `IP_ALLOWLIST_REQUIRED` | Your organisation requires an IP allowlist on each key. Ask an admin to add one. |
| 403 | `API_KEY_DISABLED` | An admin or Iverto disabled the key. Ask an admin to enable it. |
| 403 | `API_KEY_PENDING_APPROVAL` | The key waits for approval from Iverto. |
| 403 | `API_DISABLED` | API access is off for your organisation. Contact Iverto. |
| 403 | `TENANT_SUSPENDED` | Your organisation is not active. Contact Iverto. |
| 404 | `NOT_FOUND`, `EMPLOYEE_NOT_FOUND` | The item does not exist, or it is outside the sites of your key. |
| 409 | `DUPLICATE` | The item already exists. |
| 409 | `ALREADY_DECIDED` | Someone already approved or rejected this leave request. |
| 409 | `IDEMPOTENCY_IN_PROGRESS` | The first request with this `Idempotency-Key` did not finish. Wait. Then send it again. |
| 409 | `JOB_LIMIT_REACHED` | A bulk job already runs. Wait until it finishes. |
| 410 | `SYNC_CURSOR_EXPIRED` | The cursor is too old. Read the full list again. |
| 422 | `IDEMPOTENCY_KEY_REUSED` | You used this `Idempotency-Key` with a different body. Use a new key. |
| 429 | `RATE_LIMITED` | Too many requests. Wait for the number of seconds in `Retry-After`. |
| 429 | `DAILY_QUOTA_EXCEEDED` | Your organisation used its daily quota. Wait until 00:00 UTC. |
| 429 | `CONCURRENCY_LIMIT` | Too many requests at the same time. Send fewer requests in parallel. |
| 429 | `TOO_MANY_AUTH_FAILURES` | Too many requests with wrong keys came from your IP address. Wait. Then correct the key. |
| 503 | `API_UNAVAILABLE` | The API is not available now. Try again later. |
| 503 | `CREDITS_UNAVAILABLE` | The credit check is not available now. Try again in a short time. |

## Rate limits and credits

The API sets these limits:

- A limit for each key (requests each minute).
- A limit for your organisation (all keys together, requests each minute).
- A daily quota for your organisation. The quota starts again at 00:00 UTC.
- A maximum number of requests at the same time.

Each response tells you your limits and the remaining requests:

```
RateLimit-Policy: "key";q=300;w=60, "org";q=600;w=60, "day";q=200000;w=86400
RateLimit: "key";r=287;t=0
Retry-After: 3            (only with status 429)
X-Credits-Remaining: 9940 (only if your organisation uses credits)
```

If you get status `429`, wait for the number of seconds in `Retry-After`. Then send the request again.

## Permissions

An admin gives each key one or more permissions. Give a key only the permissions that the integration needs.

| Permission | Lets the key |
|---|---|
| `org:read` | Read sites and departments. |
| `employees:read` | Read employees. The `pii` field has data only if the key has PII access. |
| `employees:write` | Create and update employees in bulk. PII fields need PII access. |
| `punches:read` | Read punches. |
| `punches:write` | Record punches. |
| `attendance:read` | Read attendance days. |
| `leave:read` | Read leave types, leave requests and leave balances. |
| `leave:approve` | Approve and reject leave requests. Iverto can require approval for this permission. |
| `reports:generate` | Make report files. |

## Operations

The detailed reference for each operation is after this guide. This table gives a summary.

| Method | Path | Permission | What it does |
|---|---|---|---|
| GET | `/me` | none | Shows the key, its permissions and its limits. |
| GET | `/sites` | `org:read` | Lists the sites. |
| GET | `/departments` | `org:read` | Lists the departments. |
| GET | `/employees` | `employees:read` | Lists the employees. Filters: `status`, `siteId`, `departmentId`, `externalId`, `employeeCode`. |
| GET | `/employees/{id}` | `employees:read` | Gets one employee. |
| POST | `/employees/bulk` | `employees:write` | Creates or updates many employees in a job. See "Jobs". |
| GET | `/punches` | `punches:read` | Lists the punches. Filters: `employeeId`, `siteId`, `from`, `to`. |
| POST | `/punches` | `punches:write` | Records one manual punch. |
| GET | `/attendance-days` | `attendance:read` | Lists the attendance days. Filters: `employeeId`, `siteId`, `from`, `to` (93 days or fewer). |
| GET | `/leave-types` | `leave:read` | Lists the leave types. |
| GET | `/leave-requests` | `leave:read` | Lists the leave requests. Filters: `employeeId`, `status`, `from`, `to`. |
| GET | `/leave-requests/{id}` | `leave:read` | Gets one leave request. |
| POST | `/leave-requests/{id}/approve` | `leave:approve` | Approves a leave request as a manager. Some leave types also need HR approval. |
| POST | `/leave-requests/{id}/reject` | `leave:approve` | Rejects a leave request. A note of 3 characters or more is necessary. |
| GET | `/leave-balances` | `leave:read` | Lists the leave balances for one leave year. |
| GET | `/events` | none | Lists the events of the last 30 days. See "Event log". |
| POST | `/reports` | `reports:generate` | Makes a report file in a job. See "Jobs". |
| GET | `/jobs` | none | Lists your jobs. |
| GET | `/jobs/{id}` | none | Gets one job. |

## Webhooks

A webhook sends an event to your server immediately when something changes in Iverto Attend.

### Add a webhook

1. Ask an admin to go to **Settings → API & integrations → Webhooks**.
2. The admin adds the URL of your server. The URL must use `https://` and must be public.
3. The admin selects the event types.
4. Copy the signing secret (`whsec_…`). The app shows it one time only. Keep it in a secret store.

### Event types

| Event | Iverto sends it when | Permission that your organisation needs |
|---|---|---|
| `punch.created` | Iverto stores a punch from a terminal, the mobile app, the web app or the API. | `punches:read` |
| `attendance.day.finalized` | The day of an employee closes. | `attendance:read` |
| `attendance.day.updated` | A closed day changes, for example after a correction. | `attendance:read` |
| `leave.request.created` | An employee requests leave. | `leave:read` |
| `leave.request.decided` | Someone approves, rejects or cancels a leave request. See `data.status`. | `leave:read` |
| `employee.created` | Someone adds an employee. | `employees:read` |
| `employee.updated` | The data of an employee changes. | `employees:read` |
| `employee.exited` | An employee leaves the organisation. | `employees:read` |
| `job.completed` | A bulk job or a report job finishes. See `data.type` and `data.status`. | none |
| `api.alert` | Iverto finds a usage problem. See "Usage alerts". | none |
| `ping` | An admin clicks **Send test event**. | none |

Iverto can add new event types. Make sure that your code ignores event types that it does not know.

### The content of an event

Each event is a `POST` request with this body:

```json
{ "id": "evt_4c1f…", "type": "leave.request.decided", "createdAt": "2026-12-01T09:30:00.000Z", "apiVersion": "2026-12-01",
  "data": { "object": "leave_request", "id": "cmw…", "employeeId": "cmw…", "leaveTypeId": "cmw…", "status": "APPROVED" } }
```

The event has IDs only. It does not have personal data. To get the full item, use the API with your key.

### Check that the event comes from Iverto

Do these steps for each event:

1. Get the headers `webhook-id`, `webhook-timestamp` and `webhook-signature`.
2. Make sure that `webhook-timestamp` is less than 5 minutes old. If it is older, refuse the event.
3. Remove `whsec_` from your secret. Decode the remaining text from base64.
4. Make the text `{webhook-id}.{webhook-timestamp}.{raw body}`.
5. Calculate HMAC-SHA256 of this text with the decoded secret. Encode the result in base64.
6. Compare your result with each `v1,` value in `webhook-signature`. If one value is the same, accept the event. If no value is the same, refuse the event.

The signature follows the Standard Webhooks specification. You can also use a Standard Webhooks library to do these steps.

```js
// Node.js
import { createHmac, timingSafeEqual } from 'node:crypto';
function verifyWebhook(secret, headers, rawBody) {
  const id = headers['webhook-id'], ts = headers['webhook-timestamp'];
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest('base64');
  return headers['webhook-signature'].split(' ').some((s) => {
    const sig = s.replace(/^v1,/, '');
    return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  });
}
```

```python
# Python
import base64, hashlib, hmac, time
def verify_webhook(secret, headers, raw_body: bytes) -> bool:
    wid, ts = headers["webhook-id"], headers["webhook-timestamp"]
    if abs(time.time() - int(ts)) > 300:
        return False
    key = base64.b64decode(secret.removeprefix("whsec_"))
    expected = base64.b64encode(hmac.new(key, f"{wid}.{ts}.".encode() + raw_body, hashlib.sha256).digest()).decode()
    return any(hmac.compare_digest(s.removeprefix("v1,"), expected) for s in headers["webhook-signature"].split(" "))
```

### Reply to an event

- Reply with a `2xx` status in 10 seconds or less. Do the work after you reply.
- Iverto does not follow redirects.
- Iverto can send the same event two times. Use `webhook-id` to find and ignore duplicates.
- Events can arrive in a different sequence. Use `createdAt`, or get the latest item from the API.

### Failed events

If your server does not reply with `2xx`, Iverto sends the event again. It tries after 5 s, 30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 6 h, 12 h and 24 h. That is 11 attempts in approximately 2 days.

- If your server replies `410 Gone`, Iverto disables the webhook immediately.
- If the webhook fails for 3 days, Iverto disables it. Iverto tells your admins.
- To get the events that you did not receive, an admin enables the webhook again and clicks **Replay**.

### Change the secret

An admin can click **Rotate secret**. Iverto then signs with the new secret immediately. For 24 hours, Iverto also signs with the old secret. Change the secret on your server in these 24 hours.

## Event log

`GET /events` gives the same events as the webhooks. It keeps the events of the last 30 days. Use it if you cannot receive webhooks, or if you did not receive some events.

| Parameter | Meaning |
|---|---|
| `limit` | Number of events on one page. From 1 to 200. |
| `cursor` | The `nextCursor` value from the previous page. |
| `since` | The start time (RFC 3339), if you have no cursor. |
| `type` | Get only one event type. |

Do these steps:

1. Send `GET /events`.
2. Keep the `nextCursor` value.
3. Later, send the request again with this `cursor`. You get only the new events.
4. If there are no new events, you get an empty page and the same cursor.

A cursor older than 30 days gives `410 SYNC_CURSOR_EXPIRED`. Iverto records events only while your organisation has an active API key or webhook.

## Jobs

Bulk updates and reports can take some time. Thus they run in the background as jobs.

1. Send the `POST` request. You get status `202 Accepted` and a job.
2. Get the result in one of these two ways:
   - Send `GET /jobs/{id}` every few seconds until the job finishes.
   - Use the `job.completed` webhook.

A job has this shape:

```json
{ "object": "job", "id": "cmw…", "type": "employees.bulk_upsert", "status": "partially_succeeded",
  "progress": { "processed": 4, "total": 4 },
  "result": { "summary": { "created": 2, "updated": 1, "unchanged": 0, "failed": 1, "skipped": 0 },
              "rows": [ { "index": 3, "status": "failed", "id": null, "errors": [ { "field": "joinedOn", "message": "…" } ] } ] },
  "error": null, "createdAt": "…", "startedAt": "…", "completedAt": "…", "expiresAt": "…" }
```

| Status | Meaning |
|---|---|
| `queued` | The job waits to start. |
| `running` | The job runs now. |
| `succeeded` | The job finished with no errors. |
| `partially_succeeded` | Some records failed. See `result.rows`. |
| `failed` | The job failed. See `error.code`. |

A key can see the jobs of the types that its permissions allow. Iverto keeps jobs for 30 days.

### Create or update employees: `POST /employees/bulk`

```json
{ "records": [
    { "employeeCode": "E104", "externalId": "hris-104", "fullName": "Priya Sharma", "joinedOn": "2026-04-01", "siteId": "cmw…",
      "departmentId": "cmw…", "managerEmployeeCode": "E100", "designation": "Sales Executive" },
    { "externalId": "hris-77", "designation": "Team Lead" } ],
  "validateOnly": false, "onInvalid": "skip" }
```

How Iverto finds the employee:

- Iverto finds each record by `employeeCode`.
- If the record has no `employeeCode`, Iverto finds it by `externalId`.
- If no employee has that code, Iverto creates a new employee. A new employee needs `fullName`, `joinedOn` and `siteId`.

The fields that you can send:

- `fullName`, `joinedOn`, `siteId`, `departmentId`, `designation`, `employmentType`, `mobilePunch`, `email`, `phone`, `probationEndOn`, `confirmedOn`, `noticePeriodDays`, `externalId`.
- `managerEmployeeCode`: the code of an existing employee, or of another record in the same request.
- With PII access only: date of birth, gender, addresses, emergency contact, `pan`, `aadhaarLast4`, `uan`, `esicNumber` and bank fields.

Rules:

- If you do not send a field, Iverto keeps the current value.
- If you send `null`, Iverto removes the value.
- You can send 1,000 records or fewer in one request. Iverto can set a different limit for your organisation.
- Only one bulk job can run at a time for your organisation.
- Iverto checks the values with the same rules as the CSV import in the web app.
- If a record has an unknown field or a wrong type, Iverto refuses the request with `400`. No job starts.
- A key with a site limit can only change employees of its sites.

Options:

| Option | Meaning |
|---|---|
| `validateOnly: true` | Iverto checks all records and tells you the result. It does not change data. |
| `onInvalid: "skip"` | The default. Iverto saves the correct records and reports the incorrect records. |
| `onInvalid: "reject"` | If one record is incorrect, Iverto saves no records. The job fails with `VALIDATION_FAILED`. |

The status of each record in `result.rows`:

| Status | Meaning |
|---|---|
| `created` | Iverto created a new employee. |
| `updated` | Iverto changed the employee. |
| `unchanged` | The data was already the same. Iverto changed nothing. |
| `failed` | The record has errors. See `errors`. |
| `skipped` | The record is correct, but Iverto did not save it (`onInvalid: "reject"`). |

Iverto records each change in the audit log with your key as the actor. Iverto also sends `employee.created` and `employee.updated` events.

### Make a report: `POST /reports`

```json
{ "type": "muster-roll", "format": "pdf", "filters": { "dateFrom": "2026-11-01", "dateTo": "2026-11-30", "siteIds": ["cmw…"], "groupBy": "department" } }
```

| Field | Values |
|---|---|
| `type` | `daily-summary`, `muster-roll`, `payable-days`, `timesheet`, `punch-log`, `late-early`, `overtime`, `leave`, `absenteeism` |
| `format` | `csv` or `pdf` |
| `filters.dateFrom`, `filters.dateTo` | The period. Each report type has a maximum period. |
| `filters.siteIds`, `filters.departmentIds`, `filters.employeeIds` | Optional. Limit the report to these items. |
| `filters.groupBy` | Optional. `none`, `department` or `site`. |

When the job succeeds, `GET /jobs/{id}` gives these values in `result`:

- `downloadUrl`: the link to the file. The link is valid for 15 minutes. Each `GET /jobs/{id}` gives a new link. `GET /jobs` does not give a link.
- `urlExpiresAt`: the time when the link stops.
- `sha256`: the checksum of the file.
- `rowCount` and `format`.

A key with a site limit gets a report for its sites only. Iverto deletes the file after the report retention period of your organisation. The job then shows `result.expired: true`.

## Request signing

Request signing is optional. It makes your integration safer. A person who steals your API key cannot use it without your private key.

### Set up signing

1. Make a key pair on your server:

```bash
openssl genpkey -algorithm ed25519 -out private.pem
openssl pkey -in private.pem -pubout
```

2. Keep `private.pem` secret on your server.
3. Give the public key to an admin of your organisation.
4. The admin goes to **Settings → API & integrations**, edits the API key and pastes the public key.
5. Optional: the admin selects **Refuse unsigned requests**. Then the API refuses each request without a signature.

### Sign a request

Add these two headers to each request:

| Header | Value |
|---|---|
| `Iverto-Timestamp` | The current time in Unix seconds. |
| `Iverto-Signature` | The signature in base64 (see the steps below). |

Do these steps:

1. Get the method, for example `GET`.
2. Get the path. Use the part of the URL after `/att`, with the query string. Example: `/v1/public/punches?limit=50`.
3. Get the current time in Unix seconds.
4. Calculate SHA-256 of the exact body that you send. Write it in hexadecimal. For a request with no body, use an empty body.
5. Make the text `METHOD + "\n" + PATH + "\n" + TIMESTAMP + "\n" + BODY_HASH`.
6. Sign this text with your private key (Ed25519). Encode the signature in base64.

```js
// Node.js 18+
import { createHash, createPrivateKey, sign } from 'node:crypto';
const key = createPrivateKey(process.env.IVERTO_SIGNING_KEY_PEM);
function signedHeaders(method, path, body = '') {
  const ts = String(Math.floor(Date.now() / 1000));
  const text = `${method}\n${path}\n${ts}\n${createHash('sha256').update(body).digest('hex')}`;
  return { 'Iverto-Timestamp': ts, 'Iverto-Signature': sign(null, Buffer.from(text), key).toString('base64') };
}
// signedHeaders('GET', '/v1/public/punches?limit=50')
```

```python
# Python (cryptography)
import base64, hashlib, time
from cryptography.hazmat.primitives.serialization import load_pem_private_key
key = load_pem_private_key(open("private.pem", "rb").read(), password=None)
def signed_headers(method, path, body=b""):
    ts = str(int(time.time()))
    text = f"{method}\n{path}\n{ts}\n{hashlib.sha256(body).hexdigest()}".encode()
    return {"Iverto-Timestamp": ts, "Iverto-Signature": base64.b64encode(key.sign(text)).decode()}
# signed_headers("GET", "/v1/public/punches?limit=50")
```

Obey these rules:

- Make sure that your server clock is correct. The timestamp must be less than 5 minutes from the time of the Iverto server.
- The API accepts each signature one time only.
- Two identical requests in the same second have the same signature. The API refuses the second request. Do not send identical requests in the same second.

## Usage alerts

Iverto checks the use of your keys every hour. If Iverto finds a problem, it tells the admins of your organisation and the person who made the key. Iverto sends the alert in the app and by email.

| Alert | Iverto sends it when |
|---|---|
| Rate limited | The API refused requests because of the rate limit. |
| Daily quota | Your organisation used 80% or more of its daily quota. Iverto sets the percentage. |
| Credits | Your organisation used 80% or more of its monthly credits. |
| Key expiring | A key expires in 7 days or less. |
| Unused key | A key had no requests for 60 days. |
| Key disabled | Iverto disabled a key because it had no requests for 90 days. |
| Webhook failing | A webhook failed for more than 1 hour. |
| Error spike | The number of failed requests increased very much. |
| Unusual access | A key had many refused requests, or it came from a new IP address. |

- Iverto sends each alert one time per key per day or less.
- Admins can see the alerts in **Settings → API & integrations → Alerts**.
- Iverto also sends each alert as an `api.alert` event.
- An admin can enable a disabled key again. Nothing else about the key changes.

## Changelog

| Version | Changes |
|---|---|
| `2026-12-01` | First version. Organisation, employees, punches, attendance days and leave. Synchronization. Webhooks and the event log. Bulk employee updates and report jobs. Optional request signing. Usage alerts and the `api.alert` event. |

Iverto can add new fields, operations, event types and enum values at any time. These additions do not break your integration. Iverto makes a new version for each change that can break an integration. Iverto tells you before this change.

## Examples

Read the first 100 employees:

```bash
curl "https://ivertovm.indiasouthcentral.cloudapp.azure.com/att/v1/public/employees?limit=100" \
  -H "Authorization: Bearer $IVERTO_API_KEY"
```

Record a punch:

```bash
curl -X POST https://ivertovm.indiasouthcentral.cloudapp.azure.com/att/v1/public/punches \
  -H "Authorization: Bearer $IVERTO_API_KEY" \
  -H "Idempotency-Key: gate-7-2026-12-01T09:02:11Z-E104" \
  -H "Content-Type: application/json" \
  -d '{"employeeId":"cmw…","punchedAt":"2026-12-01T03:32:11Z","direction":"in","reason":"Gate 7 reader"}'
```
