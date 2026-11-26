# Iverto Public API — Architecture & Security Spec

Status: **Phases 1–2 core, webhooks, jobs, request signing, usage alerts and the in-app API reference implemented (pre-beta).** Everything in §3 ("one-way doors") must be settled before GA; after GA the public contract is frozen and changes follow §19. Integrator reference: [public-api-reference.md](public-api-reference.md).

### Implementation status (2026-11-25)

Built (`apps/api/src/public-api/`, migrations `20261125000000_public_api` + `20261126000000_webhooks` + `20261127000000_api_jobs` + `20261128000000_signing_alerts`, `post-init/007-public-api.sql` + `008-webhooks.sql` + `009-api-jobs.sql` + `010-api-alerts.sql`; UI in `apps/web/src/components/ApiAccess.tsx`):
- Key format, peppered HMAC with versioning, constant-time verify, dummy compare, checksum (§2).
- Registry, operation-level permissions, superadmin method ceiling, `API_KEY` principal that fails closed in role checks (§4–§5).
- Versioned per-tenant and platform-default policies with validation, preview, rollback, kill switch, revoke-all; approval queue (§5).
- Guard order per §6, Origin rejection, IP allowlists (key ∩ org), required Idempotency-Key with body fingerprint, problem+json errors.
- Redis Lua limiter (key + org + daily + concurrency, cost weights), IETF headers, bad-auth IP block, internal limiter moved to Redis (§7).
- Credits: monthly grant + top-ups, per-key caps, block/overage, refunds on 5xx/429/304, counters rebuilt from logs (§8).
- Request log via Redis Stream → batched insert, INSERT-only, retention via `api_purge` in the daily retention job; usage summaries (§9).
- Sync: `updated_at` triggers, tombstones, commit-lag-safe cap, signed cursors, ETag/304 (§11). `Employee.externalId`.
- v1 resources: me, sites, departments, employees, punches (read + record), attendance days, leave types/requests (read, approve, reject), leave balances.
- Org admin UI (Settings → API & integrations) and superadmin UI (Platform → Developer API, tenant → Developer API).
- Webhooks + event log (§10): trigger-based outbox, dispatcher + sender, Standard Webhooks signing with encrypted secrets and 24 h dual-signature rotation, SSRF-safe sender, retries per the schedule, 410 / 3-day auto-disable with admin notification, replay, manual retry, delivery log, policy checked at subscribe and delivery time, `GET /v1/events`. Org UI in Settings → API & integrations; superadmin toggle + max endpoints in the policy editor, endpoint list + disable on the tenant page.
- Jobs (§12): `ApiJob` resource, `GET /jobs` + `/jobs/:id`, `job.completed`; bulk employee upsert through the CSV import's validator and the same employee create/update (validateOnly, onInvalid, externalId matching, managers, per-row results, 100-row checkpoints with lease-based resume, key re-checked per chunk); report jobs over the existing report queue with a 15-minute download URL minted per GET. New permissions `employees:write`, `reports:generate` (module `reports`); policy `bulk` limits in the superadmin editor.
- Tests: `src/public-api/public-api.spec.ts` (keys, policy, cursors, registry ↔ routes, webhook signing vector, secret encryption, SSRF ranges, bulk record checks) and `test/e2e-public-api.mjs` + `test/e2e-webhooks.mjs` + `test/e2e-jobs.mjs` (end-to-end, run after `test/restart-stack.mjs`). Data safety: `test/e2e-module-toggles.mjs` (HR / payroll / API modules off and on, keys revoked, webhooks disabled: every business table byte-identical) and `test/upgrade-rehearsal.sh <last prod migration> <prod ref>` (a production-shaped DB upgraded with exactly the deploy steps: every pre-existing row and column unchanged) — run both before each deploy.

Deviations: the public API runs **in the main process** (the VM has ~900 MB; a second Node process doesn't fit). It shares nothing process-specific, so it can move to `main-public.ts` later without changing a URL; until then isolation comes from the org concurrency cap and limiter. App path is `/v1/public/*`; Caddy maps `api.iverto.ai/v1/*` onto it. `ApiRequestLog` is a plain indexed table with retention deletes (partition when volume needs it); `ApiUsageHourly` is not built — usage is aggregated from the log. A key's leave approval counts as a manager's (types that need HR approval still wait for HR).

Webhook deviations from §10: events are written by **database triggers** (`post-init/008-webhooks.sql`), not an `event` option on `AuditableActionService` — every writer (terminal ingest, raw-SQL recompute, mobile, API) is covered without having to remember, still in the same transaction. Events are only recorded for tenants with an active key or a webhook endpoint. Delivery is a Postgres queue (`FOR UPDATE SKIP LOCKED` + leases) polled every second rather than BullMQ, and the 5-in-flight cap is per instance. A `WebhookDelivery` row holds the latest attempt (status, code, 1 KB snippet, latency, error) and the attempt count, not one row per attempt. Replay runs inline (≤ 10,000 events) rather than as a Job. `data.object` matches the resource's `object` (`leave_request`, `attendance_day`), and leave decisions carry `status`. Not yet emitted: `payroll.run.locked`, `job.completed`, `api.alert` (their features don't exist yet). Policy preview doesn't count affected endpoints yet.

Jobs deviations from §12: `atomic` is `onInvalid: "reject"` — if any record fails validation nothing is written; it is not one database transaction, so a record that fails while saving (rare: a concurrent duplicate) doesn't roll back the others. Rows add a `skipped` status (valid rows not applied under reject). Bulk costs a flat 10 rate-limit tokens / credits per request, not 1 per record (the policy's `costs` can raise it). Bulk jobs run in-process, one at a time per process, from a Postgres lease (not BullMQ). Report files stay in Supabase Storage (signed URL, 15 min), not Azure Blob; only the built-in report types are public, tenant templates are not. Salary columns are not accepted by bulk upsert (no payroll resources yet).

- Request signing (§2): Ed25519 public key per API key (`public-api/signing.ts`), optional or required per key, ±5 min, replay cache on the signature; raw body via Nest `rawBody`.
- Usage alerts & key hygiene (§15): hourly `api-alerts` cron (`public-api/alerts.ts`) for rate limiting, quota, credits, expiring and unused keys, failing webhooks, error spikes and auth anomalies; stored in `api_alerts` (also the 24 h throttle), in-app + email to admins and the key's creator, `api.alert` event; unused keys auto-DISABLED and audited; thresholds in the policy's `alerts`; daily digest email to platform admins; `POST /platform/api/alerts/run`.
- Developer portal (§14), in-app: the OpenAPI document is generated from the registry (`public-api/openapi.ts`; a test fails when an operation lacks docs or a serializer field differs from its schema, and a committed jest snapshot is the contract snapshot). The web app renders it with Redoc at `/developers` (org admins) and `/platform/developers` (superadmins), with this repo's `public-api-reference.md` as the guide and a JSON download for Postman.

Sandbox & test keys (§13) were built and then deferred to a later release: the implementation is kept in `docs/future/sandbox/`. `ivk_test_` keys are refused until then.

Deviations from §14: no separate `developers.iverto.ai` site and no public docs; the reference lives in the app, for org admins and superadmins only. No try-it console (it needs test keys).

Not built yet: sandbox + test keys (§13, parked in docs/future/sandbox), HR/payroll resources.

Goal: let third-party developers integrate with attendance, leave, HR and payroll data through a stable, secure, server-to-server API. Every org gets the same features (no pricing tiers). Superadmins set the ceiling per org; org admins grant per-key permissions within it.

---

## 1. Principles

1. **The contract is the only thing that's frozen.** URLs, field names, ID formats, key format, permission names, error, event and job formats. Internals stay changeable because they sit behind a separate public layer.
2. **Fail closed.** Unknown principal, unregistered route, missing permission, unknown policy, sandbox side effect → deny.
3. **Ceiling, not copy.** Effective permissions are computed per request (`key ∩ tenant policy ∩ tenant features`), never stored, so tightening a policy bites immediately.
4. **Blast-radius isolation.** Public API traffic can never degrade terminals, mobile or the web app.
5. **Push over poll.** Webhooks + incremental sync keep integrators off the rate limiter.
6. **Beta before freeze.** 60–90 day design-partner beta (2–3 customers, written "v1-beta may change" terms), then GA.

---

## 2. Authentication

| Option | Decision |
|---|---|
| **API keys** (opaque, prefixed, peppered hash) | **v1.** Industry standard for B2B server-to-server (Stripe, Twilio). Simple, instantly revocable, scopable. |
| Ed25519 request signing | **Optional per key / requirable per org.** Customer registers a public key; server stores no secret. |
| OAuth2 client credentials | Later, additive. Same keys exchanged for 15-min JWTs (`jose` is installed). |
| OAuth2 authorization code + PKCE | Later, only for apps acting *as an employee* (e.g. chat bots). |
| Supabase user JWTs | No — those are human sessions with MFA/password state. |
| mTLS | No — too much operational work for customers. |

### Key format

```
ivk_{live|test}_{keyId}_{secret}{crc32}
```

- `keyId` — 12 random chars, plaintext, unique index (lookup).
- `secret` — 32 random bytes, base64url. Shown **once**.
- `crc32` — checksum; malformed keys rejected before any DB hit; keeps secret-scanner false positives low.
- Stored as `HMAC-SHA256(pepper[pepperVersion], secret)`, compared with `timingSafeEqual`. Columns `hashAlgo` + `pepperVersion` allow pepper rotation / algorithm change without reissuing keys.
- Not bcrypt/argon2: a 256-bit random secret can't be brute-forced; a slow hash adds 50–100 ms per request.
- Pepper lives in **Azure Key Vault**, never `.env`. A DB dump alone can't verify keys.
- On unknown `keyId`, compute a dummy HMAC anyway so timing doesn't reveal key existence.
- Accepted **only** in `Authorization: Bearer`. Keys in query strings are rejected (URLs end up in logs).
- `ivk_test_` keys resolve only to sandbox tenants, `ivk_live_` only to live tenants (§13).
- Prefix will be registered with GitHub secret scanning → never change it.

### Request signing (optional)

`Ed25519( method + "\n" + path + "\n" + timestamp + "\n" + sha256(body) )`, sent as `Iverto-Signature` + `Iverto-Timestamp`. ±5 min skew, replay cache keyed on the signature. (HMAC with the API key secret is impossible — the server only holds its hash.)

---

## 3. One-way doors (freeze before GA)

| Decision | Choice | Why |
|---|---|---|
| Base URL | `https://api.iverto.ai/v1/...` | Own host → can move/scale without touching customers. |
| Versioning | URL major + `Iverto-Version: YYYY-MM-DD` header **pinned to each key at creation** | Future breaking changes can apply to new keys only. Free on day one, impossible to retrofit cleanly. |
| Key format | §2 | Secret-scanner registration locks it in. |
| Permission IDs | `resource:action` strings from the registry; never renamed, only deprecated/aliased | Customers hard-code them. |
| IDs | Opaque strings, ≤ 64 chars | Keeps the ID scheme (cuid today) changeable. |
| External IDs | `externalId` on employees (≤ 128 chars, unique per tenant) | Integrators map their own system's ids; can't be bolted on after they've built around `employeeCode`. |
| Pagination | **Cursor only**: `limit` (max 200), `next_cursor` (signed, opaque). No offsets. | Offsets break under concurrent writes; can't be removed later. |
| Incremental sync | `updated_since` + **tombstones** (`deleted: true`), **at-least-once** (a row may repeat; clients upsert by `id`) | Without tombstones, sync clients never learn about deletes; at-least-once must be promised from day one (§11). |
| Timestamps | RFC 3339 UTC (`Z`). Business dates `YYYY-MM-DD` + site IANA `timezone`. | An attendance day is a local date, not an instant. |
| Money | Integer **paise** + `currency: "INR"` | Matches DB (`ExpenseClaim.amount`, `EmployeeSalary.monthlyGross`). Never floats. |
| Leave quantities | Decimal **strings** (`"1.5"`) | DB is `Decimal(5,1)`; JSON floats lose precision. |
| Field casing | camelCase (matches mobile API) | Pick once. |
| Nulls | Every documented field always present; `null`, never omitted | No "missing vs null" ambiguity. |
| Enums | Documented as **open** — clients must tolerate unknown values | New statuses stay non-breaking. |
| Errors | RFC 9457 `application/problem+json`, stable machine `code` | Codes are contract; messages aren't. |
| Idempotency | `Idempotency-Key` **required on every POST** (24 h). Same key + different body → 422. | Can't be made required later. |
| Rate-limit headers | IETF `RateLimit` / `RateLimit-Policy` + `Retry-After` | Standard; client libraries understand it. |
| Webhooks | [Standard Webhooks](https://www.standardwebhooks.com/) (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,...`, HMAC-SHA256); at-least-once, unordered, **thin events** | Avoids stale data/PII in payloads and a second payload contract. |
| Event names | `resource.verb` past tense (`leave.request.decided`); never renamed, only added | Customers route on them. |
| Async work | One `Job` resource for all async operations (§12); bulk = **per-row partial success** by default | Every future async feature reuses the same shape. |
| Limits wording | Docs say limits "may be adjusted with notice" | Keeps limits a two-way door. |

---

## 4. Structure

### Separate public layer (not decorators on internal controllers)

Internal handlers return raw Prisma rows (e.g. [leave.ts:749](../apps/api/src/leave/leave.ts) returns `leaveType.findMany(...)`), so any new column would leak into a public response and become contract. Internal pagination is also mixed (`page` vs `cursor`). Therefore:

```
apps/api/src/
  main-public.ts                 // second entry point, own port
  public-api/
    public-app.module.ts
    registry.ts                  // every operation: id, method, path, permission, cost, sensitive, piiFields, deprecated
    auth.guard.ts                // key auth + optional Ed25519 check
    limiter.ts + limiter.lua     // Redis token buckets
    log.ts                       // request-log hook → Redis Stream
    v1/<resource>.controller.ts  // thin; calls existing services
    v1/<resource>.serializer.ts  // explicit field allowlist per resource
    events/                      // outbox emit helper, dispatcher, event log endpoint
    webhooks/                    // delivery worker, SSRF-safe sender, Standard Webhooks signer
    jobs/                        // Job resource, bulk upsert worker, report job bridge
    sandbox/                     // seeding, reset, simulation endpoints
    alerts.ts                    // hourly usage alerts + stale-key job
  api-admin/                     // on the internal app: org-admin key/webhook mgmt, platform policy, approvals, logs
```

- Public controllers own request DTOs and response serializers; business logic stays in existing services.
- Only routes in `registry.ts` are routable on the public process. Registry also drives docs, permission catalogue, cost table, event catalogue, tests and deprecations.

### Separate process

Public API runs as its own Node process (`main-public.ts`), own port, own `api.` host in Caddy, own memory cap and **own small DB connection pool**. Same codebase. A customer hammering reports can't slow M50 punches or the web app, and the Azure box's memory pressure stays bounded per process. Webhook delivery and job workers run in the existing BullMQ worker setup, not in the request process.

### Distinct principal

`AuthUser.kind = 'user' | 'api_key'` with `apiKey: { id, tenantId, siteIds, scopes, ... }`. Not a stand-in ADMIN: there are ~47 `ADMIN`/`isHrOrAdmin` checks in services that would silently grant shortcuts (`assertNotSelf`, approvals).

- `ScopeService.employeeWhere` gets an explicit `api_key` branch: whole tenant ∩ `siteIds`.
- Any service path receiving an `api_key` principal it doesn't explicitly handle **throws** (fail closed).
- RLS context: `tenantId`, `siteIds`, `userId = 'apikey:<id>'`, `isSuperAdmin = false`.
- `AuditActor.type` gains `'api_key'` + `keyId`; writes via the API land in `AuditLog` with the key as actor.

### Cache invalidation

`forgetTenant()` in [jwt-auth.guard.ts](../apps/api/src/auth/jwt-auth.guard.ts) only clears the local instance's map. With a second process, a suspended tenant's keys would work for up to 60 s. All caches (tenant status, policy, key) invalidate via **Redis pub/sub**, TTL kept as backstop (key cache 30 s).

---

## 5. Permission model

```
Platform defaults (superadmin, global)
  └─ Tenant API policy (superadmin, per org)        ← ceiling
       └─ API key permissions (org admin, per key)  ← ⊆ ceiling
Effective = key ∩ tenant policy ∩ tenant features (hr / payroll)
```

- **Operation-level permissions** from the registry, e.g. `leave.requests:read`, `leave.requests:write`, `leave.requests:approve`, `payroll.runs:approve`, `employees:bulk_write`, `pii:read`.
- **Superadmin HTTP-method filter** (GET / POST / PATCH / DELETE per module) sits on top as a coarse ceiling ("no DELETE for this org" in one click).
- Keys exceeding a tightened policy are clipped at runtime and badged "restricted by platform policy" in the org admin UI.
- Ceiling is enforced **server-side** on every key and webhook-endpoint create/edit, not just in the UI.

### Modules

| Module | Covers | Tenant feature gate |
|---|---|---|
| `org` | sites, departments, projects, holiday calendars, attendance policies | — |
| `employees` | employees, profile requests, bulk upsert | — |
| `punches` | punches | — |
| `attendance` | attendance days, corrections | — |
| `schedule` | shifts, shift patterns, roster | — |
| `leave` | leave types, requests, balances | — |
| `remote` | remote-work requests & punches | — |
| `field_visits` | field visits | — |
| `hr` | documents, letters, assets, expenses, announcements, checklists | `hr` |
| `payroll` | salaries, runs, payslips | `payroll` |
| `reports` | report jobs | — |
| `terminals` | read-only device status | — |
| `events` / `jobs` | event log, async jobs | — (filtered by the resource permission behind each item) |

Never exposed: `platform/*`, `users`/`auth`, `mobile/*`, `live`, `audit-logs`, terminal provisioning.

### Superadmin policy (per tenant, falls back to platform default)

```ts
{
  enabled: boolean,
  modules: { attendance: ['GET'], leave: ['GET','POST','PATCH'], payroll: [], ... }, // method ceiling
  operations?: string[],                    // optional finer allow-list
  approvalRequired: ['payroll.*', 'employees:delete', 'employees:bulk_write'],
  piiAllowed: boolean,
  maxKeys: 10,
  maxKeyLifetimeDays: 365 | null,
  requireIpAllowlist: boolean,
  requireSignedWrites: boolean,
  orgIpAllowlist: string[],                 // CIDRs
  rateLimit: { perMinute: 600, burst: 100, perDay: 200_000, concurrency: 20 },   // whole org
  keyRateCeiling: { perMinute: 300 },
  piiDailyRecordCeiling?: number,           // per key
  credits: {
    enabled: false, monthlyGrant: 100_000, rollover: false,
    onExhausted: 'block' | 'allow_overage',
    costs: { default: 1, 'reports:write': 25, 'employees:bulk_write': 1 /* per record */ },
  },
  webhooks: { enabled: true, maxEndpoints: 10 },
  bulk: { maxRecordsPerRequest: 1000, concurrentJobs: 1 },
  sandbox: { enabled: true },
  hygiene: { staleWarnDays: 60, staleDisableDays: 90, expiryWarnDays: [7, 1] },
  alerts: { rateLimitPressurePct: 80, quotaPct: [80, 100], creditPct: [80, 100], errorSpikeFactor: 5 },
  logging: { retentionDays: 90, captureBodies: 'none' | 'errors' | 'all_redacted' },  // logging itself can't be disabled
}
```

Plus: **global kill switch** and per-tenant **revoke-all**.

Policies are **versioned** (append-only `ApiPolicyVersion`), schema-validated, **previewed before save** ("restricts 4 keys and 1 webhook endpoint in 2 orgs"), audited, one-click rollback.

### Org admin (per key)

Name, description, purpose, integrator name, environment (`live`/`test`), permissions ⊆ policy, `siteIds`, IP allowlist (CIDR), rate limit ≤ ceiling, monthly credit cap, expiry ≤ lifetime, PII toggle (if allowed), optional Ed25519 public key, rotate (overlap window) / revoke / re-enable (if `DISABLED`).

Rules:
- Key and webhook management is **ADMIN-only** and needs an `aal2` session (already true for all web routes).
- A superadmin using the `X-Tenant-Id` override **cannot create tenant keys or webhook endpoints** (no hidden backdoors).
- Keys belong to the org; keys created by a deactivated admin are flagged for ownership transfer.
- Stale and expiring keys are handled by §15.

---

## 6. Request flow (public process)

1. Parse `Bearer ivk_...`; verify checksum; look up `keyId` (cache → DB); constant-time hash compare (dummy compare on miss).
2. Reject revoked / disabled / expired / `PENDING_APPROVAL`; reject environment ↔ tenant-kind mismatch (`test` ↔ `SANDBOX`). `X-Tenant-Id` ignored.
3. Tenant `ACTIVE`, `policy.enabled`, global kill switch.
4. Operation must be in the registry; tenant feature on; permission in `key ∩ policy`; method allowed.
5. Reject if `Origin` header present (server-to-server only) — **sole exception**: `Origin: https://developers.iverto.ai` with an `ivk_test_` key (portal try-it, §14). Require `application/json`.
6. IP ∈ key allowlist ∩ org allowlist. Ed25519 signature if required.
7. Rate limit (§7) → credits reserve (§8) → idempotency check.
8. Handler with `api_key` principal inside RLS context; DB statement timeout.
9. Serialize → compute `ETag`; if it matches `If-None-Match` → `304`, credits refunded (§11).
10. `onResponse`: enqueue log row, settle credits (refund on 5xx/429/304), throttled `lastUsedAt` update (≤ 1/min via Redis). Deprecated operations add `Deprecation` / `Sunset` / `Link` headers (§14).

All responses: `X-Request-Id`, rate-limit headers, `X-Credits-Remaining` (if credits on). `GET` responses: `Cache-Control: private, no-cache` + `ETag` (revalidate every time, never stored by shared caches); everything else `no-store`.

---

## 7. Rate limiting

**Fix first:** [main.ts](../apps/api/src/main.ts) uses `@fastify/rate-limit` with the default **in-memory** store (limits multiply by instance count) keyed on the last 64 chars of `Authorization`. Move it to the Redis store. The public process uses the limiter below.

| Layer | Key | Purpose |
|---|---|---|
| Bad-auth guard | IP | > 20 invalid keys/min → IP blocked 15 min |
| Per key | `keyId` | Org admin setting ≤ platform ceiling |
| Per org | `tenantId` | Sum of all keys; superadmin setting |
| Daily quota | `tenantId` | `perDay` |
| Concurrency | `tenantId` | In-flight cap; protects heavy endpoints |
| Cost weight | operation | e.g. report job = 25 tokens, bulk = 1 per record, GET = 1 |

**Algorithm:** token bucket in one Redis Lua script that checks key and org buckets **atomically** — an org-rejected request doesn't consume key tokens; correct across instances. `ioredis.defineCommand`, no new dependency.

**Response:** `429` + `Retry-After`; IETF `RateLimit` / `RateLimit-Policy` on every response. `304` responses still cost 1 token (the query still runs) but no credits.

Also: `limit` ≤ 200, date-range cap (e.g. 93 days) on attendance/punch queries, 1 MB body limit, reports and bulk always async via BullMQ.

---

## 8. Credits (optional, per tenant)

- Hot path: Redis `DECRBY credits:<tenant> cost` reserve before handler; refund on 5xx/429/304. Other 4xx still charged (no free validation abuse).
- Webhook deliveries and event-log reads are free (they replace polling).
- `ApiCreditLedger`: grants, top-ups, monthly resets, expiry, **hourly** charge rollups (not a row per request; per-request charge is in `ApiRequestLog.creditsCharged`).
- Exhausted → `402 CREDITS_EXHAUSTED` or overage per `onExhausted`.
- Sandbox tenants are never charged.
- Alerts per §15.

---

## 9. Logging

Not in `AuditLog` (volume). Two tables:

- **`ApiRequestLog`** — monthly partitions on `created_at`. Fields: `requestId` (unique), tenant, key, operationId, apiVersion, method, route template (`/leave/requests/:id`), status, error code, latency, req/res bytes, IP, user agent, credits charged, rate-limit decision, `notModified`. Bodies only per `captureBodies`, PII-redacted. **Never** the `Authorization` header or any key material.
- **`ApiUsageHourly`** — (tenant, key, operation, hour) → count, errors, p95, credits. Dashboards and alerts read this, never raw logs.

Write path: `onResponse` → Redis Stream (consumer group + ack) → BullMQ worker batch-inserts every 2 s. Redis down → synchronous DB insert. Never dropped; duplicates removed by `requestId`.

Integrity: app DB role has **INSERT-only** on `api_request_logs`; partition drops run under a separate maintenance role; nightly retention job drops partitions older than `retentionDays` (sandbox: 7 days).

Visibility:
- Org admin: own tenant logs, filters (key / status / operation), usage charts, CSV export, live tail via existing Socket.IO `LiveGateway`, webhook delivery log (§10).
- Superadmin: all tenants, top consumers, error-rate outliers, credit burn.
- Key / webhook-endpoint lifecycle and policy changes → `AuditLog`.

---

## 10. Webhooks & events

### Event catalogue (initial)

| Event | Emitted when |
|---|---|
| `punch.created` | a punch is stored (terminal, mobile, remote or API) |
| `attendance.day.finalized` | the day closes after the site's day boundary — once per employee/date |
| `attendance.day.updated` | a finalized day changes (correction, recompute) |
| `leave.request.created` | a leave request is submitted |
| `leave.request.decided` | approved, rejected or cancelled (`data.decision`) |
| `payroll.run.locked` | a payroll run is approved/locked |
| `employee.created` / `employee.updated` / `employee.exited` | employee lifecycle |
| `job.completed` | a bulk or report job reaches a terminal status (§12) |
| `api.alert` | a usage alert fires (§15) |
| `ping` | the "send test event" button |

Events live in the registry; each declares the read permission needed to receive it (e.g. `payroll.run.locked` → `payroll.runs:read` + `payroll` feature).

### Envelope (thin)

```json
{
  "id": "evt_…",
  "type": "leave.request.decided",
  "createdAt": "2026-12-01T09:30:00Z",
  "apiVersion": "2026-12-01",
  "data": { "object": "leave.request", "id": "…", "employeeId": "…", "decision": "APPROVED" }
}
```

Consumers fetch the full object with their API key. Payloads never carry PII beyond ids.

### Reliability

- **Transactional outbox:** events are inserted into `ApiEvent` in the **same DB transaction** as the change — `AuditableActionService.run` gains an optional `event`, and an `emitEvent(tx, …)` helper covers paths outside it (terminal punch ingest, `recompute.service.ts`, day close in `jobs.ts`). No event without a committed change; no committed change without an event.
- **Dispatcher** (BullMQ) picks undispatched `ApiEvent` rows, fans out to matching endpoints → one `WebhookDelivery` row + job per endpoint. Crash-safe: anything with `dispatchedAt IS NULL` is picked up on restart.
- **Retries**, exponential backoff with jitter: immediate, 5 s, 30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 6 h, 12 h, 24 h (11 attempts ≈ 2 days). Success = 2xx within 10 s. `410 Gone` disables the endpoint immediately.
- **Auto-disable** an endpoint after 3 days of continuous failure → email org admins. Re-enabling offers to replay the missed window.
- **Per-endpoint concurrency cap** (5 in flight) so we never flood a customer's server. Ordering isn't guaranteed; consumers use `createdAt` or fetch the latest object.
- **Event log API:** `GET /v1/events?type=&starting_after=` (cursor, 30-day retention) — consumers recover anything missed without asking us to replay.
- **Delivery log:** every attempt (status, latency, response code, first 1 KB of response body stored as text, never parsed), retained 30 days, visible to org admins.
- **Replay:** one delivery, or every event for an endpoint in a time range (runs as a Job). Replays keep the original `webhook-id` so consumers dedupe.

### Security

- Standard Webhooks HMAC-SHA256; `whsec_…` secret generated by us, shown once, **encrypted at rest** (key in Key Vault — must be readable to sign).
- **Rotation:** new secret signs immediately; the old one also signs for 24 h (`webhook-signature` carries both, space-separated, per the spec).
- HTTPS only; SSRF controls per §16 (API7).
- Subscriptions are checked against the policy at create time **and at delivery time** — a tightened policy stops deliveries immediately.

---

## 11. Incremental sync & caching

**Synced resources:** employees, sites, departments, punches, attendance days, leave requests, leave balances, payslips, expenses.

**Schema prerequisite:** only 8 models have `updatedAt` today (Employee, Asset, AttendancePolicy, LetterTemplate, ReportTemplate, SalaryStructure, TerminalUser, TerminalFaceTemplate). `Punch`, `AttendanceDay`, `LeaveRequest`, `Site`, `Department` and others don't. Every synced table gets `updated_at`, maintained by a **Postgres `BEFORE INSERT OR UPDATE` trigger, not Prisma `@updatedAt`** — `recompute.service.ts` writes via raw SQL, which `@updatedAt` never sees. Index `(tenant_id, updated_at, id)`.

**Tombstones:** an `AFTER DELETE` trigger on every synced table writes `deleted_records(tenant_id, resource, record_id, deleted_at)`. Triggers catch every path (Prisma, raw SQL, cascades). Sync results include `{ id, deleted: true, deletedAt }`. Retained 90 days; a cursor older than that → `410 SYNC_CURSOR_EXPIRED` (client does a full resync).

**Cursor:** `GET /v1/punches?updated_since=2026-12-01T00:00:00Z` → ordered by `(updated_at, id)`; `next_cursor` encodes both, so rows sharing a timestamp are never skipped.

**Commit-lag safety:** the trigger stamps `updated_at = now()` (transaction start). A long transaction can commit *after* the cursor has passed its timestamp. So results are capped at the **start time of the oldest still-running write transaction** (from `pg_stat_activity`, cached 1 s; fallback cap `now() − 5 min`). Any row a running transaction will commit has `updated_at ≥` that cap, so it can't land behind a cursor. Still documented as at-least-once.

**ETag / 304:** `ETag` = hash of the serialized response (single resources and list pages). `If-None-Match` match → `304`, **no credit charge**, 1 rate-limit token. Single resources also send `Last-Modified`.

---

## 12. Bulk & async jobs

### `Job` resource (one shape for all async work)

```json
{
  "id": "…", "object": "job", "type": "employees.bulk_upsert | report",
  "status": "queued | running | succeeded | partially_succeeded | failed",
  "progress": { "processed": 400, "total": 1000 },
  "result": { … }, "error": null,
  "createdAt": "…", "startedAt": "…", "completedAt": "…", "expiresAt": "…"
}
```

`GET /v1/jobs/:id`, `GET /v1/jobs` (cursor), `job.completed` webhook. Only visible with the permission behind the job type. Retained 30 days. Internal statuses (e.g. `ReportJob.status` `READY`) map through the serializer, so internals stay changeable.

### Bulk employee upsert

- `POST /v1/employees/bulk` → `202 Accepted` + Job. Up to `bulk.maxRecordsPerRequest` (default 1,000) per request; `Idempotency-Key` required.
- Match key per record: `employeeCode` (unique per tenant, same as CSV import) or `externalId`.
- **Same validation and apply logic as CSV import** ([import.ts](../apps/api/src/employees/import.ts)) — one code path, one set of rules.
- Result per row by index: `{ index, status: created | updated | unchanged | failed, id, errors[] }`.
- `validateOnly: true` → dry run, nothing written. `atomic: true` → all-or-nothing; default is partial success.
- Processed in chunks of 100 with a progress checkpoint; a crashed worker resumes from the last checkpoint (upsert is idempotent, so reprocessing a chunk is safe).
- `bulk.concurrentJobs` per tenant (default 1); credits and rate-limit weight = 1 per record.
- Writes are audited per row with the key as actor; each change emits `employee.created` / `employee.updated`.

### Report jobs

- `POST /v1/reports` `{ type, format, filters }` → creates a `ReportJob` under the key's scope (`siteIds`) → Job. Only report types listed in the registry are exposed.
- Result: `{ downloadUrl, sha256, rowCount, urlExpiresAt }`. `downloadUrl` is a **15-minute Azure Blob SAS URL generated on each GET**, never stored. Files follow the tenant's `reportRetentionDays`.

---

## 13. Sandbox & test keys

- Each org gets its **own sandbox tenant**, provisioned on first test key: `Tenant.kind = 'SANDBOX'`, `parentTenantId`. Separate tenant = RLS isolation for free; no shared sandbox where developers see each other's data.
- **Seeded** by a seed script reusing tenant provisioning (`platform/tenant-defaults.ts`): 3 sites, ~50 employees, 60 days of punches and attendance, leave requests in every state, a locked payroll run if the parent has payroll.
- `ivk_test_` keys only resolve to `SANDBOX` tenants and `ivk_live_` only to `LIVE` — checked at key creation **and** in the guard.
- **Side effects suppressed, fail-closed:** mail, push (FCM), in-app notifications and terminal commands refuse `SANDBOX` tenants at their single entry points. Webhooks **do** fire — that's what developers are testing.
- **Simulation endpoints** (sandbox only): `POST /v1/sandbox/punches` (simulated terminal punch), `POST /v1/sandbox/attendance/close-day` (finalize a day now), `POST /v1/sandbox/reset` (wipe and re-seed).
- Same permission ceiling as the parent org (developers can't build against permissions they won't get live); lower rate limits; no credits; logs kept 7 days; excluded from platform stats.
- Purged when the parent org's API access is disabled.

---

## 14. Developer portal

- Static site at `developers.iverto.ai`, built in CI from the registry-generated OpenAPI (Scalar or Redoc — static HTML, no server). No login; keys are managed inside the Iverto app.
- **Postman:** "Import into Postman" links straight to `openapi.json` (Postman imports OpenAPI 3 natively) — no hand-maintained collection to drift.
- **Try-it:** runs from the browser against the API with **test keys only** (the single `Origin` exception in §6). Live keys from a browser are always rejected.
- **Changelog:** `CHANGELOG.md` per API version; CI fails if the contract-snapshot diff has no matching changelog entry.
- **Guides:** auth, pagination & sync, webhooks + signature verification (samples in Node, Python, PHP, Java, C#), idempotency, errors, rate limits, bulk & jobs, sandbox.
- **Deprecation / Sunset:** registry `deprecated: { since, sunset, replacement }` automatically adds `Deprecation` (RFC 9745), `Sunset` (RFC 8594) and `Link: <guide>; rel="deprecation"` headers; the portal marks the operation; §19 notification emails.
- Links to the status page and `security.txt`.

---

## 15. Usage alerts & key hygiene

Hourly BullMQ job over `ApiUsageHourly`, `ApiKey` and `WebhookEndpoint`:

| Alert | Trigger |
|---|---|
| Rate-limit pressure | org > `rateLimitPressurePct` of its per-minute limit for 15 min, or any 429s |
| Daily quota | `quotaPct` thresholds (80 / 100%) |
| Credits | `creditPct` thresholds (80 / 100%) |
| Key expiring | `expiryWarnDays` (7 and 1 days) |
| Key stale | unused `staleWarnDays` (60) → warning; `staleDisableDays` (90) → **auto-`DISABLED`** |
| Webhook failing | endpoint failing > 1 h; auto-disabled (§10) |
| Error spike | 4xx/5xx rate > `errorSpikeFactor` × 7-day baseline |
| Auth anomaly | 401 storm on a key; new IP/country for a key without an allowlist |

- **Channels:** in-app notification + email to org admins and the key owner; optional `api.alert` webhook event. Superadmin gets a daily cross-tenant digest.
- **Throttled:** one alert per type per key per 24 h (Redis `SET NX` with TTL).
- `DISABLED` ≠ `REVOKED`: an admin can re-enable a disabled key; revoked is permanent.
- Thresholds live in the superadmin policy (`hygiene`, `alerts`, §5).

---

## 16. Security — OWASP API Top 10 (2023)

| Risk | Control |
|---|---|
| API1 Object-level authz | RLS + tenant/site-scoped queries in every public path; 404 (not 403) outside scope; generated cross-tenant tests per operation. |
| API2 Authentication | §2: 256-bit secrets, peppered HMAC, constant time, dummy compare, bad-auth IP throttle, expiry, pub/sub revocation, test/live separation. |
| API3 Property-level authz | Whitelist request DTOs (global `ValidationPipe`); **explicit response serializers** — no Prisma object reaches a response; PII fields only with `pii:read`; thin webhook payloads. |
| API4 Resource consumption | §7 limits, concurrency, cost weights, page/date-range caps, body limit, statement timeout, async reports and bulk, one bulk job per tenant. |
| API5 Function-level authz | Operation permissions from the registry; unregistered = unroutable. |
| API6 Sensitive business flows | `sensitive` operations (payroll, deletes, bulk writes) need superadmin-approved keys; soft deletes; payroll lock rules apply as on web. |
| API7 SSRF (webhooks) | HTTPS only; resolve DNS, block private / loopback / link-local / `169.254.169.254`, connect to the checked IP (no DNS rebinding); no redirects; 10 s timeout; response size cap. |
| API8 Misconfiguration | `private, no-cache` / `no-store`, Origin rejection, CORS off on `api.` (except portal + test keys), JSON-only, TLS 1.2+ at Caddy, Swagger off internally, static public docs. |
| API9 Inventory | Registry is the inventory; public process only mounts `v1` controllers. |
| API10 Unsafe consumption | Webhook responses never parsed. |

Additional:
- **Secrets:** pepper + webhook-secret encryption key in Azure Key Vault.
- **Log hygiene test:** fails if any full key string appears in a log row.
- **Insider:** no superadmin-minted tenant keys or webhook endpoints; superadmin can't disable request logging.
- **Sandbox containment:** side-effect entry points refuse sandbox tenants; test keys can never reach live data.
- **DPDP Act:** per-key purpose + integrator name; per-key access logs answer "which third party accessed this data"; optional daily PII record ceiling per key.
- **Leak response:** global kill switch, per-tenant revoke-all, written runbook, `security.txt` + responsible-disclosure address.

---

## 17. Failure modes

| Failure | Behaviour |
|---|---|
| Redis down — limiter | Pass through with conservative per-process in-memory cap + alert |
| Redis down — credits | Writes `503`; reads small local allowance; reconcile from logs |
| Redis down — key cache | DB lookups; revocation still effective |
| Redis down — logs | Synchronous DB insert; never dropped |
| Log worker backlog | Stream consumer group + ack; alert at 60 s lag |
| DB slow | Statement timeout → `503` + `Retry-After`; public pool can't starve internal processes |
| One customer flooding | Org bucket + concurrency absorb it; other orgs and internal app unaffected |
| Customer webhook endpoint down | Retries for ~2 days → auto-disable + email; events recoverable via event log API for 30 days |
| Webhook dispatcher crash | Outbox rows with `dispatchedAt IS NULL` dispatched on restart; at-least-once |
| Bulk worker crash | Resumes from last 100-record checkpoint; idempotent upsert |
| Long-running write transaction | Sync cap holds the cursor back until it commits (§11) |
| Sync cursor older than tombstone retention | `410 SYNC_CURSOR_EXPIRED` → client full resync |
| Sandbox side effect attempted | Entry point refuses (fail closed) and logs |
| Bad policy push | Versioned, validated, previewed, one-click rollback |
| Deploy | Graceful drain (`enableShutdownHooks`); public process deploys independently |
| Multiple instances | All state in Redis / Postgres |
| Clock skew | ±5 min on signed requests; NTP on host |

---

## 18. Data model

| Model | Key fields |
|---|---|
| `ApiKey` | `id, tenantId, keyId @unique, secretHash, hashAlgo, pepperVersion, last4, name, description, purpose, integratorName, environment, apiVersion, scopes Json, siteIds String[], ipAllowlist String[], rateLimitPerMin?, creditCap?, piiAccess, signingPublicKey?, status (PENDING_APPROVAL\|ACTIVE\|DISABLED\|REVOKED), expiresAt?, graceUntil?, rotatedFromId?, lastUsedAt?, lastUsedIp?, createdBy, revokedBy?, createdAt` |
| `ApiPolicyVersion` | append-only; `tenantId?` (null = platform default), `version`, `policy Json`, `createdBy`, `createdAt`; latest row is active |
| `ApiRequestLog` | partitioned monthly; INSERT-only grant; fields per §9 |
| `ApiUsageHourly` | `(tenantId, keyId, operationId, hour)` unique; count, errors, p95Ms, credits |
| `ApiCreditLedger` | `tenantId, keyId?, delta, reason, balanceAfter, createdAt` |
| `ApiEvent` | outbox + event log: `id, tenantId, type, data Json, apiVersion, createdAt, dispatchedAt?`; index `(tenantId, createdAt)`; 30-day retention |
| `WebhookEndpoint` | `tenantId, url, events String[], secretEncrypted, previousSecretEncrypted?, previousSecretUntil?, status (ACTIVE\|DISABLED), failingSince?, createdBy` |
| `WebhookDelivery` | `endpointId, eventId, attempt, status, responseCode?, responseSnippet?, latencyMs?, nextRetryAt?, createdAt`; 30-day retention |
| `ApiJob` | `id, tenantId, keyId, type, status, progress Json, input Json, result Json, error?, reportJobId?, checkpoint Int, createdAt, startedAt?, completedAt?, expiresAt` |
| `DeletedRecord` | `tenantId, resource, recordId, deletedAt`; written by triggers; 90-day retention |
| `Tenant` (changed) | `+ kind (LIVE\|SANDBOX)`, `+ parentTenantId?` |
| `Employee` (changed) | `+ externalId?` with `@@unique([tenantId, externalId])` |
| Synced tables (changed) | `+ updated_at` via trigger, index `(tenant_id, updated_at, id)` |

All new tables get RLS policies in [003-rls.sql](../apps/api/prisma/post-init/003-rls.sql).

---

## 19. Change rules after GA

- **Allowed any time:** new endpoints, new optional params, new response fields, new enum values, new permissions, new event types, new job types, raising limits.
- **Breaking (new `Iverto-Version` date or `v2` only):** removing/renaming anything, type changes, new required params, tighter validation, changed defaults, changed error codes, changed event payload fields.
- **Deprecation:** ≥ 12 months' notice; `Deprecation` + `Sunset` headers; email owners of keys the logs show calling deprecated operations; per-operation usage dashboard.

---

## 20. GA gates

1. **Registry-generated security tests** per operation: no permission → 403; other tenant → 404; outside key sites → 404; revoked / disabled / expired → 401; `Origin` present → 403 (except portal + test key); method blocked by superadmin → 403; test key against live tenant → 401.
2. **Contract snapshot:** committed public OpenAPI; CI fails on breaking diff or a diff without a changelog entry.
3. **Serializer leak test:** adding a model column doesn't change any public response.
4. **Outbox test:** a rolled-back transaction emits no event; a committed one always does.
5. **Webhook tests:** signatures verify with the official Standard Webhooks libraries; dual-signature rotation; SSRF suite (private IPs, DNS rebinding, redirects, metadata IP).
6. **Sync correctness:** concurrent long transaction + sync polling never misses a row; deletes appear as tombstones.
7. **Sandbox containment:** no mail / FCM / notification / terminal call for a sandbox tenant.
8. **Bulk:** crash mid-job resumes correctly; `atomic` rolls back fully; per-row errors match CSV import.
9. **Load test** (k6) at 2× org limits across 10 orgs; terminal punch latency unchanged.
10. **Chaos test:** kill Redis, the log worker and the dispatcher mid-run; behaviour matches §17.
11. Threat-model review → **external pen test** of `api.`.
12. **Design-partner beta** 60–90 days → freeze v1.

---

## 21. Phases

1. **Core** — models + migrations (incl. `updated_at` triggers, tombstones, `externalId`, `Tenant.kind`) + RLS, registry, public process + guard, `api_key` principal, serializers for employees, punches, attendance days, leave; cursor pagination + incremental sync + ETag; idempotency; request logging pipeline; org-admin key UI (Settings → API & Integrations); superadmin policy UI (Platform → tenant → API); registry-generated tests; contract snapshot.
2. **Limits & developer experience** — Lua limiter (key + org + concurrency + cost), headers, bad-auth guard, internal limiter → Redis store, pub/sub cache invalidation, Ed25519 signing; sandbox tenants + seeding + simulation endpoints; developer portal + try-it + changelog + deprecation headers.
3. **Webhooks & jobs** — outbox + dispatcher, endpoints UI, deliveries / retries / replay / auto-disable / rotation, event log API; `Job` resource, bulk employee upsert, report jobs; remaining resources (HR, payroll). **Design-partner beta starts here.**
4. **Credits, analytics & hygiene** — credit reserve/settle + ledger, `ApiUsageHourly` dashboards, superadmin cross-tenant overview, policy versioning UI with preview/rollback, usage alerts, stale-key auto-disable.
5. **GA** — §20 gates pass → freeze v1.

---

## 22. Future features

1. **SCIM 2.0** employee provisioning (Azure AD, Okta, Zoho People).
2. **OAuth client credentials** for enterprise customers that require it.
3. **OAuth authorization code + PKCE** for apps acting as an employee.
4. **MCP server** in front of the public API so customers' AI agents use the same keys and permissions.

Deliberately out: mTLS, bcrypt/argon2 for keys, old-version response transformers (until a breaking change actually exists), per-key time-of-day windows, a hand-maintained Postman collection.
