import { SetMetadata } from '@nestjs/common';

/**
 * The public API inventory (docs/public-api.md §4). Every routable public operation is
 * listed here; the guard refuses any handler without an @Op that resolves to an entry.
 *
 * Permission ids, operation ids and paths are contract: add, never rename. To retire
 * one, set `deprecated` (adds Deprecation/Sunset headers) and keep it working until sunset.
 */

/** The Iverto-Version new keys are pinned to (docs/public-api.md §3). */
export const CURRENT_API_VERSION = '2026-12-01';

export const HTTP_METHODS = ['GET', 'POST', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const MODULES = {
  org: 'Organisation (sites, departments)',
  employees: 'Employees',
  punches: 'Punches',
  attendance: 'Attendance',
  leave: 'Leave',
  reports: 'Reports',
} as const;
export type ModuleId = keyof typeof MODULES;

export const PERMISSIONS = {
  'org:read': { module: 'org', label: 'Read sites and departments' },
  'employees:read': { module: 'employees', label: 'Read employees' },
  'employees:write': { module: 'employees', label: 'Create and update employees in bulk' },
  'punches:read': { module: 'punches', label: 'Read punches' },
  'punches:write': { module: 'punches', label: 'Record punches' },
  'attendance:read': { module: 'attendance', label: 'Read attendance days' },
  'leave:read': { module: 'leave', label: 'Read leave types, requests and balances' },
  'leave:approve': { module: 'leave', label: 'Approve or reject leave requests' },
  'reports:generate': { module: 'reports', label: 'Generate attendance reports (CSV / PDF)' },
} as const satisfies Record<string, { module: ModuleId; label: string }>;
export type PermissionId = keyof typeof PERMISSIONS;

export interface Operation {
  id: string;
  method: HttpMethod;
  /** Public path (after the base URL https://ivertovm.indiasouthcentral.cloudapp.azure.com/att/v1/public). */
  path: string;
  /** null: any valid key (introspection). */
  permission: PermissionId | null;
  /** Rate-limit tokens and credits per call. */
  cost: number;
  summary: string;
  deprecated?: { since: string; sunset: string; replacement?: string };
}

const op = (id: string, method: HttpMethod, path: string, permission: PermissionId | null, summary: string, cost = 1): Operation => ({
  id,
  method,
  path,
  permission,
  cost,
  summary,
});

export const OPERATIONS: readonly Operation[] = [
  op('me.get', 'GET', '/me', null, 'Get the key, its permissions and its limits'),
  op('sites.list', 'GET', '/sites', 'org:read', 'List sites'),
  op('departments.list', 'GET', '/departments', 'org:read', 'List departments'),
  op('employees.list', 'GET', '/employees', 'employees:read', 'List employees'),
  op('employees.get', 'GET', '/employees/:id', 'employees:read', 'Get an employee'),
  op('punches.list', 'GET', '/punches', 'punches:read', 'List punches'),
  op('punches.create', 'POST', '/punches', 'punches:write', 'Record a punch'),
  op('attendance_days.list', 'GET', '/attendance-days', 'attendance:read', 'List attendance days'),
  op('leave_types.list', 'GET', '/leave-types', 'leave:read', 'List leave types'),
  op('leave_requests.list', 'GET', '/leave-requests', 'leave:read', 'List leave requests'),
  op('leave_requests.get', 'GET', '/leave-requests/:id', 'leave:read', 'Get a leave request'),
  op('leave_requests.approve', 'POST', '/leave-requests/:id/approve', 'leave:approve', 'Approve a leave request'),
  op('leave_requests.reject', 'POST', '/leave-requests/:id/reject', 'leave:approve', 'Reject a leave request'),
  op('leave_balances.list', 'GET', '/leave-balances', 'leave:read', 'List leave balances'),
  op('events.list', 'GET', '/events', null, 'List the events of the last 30 days', 0),
  op('employees.bulk_upsert', 'POST', '/employees/bulk', 'employees:write', 'Create or update employees in bulk (job)', 10),
  op('reports.create', 'POST', '/reports', 'reports:generate', 'Make a report file (job)', 25),
  op('jobs.list', 'GET', '/jobs', null, 'List jobs'),
  op('jobs.get', 'GET', '/jobs/:id', null, 'Get a job'),
];

/** Built-in report types exposed publicly (reports/definitions.ts); tenant-built templates are not. */
export const PUBLIC_REPORT_TYPES = [
  'daily-summary', 'muster-roll', 'payable-days', 'timesheet', 'punch-log', 'late-early', 'overtime', 'leave', 'absenteeism',
] as const;

/** Job types and the permission a key needs to see one. */
export const JOB_TYPES = {
  'employees.bulk_upsert': 'employees:write',
  report: 'reports:generate',
} as const satisfies Record<string, PermissionId>;
export type JobType = keyof typeof JOB_TYPES;

/**
 * Webhook event types (docs/public-api.md §10) — contract, like operations. Emitted by the
 * triggers in post-init/008-webhooks.sql. Receiving one needs its read permission: an
 * endpoint needs it allowed by the org policy; a key reading GET /events needs it on the key.
 */
export const EVENTS = {
  'punch.created': { permission: 'punches:read', label: 'Iverto stores a punch from a terminal, the mobile app, the web app or the API' },
  'attendance.day.finalized': { permission: 'attendance:read', label: 'The day of an employee closes' },
  'attendance.day.updated': { permission: 'attendance:read', label: 'A closed day changes, for example after a correction' },
  'leave.request.created': { permission: 'leave:read', label: 'An employee requests leave' },
  'leave.request.decided': { permission: 'leave:read', label: 'Someone approves, rejects or cancels a leave request' },
  'employee.created': { permission: 'employees:read', label: 'Someone adds an employee' },
  'employee.updated': { permission: 'employees:read', label: 'The data of an employee changes' },
  'employee.exited': { permission: 'employees:read', label: 'An employee leaves the organisation' },
  // Ids only; any key may receive it (the job itself is visible only with its type's permission).
  'job.completed': { permission: null, label: 'A bulk job or a report job finishes' },
  // Usage alert raised for the org (§15): data.type, data.level, data.message, data.apiKeyId.
  'api.alert': { permission: null, label: 'Iverto finds a usage problem, for example a rate limit, an expiring key or many errors' },
} as const satisfies Record<string, { permission: PermissionId | null; label: string }>;
export type EventType = keyof typeof EVENTS;
export const isEventType = (t: string): t is EventType => Object.prototype.hasOwnProperty.call(EVENTS, t);

export const OPERATION_BY_ID = new Map(OPERATIONS.map((o) => [o.id, o]));

/** HTTP methods each permission's operations use; a policy must allow all of them for the permission to work. */
export function methodsOf(permission: PermissionId): HttpMethod[] {
  return [...new Set(OPERATIONS.filter((o) => o.permission === permission).map((o) => o.method))];
}

export const isPermission = (p: string): p is PermissionId => Object.prototype.hasOwnProperty.call(PERMISSIONS, p);

export const OP_KEY = 'publicApiOperation';
/** Binds a handler to its registry entry. */
export const Op = (id: string) => SetMetadata(OP_KEY, id);
