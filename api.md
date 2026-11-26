# Iverto Attendance API Reference (Web, Admin & Platform)

Comprehensive technical documentation for the Iverto Attendance backend web and administrative endpoints (`/v1/*`).

---

## 1. Architectural Overview & Conventions

### Base URL
- **Production Proxy Base**: `https://<api-domain>/att/v1` (Proxy strips `/att` and routes to API)
- **Direct Service Base**: `http://<host>:8040/v1`
- **Swagger OpenAPI Docs**: `/docs` (JSON available at `/docs/openapi.json` in non-production)

### Authentication
All endpoints (except `/v1/health/*` and terminal WebSocket handshakes) require an `Authorization` header containing a valid Supabase JWT Bearer token:
```http
Authorization: Bearer <access_token>
```
Tokens are verified against the Supabase project JWKS endpoint using asymmetric keys (RS256/ES256).

#### User Context Claims (`app_metadata`)
The JWT claims are decoded and enforced across all domain modules:
- `sub`: Unique user ID (Supabase Auth UID).
- `tenant_id`: Associated tenant UUID. Required for all tenant-scoped operations.
- `role`: One of `ADMIN`, `HR`, `MANAGER`, `EMPLOYEE`, or `PLATFORM_ADMIN` (for super admins).
- `employee_id`: Linked employee UUID (if assigned).
- `site_ids`: Array of site UUIDs restricted to the user (empty array grants all tenant sites).
- `must_change_password`: Boolean indicating temporary credentials requiring replacement before standard access.

#### Platform Admin Impersonation
Users with `is_super_admin: true` in their token can troubleshoot and manage any tenant by passing the `X-Tenant-Id` header:
```http
X-Tenant-Id: <tenant-uuid>
```
When this header is passed, the platform admin acts with `ADMIN` role inside that tenant, and an audit entry (`PLATFORM_TENANT_OVERRIDE`) is logged.

### Standard Response & Error Format
All errors thrown by the application follow the standardized RFC-compliant error schema:

```json
{
  "statusCode": 400,
  "code": "BAD_REQUEST",
  "message": "Human-readable explanation of error",
  "details": []
}
```

#### Common Machine-Readable Codes
| HTTP Status | Error Code | Description |
|---|---|---|
| `400` | `VALIDATION_FAILED` | Class-validator payload violation. `details` contains field failure messages. |
| `400` | `CONSTRAINT_FAILED` | Database integrity constraint failed. |
| `400` | `INVALID_REFERENCE`| Foreign key reference does not exist. |
| `401` | `UNAUTHORIZED` | Missing, expired, or malformed Bearer token. |
| `403` | `FORBIDDEN` | Caller lacks the role or permission required for the operation. |
| `403` | `TENANT_SUSPENDED`| The tenant is deactivated. User login blocked until reactivation. |
| `403` | `FEATURE_DISABLED` | The route belongs to a module (HR or payroll, `details.feature`) the platform hasn't switched on for this tenant (§2.6a). |
| `403` | `PASSWORD_CHANGE_REQUIRED` | Initial temporary password must be replaced via `/v1/auth/password`. |
| `403` | `MFA_REQUIRED` | The session has not passed a two-factor (TOTP) check. Every web route needs an `aal2` Supabase session; only `/v1/mobile/*`, `/v1/auth/*`, `GET /v1/org`, `GET /v1/departments` and `GET /v1/attendance/overview` accept password-only sessions. |
| `404` | `NOT_FOUND` | Requested entity does not exist. |
| `409` | `DUPLICATE` / `CONFLICT` | Unique key collision (e.g. employee code, tenant slug). |
| `409` | `OVERLAP` | Date range conflict with an existing schedule or leave record. |
| `413` | `PAYLOAD_TOO_LARGE`| Payload exceeded maximum body threshold (10MB HTTP max, 5MB file upload max). |
| `429` | `TOO_MANY_REQUESTS`| Exceeded rate limiter window (600/min standard, 10/min password change). |
| `503` | `NOT_READY` / `SERVICE_UNAVAILABLE` | Database, Redis, or hardware gateway connection failure. |

---

## 2. Platform Administration (`/v1/platform/tenants`)

> **Access Control**: Super Admins (`PLATFORM_ADMIN`) only.

### 2.1 List All Tenants
```http
GET /v1/platform/tenants
```
Retrieves all onboarded organisations with real-time operational metrics.

#### Response `200 OK`
```json
[
  {
    "id": "18f97e23-74cf-4ca6-b8f2-d853e3d98c11",
    "name": "Acme Manufacturing",
    "slug": "acme-mfg",
    "status": "ACTIVE",
    "createdAt": "2026-03-15T08:00:00.000Z",
    "suspendedAt": null,
    "suspendedReason": null,
    "employeeCount": 240,
    "terminalCount": 6,
    "terminalsOnline": 5,
    "lastPunchAt": "2026-03-30T09:42:15.000Z"
  }
]
```

---

### 2.2 Create & Provision Tenant
```http
POST /v1/platform/tenants
```
Initializes a new isolated tenant along with its initial site, holiday calendar, default attendance policy, standard shift, leave types, and administrator account.

#### Request Body
```json
{
  "name": "Acme Manufacturing",
  "slug": "acme-mfg",
  "site": {
    "name": "Main Plant",
    "timezone": "Asia/Kolkata"
  },
  "admin": {
    "fullName": "Jane Doe",
    "email": "jane.doe@acme.com"
  },
  "features": { "hr": true, "payroll": false }
}
```
`features` is optional; a module left out starts off (see §2.6a).

#### Response `201 Created`
```json
{
  "tenant": {
    "id": "18f97e23-74cf-4ca6-b8f2-d853e3d98c11",
    "name": "Acme Manufacturing",
    "slug": "acme-mfg",
    "status": "ACTIVE",
    "createdAt": "2026-03-30T10:00:00.000Z"
  },
  "admin": {
    "userId": "92f1b8a5-d0c3-4d7a-8fbe-449e7b231122",
    "email": "jane.doe@acme.com",
    "temporaryPassword": "Init-7k9!bX2@vL"
  }
}
```

---

### 2.3 Get Tenant Details & Audit History
```http
GET /v1/platform/tenants/:id
```
Returns comprehensive metadata for a specific tenant including all sites and administrative audit events.

---

### 2.4 Update Tenant Details
```http
PATCH /v1/platform/tenants/:id
```
#### Request Body
```json
{
  "name": "Acme Industries Global",
  "slug": "acme-global"
}
```

---

### 2.5 Suspend Tenant
```http
POST /v1/platform/tenants/:id/suspend
```
Suspends the organisation. Active users are blocked from access within 60 seconds (cached TTL). Terminals are rejected upon connection/login and will buffer punches locally.

#### Request Body
```json
{
  "reason": "Non-payment of subscription fees"
}
```

---

### 2.6 Reactivate Tenant
```http
POST /v1/platform/tenants/:id/reactivate
```
Restores tenant status to `ACTIVE`.

---

### 2.6a Switch Modules (HR, Payroll)
```http
PATCH /v1/platform/tenants/:id/features
```
Attendance, leave and the employee directory are always on; HR and payroll are paid modules switched on per tenant. Send only the modules to change:
```json
{ "payroll": false }
```
Returns the tenant; `settings.features` holds `{ "hr": boolean, "payroll": boolean }` (a tenant created before modules existed has none, which means both off). Audited as `TENANT_MODULES_UPDATED`. Tenant admins can't change this: `features` isn't accepted by `PATCH /v1/org`.

While a module is off:
- its routes answer `403 FEATURE_DISABLED` within 60 seconds (the same cache as suspension). HR covers documents, letters, checklists and tasks, the org chart, expenses (including `/mobile/approvals?type=expense`), assets, announcements and `/hr/settings`. Payroll covers `/payroll/*`, `/employees/:id/salaries` and `/employees/:id/payslips`, plus the mobile payslip routes;
- payroll runs no longer lock attendance, new employees and exits get no checklist tasks, document-expiry reminders stop, and the import ignores salary columns (the template and `/employees/import/columns` leave them out).

Nothing is deleted: switching a module back on restores all of its data. `GET /v1/org` returns `settings.features` for the web to hide what is off.

---

### 2.7 Retry Tenant Provisioning
```http
POST /v1/platform/tenants/:id/retry-admin
```
Used if administrator creation failed during asynchronous provisioning. Completes pending admin registration.

---

### 2.8 Reset Tenant Admin Password
```http
POST /v1/platform/tenants/:id/admin/reset-password
```
Generates a new temporary password for the initial tenant administrator and flags `mustChangePassword = true`.

#### Response `200 OK`
```json
{
  "userId": "92f1b8a5-d0c3-4d7a-8fbe-449e7b231122",
  "email": "jane.doe@acme.com",
  "temporaryPassword": "Temp-9uP#1aQ8*zR"
}
```

---

### 2.9 Platform Announcements ("What's new" for org admins)
```http
GET    /v1/platform/announcements        # newest first, up to 200
POST   /v1/platform/announcements
DELETE /v1/platform/announcements/:id    # 204; withdraws it
```
Platform admins only. Publishes immediately to the admins of every tenant:
```json
{ "kind": "FEATURE", "title": "Payroll is here", "body": "Plain text, line breaks kept (max 5000)" }
```
`kind` is `FEATURE`, `UPDATE` or `CHANGELOG`; the title is 3–140 characters. Returns `{ id, kind, title, body, publishedAt, createdBy }`. Audited as `PLATFORM_ANNOUNCEMENT_PUBLISHED` / `PLATFORM_ANNOUNCEMENT_DELETED`.

Org admins (role `ADMIN`; not HR, and not a platform admin using "Open as admin") read them as a popup shown once:
```http
GET  /v1/whats-new         # unseen, newest first, up to 10
POST /v1/whats-new/seen    # 204; marks everything published so far as seen
```
"Unseen" means published after the admin last called `/whats-new/seen`, or after their account was created if they never have, so a new admin doesn't get the backlog. Other roles get `403`.

---

## 3. Authentication & User Management

### 3.1 Change Own Password
```http
POST /v1/auth/password
```
> **Access Control**: Any authenticated user (including users with `mustChangePassword = true`). Rate-limited to 10 attempts/minute.

#### Request Body
```json
{
  "currentPassword": "Temp-9uP#1aQ8*zR",
  "newPassword": "SecurePersonalPassword2026!"
}
```

#### Response `200 OK`
```json
{
  "status": "ok",
  "message": "Password updated successfully"
}
```

---

### 3.2 List Tenant Users
```http
GET /v1/users
```
> **Access Control**: `ADMIN`, `HR`.

Returns all web and mobile logins configured for the tenant.

#### Response `200 OK`
```json
[
  {
    "userId": "92f1b8a5-d0c3-4d7a-8fbe-449e7b231122",
    "email": "jane.doe@acme.com",
    "displayName": "Jane Doe",
    "role": "ADMIN",
    "status": "ACTIVE",
    "employeeId": null,
    "siteIds": [],
    "mustChangePassword": false,
    "createdAt": "2026-03-30T10:00:00.000Z"
  }
]
```

---

### 3.3 Create User Account
```http
POST /v1/users
```
> **Access Control**: `ADMIN` (all roles), `HR` (`EMPLOYEE` and `MANAGER` roles only).

#### Request Body
```json
{
  "email": "mark.lead@acme.com",
  "displayName": "Mark Lead",
  "role": "MANAGER",
  "employeeId": "2bf51cc7-2287-4d92-95f7-920f92b02441",
  "siteIds": ["05d53cb1-efec-4be8-8422-44673891d4e0"]
}
```

#### Response `201 Created`
```json
{
  "userId": "d742aa15-8889-4a99-b1d6-4e55e81878a2",
  "email": "mark.lead@acme.com",
  "temporaryPassword": "Gen-4xW#9kL1!aP"
}
```

---

### 3.4 Update User
```http
PATCH /v1/users/:id
```
> **Access Control**: `ADMIN`.

#### Request Body
```json
{
  "displayName": "Mark Lead Jr.",
  "role": "HR",
  "siteIds": []
}
```

---

### 3.5 Deactivate User
```http
DELETE /v1/users/:id
```
> **Access Control**: `ADMIN`. Revokes active sessions in Supabase Auth and marks status as `INACTIVE`.

---

### 3.6 Reactivate User
```http
POST /v1/users/:id/reactivate
```
> **Access Control**: `ADMIN`. Re-enables the user account.

---

### 3.7 Reset User Password
```http
POST /v1/users/:id/reset-password
```
> **Access Control**: `ADMIN`, `HR`. Generates a new temporary password.

### 3.8 Reset Two-Factor
```http
POST /v1/users/:id/reset-mfa
```
> **Access Control**: `ADMIN`, `HR`. Deletes the user's authenticator factors (lost phone); they enrol a new one at their next web sign-in. Response `{ "userId": "…", "factorsRemoved": 1 }`.

### 3.9 Forgot / Reset Password (public)
```http
POST /v1/auth/forgot-password   { "email": "user@company.com" }
POST /v1/auth/reset-password    { "token": "<from the e-mailed link>", "newPassword": "…" }
```
> **Access Control**: Public, 10 requests/minute per IP. `forgot-password` always answers `{ "ok": true }` and e-mails a one-time link (Resend; expires in an hour) to `WEB_APP_URL/reset-password?token=…` when an active account exists. `reset-password` spends the token, sets the password (clearing `mustChangePassword`) and signs the user out everywhere; a bad or used token → `400 INVALID_RESET_LINK`.

Two-factor itself is Supabase Auth MFA (TOTP) driven from the web client: `mfa.enroll` → QR, `mfa.challengeAndVerify` → `aal2` session.

---

## 4. Organization Structure (`/v1/org`, `/v1/sites`, `/v1/departments`, `/v1/projects`)

### 4.1 Organization Settings
```http
GET /v1/org
PATCH /v1/org
```
- `GET`: Returns company name, slug, day boundary cutoff (`dayBoundary`, e.g. `04:00`), default weekly off days (e.g. `[0]` for Sunday), branding configuration, and retention limits.
- `PATCH`: Modifies settings (`ADMIN` only). Modifying `dayBoundary` automatically queues attendance recalculation for `[today - 1, today + 14]` across the tenant.

#### Request Body (`PATCH /v1/org`)
```json
{
  "name": "Acme Manufacturing Ltd",
  "dayBoundary": "05:00",
  "defaultWeeklyOffs": [0, 6],
  "storePunchPhotos": true,
  "punchPhotoRetentionDays": 90,
  "reportRetentionDays": 365,
  "branding": {
    "logoUrl": "https://assets.acme.com/branding/logo.png",
    "primaryColor": "#1E40AF",
    "displayName": "Acme Workforce"
  }
}
```

---

**Company letterhead** (`branding` in `PATCH /v1/org`): besides `displayName`, `logoUrl` (https) and `primaryColor`, it takes `legalName`, `address` (line breaks kept), `phone`, `email`, `website` and `registration` (e.g. "CIN … · GSTIN …"). These print at the top of payslips and letters and under the band of report PDFs. Letter templates can use `{{org.address}}`, `{{org.phone}}`, `{{org.email}}` and `{{org.website}}`.

### 4.2 Sites (`/v1/sites`)
Sites define physical workplace boundaries and legal timezone contexts.
- `GET /v1/sites`: List tenant sites.
- `POST /v1/sites`: Create a site (`ADMIN` only).
- `GET /v1/sites/:id`: Get site details.
- `PATCH /v1/sites/:id`: Update site (`ADMIN` only).
- `DELETE /v1/sites/:id`: Delete site (`ADMIN` only; fails with `409 SITE_IN_USE` if employees or terminals are assigned).

#### Site Creation Payload
```json
{
  "name": "Pune Tech Park",
  "address": "Tower 4, Magarpatta City, Pune",
  "timezone": "Asia/Kolkata",
  "holidayCalendarId": "9d150244-a0c3-42e1-a20c-c69812a688b1"
}
```

---

### 4.3 Departments (`/v1/departments`)
- `GET /v1/departments`: List departments with employee headcount.
- `POST /v1/departments`: Create department (`ADMIN`, `HR`).
- `PATCH /v1/departments/:id`: Update department (`ADMIN`, `HR`).
- `DELETE /v1/departments/:id`: Remove department (`ADMIN`, `HR`; rejected if employees exist).

#### Department Payload
```json
{
  "name": "Quality Engineering",
  "code": "QE",
  "headEmployeeId": "2bf51cc7-2287-4d92-95f7-920f92b02441",
  "policyId": "d32782b1-0ea9-42b7-8378-43d7890ecb12"
}
```

---

### 4.4 Projects & Project Membership (`/v1/projects`)
Cross-departmental temporary groupings.
- `GET /v1/projects`: List projects.
- `POST /v1/projects`: Create project.
- `PATCH /v1/projects/:id`: Update project.
- `DELETE /v1/projects/:id`: Remove project.
- `GET /v1/projects/:id/members`: List active and historical employee memberships with `from` and `to` dates.
- `PUT /v1/projects/:id/members`: Atomic replacement of project membership roster (`ADMIN`, `HR`).

#### Members Allocation Payload (`PUT /v1/projects/:id/members`)
```json
{
  "members": [
    {
      "employeeId": "2bf51cc7-2287-4d92-95f7-920f92b02441",
      "from": "2026-04-01",
      "to": "2026-09-30"
    }
  ]
}
```

---

## 5. Employee Master & Offboarding (`/v1/employees`)

> **Access Control**: `ADMIN`, `HR` for mutations; scoped reads for `MANAGER`.

### 5.1 Query Employees
```http
GET /v1/employees?siteId=&departmentId=&projectId=&managerId=&status=ACTIVE&q=&page=1&size=50
```
#### Query Parameters
- `siteId`, `departmentId`, `projectId`, `managerId`: Filter by organizational relationships.
- `status`: `ACTIVE` (default) or `EXITED`.
- `q`: Partial substring match on name, employee code, or email.
- `page`, `size`: Pagination parameters (default size 50, max 500).

---

### 5.2 Create Employee
```http
POST /v1/employees
```
Creates an employee, establishes their initial schedule (default shift or specified `shiftId`), and initiates materialized attendance days.

#### Request Body
```json
{
  "employeeCode": "EMP-0412",
  "fullName": "Rahul Sharma",
  "siteId": "05d53cb1-efec-4be8-8422-44673891d4e0",
  "departmentId": "c3562309-842b-45a8-b642-c6cb0e9f1604",
  "managerId": "2bf51cc7-2287-4d92-95f7-920f92b02441",
  "email": "rahul.sharma@acme.com",
  "phone": "+919876543210",
  "designation": "Production Specialist",
  "employmentType": "FULL_TIME",
  "joinedOn": "2026-04-01",
  "mobilePunch": "REMOTE_DAYS",
  "biometricConsent": true,
  "shiftId": "e2bb33f5-1952-443b-a13f-2d7c588e390c"
}
```

---

### 5.3 Bulk Import & Update (Excel or CSV)
```http
GET  /v1/employees/import/columns
GET  /v1/employees/import/template.xlsx?siteId=&prefill=false
POST /v1/employees/import/read
POST /v1/employees/import
```
All four are `ADMIN` / `HR`.

**The column registry** (`GET /import/columns`) lists every column the import understands: `key`, `label`, `section` (Basics · Job · Personal · Contact & emergency · Statutory IDs · Bank · Salary), `required`, `rule`, `example`, `type`, `values` (for enums), `aka` (accepted header spellings), and `virtual` / `sensitive` / `selfEditable`. Headers are matched by key, by label (a trailing `*` is ignored) or by any `aka` spelling, ignoring case, spaces and punctuation. Unknown headers are ignored and listed in `ignoredColumns`.

**The Excel template** (`GET /import/template.xlsx`) is built for the tenant:
- Dropdowns list its own sites, departments, employment types, salary structures, the enum values, and (as a suggestion list) existing employee codes.
- Date columns are date cells. PAN, IFSC, UAN and Aadhaar-last-4 have length checks, and ID and account columns are text cells, so leading zeros and 15-digit account numbers survive.
- Each header has a note with its rule and an example. Required headers are marked `*`.
- An Instructions sheet carries a column dictionary.
- `siteId` drops the Site column. With `prefill=true` you get the same workbook filled with the current active employees in scope, for the edit-and-re-upload loop. This export is audited as `EMPLOYEES_EXPORTED`.

**Reading a workbook**: `POST /import/read { "fileBase64": "<xlsx>" }` returns `{ "rows": string[][] }`, header first. It reads the first visible sheet that has an Employee code header row, skipping the title and section rows above it. Dates come back as `YYYY-MM-DD` and numbers as plain digits. Send the rows on as CSV.

**Importing**: `POST /import`
```json
{ "csv": "...", "mode": "CREATE", "siteId": "<optional>", "commit": false, "biometricConsent": true }
```
- `mode: "CREATE"` (default) adds new employees. A code that already exists is an error.
- `mode: "UPSERT"` updates existing employees matched by `employeeCode`: a **blank cell keeps** the current value, a single **`-` clears** it (not allowed on required fields). Codes not found are created.
- `siteId` is the site new employees join. Without it, new rows need a Site column. In UPSERT mode a Site cell moves the person.
- Required columns: CREATE needs `employeeCode`, `fullName`, `joinedOn` (+ `siteName` without `siteId`). UPSERT needs only `employeeCode`.
- **Dates** may be `YYYY-MM-DD`, `DD/MM/YYYY`, `DD-MM-YYYY` or `DD.MM.YYYY` (day first). PAN and IFSC are upper-cased and spaces are removed.
- **Aadhaar**: only the last 4 digits are stored. A full 12-digit number is refused with a message saying so.
- **Salary**: `monthlyGross` (₹) with `salaryStructure` (by name) creates or revises an effective-dated salary. The structure may be left blank when the employee already has one, or when the tenant has exactly one. `salaryEffectiveFrom` defaults to the joining date (new) or the 1st of the current month (update).
- Managers may be existing employees or rows further down the same file.

Dry run (`commit: false`):
```json
{ "committed": false, "mode": "UPSERT", "total": 3, "valid": 2, "invalid": 1, "creates": 1, "updates": 2, "ignoredColumns": ["Notes"],
  "errors": [{ "line": 3, "errors": [{ "field": "pan", "message": "PAN must look like ABCDE1234F" }] }],
  "sample": [{ "line": 2, "op": "UPDATE", "employeeCode": "EMP001", "designation": "Lead" }] }
```
Commit returns the same plus `createdIds` and `updatedIds`. A file with any invalid row is refused (`400 IMPORT_INVALID`, `details` = the errors). New employees get their onboarding checklist. Audit: `EMPLOYEES_IMPORTED { mode, created, updated }`, plus `SALARY_SET` per salary.

### 5.3a Directory fields
`POST /v1/employees` and `PATCH /v1/employees/:id` accept, on top of the fields in 5.2:

| Section | Fields |
|---|---|
| Job | `probationEndOn`, `confirmedOn` (dates), `noticePeriodDays` (0–365) |
| Personal | `dateOfBirth`, `gender` (`MALE`·`FEMALE`·`OTHER`), `maritalStatus` (`SINGLE`·`MARRIED`·`OTHER`), `bloodGroup` (`A+`…`O-`), `fatherOrSpouseName` |
| Contact & emergency | `personalEmail`, `altPhone`, `currentAddress`, `permanentAddress`, `emergencyName`, `emergencyRelation`, `emergencyPhone` |
| Statutory IDs | `pan` (`ABCDE1234F`), `aadhaarLast4` (4 digits), `uan` (12 digits), `esicNumber` |
| Bank | `paymentMode` (`BANK`·`CASH`·`CHEQUE`, null = BANK), `bankAccountName`, `bankAccountNumber` (6–20 digits), `bankIfsc` (`HDFC0001234`), `bankName` |

`null` clears a field. Values are validated against the same registry as the import (`400 INVALID_FIELD` names the field). **PAN, Aadhaar-last-4, UAN, ESIC and bank details are returned only to ADMIN/HR and to the employee themself.** A manager sees the rest of the profile without them.

`GET /v1/employees/org-chart` (any role) returns every active employee in the caller's sites as `{ id, employeeCode, fullName, designation, managerId, department, site }`, for drawing the reporting tree.

---

### 5.4 Get Employee Profile
```http
GET /v1/employees/:id
```
Returns employee record (with the directory fields of 5.3a; sensitive ones only for HR/admin/self), active system login account status, recent work schedules, terminal slot bindings, and face template synchronization state.

---

### 5.5 Update Employee
```http
PATCH /v1/employees/:id
```
Updates employee data. Changing `joinedOn` or `exitOn` triggers automated validity period synchronization across all physical terminals holding the employee's face slot.

---

### 5.6 Employee Offboarding (Exit Management)
```http
POST /v1/employees/:id/offboard
```
Atomic execution of employee exit workflow:
1. Deletes future materialized attendance days past `exitOn`.
2. Cancels pending leave and remote work requests.
3. Deletes biometric face templates from database.
4. Commands all active terminals holding employee slots to release the slot and delete hardware face records.
5. Deletes active Supabase Auth user credentials (freeing the email address).
6. Sets employee status to `EXITED`.

#### Request Body
```json
{
  "exitOn": "2026-04-30",
  "reason": "Resigned to pursue higher education"
}
```

#### Response `200 OK`
```json
{
  "employee": {
    "id": "88cfc843-e6ef-4613-8991-ecff02a9e334",
    "status": "EXITED",
    "exitOn": "2026-04-30"
  },
  "devices": [
    {
      "deviceId": "dev-01",
      "serialNo": "DJ20250307014",
      "status": "cleared"
    }
  ],
  "loginRemoved": true
}
```

---

## 6. Terminals & M50 Biometrics (`/v1/terminals`)

Control plane for M50 facial recognition terminals communicating over persistent raw WebSocket connections.

### 6.1 Fleet Overview
```http
GET /v1/terminals
```
Lists registered devices with real-time socket connection status, IP addresses, enrolled slot counts, and unattributed punch queues.

#### Response `200 OK`
```json
[
  {
    "id": "78b77622-cce7-4fe7-b769-d419bdfca512",
    "serialNo": "DJ20250307014",
    "name": "North Gate Turnstile",
    "gateName": "North Gate",
    "direction": "IN",
    "siteId": "05d53cb1-efec-4be8-8422-44673891d4e0",
    "siteName": "Main Plant",
    "status": "online",
    "lastSeenAt": "2026-03-30T10:14:22.000Z",
    "ipAddress": "192.168.1.120",
    "activeSlots": 142,
    "unattributedPunches": 3
  }
]
```

---

### 6.2 Provision Terminal
```http
POST /v1/terminals
```
Authorizes a terminal by its factory serial number prior to initial network connection.

#### Request Body
```json
{
  "serialNo": "DJ20250307014",
  "siteId": "05d53cb1-efec-4be8-8422-44673891d4e0",
  "name": "North Gate Turnstile",
  "gateName": "North Gate",
  "direction": "BOTH",
  "clockTimezone": "Asia/Kolkata"
}
```

---

### 6.3 Template Coverage & Management
- `GET /v1/terminals/templates/coverage`: Matrix showing which employees have active templates and which terminals have received them.
- `POST /v1/terminals/templates/capture`: Harvests face biometric templates from a source terminal for an array of employee IDs.
- `POST /v1/terminals/templates/distribute`: Pushes stored templates to multiple destination terminals.

#### Distribute Request Body
```json
{
  "employeeIds": ["88cfc843-e6ef-4613-8991-ecff02a9e334"],
  "deviceIds": ["dev-02", "dev-03"],
  "sourceDeviceId": "dev-01",
  "skipEnrolled": true
}
```

---

### 6.4 Slot Reservation & Keypad Claim Workflow
1. **Pre-reserve Slot**:
   ```http
   POST /v1/terminals/:deviceId/users
   ```
   ```json
   { "employeeId": "88cfc843-e6ef-4613-8991-ecff02a9e334" }
   ```
   Allocates a unique numerical hardware `UserID` (slot) on the terminal and configures employee validity dates.

2. **Claim Keypad Enrolment**:
   If an employee enrolled at the physical terminal keypad without pre-reservation, link the slot:
   ```http
   POST /v1/terminals/:deviceId/users/:terminalUserId/claim
   ```
   ```json
   {
     "employeeId": "88cfc843-e6ef-4613-8991-ecff02a9e334",
     "renameOnDevice": true,
     "captureTemplate": true
   }
   ```
   Attributed retroactively to any previously recorded `UNKNOWN` punches originating from this slot.

3. **Release Claim**:
   ```http
   DELETE /v1/terminals/:deviceId/users/:terminalUserId/claim
   ```

---

### 6.5 Direct Face Enrolment via Photo
```http
POST /v1/terminals/:deviceId/enroll/photo
```
Uploads a base64-encoded JPEG (<32KB decoded) directly to the terminal's neural model for zero-touch enrollment.

```json
{
  "employeeId": "88cfc843-e6ef-4613-8991-ecff02a9e334",
  "photoBase64": "/9j/4AAQSkZJRgABAQEASABIAAD..."
}
```

---

### 6.6 Hardware Inspection & Diagnostics
- `GET /v1/terminals/:deviceId/device/status`: Real-time hardware health (CPU, memory, storage, temperature).
- `GET /v1/terminals/:deviceId/device/logs?from=0&limit=100`: Hardware punch buffer stored on device Flash.
- `GET /v1/terminals/:deviceId/device/users`: Compares physical hardware slots with local database mappings.
- `GET /v1/terminals/:deviceId/device/users/:terminalUserId/photo`: Retrieves facial capture JPEG snapshot stored in terminal RAM.
- `GET /v1/terminals/:deviceId/device/unclaimed`: Lists all slots occupied on hardware not bound to an employee.
- `GET /v1/terminals/:deviceId/device/admin-logs`: Terminal system audit logs (categories: `enrollment`, `deletion`, `configuration`, `session`).

---

## 7. Punches & Attendance Records (`/v1/punches`)

### 7.1 List Raw Punches
```http
GET /v1/punches?from=2026-03-01&to=2026-03-30&siteId=&employeeId=&source=TERMINAL&unknownOnly=false&cursor=&limit=100
```
Cursor-paginated immutable raw punch log sorted descending by timestamp.

#### Response `200 OK`
```json
{
  "data": [
    {
      "id": "punch-01",
      "employeeId": "88cfc843-e6ef-4613-8991-ecff02a9e334",
      "employeeName": "Rahul Sharma",
      "employeeCode": "EMP-0412",
      "punchedAt": "2026-03-30T09:02:14.000Z",
      "localTime": "2026-03-30 14:32:14",
      "workDate": "2026-03-30",
      "direction": "in",
      "source": "TERMINAL",
      "deviceId": "dev-01",
      "deviceName": "North Gate Turnstile",
      "siteId": "05d53cb1-efec-4be8-8422-44673891d4e0"
    }
  ],
  "nextCursor": "eyJ0IjoiMjAyNi0wMy0zMFQwOTowMjoxNC4wMDBaIiwiaWQiOiJwdW5jaC0wMSJ9"
}
```

---

### 7.2 Manual HR Punch Insertion
```http
POST /v1/punches
```
> **Access Control**: `ADMIN`, `HR`. Inserts an audited punch entry directly and queues immediate recomputation.

```json
{
  "employeeId": "88cfc843-e6ef-4613-8991-ecff02a9e334",
  "at": "2026-03-30T09:05:00.000Z",
  "direction": "in",
  "reason": "Biometric device offline during power cut"
}
```

---

## 8. Shifts & Roster Scheduling (`/v1/shifts`, `/v1/shift-patterns`, `/v1/roster`)

### 8.1 Shift Definitions (`/v1/shifts`)
- `GET /v1/shifts`: List defined shifts.
- `POST /v1/shifts`: Create shift (`ADMIN`, `HR`).
- `PATCH /v1/shifts/:id`: Update shift properties.
- `DELETE /v1/shifts/:id`: Deactivate shift.

#### Shift Payload
```json
{
  "name": "General Day Shift",
  "code": "GEN",
  "color": "#10B981",
  "kind": "FIXED",
  "startTime": "09:00",
  "endTime": "18:00",
  "breakMinutes": 60,
  "requiredMinutes": 480,
  "coreStart": null,
  "coreEnd": null,
  "worksHolidays": false,
  "isDefault": true,
  "active": true
}
```

---

### 8.2 Shift Rotation Patterns (`/v1/shift-patterns`)
Rotational repeating cyclical patterns (e.g. 6 days Morning, 2 days Off).
- `GET /v1/shift-patterns`: List patterns.
- `POST /v1/shift-patterns`: Create pattern (`ADMIN`, `HR`).
- `PATCH /v1/shift-patterns/:id`: Update pattern.
- `DELETE /v1/shift-patterns/:id`: Delete pattern (rejected if assigned to employees).

#### Pattern Payload
```json
{
  "name": "Morning-Night-Off Cycle",
  "days": [
    "shift-id-morning",
    "shift-id-morning",
    "shift-id-night",
    "shift-id-night",
    null,
    null
  ]
}
```

---

### 8.3 Employee Schedule Assignment (`/v1/employee-schedules`)
Assigns fixed shifts or rotating patterns to employees starting from an effective date.

```http
POST /v1/employee-schedules
```
```json
{
  "employeeIds": ["88cfc843-e6ef-4613-8991-ecff02a9e334"],
  "effectiveFrom": "2026-04-01",
  "effectiveTo": "2026-12-31",
  "shiftId": "e2bb33f5-1952-443b-a13f-2d7c588e390c",
  "weeklyOffs": [0, 6],
  "reevaluateHistory": false
}
```

---

### 8.4 Roster Grid & Conflict Validation (`/v1/roster`)
```http
GET /v1/roster?from=2026-04-01&to=2026-04-14&departmentId=
```
Evaluates shift assignments against legal and company health policies. Automatically tags conflicts:
- `REST_TOO_SHORT`: Less than policy minimum rest hours between consecutive shifts.
- `LEAVE_OVERLAP`: Employee has approved leave on a scheduled working day.
- `WEEKLY_HOURS_EXCEEDED`: Exceeds policy maximum weekly hours.

---

### 8.5 Manager Roster Overrides (`/v1/roster/overrides`)
- `PUT /v1/roster/overrides`: Upsert temporary shift replacements or assign ad-hoc rest days.
- `DELETE /v1/roster/overrides`: Revert overrides to underlying master schedule.

#### Upsert Overrides Payload
```json
{
  "items": [
    {
      "employeeId": "88cfc843-e6ef-4613-8991-ecff02a9e334",
      "date": "2026-04-05",
      "shiftId": null,
      "reason": "Compensatory rest day"
    }
  ],
  "reevaluateHistory": true
}
```

---

## 9. Holiday Calendars & Attendance Policies

### 9.1 Holiday Calendars (`/v1/holiday-calendars`)
- `GET /v1/holiday-calendars`: List calendars.
- `POST /v1/holiday-calendars`: Create calendar.
- `GET /v1/holiday-calendars/:id/holidays`: List specific holidays.
- `POST /v1/holiday-calendars/:id/holidays`: Add holiday date (triggers automatic recalculation of affected site employee schedules).
- `DELETE /v1/holiday-calendars/:id/holidays/:holidayId`: Remove holiday.
- `POST /v1/holiday-calendars/:id/holidays/import`: Bulk add `{ "holidays": [{ "date": "2027-01-26", "name": "Republic Day" }] }` (max 1000). A date already in the calendar takes the new name. Returns `{ imported, created, updated }`.
- `PUT /v1/holiday-calendars/:id/sites`: Set which office locations follow this calendar, `{ "siteIds": [...] }`. Listed sites move here; sites dropped from the list are left without a calendar. Affected employees' days (yesterday → +14 days) are recomputed, as they are when `PATCH /v1/sites/:id` changes `holidayCalendarId`.

#### Add Holiday Payload
```json
{
  "date": "2026-05-01",
  "name": "Labor Day"
}
```

---

### 9.2 Attendance Policies (`/v1/attendance-policies`)
Defines the parameters used by the automated attendance compute engine.

```http
POST /v1/attendance-policies
PATCH /v1/attendance-policies/:id
```
#### Policy Parameters Payload
```json
{
  "name": "Standard Corporate Policy",
  "isDefault": true,
  "graceInMinutes": 15,
  "graceOutMinutes": 10,
  "halfDayMinPercent": 50,
  "fullDayMinPercent": 85,
  "earlyWindowMinutes": 120,
  "lateWindowMinutes": 240,
  "duplicatePunchSeconds": 60,
  "minSessionMinutes": 15,
  "absentAfterMinutes": 240,
  "missedOutCredit": "UNTIL_SHIFT_END",
  "overtimeEnabled": true,
  "overtimeMinMinutes": 30,
  "breakDeduction": "SHIFT_BREAK",
  "roundingMinutes": 5,
  "minRestHours": 8,
  "maxWeeklyHours": 48
}
```

---

## 10. Attendance Computation & Day Drawer (`/v1/attendance`)

### 10.1 Daily Attendance Statuses
```http
GET /v1/attendance/days?from=2026-03-01&to=2026-03-30&status=PRESENT,LATE&isLate=true&page=1&size=100
```
Filters computed attendance records across employee scopes.

---

### 10.2 Day Drawer Details
```http
GET /v1/attendance/days/:id
```
Detailed inspection modal for an attendance day:
- Computed work date, status, minutes worked, break duration, overtime.
- Complete raw punch stream attributed to this day window.
- Paired work session segments with in/out timestamps.
- Related leave requests, remote authorizations, and correction applications.
- Full chronological audit history.

---

### 10.3 Month Overview & Muster Roll Grid
```http
GET /v1/attendance/overview?month=2026-03&grid=true
```
Returns aggregate totals per employee (Present, Absent, Leave, Late, Overtime minutes), daily tenant-wide distribution, and an optional day-by-day status matrix.

---

### 10.4 Historical Re-evaluate ("Recompute")
```http
POST /v1/attendance/recompute
```
> **Access Control**: `ADMIN`, `HR`. Queues a background BullMQ job to re-evaluate attendance over a historical window, recalculating statuses against updated policies, shifts, or corrections.

```json
{
  "employeeIds": ["88cfc843-e6ef-4613-8991-ecff02a9e334"],
  "from": "2026-03-01",
  "to": "2026-03-15",
  "reason": "Updated attendance grace period policy"
}
```

---

## 11. Attendance Corrections (`/v1/attendance/corrections`)

Allows employees or HR managers to resolve missed punches. When approved, synthetic `CORRECTION` punches are inserted into the punch stream and attendance is recalculated without overwriting hardware logs.

### 11.1 List Corrections
```http
GET /v1/attendance/corrections?status=PENDING&from=&to=&limit=50
```

---

### 11.2 Submit Correction
```http
POST /v1/attendance/corrections
```
```json
{
  "employeeId": "88cfc843-e6ef-4613-8991-ecff02a9e334",
  "date": "2026-03-28",
  "in": "09:00",
  "out": "18:00",
  "reason": "Biometric terminal failed to read face at checkout",
  "fieldVisitIds": ["fv-31", "fv-32"]
}
```
`fieldVisitIds` (optional, up to 10) attaches that employee's field visits as proof, e.g. one per client visited that day; any visit that isn't theirs → `400 BAD_PROOF`. The older single `fieldVisitId` is still accepted. Listed corrections carry `fieldVisits` (`[{ id, takenAt, lat, lng, accuracy, isMockLocation, note, photoUrl }]`, oldest first, `[]` when none) and, for older clients, `fieldVisit` (the first of them, or `null`).

### 11.2a Field Visits
```http
GET /v1/field-visits?employeeId=&date=YYYY-MM-DD&cursor=&limit=50
```
> **Access Control**: Any user, scoped like the employee list (an `EMPLOYEE` sees only their own). Geotagged selfies taken in the mobile app (`POST /v1/mobile/field-visits`), newest first, each with a 1-hour `photoUrl`. They never count as punches.

---

### 11.3 Approve / Reject Correction
```http
POST /v1/attendance/corrections/:id/approve
POST /v1/attendance/corrections/:id/reject
```
#### Approve Payload
```json
{ "note": "Verified with team supervisor" }
```
#### Reject Payload
```json
{ "note": "No record of physical presence on CCTV" }
```

---

## 12. Leave Management (`/v1/leave`)

### 12.1 Leave Types (`/v1/leave/types`)
- `GET /v1/leave/types`: List active leave types.
- `POST /v1/leave/types`: Define a leave type (`ADMIN`, `HR`).
- `PATCH /v1/leave/types/:id`: Update leave type rules.
- `DELETE /v1/leave/types/:id`: Deactivate leave type.

#### Leave Type Payload
```json
{
  "code": "CL",
  "name": "Casual Leave",
  "color": "#3B82F6",
  "paid": true,
  "allowHalfDay": true,
  "accrualKind": "MONTHLY",
  "accrualAmount": 1.5,
  "maxBalance": 18,
  "carryForwardMax": 5,
  "allowNegative": false,
  "requiresAttachment": false,
  "minNoticeDays": 2,
  "countsOffDays": false,
  "requiresHrApproval": false
}
```
Accrual runs hourly per tenant (catching up missed months). At the leave-year end (1 April) the positive balance moves to the next year up to `carryForwardMax` (`null` = all of it, `0` = none) and the rest lapses; send `null` to clear `maxBalance` or `carryForwardMax`. Balances (`GET /v1/leave/balances`) report `carriedIn` and `carriedOut` separately.

---

### 12.2 Leave Request Lifecycle
- `POST /v1/leave/requests/preview`: Calculates working days deduction prior to submission.
- `POST /v1/leave/requests`: Submits leave request.
- `GET /v1/leave/requests/:id/attachment`: Generates temporary signed URL for supporting medical document.
- `POST /v1/leave/requests/:id/approve`: Approves leave and decrements ledger balance.
- `POST /v1/leave/requests/:id/reject`: Rejects application.
- `POST /v1/leave/requests/:id/cancel`: Cancels pending or approved leave (automatically credits ledger).

#### Leave Request Submission Payload
```json
{
  "employeeId": "88cfc843-e6ef-4613-8991-ecff02a9e334",
  "leaveTypeId": "leave-type-cl",
  "from": "2026-04-10",
  "to": "2026-04-11",
  "startHalf": "FIRST",
  "endHalf": "SECOND",
  "reason": "Family function",
  "attachmentKey": "acme/user-01/cert.pdf"
}
```

---

### 12.3 Balances, Ledger & Adjustments
- `GET /v1/leave/balances?employeeId=&year=2026`: Available, used, and pending leave balances.
- `GET /v1/leave/ledger?employeeId=&leaveTypeId=`: Audit trail of all balance adjustments, accruals, and deductions.
- `POST /v1/leave/adjustments`: Manual HR balance adjustment (`ADMIN`, `HR`).
- `POST /v1/leave/comp-off`: Grants compensatory off credit for working on a holiday or rest day (`ADMIN`, `HR`).

#### Adjustment Payload
```json
{
  "employeeId": "88cfc843-e6ef-4613-8991-ecff02a9e334",
  "leaveTypeId": "leave-type-cl",
  "year": 2026,
  "delta": 2.0,
  "kind": "ADJUSTMENT",
  "note": "Correction of opening balance carryover"
}
```

---

## 13. Remote Work (`/v1/remote-work`)

Workflow for remote work permissions enabling mobile GPS punch authorization.
- `GET /v1/remote-work/requests`: List requests.
- `POST /v1/remote-work/requests`: Apply for remote work authorization.
- `POST /v1/remote-work/requests/:id/approve`: Authorize remote work days.
- `POST /v1/remote-work/requests/:id/reject`: Reject application.
- `POST /v1/remote-work/requests/:id/cancel`: Cancel remote authorization.

Mobile check-in review (ADMIN / HR / MANAGER, scoped like the rest). Each `MOBILE` punch carries a selfie (Azure Blob) and GPS, and starts `PENDING`; it counts immediately, and a rejection sets `outcome: DENIED` and recomputes the day.
- `GET /v1/remote-work/punches?status=PENDING|APPROVED|REJECTED&employeeId=&from=&to=&cursor=&limit=`: Check-ins newest first; each row is a punch plus `selfieUrl` (read-only SAS link, valid 1 hour). Omit `status` for all.
- `POST /v1/remote-work/punches/:id/approve`: Body `{ "note"?: string }`.
- `POST /v1/remote-work/punches/:id/reject`: Body `{ "note": string }` (required); the employee is notified. Only `PENDING` check-ins can be decided (`409 ALREADY_DECIDED`).

#### Remote Work Request Payload
```json
{
  "from": "2026-04-02",
  "to": "2026-04-03",
  "reason": "Working from home during client visits"
}
```

---

## 14. Reports & Exports (`/v1/reports`)

### 14.1 Catalogue
```http
GET /v1/reports/types
```
Returns list of available report engines:
1. `daily-summary`: Daily headcount, in/out times, and work duration.
2. `muster-roll`: Government-compliant monthly attendance matrix with daily status codes.
3. `timesheet`: Detailed punch segments and approval sign-off sheets.
4. `punch-log`: Audit log of all raw punch events.
5. `late-early`: Exceptions for late arrivals and early departures.
6. `overtime`: Overtime summaries and compliance tracking.
7. `leave`: Leave utilization and balance summaries.
8. `absenteeism`: Unplanned absenteeism rates and patterns.
9. `payable-days`: Payroll input per employee — employed days, absences, late penalty, unpaid leave, LOP, paid days, OT (same maths as a payroll run, §18.5).

---

### 14.2 Request Export Job
```http
POST /v1/reports/exports
```
Queues an asynchronous generation job via BullMQ.

#### Request Body
```json
{
  "type": "muster-roll",
  "format": "pdf",
  "filters": {
    "dateFrom": "2026-03-01",
    "dateTo": "2026-03-31",
    "departmentIds": ["c3562309-842b-45a8-b642-c6cb0e9f1604"]
  }
}
```

#### Response `202 Accepted`
```json
{
  "jobId": "rep-job-94812",
  "status": "queued"
}
```

---

### 14.3 Download Report File
```http
GET /v1/reports/exports/:jobId/download?redirect=true
```
- `redirect=true` (default): Returns `302 Found` redirecting to an authenticated 5-minute Supabase Storage signed download URL.
- `redirect=false`: Returns JSON: `{ "url": "https://...", "expiresInSeconds": 300 }`.

---

### 14.4 Scheduled Automated Reports
Configures recurring cron jobs delivering reports directly to team inboxes.
- `GET /v1/reports/schedules`: List schedules.
- `POST /v1/reports/schedules`: Create schedule (`ADMIN`, `HR`, `MANAGER`).
- `PATCH /v1/reports/schedules/:id`: Update schedule.
- `DELETE /v1/reports/schedules/:id`: Remove schedule.

#### Schedule Creation Payload
```json
{
  "name": "Weekly Monday Absenteeism Brief",
  "type": "absenteeism",
  "format": "csv",
  "filters": {
    "period": "last7"
  },
  "cron": "0 8 * * 1",
  "timezone": "Asia/Kolkata",
  "recipientUserIds": ["92f1b8a5-d0c3-4d7a-8fbe-449e7b231122"],
  "enabled": true
}
```

---

## 15. Live Board, WebSocket Gateway & Audit Logs

### 15.1 REST Live Snapshot (`/v1/live/board`)
```http
GET /v1/live/board?siteId=&departmentId=
```
> **Access Control**: `ADMIN`, `HR`, `MANAGER`.

Returns real-time workforce headcount:
- Live state counts: `IN`, `IN_LATE`, `ON_BREAK`, `LEFT`, `NOT_YET_IN`, `LATE_NOT_IN`, `ON_LEAVE`, `REMOTE`, `OFF`, `ABSENT`.
- Active terminal hardware online/offline statuses.
- Stream of most recent 30 punches.

---

### 15.2 WebSocket Gateway (`/live`)
Socket.IO connection namespace for live delta updates.

```javascript
import { io } from 'socket.io-client';

const socket = io('https://<api-domain>/live', {
  auth: { token: '<jwt-token>' },
  transports: ['websocket']
});
```

#### Gateway Rooms
- `user:<userId>`: Personal notifications, approval requests, report ready events.
- `tenant:<tenantId>`: All tenant-wide events (`ADMIN`, unrestricted `HR`).
- `site:<siteId>`: Site-restricted events.
- `dept:<deptId>`: Department events for department heads.
- `mgr:<employeeId>`: Direct team reporting events.

#### Events Emitted by Server
| Event Name | Room | Payload Description |
|---|---|---|
| `punch.created` | Scope rooms | Real-time punch recorded on terminal or mobile. |
| `attendance.updated` | Scope rooms | Materialized attendance day updated. |
| `device.status` | `tenant:`, `site:` | Terminal connected, disconnected, or heartbeat received. |
| `report.ready` | `user:` | Asynchronous export job completed with download metadata. |
| `report.failed` | `user:` | Export generation failure notification. |
| `approval.pending` | `user:` | New request awaiting supervisor decision. |
| `notification.new` | `user:` | General in-app notification entry. |

---

### 15.3 Audit Logs (`/v1/audit-logs`)
```http
GET /v1/audit-logs?action=&actorUserId=&targetType=&targetId=&from=&to=&page=1&size=50
```
> **Access Control**: `ADMIN`.

Immutable audit log recording every mutation, actor UID, IP/client information, and before/after payloads.

---

## 16. Health & Readiness (`/v1/health`)

> **Access Control**: Public (No JWT required, exempt from rate limiting).

### 16.1 Liveness Probe
```http
GET /v1/health/live
```
#### Response `200 OK`
```json
{
  "status": "ok",
  "time": "2026-03-30T10:20:00.000Z"
}
```

---

### 16.2 Readiness Probe
```http
GET /v1/health/ready
```
Validates connectivity across all critical dependencies:
- PostgreSQL database transaction ping.
- Redis client connectivity ping.
- M50 Terminal Server WebSocket listener attachment.

#### Response `200 OK`
```json
{
  "status": "ok",
  "database": true,
  "redis": true,
  "terminalServer": true
}
```
If any check fails, returns `503 Service Unavailable` with `"code": "NOT_READY"`.

---

## 17. HR (`/v1/hr`, documents, letters, tasks, expenses, assets, announcements, profile changes)

> Confidential files (documents, generated letters, expense receipts) are stored in a private Azure Blob container (`AZURE_STORAGE_CONTAINER_DOCUMENTS`, default `hr-documents`). They are opened only through **5-minute read-only SAS links**, and only after the access check.

### 17.1 HR settings
```http
GET /v1/hr/settings          (any role)
PUT /v1/hr/settings          (ADMIN, HR)
```
```json
{
  "checklists": {
    "ONBOARDING":  [{ "title": "Collect ID and address proofs", "assigneeRole": "HR", "dueDays": 0 }],
    "OFFBOARDING": [{ "title": "Exit interview", "assigneeRole": "HR", "dueDays": -1 }]
  },
  "expenseCategories": ["Travel", "Food", "..."],
  "assetCategories": ["Laptop", "Mobile phone", "..."],
  "expenseRequiresHrApproval": true
}
```
`assigneeRole` is `HR` | `IT` | `MANAGER` | `EMPLOYEE`. `dueDays` counts from the joining date (onboarding) or the exit date (offboarding; negative = before). GET also returns `documentCategories` and `taskRoles`.

### 17.2 On/offboarding checklists
- `GET /v1/employees/:id/tasks` (scoped): one employee's tasks.
- `POST /v1/employees/:id/tasks` (ADMIN, HR): `{ kind, title, assigneeRole, dueOn? }`.
- `GET /v1/tasks/mine?all=false`: the caller's to-do list. HR/admin see HR and IT tasks in scope, a manager sees their team's MANAGER tasks, and everyone sees their own EMPLOYEE tasks. Each item carries `overdue`.
- `POST /v1/tasks/:id/done { note? }`, `POST /v1/tasks/:id/reopen`, `DELETE /v1/tasks/:id` (HR).

Tasks are created automatically: onboarding on `POST /employees` (and import), offboarding on `POST /employees/:id/offboard`. Offboarding adds one "Return …" task per asset still assigned.

### 17.3 Document vault
```http
GET    /v1/employees/:id/documents
POST   /v1/employees/:id/documents
GET    /v1/documents/:id/url            → { url, expiresInSeconds: 300, contentType }
POST   /v1/documents/:id/verify         (ADMIN, HR)
DELETE /v1/documents/:id                (ADMIN, HR)
GET    /v1/documents/expiring?days=30   (ADMIN, HR)
```
Only HR/admin (in scope) and the employee themself can list or open documents; a manager gets `404`. Upload body:
```json
{ "category": "ID_PROOF", "name": "Passport", "expiresOn": "2031-05-01", "fileName": "passport.pdf", "contentType": "application/pdf", "dataBase64": "..." }
```
- `category` is one of `ID_PROOF`, `ADDRESS_PROOF`, `EDUCATION`, `EXPERIENCE`, `CONTRACT`, `LETTER`, `OTHER`. `LETTER` is HR-only.
- Files are JPEG, PNG or PDF, at most 5 MB, with the type checked by magic bytes.
- An HR upload is marked verified at once.
- A daily job (`document-expiry`) notifies HR/admins and the employee 30 and 7 days before `expiresOn`.

Opening a document is audited (`DOCUMENT_OPENED`).

### 17.4 Letters
```http
GET    /v1/letter-templates                          the organisation's templates
GET    /v1/letter-templates/library                  ready-made starting points: { key, kind, name, description, placeholders }
POST   /v1/letter-templates/library/:key/adopt       copy one in ("Offer letter (2)" if the name is taken) → the new template
GET    /v1/letter-templates/fields                   placeholder chips: { key, label, group: Employee|Salary|Company|Letter, sample }
POST   /v1/letter-templates/render { body, employeeId? }   live preview of unsaved text → { text, missing }
POST   /v1/letter-templates ; PATCH/DELETE /v1/letter-templates/:id      { kind, name, body }
POST   /v1/employees/:id/letters { "templateId": "...", "extra": { ... }, "save": true }
```
All `ADMIN` / `HR`. Starting points: offer, appointment, confirmation, salary revision, experience and relieving letters. Nothing is created automatically; Settings → Letters copies the ones you want.

- **Placeholders** are written `{{employee.fullName}}` etc. `GET …/fields` lists them all with human labels; company fields come from the letterhead settings (§4.1).
- **Preview:** `render` fills unsaved editor text for a chosen employee, or with sample values when `employeeId` is omitted. `missing` lists placeholders that came out blank or are unknown.
- **Generate:** `POST /employees/:id/letters` renders the template on the company letterhead and files it as a `LETTER` document (`save: false` returns `{ text, missing }` only).

### 17.5 Expense claims
```http
GET  /v1/expenses?status=&employeeId=&awaitingMe=&unpaid=&cursor=&limit=
POST /v1/expenses
POST /v1/expenses/:id/approve|reject|cancel        { "note": "..." }
POST /v1/expenses/:id/paid-outside-payroll         (ADMIN, HR)
```
Submit (the employee):
```json
{ "category": "Travel", "amount": 1250.50, "claimDate": "2026-11-12", "description": "Cab to client site", "receiptBase64": "...", "receiptType": "image/jpeg", "fieldVisitId": "<optional>" }
```
- **Approval** works like remote work: the manager, then HR when `expenseRequiresHrApproval` is on. HR/admin approval is final.
- **Rejection** needs a reason.
- **Response:** each claim carries `progress` (the approval tracker), `amount` in rupees, `receiptUrl` (a 5-minute link), `reimbursed` and `reimbursedOutsidePayroll`.
- **Reimbursement:** approved, unreimbursed claims dated on or before a pay period's end are paid in that payroll run as `REIMBURSEMENT` lines. Approving the run marks them reimbursed.

### 17.6 Assets
```http
GET  /v1/assets?status=&employeeId=&category=&q=
POST /v1/assets ; PATCH /v1/assets/:id                    (ADMIN, HR) { tag, name, category, serialNo?, note? }
POST /v1/assets/:id/assign { "employeeId": "..." }        (ADMIN, HR)
POST /v1/assets/:id/return { "status": "IN_STOCK" | "RETIRED" }
POST /v1/assets/:id/retire ; GET /v1/assets/:id/history   (ADMIN, HR)
```
`tag` is unique per tenant. Status is `IN_STOCK` → `ASSIGNED` → back to `IN_STOCK` or `RETIRED`. History is the asset's audit trail. Non-HR callers see only assets assigned to people in their scope.

### 17.7 Announcements
```http
GET  /v1/announcements                         HR: all, with acks/audience counts · others: published ones that reach them, with ackAt
POST /v1/announcements ; PATCH /v1/announcements/:id      (drafts only)
POST /v1/announcements/:id/publish             → notifies the audience (push + inbox, type ANNOUNCEMENT)
POST /v1/announcements/:id/ack
GET  /v1/announcements/:id/acks                (ADMIN, HR) who has / hasn't acknowledged
DELETE /v1/announcements/:id
```
Body: `{ title, body, siteIds?: [], departmentIds?: [], requiresAck?: false }`. Empty lists mean everyone. A published announcement cannot be edited.

### 17.8 Profile change requests
```http
GET  /v1/profile-requests?status=&employeeId=     HR/admin: all in scope; others: their own
POST /v1/profile-requests { "changes": { "bankIfsc": "HDFC0001234", "currentAddress": "..." }, "reason": "Moved house" }
POST /v1/profile-requests/:id/approve|reject     (ADMIN, HR)
POST /v1/profile-requests/:id/cancel             (the employee)
```
- **Self-editable fields:** personal, contact and emergency details, statutory IDs and bank details. Fields marked `selfEditable` in `/employees/import/columns` can be requested; anything else gets `400 NOT_SELF_EDITABLE`.
- **One at a time:** only one request can be pending per employee.
- **Approval:** nothing changes until HR approves. Approval re-validates the values and applies them in one transaction.
- **Response:** each request includes `before` (current values) for the diff.

---

## 18. Payroll (`/v1/payroll`)

> **Access Control**: `ADMIN`, `HR` unless stated. Money in requests is **rupees**. Payroll run detail and payslip `lines` are **paise** (integers); payslip and salary reads for people are rupees.

### 18.1 Settings: pay cycle, locking, statutory
```http
GET /v1/payroll/settings ; PUT /v1/payroll/settings
```
| Field | Default | Meaning |
|---|---|---|
| `cycleStartDay` | 1 | 1–28. Month *M* covers day D of M−1 to day D−1 of M (26 → Nov = 26 Oct – 25 Nov). 1 = calendar month. |
| `payDay` | 1 | Credit day, printed on payslips |
| `lockOn` | `APPROVED` | `APPROVED` · `PAID` · `MANUAL` |
| `lockMode` | `BLOCK` | `BLOCK`: a locked period refuses attendance changes. `SNAPSHOT_ONLY`: changes allowed, shown as drift |
| `lockGraceDays` | 0 | Days after the period end before an automatic lock applies |
| `otEnabled`, `otMultiplier`, `otBase`, `standardHoursPerDay` | true, 2, `GROSS`, 8 | OT pay = hours × (base ÷ days in period ÷ hours/day) × multiplier |
| `pfRate`, `pfWageCap` | 12, 15000 | PF employee and employer on min(earned Basic + DA, cap) |
| `esiEmployeeRate`, `esiEmployerRate`, `esiThreshold` | 0.75, 3.25, 21000 | ESI when the full monthly gross ≤ threshold; on earned gross; rounded up to the rupee |
| `ptSlabs`, `defaultPtState` | KA, MH examples | `{ "KA": [{ "min": 0, "amount": 0 }, { "min": 25000, "amount": 200, "febAmount": 300 }] }`. Verify against the current state notification |

**Gapless periods:** the next run starts the day after the previous run's `periodEnd`. Changing `cycleStartDay` therefore makes one transition period (flagged in the run's warnings), never a gap or an overlap. Each run freezes its `periodStart` and `periodEnd`.

### 18.2 Period lock
When a run's period is locked (per `lockOn`, after `lockGraceDays`, or by a manual lock) and `lockMode` is `BLOCK`, these return **`409 PAYROLL_LOCKED`**, with `details: { month, periodStart, periodEnd }`, for any date inside the period:
- submitting or approving attendance corrections
- submitting, approving or cancelling (when already approved) leave
- remote-work requests and decisions
- rejecting a mobile check-in
- manual punches

Terminal punches are never refused; the run shows the drift instead (18.5).

### 18.3 Salary structures & salaries
```http
GET/POST /v1/payroll/structures ; PATCH /v1/payroll/structures/:id
GET  /v1/employees/:id/salaries        (HR/admin, or the employee)
POST /v1/employees/:id/salaries        (ADMIN, HR)
```
Structure:
```json
{ "name": "Standard", "components": [
  { "code": "BASIC", "name": "Basic", "kind": "EARNING", "calc": "PCT_GROSS", "value": 50, "prorate": true },
  { "code": "HRA", "name": "House rent allowance", "kind": "EARNING", "calc": "PCT_BASIC", "value": 50, "prorate": true },
  { "code": "SPECIAL", "name": "Special allowance", "kind": "EARNING", "calc": "BALANCE", "value": 0, "prorate": true } ] }
```
- `calc` is `FIXED` (₹/month), `PCT_GROSS`, `PCT_BASIC` or `BALANCE` (the rest of gross; at most one).
- Components are worked out in order: fixed and % of gross, then % of Basic, then the balance.
- PF uses the `BASIC` (+ `DA`) components.
- A "Standard" structure is seeded on first `GET`.

Salary: `{ effectiveFrom, structureId, monthlyGross, overrides?: { HRA: 4000 }, pf?, esi?, pt?, ptState? }`. Saving the same `effectiveFrom` again revises that row. The row with the latest `effectiveFrom` on or before the period end applies.

### 18.4 Adjustments & loans
```http
GET  /v1/payroll/adjustments?month=&employeeId= ; POST /v1/payroll/adjustments ; DELETE /v1/payroll/adjustments/:id
GET  /v1/payroll/loans?employeeId= ; POST /v1/payroll/loans ; POST /v1/payroll/loans/:id/close
```
- **Adjustment:** `{ employeeId | employeeIds: [...], month: "2026-11", kind: "EARNING" | "DEDUCTION", code: "BONUS" | "INCENTIVE" | "ARREARS" | "ADVANCE" | "OTHER", amount, note? }`. `employeeIds` adds the same adjustment for several people in one transaction and returns the created rows. It is refused for a month whose run is no longer a draft.
- **Loan:** `{ employeeId, principal, emi, startMonth, note? }`. The EMI (capped at what is outstanding) is deducted in every run from `startMonth`, and the loan closes itself when repaid. `recovered` and `outstanding` are derived from approved payslips.

### 18.5 Runs
```http
GET    /v1/payroll/runs
POST   /v1/payroll/runs { "month": "2026-11", "force": false }   create or recompute the month's DRAFT
GET    /v1/payroll/runs/:id                                     run + payslips + drift
POST   /v1/payroll/runs/:id/approve | paid | lock
POST   /v1/payroll/runs/:id/unlock                              (ADMIN)
DELETE /v1/payroll/runs/:id                                     latest draft only
GET    /v1/payroll/runs/:id/bank-file.csv                       approved/paid; BANK-mode payslips with net > 0
GET    /v1/payroll/runs/:id/register.csv                        one row per employee, every component a column
```
**Payable days** per employee:
- employed days = the period ∩ `joinedOn..exitOn`
- LOP = absences × the policy's `absenceDeduction` (half days and "half leave + half absent" count ½) + late penalty (`lateDeduction` every `lateDeductionEvery`) + unpaid-leave portions
- paid days = employed − LOP
- earnings are prorated by paid days ÷ days in the period

The same numbers appear in the `payable-days` report (§14).

**Creating a run:**
- **Refused cases:** `409 PERIOD_NOT_OVER` before the period ends and `409 ATTENDANCE_NOT_FINAL` while days are unfinalised (`details.pending`), unless `force`. Also `409 OUT_OF_ORDER` for a month before an existing run, and `409 RUN_CLOSED` to recompute an approved run.
- **What a payslip includes:** OT, adjustments for the month, loan EMIs, and approved, unreimbursed expense claims.
- **Warnings** list transition periods, unfinalised days, employees without a salary (left out), missing bank details, and structure problems.

**Approving and paying:**
- **Approve** consumes the adjustments and expense claims it pays.
- **Paid** notifies every employee (`PAYSLIP_READY`) and closes loans that are fully recovered.
- **Unlock** (admin, audited) returns an APPROVED run to DRAFT and releases what it consumed. A PAID run cannot be unlocked: settle later changes as `ARREARS`.

**Drift:** for an approved or paid run, `drift` lists employees whose paid days or OT changed since the run was computed (`paidDaysThen` / `paidDaysNow`).

Payslip line kinds are `EARNING`, `REIMBURSEMENT`, `DEDUCTION` and `EMPLOYER` (employer PF/ESI, not deducted). Net = earnings + reimbursements − deductions.

### 18.6 Payslips
```http
GET /v1/payroll/payslips/mine          (any role) the caller's paid payslips
GET /v1/employees/:id/payslips         HR/admin: all runs; the employee: paid runs only
GET /v1/payroll/payslips/:id           lines in rupees
GET /v1/payroll/payslips/:id/pdf       branded A4 PDF: pay days, LOP, earnings/deductions, net in words, employer contributions
```
An employee can open their own payslip only once its run is `PAID`.
