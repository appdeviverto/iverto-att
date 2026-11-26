import { CURRENT_API_VERSION, EVENTS, JOB_TYPES, OPERATIONS, Operation, PERMISSIONS, PUBLIC_REPORT_TYPES } from './registry';

/**
 * The public OpenAPI 3.0 document (docs/public-api.md §14), built from the registry: paths,
 * methods, permissions and costs come from OPERATIONS, so a new operation without docs fails
 * public-api.spec.ts, and serializer fields are checked against these schemas there too.
 * Served to org admins and superadmins only; rendered in the web app with Redoc. The prose
 * guides (auth, sync, webhooks, signing) come from docs/public-api-reference.md.
 */

type Schema = Record<string, unknown>;
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const str = (description?: string, extra: Schema = {}): Schema => ({ type: 'string', ...(description && { description }), ...extra });
const int = (description?: string, extra: Schema = {}): Schema => ({ type: 'integer', ...(description && { description }), ...extra });
const bool = (description?: string): Schema => ({ type: 'boolean', ...(description && { description }) });
const nul = (s: Schema): Schema => (s.$ref ? { allOf: [s], nullable: true } : { ...s, nullable: true });
const instant = (d?: string) => str(d, { format: 'date-time' });
const date = (d?: string) => str(d, { format: 'date' });
const decimal = (d?: string) => str(d, { pattern: '^-?\\d+\\.\\d$', example: '1.0' });
const oneOf = (values: readonly string[], d?: string) => str(d, { enum: [...values] });
const obj = (properties: Record<string, Schema>, optional: string[] = []): Schema => ({
  type: 'object',
  properties,
  required: Object.keys(properties).filter((k) => !optional.includes(k)),
});
const constant = (v: string) => str(undefined, { enum: [v] });

/** Response schemas: one per serializer in serializers.ts (fields checked by the spec test). */
export const SCHEMAS: Record<string, Schema> = {
  Site: obj({ object: constant('site'), id: str(), name: str(), address: nul(str()), timezone: str('IANA zone', { example: 'Asia/Kolkata' }), createdAt: instant(), updatedAt: instant() }),
  Department: obj({ object: constant('department'), id: str(), name: str(), code: nul(str()), headEmployeeId: nul(str()), createdAt: instant(), updatedAt: instant() }),
  EmployeePii: obj({
    dateOfBirth: nul(date()), gender: nul(oneOf(['MALE', 'FEMALE', 'OTHER'])), personalEmail: nul(str()), currentAddress: nul(str()), permanentAddress: nul(str()),
    pan: nul(str()), aadhaarLast4: nul(str()), uan: nul(str()), esicNumber: nul(str()), bankAccountName: nul(str()), bankAccountNumber: nul(str()), bankIfsc: nul(str()), bankName: nul(str()),
  }),
  Employee: obj({
    object: constant('employee'), id: str('Iverto employee id (stable)'), externalId: nul(str('Your system\'s id, set by bulk upsert')), employeeCode: str('The code HR assigned, shown on terminals and reports'),
    fullName: str(), email: nul(str()), phone: nul(str()), designation: nul(str()), employmentType: str(), status: oneOf(['ACTIVE', 'EXITED']), siteId: str(), departmentId: nul(str()), managerId: nul(str()),
    joinedOn: date(), exitOn: nul(date()), pii: nul({ ...ref('EmployeePii'), description: 'Only for keys with PII access; otherwise null' }), createdAt: instant(), updatedAt: instant(),
  }),
  PunchLocation: obj({ lat: { type: 'number' }, lng: { type: 'number' }, accuracy: nul({ type: 'number', description: 'metres' }) }),
  Punch: obj({
    object: constant('punch'), id: str(), employeeId: nul(str('null until an unknown terminal user is matched to an employee')), siteId: str(), deviceId: nul(str()),
    punchedAt: instant('When the person punched (the terminal\'s clock), not when Iverto received it'), workDate: nul(date('The attendance day it counts towards; null until computed')),
    source: oneOf(['TERMINAL', 'MOBILE', 'CORRECTION', 'MANUAL']), direction: oneOf(['in', 'out', 'unknown'], '"unknown" on two-way gates: the attendance engine pairs first in / last out'),
    outcome: oneOf(['GRANTED', 'DENIED', 'UNKNOWN']), reviewStatus: nul(oneOf(['PENDING', 'APPROVED', 'REJECTED'], 'Mobile punches only')), reason: nul(str()), location: nul(ref('PunchLocation')),
    receivedAt: instant('When Iverto stored it: later than punchedAt for logs a terminal buffered while offline'), updatedAt: instant(),
  }),
  AttendanceDay: obj({
    object: constant('attendance_day'), id: str(), employeeId: str(), siteId: str(), workDate: date(), timezone: str(), dayType: oneOf(['WORKING', 'WEEKLY_OFF', 'HOLIDAY']), holidayName: nul(str()), shiftId: nul(str()),
    status: oneOf(['PENDING', 'PRESENT', 'HALF_DAY', 'ABSENT', 'ON_LEAVE', 'HALF_LEAVE', 'REMOTE', 'HOLIDAY', 'WEEKLY_OFF']), scheduledStart: nul(instant()), scheduledEnd: nul(instant()), firstIn: nul(instant()), lastOut: nul(instant()),
    workedMinutes: int(), breakMinutes: int(), lateMinutes: int(), earlyExitMinutes: int(), overtimeMinutes: int(), punchCount: int(), isLate: bool(), isEarlyExit: bool(), missedPunch: bool(),
    leavePortion: decimal(), leaveTypeId: nul(str()), permissionMinutes: int(), remote: bool(), corrected: bool(), finalizedAt: nul(instant('Set when the day closes; it can still change after (corrections)')), updatedAt: instant(),
  }),
  LeaveType: obj({ object: constant('leave_type'), id: str(), code: str(), name: str(), paid: bool(), active: bool(), unit: oneOf(['DAYS', 'HOURS']), allowHalfDay: bool(), createdAt: instant(), updatedAt: instant() }),
  LeaveRequest: obj({
    object: constant('leave_request'), id: str(), employeeId: str(), leaveTypeId: str(), startDate: date(), endDate: date(), startHalf: nul(oneOf(['FIRST', 'SECOND'])), endHalf: nul(oneOf(['FIRST', 'SECOND'])),
    startTime: nul(str('HH:mm, hourly types')), endTime: nul(str()), minutes: nul(int()), days: decimal(), reason: nul(str()), status: oneOf(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']),
    decidedAt: nul(instant()), decisionNote: nul(str()), createdAt: instant(), updatedAt: instant(),
  }),
  LeaveBalance: obj({ object: constant('leave_balance'), employeeId: str(), leaveTypeId: str(), leaveYear: int(), balance: nul(decimal()), pending: nul(decimal()), available: nul(decimal()) }),
  Deleted: obj({ object: str('The resource type'), id: str(), deleted: { type: 'boolean', enum: [true] }, deletedAt: instant() }),
  Me: obj({
    object: constant('api_key'), id: str(), name: str(), organisationId: str(), permissions: { type: 'array', items: str() }, piiAccess: bool(), siteIds: { type: 'array', items: str(), description: 'Empty: every site' },
    limits: obj({ perMinute: int(), perDay: int(), concurrency: int(), keyPerMinute: int() }), credits: obj({ enabled: bool() }),
  }),
  Event: obj({ id: str('evt_…; also the webhook-id header'), type: oneOf(Object.keys(EVENTS)), createdAt: instant(), apiVersion: str(), data: { type: 'object', description: 'Ids only: fetch the resource for its current state' } }),
  Job: obj({
    object: constant('job'), id: str(), type: oneOf(Object.keys(JOB_TYPES)), status: oneOf(['queued', 'running', 'succeeded', 'partially_succeeded', 'failed']),
    progress: nul(obj({ processed: int(), total: int() })), result: nul({ type: 'object', description: 'Bulk: { summary, rows }. Report: { format, rowCount, sha256, downloadUrl, urlExpiresAt, expired }' }),
    error: nul(obj({ code: str(), message: str() })), createdAt: instant(), startedAt: nul(instant()), completedAt: nul(instant()), expiresAt: instant(),
  }),
  Problem: obj({ type: str(), title: str(), status: int(), code: str('Stable: switch on this'), requestId: str(), errors: nul({ description: 'Details, e.g. field errors' }) }),
};

const listOf = (item: string, withDeletions = false): Schema =>
  obj({
    object: constant('list'),
    data: { type: 'array', items: withDeletions ? { oneOf: [ref(item), ref('Deleted')] } : ref(item) },
    hasMore: bool(),
    nextCursor: nul(str('Pass as `cursor`. Keep the last one: it resumes the sync later')),
  });

interface Param { name: string; in: 'query' | 'path'; schema: Schema; description?: string; required?: boolean }
const q = (name: string, schema: Schema, description?: string): Param => ({ name, in: 'query', schema, description });
const LIST = [
  q('limit', int(undefined, { minimum: 1, maximum: 200, default: 50 })),
  q('cursor', str(), 'nextCursor of the previous page'),
  q('updatedSince', instant(), 'Incremental sync: rows changed at or after this instant, plus deletions (as `deleted: true` items)'),
];
const RANGE_YMD = [q('from', date()), q('to', date(), 'Inclusive; at most 93 days after from')];

interface OpDoc { tag: string; params?: Param[]; body?: Schema; response: Schema; status?: number; description?: string }

const BULK_FIELDS =
  'Fields: `employeeCode`, `externalId`, `fullName`, `joinedOn`, `siteId`, `departmentId`, `managerEmployeeCode`, `designation`, `employmentType`, `mobilePunch`, `email`, `phone`, `probationEndOn`, `confirmedOn`, `noticePeriodDays`; with PII access also date of birth, gender, addresses, emergency contact, `pan`, `aadhaarLast4`, `uan`, `esicNumber` and bank fields. A field left out is kept; `null` clears it.';

/** Per-operation docs. Every OPERATIONS entry must have one (public-api.spec.ts). */
export const OPERATION_DOCS: Record<string, OpDoc> = {
  'me.get': { tag: 'Key', response: ref('Me') },
  'sites.list': { tag: 'Organisation', params: LIST, response: listOf('Site', true) },
  'departments.list': { tag: 'Organisation', params: LIST, response: listOf('Department', true) },
  'employees.list': {
    tag: 'Employees',
    params: [...LIST, q('status', oneOf(['ACTIVE', 'EXITED'])), q('siteId', str()), q('departmentId', str()), q('externalId', str()), q('employeeCode', str())],
    response: listOf('Employee', true),
  },
  'employees.get': { tag: 'Employees', response: ref('Employee') },
  'employees.bulk_upsert': {
    tag: 'Employees',
    status: 202,
    body: obj(
      {
        records: { type: 'array', minItems: 1, maxItems: 5000, items: { type: 'object', additionalProperties: true }, description: BULK_FIELDS },
        validateOnly: bool('Report what would happen; write nothing'),
        onInvalid: oneOf(['skip', 'reject'], 'skip (default): apply the valid records. reject: write nothing if any record is invalid'),
      },
      ['validateOnly', 'onInvalid'],
    ),
    response: ref('Job'),
    description: 'Matches by `employeeCode`, or by `externalId` when the code is left out. Validated like the CSV import in the web app. Poll the job or subscribe to `job.completed`.',
  },
  'punches.list': {
    tag: 'Punches',
    params: [...LIST, q('employeeId', str()), q('siteId', str()), q('from', instant(), 'punchedAt ≥ from'), q('to', instant(), 'punchedAt < to')],
    response: listOf('Punch', true),
    description:
      'Historical punches by `from`/`to` (when people punched). To catch punches a terminal uploads late (it buffers while offline and sends the backlog on reconnect, with the original punch times), sync with `updatedSince`/`cursor`, which follow when Iverto stored or changed each punch.',
  },
  'punches.create': {
    tag: 'Punches',
    status: 201,
    body: obj({ employeeId: str(), punchedAt: instant(), direction: oneOf(['in', 'out']), reason: str(undefined, { minLength: 3, maxLength: 500 }) }),
    response: ref('Punch'),
    description: 'A manual punch (source MANUAL), audited with the key as the actor. Refused in closed payroll periods.',
  },
  'attendance_days.list': { tag: 'Attendance', params: [...LIST, q('employeeId', str()), q('siteId', str()), ...RANGE_YMD], response: listOf('AttendanceDay', true) },
  'leave_types.list': { tag: 'Leave', params: LIST, response: listOf('LeaveType', true) },
  'leave_requests.list': {
    tag: 'Leave',
    params: [...LIST, q('employeeId', str()), q('status', oneOf(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'])), q('from', date(), 'Requests overlapping from…to'), q('to', date())],
    response: listOf('LeaveRequest', true),
  },
  'leave_requests.get': { tag: 'Leave', response: ref('LeaveRequest') },
  'leave_requests.approve': { tag: 'Leave', body: obj({ note: str(undefined, { maxLength: 1000 }) }, ['note']), response: ref('LeaveRequest'), description: 'Counts as a manager approval: types that need HR approval still wait for HR.' },
  'leave_requests.reject': { tag: 'Leave', body: obj({ note: str(undefined, { minLength: 3, maxLength: 1000 }) }), response: ref('LeaveRequest') },
  'leave_balances.list': {
    tag: 'Leave',
    params: [q('year', int('Leave year (starts in April); default: current')), q('employeeId', str()), q('limit', int(undefined, { minimum: 1, maximum: 200 })), q('cursor', str())],
    response: listOf('LeaveBalance'),
  },
  'events.list': {
    tag: 'Events',
    params: [q('type', oneOf(Object.keys(EVENTS))), q('since', instant(), 'Start when there is no cursor'), q('limit', int(undefined, { minimum: 1, maximum: 200 })), q('cursor', str())],
    response: listOf('Event'),
    description: 'What webhooks deliver, for consumers that poll or missed deliveries. Kept 30 days; only event types the key\'s permissions cover.',
  },
  'reports.create': {
    tag: 'Jobs',
    status: 202,
    body: obj({
      type: oneOf(PUBLIC_REPORT_TYPES),
      format: oneOf(['csv', 'pdf']),
      filters: obj(
        { dateFrom: date(), dateTo: date(), siteIds: { type: 'array', items: str() }, departmentIds: { type: 'array', items: str() }, employeeIds: { type: 'array', items: str() }, groupBy: oneOf(['none', 'department', 'site']) },
        ['siteIds', 'departmentIds', 'employeeIds', 'groupBy'],
      ),
    }),
    response: ref('Job'),
  },
  'jobs.list': { tag: 'Jobs', params: [q('type', oneOf(Object.keys(JOB_TYPES))), q('cursor', str())], response: listOf('Job') },
  'jobs.get': { tag: 'Jobs', response: ref('Job'), description: 'Report jobs include a download URL valid for 15 minutes, minted on every call.' },
};

const TAGS = [
  ['Key', 'The calling key'],
  ['Organisation', 'Sites and departments'],
  ['Employees', 'The employee directory'],
  ['Punches', 'Raw punches from terminals, mobile, corrections and manual entry'],
  ['Attendance', 'Computed attendance days'],
  ['Leave', 'Leave types, requests and balances'],
  ['Events', 'The event log behind webhooks'],
  ['Jobs', 'Bulk writes and reports, run in the background'],
];

function operation(op: Operation) {
  const doc = OPERATION_DOCS[op.id];
  const pathParams = [...op.path.matchAll(/:(\w+)/g)].map((m): Param => ({ name: m[1], in: 'path', required: true, schema: str() }));
  const headers = [
    ...(op.method === 'POST' ? [{ name: 'Idempotency-Key', in: 'header', required: true, schema: str(undefined, { maxLength: 200 }), description: 'Unique per logical write; a retry with the same key and body returns the first response' }] : []),
    { name: 'Iverto-Timestamp', in: 'header', schema: str(), description: 'Request signing (optional): unix seconds' },
    { name: 'Iverto-Signature', in: 'header', schema: str(), description: 'Request signing (optional): base64 Ed25519 signature' },
  ];
  const status = String(doc.status ?? 200);
  const permission = op.permission ? `Permission: \`${op.permission}\` (${PERMISSIONS[op.permission].label}).` : 'Any valid key.';
  return {
    operationId: op.id,
    summary: op.summary,
    tags: [doc.tag],
    description: [doc.description, `${permission} Cost: ${op.cost} ${op.cost === 1 ? 'unit' : 'units'}.`].filter(Boolean).join('\n\n'),
    ...(op.deprecated && { deprecated: true }),
    parameters: [...pathParams, ...(doc.params ?? []), ...headers],
    ...(doc.body && { requestBody: { required: true, content: { 'application/json': { schema: doc.body } } } }),
    responses: {
      [status]: { description: status === '202' ? 'Accepted: a job' : 'OK', content: { 'application/json': { schema: doc.response } } },
      ...(op.method === 'GET' && { '304': { description: 'Not modified (If-None-Match); costs nothing' } }),
      '4XX': { description: 'Error (problem+json)', content: { 'application/problem+json': { schema: ref('Problem') } } },
      '5XX': { description: 'Server error (problem+json)', content: { 'application/problem+json': { schema: ref('Problem') } } },
    },
    'x-permission': op.permission,
    'x-cost': op.cost,
  };
}

export function buildOpenApi(serverUrl = 'https://api.iverto.ai/v1') {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPERATIONS) {
    const path = op.path.replace(/:(\w+)/g, '{$1}');
    paths[path] = { ...paths[path], [op.method.toLowerCase()]: operation(op) };
  }
  const webhooks = Object.fromEntries(
    Object.entries(EVENTS).map(([type, e]) => [
      type,
      {
        post: {
          summary: type,
          description: `${e.label}. ${e.permission ? `Needs \`${e.permission}\`.` : ''} Signed with Standard Webhooks headers (webhook-id, webhook-timestamp, webhook-signature).`,
          requestBody: { content: { 'application/json': { schema: ref('Event') } } },
          responses: { '200': { description: 'Any 2xx acknowledges the delivery; anything else is retried' } },
        },
      },
    ]),
  );
  return {
    openapi: '3.0.3',
    info: {
      title: 'Iverto Attend API',
      version: CURRENT_API_VERSION,
      description: 'Attendance, leave and employee data for payroll, ERP, HR and access-control integrations. Server-to-server only.',
    },
    servers: [{ url: serverUrl }],
    security: [{ apiKey: [] }],
    tags: TAGS.map(([name, description]) => ({ name, description })),
    paths,
    'x-webhooks': webhooks,
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'ivk_live_…' } },
      schemas: SCHEMAS,
    },
  };
}
