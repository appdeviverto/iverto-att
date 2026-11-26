import { CURRENT_API_VERSION, EVENTS, JOB_TYPES, OPERATIONS, Operation, PERMISSIONS, PUBLIC_REPORT_TYPES } from './registry';

/**
 * The public OpenAPI 3.0 document (docs/public-api.md §14), built from the registry: paths,
 * methods, permissions and costs come from OPERATIONS, so a new operation without docs fails
 * public-api.spec.ts, and serializer fields are checked against these schemas there too.
 * Served to org admins and superadmins only; rendered in the web app with Scalar. The prose
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
  Site: obj({ object: constant('site'), id: str(), name: str(), address: nul(str()), timezone: str('The time zone of the site (IANA name).', { example: 'Asia/Kolkata' }), createdAt: instant(), updatedAt: instant() }),
  Department: obj({ object: constant('department'), id: str(), name: str(), code: nul(str()), headEmployeeId: nul(str()), createdAt: instant(), updatedAt: instant() }),
  EmployeePii: obj({
    dateOfBirth: nul(date()), gender: nul(oneOf(['MALE', 'FEMALE', 'OTHER'])), personalEmail: nul(str()), currentAddress: nul(str()), permanentAddress: nul(str()),
    pan: nul(str()), aadhaarLast4: nul(str()), uan: nul(str()), esicNumber: nul(str()), bankAccountName: nul(str()), bankAccountNumber: nul(str()), bankIfsc: nul(str()), bankName: nul(str()),
  }),
  Employee: obj({
    object: constant('employee'), id: str('The Iverto ID of the employee. It does not change.'), externalId: nul(str('The ID of the employee in your system. You set it with POST /employees/bulk.')), employeeCode: str('The employee code from HR. Terminals and reports show this code.'),
    fullName: str(), email: nul(str()), phone: nul(str()), designation: nul(str()), employmentType: str(), status: oneOf(['ACTIVE', 'EXITED']), siteId: str(), departmentId: nul(str()), managerId: nul(str()),
    joinedOn: date(), exitOn: nul(date()), pii: nul({ ...ref('EmployeePii'), description: 'Personal data. It has a value only if the key has PII access. Otherwise it is null.' }), createdAt: instant(), updatedAt: instant(),
  }),
  PunchLocation: obj({ lat: { type: 'number' }, lng: { type: 'number' }, accuracy: nul({ type: 'number', description: 'The accuracy of the location, in metres.' }) }),
  Punch: obj({
    object: constant('punch'), id: str(), employeeId: nul(str('The Iverto ID of the employee. It is null if the terminal does not know the person yet.')), siteId: str(), deviceId: nul(str()),
    punchedAt: instant('The time when the person punched. The terminal clock gives this time.'), workDate: nul(date('The attendance day of the punch. It is null until Iverto calculates it.')),
    source: oneOf(['TERMINAL', 'MOBILE', 'CORRECTION', 'MANUAL']), direction: oneOf(['in', 'out', 'unknown'], 'A terminal at a two-way gate sends unknown. Iverto then calculates the first in and the last out.'),
    outcome: oneOf(['GRANTED', 'DENIED', 'UNKNOWN']), reviewStatus: nul(oneOf(['PENDING', 'APPROVED', 'REJECTED'], 'Only for punches from the mobile app.')), reason: nul(str()), location: nul(ref('PunchLocation')),
    receivedAt: instant('The time when Iverto stored the punch. It is later than punchedAt if the terminal was offline.'), updatedAt: instant(),
  }),
  AttendanceDay: obj({
    object: constant('attendance_day'), id: str(), employeeId: str(), siteId: str(), workDate: date(), timezone: str(), dayType: oneOf(['WORKING', 'WEEKLY_OFF', 'HOLIDAY']), holidayName: nul(str()), shiftId: nul(str()),
    status: oneOf(['PENDING', 'PRESENT', 'HALF_DAY', 'ABSENT', 'ON_LEAVE', 'HALF_LEAVE', 'REMOTE', 'HOLIDAY', 'WEEKLY_OFF']), scheduledStart: nul(instant()), scheduledEnd: nul(instant()), firstIn: nul(instant()), lastOut: nul(instant()),
    workedMinutes: int(), breakMinutes: int(), lateMinutes: int(), earlyExitMinutes: int(), overtimeMinutes: int(), punchCount: int(), isLate: bool(), isEarlyExit: bool(), missedPunch: bool(),
    leavePortion: decimal(), leaveTypeId: nul(str()), permissionMinutes: int(), remote: bool(), corrected: bool(), finalizedAt: nul(instant('The time when the day closed. A closed day can still change after a correction.')), updatedAt: instant(),
  }),
  LeaveType: obj({ object: constant('leave_type'), id: str(), code: str(), name: str(), paid: bool(), active: bool(), unit: oneOf(['DAYS', 'HOURS']), allowHalfDay: bool(), createdAt: instant(), updatedAt: instant() }),
  LeaveRequest: obj({
    object: constant('leave_request'), id: str(), employeeId: str(), leaveTypeId: str(), startDate: date(), endDate: date(), startHalf: nul(oneOf(['FIRST', 'SECOND'])), endHalf: nul(oneOf(['FIRST', 'SECOND'])),
    startTime: nul(str('The start time (HH:mm). Only for leave types in hours.')), endTime: nul(str()), minutes: nul(int()), days: decimal(), reason: nul(str()), status: oneOf(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']),
    decidedAt: nul(instant()), decisionNote: nul(str()), createdAt: instant(), updatedAt: instant(),
  }),
  LeaveBalance: obj({ object: constant('leave_balance'), employeeId: str(), leaveTypeId: str(), leaveYear: int(), balance: nul(decimal()), pending: nul(decimal()), available: nul(decimal()) }),
  Deleted: obj({ object: str('The type of the deleted item.'), id: str(), deleted: { type: 'boolean', enum: [true] }, deletedAt: instant() }),
  Me: obj({
    object: constant('api_key'), id: str(), name: str(), organisationId: str(), permissions: { type: 'array', items: str() }, piiAccess: bool(), siteIds: { type: 'array', items: str(), description: 'The sites that the key can see. An empty list means all sites.' },
    limits: obj({ perMinute: int(), perDay: int(), concurrency: int(), keyPerMinute: int() }), credits: obj({ enabled: bool() }),
  }),
  Event: obj({ id: str('The event ID (evt_…). The webhook-id header has the same value.'), type: oneOf(Object.keys(EVENTS)), createdAt: instant(), apiVersion: str(), data: { type: 'object', description: 'IDs only. To get the full item, use the API.' } }),
  Job: obj({
    object: constant('job'), id: str(), type: oneOf(Object.keys(JOB_TYPES)), status: oneOf(['queued', 'running', 'succeeded', 'partially_succeeded', 'failed']),
    progress: nul(obj({ processed: int(), total: int() })), result: nul({ type: 'object', description: 'For a bulk job: summary and rows. For a report job: format, rowCount, sha256, downloadUrl, urlExpiresAt and expired.' }),
    error: nul(obj({ code: str(), message: str() })), createdAt: instant(), startedAt: nul(instant()), completedAt: nul(instant()), expiresAt: instant(),
  }),
  Problem: obj({ type: str(), title: str(), status: int(), code: str('The error code. It does not change. Use it in your code.'), requestId: str(), errors: nul({ description: 'More data about the error, for example the fields that are not correct.' }) }),
};

const listOf = (item: string, withDeletions = false): Schema =>
  obj({
    object: constant('list'),
    data: { type: 'array', items: withDeletions ? { oneOf: [ref(item), ref('Deleted')] } : ref(item) },
    hasMore: bool(),
    nextCursor: nul(str('Send this value as cursor to get the next page. Keep the last value for the next synchronization.')),
  });

interface Param { name: string; in: 'query' | 'path'; schema: Schema; description?: string; required?: boolean }
const q = (name: string, schema: Schema, description?: string): Param => ({ name, in: 'query', schema, description });
const LIST = [
  q('limit', int(undefined, { minimum: 1, maximum: 200, default: 50 }), 'The number of items on one page.'),
  q('cursor', str(), 'The nextCursor value from the previous page.'),
  q('updatedSince', instant(), 'Get only the items that changed at or after this time. Deleted items come back with deleted: true.'),
];
const RANGE_YMD = [q('from', date(), 'The first day.'), q('to', date(), 'The last day. It is included. It is 93 days or fewer after from.')];

interface OpDoc { tag: string; params?: Param[]; body?: Schema; response: Schema; status?: number; description?: string }

const BULK_FIELDS =
  'The employee records. Fields: `employeeCode`, `externalId`, `fullName`, `joinedOn`, `siteId`, `departmentId`, `managerEmployeeCode`, `designation`, `employmentType`, `mobilePunch`, `email`, `phone`, `probationEndOn`, `confirmedOn`, `noticePeriodDays`. With PII access, you can also send date of birth, gender, addresses, emergency contact, `pan`, `aadhaarLast4`, `uan`, `esicNumber` and bank fields. If you do not send a field, Iverto keeps the current value. If you send `null`, Iverto removes the value.';

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
        records: { type: 'array', minItems: 1, maxItems: 5000, items: { type: 'object', additionalProperties: true, example: { employeeCode: 'E1001', fullName: 'Asha Rao', joinedOn: '2026-04-01', siteId: 'SITE_ID', designation: 'Technician' } }, description: BULK_FIELDS },
        validateOnly: bool('If true, Iverto checks the records and tells you the result. It does not change data.'),
        onInvalid: oneOf(['skip', 'reject'], 'skip (default): Iverto saves the correct records. reject: if one record is incorrect, Iverto saves no records.'),
      },
      ['validateOnly', 'onInvalid'],
    ),
    response: ref('Job'),
    description: 'Iverto finds each record by `employeeCode`. If the record has no code, Iverto uses `externalId`. Iverto checks the values with the same rules as the CSV import in the web app. To get the result, send `GET /jobs/{id}` or use the `job.completed` webhook.',
  },
  'punches.list': {
    tag: 'Punches',
    params: [...LIST, q('employeeId', str()), q('siteId', str()), q('from', instant(), 'Get punches with punchedAt at or after this time.'), q('to', instant(), 'Get punches with punchedAt before this time.')],
    response: listOf('Punch', true),
    description:
      'Use `from` and `to` to get the punches of a past period. These filters use the time when the person punched.\n\nA terminal without a connection stores punches. It sends them later with the original times. To get these late punches, synchronize with `cursor` or `updatedSince`. These use the time when Iverto stored the punch.',
  },
  'punches.create': {
    tag: 'Punches',
    status: 201,
    body: obj({ employeeId: str(), punchedAt: instant(), direction: oneOf(['in', 'out']), reason: str(undefined, { minLength: 3, maxLength: 500 }) }),
    response: ref('Punch'),
    description: 'Records one manual punch (source MANUAL). The audit log shows your key as the actor. Iverto refuses punches in a closed payroll period.',
  },
  'attendance_days.list': { tag: 'Attendance', params: [...LIST, q('employeeId', str()), q('siteId', str()), ...RANGE_YMD], response: listOf('AttendanceDay', true) },
  'leave_types.list': { tag: 'Leave', params: LIST, response: listOf('LeaveType', true) },
  'leave_requests.list': {
    tag: 'Leave',
    params: [...LIST, q('employeeId', str()), q('status', oneOf(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'])), q('from', date(), 'Get requests that include days on or after this date.'), q('to', date(), 'Get requests that include days on or before this date.')],
    response: listOf('LeaveRequest', true),
  },
  'leave_requests.get': { tag: 'Leave', response: ref('LeaveRequest') },
  'leave_requests.approve': { tag: 'Leave', body: obj({ note: str(undefined, { maxLength: 1000 }) }, ['note']), response: ref('LeaveRequest'), description: 'Your approval counts as a manager approval. If the leave type also needs HR approval, the request waits for HR.' },
  'leave_requests.reject': { tag: 'Leave', body: obj({ note: str(undefined, { minLength: 3, maxLength: 1000 }) }), response: ref('LeaveRequest') },
  'leave_balances.list': {
    tag: 'Leave',
    params: [q('year', int('The leave year. A leave year starts in April. The default is the current leave year.')), q('employeeId', str()), q('limit', int(undefined, { minimum: 1, maximum: 200 })), q('cursor', str())],
    response: listOf('LeaveBalance'),
  },
  'events.list': {
    tag: 'Events',
    params: [q('type', oneOf(Object.keys(EVENTS))), q('since', instant(), 'The start time, if you have no cursor.'), q('limit', int(undefined, { minimum: 1, maximum: 200 })), q('cursor', str())],
    response: listOf('Event'),
    description: 'Gives the same events as the webhooks. Use it if you cannot receive webhooks, or if you did not receive some events. Iverto keeps events for 30 days. You get only the event types that your key has permission for.',
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
  'jobs.get': { tag: 'Jobs', response: ref('Job'), description: 'For a report job, the result has a download link. The link is valid for 15 minutes. Each call gives a new link.' },
};

const TAGS = [
  ['Key', 'Information about the API key that sends the request.'],
  ['Organisation', 'The sites and departments of your organisation.'],
  ['Employees', 'The employees of your organisation.'],
  ['Punches', 'Punches from terminals, the mobile app, corrections and manual entry.'],
  ['Attendance', 'The attendance of each employee for each day, as Iverto calculates it.'],
  ['Leave', 'Leave types, leave requests and leave balances.'],
  ['Events', 'The list of events that the webhooks send.'],
  ['Jobs', 'Bulk updates and reports. They run in the background.'],
];

function operation(op: Operation) {
  const doc = OPERATION_DOCS[op.id];
  const pathParams = [...op.path.matchAll(/:(\w+)/g)].map((m): Param => ({ name: m[1], in: 'path', required: true, schema: str() }));
  const headers = [
    ...(op.method === 'POST' ? [{ name: 'Idempotency-Key', in: 'header', required: true, schema: str(undefined, { maxLength: 200, example: 'a3f1c2e4-5b6d-4e7f-8a9b-0c1d2e3f4a5b' }), description: 'A unique value for each new action. If you send the request again with the same key and body, you get the first response.' }] : []),
    { name: 'Iverto-Timestamp', in: 'header', schema: str(), description: 'Optional. For request signing: the current time in Unix seconds.' },
    { name: 'Iverto-Signature', in: 'header', schema: str(), description: 'Optional. For request signing: the Ed25519 signature in base64.' },
  ];
  const status = String(doc.status ?? 200);
  const permission = op.permission ? `Permission: \`${op.permission}\` (${PERMISSIONS[op.permission].label}).` : 'Permission: none. Each valid key can use it.';
  return {
    operationId: op.id,
    summary: op.summary,
    tags: [doc.tag],
    description: [doc.description, `${permission}\n\nCost: ${op.cost} ${op.cost === 1 ? 'unit' : 'units'} of your rate limit.`].filter(Boolean).join('\n\n'),
    ...(op.deprecated && { deprecated: true }),
    parameters: [...pathParams, ...(doc.params ?? []), ...headers],
    ...(doc.body && { requestBody: { required: true, content: { 'application/json': { schema: doc.body } } } }),
    responses: {
      [status]: { description: status === '202' ? 'Accepted. The response is a job.' : 'OK', content: { 'application/json': { schema: doc.response } } },
      ...(op.method === 'GET' && { '304': { description: 'Not modified. Nothing changed since the ETag that you sent in If-None-Match. It costs nothing.' } }),
      '4XX': { description: 'Error in the request. See the code field.', content: { 'application/problem+json': { schema: ref('Problem') } } },
      '5XX': { description: 'Error on the server. Try again later.', content: { 'application/problem+json': { schema: ref('Problem') } } },
    },
    'x-permission': op.permission,
    'x-cost': op.cost,
  };
}

export const API_BASE_URL = 'https://ivertovm.indiasouthcentral.cloudapp.azure.com/att/v1/public';

export function buildOpenApi(serverUrl = API_BASE_URL) {
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
          description: `${e.label}. ${e.permission ? `Your organisation needs the \`${e.permission}\` permission. ` : ''}Iverto signs the request with the headers webhook-id, webhook-timestamp and webhook-signature.`,
          requestBody: { content: { 'application/json': { schema: ref('Event') } } },
          responses: { '200': { description: 'Reply with any 2xx status. For other replies, Iverto sends the event again.' } },
        },
      },
    ]),
  );
  return {
    openapi: '3.0.3',
    info: {
      title: 'Iverto Attend API',
      version: CURRENT_API_VERSION,
      description: 'Connect your payroll, ERP, HR or access-control system to Iverto Attend. Use the API only from a server.',
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
