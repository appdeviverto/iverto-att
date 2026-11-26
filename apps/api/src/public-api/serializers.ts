import { AttendanceDay, Department, Employee, LeaveRequest, LeaveType, Prisma, Punch, Site } from '@prisma/client';

/**
 * Public response shapes (§3): an explicit allowlist per resource, so a column added to the
 * database never appears in the API by accident. Every documented field is always present
 * (null, never omitted). Instants are RFC 3339 UTC, calendar dates YYYY-MM-DD, quantities
 * that are decimals in the DB are strings.
 */

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const dec = (d: Prisma.Decimal | null) => (d === null ? null : d.toFixed(1));

export const presentSite = (s: Site) => ({
  object: 'site' as const,
  id: s.id,
  name: s.name,
  address: s.address,
  timezone: s.timezone,
  createdAt: iso(s.createdAt),
  updatedAt: iso(s.updatedAt),
});

export const presentDepartment = (d: Department) => ({
  object: 'department' as const,
  id: d.id,
  name: d.name,
  code: d.code,
  headEmployeeId: d.headEmployeeId,
  createdAt: iso(d.createdAt),
  updatedAt: iso(d.updatedAt),
});

/** PII only for keys with PII access (and an org policy that allows it); otherwise `pii: null`. */
export const presentEmployee = (e: Employee, pii: boolean) => ({
  object: 'employee' as const,
  id: e.id,
  externalId: e.externalId,
  employeeCode: e.employeeCode,
  fullName: e.fullName,
  email: e.email,
  phone: e.phone,
  designation: e.designation,
  employmentType: e.employmentType,
  status: e.status,
  siteId: e.siteId,
  departmentId: e.departmentId,
  managerId: e.managerId,
  joinedOn: ymd(e.joinedOn),
  exitOn: ymd(e.exitOn),
  pii: pii
    ? {
        dateOfBirth: ymd(e.dateOfBirth),
        gender: e.gender,
        personalEmail: e.personalEmail,
        currentAddress: e.currentAddress,
        permanentAddress: e.permanentAddress,
        pan: e.pan,
        aadhaarLast4: e.aadhaarLast4,
        uan: e.uan,
        esicNumber: e.esicNumber,
        bankAccountName: e.bankAccountName,
        bankAccountNumber: e.bankAccountNumber,
        bankIfsc: e.bankIfsc,
        bankName: e.bankName,
      }
    : null,
  createdAt: iso(e.createdAt),
  updatedAt: iso(e.updatedAt),
});

export const presentPunch = (p: Punch) => ({
  object: 'punch' as const,
  id: p.id,
  employeeId: p.employeeId,
  siteId: p.siteId,
  deviceId: p.deviceId,
  punchedAt: iso(p.punchedAt),
  workDate: ymd(p.workDate),
  source: p.source,
  direction: p.direction,
  outcome: p.outcome,
  reviewStatus: p.reviewStatus,
  reason: p.reason,
  location: p.lat !== null && p.lng !== null ? { lat: p.lat, lng: p.lng, accuracy: p.accuracy } : null,
  receivedAt: iso(p.receivedAt),
  updatedAt: iso(p.updatedAt),
});

export const presentAttendanceDay = (d: AttendanceDay) => ({
  object: 'attendance_day' as const,
  id: d.id,
  employeeId: d.employeeId,
  siteId: d.siteId,
  workDate: ymd(d.workDate),
  timezone: d.timezone,
  dayType: d.dayType,
  holidayName: d.holidayName,
  shiftId: d.shiftId,
  status: d.status,
  scheduledStart: iso(d.schedStart),
  scheduledEnd: iso(d.schedEnd),
  firstIn: iso(d.firstIn),
  lastOut: iso(d.lastOut),
  workedMinutes: d.workedMinutes,
  breakMinutes: d.breakMinutes,
  lateMinutes: d.lateMinutes,
  earlyExitMinutes: d.earlyExitMinutes,
  overtimeMinutes: d.overtimeMinutes,
  punchCount: d.punchCount,
  isLate: d.isLate,
  isEarlyExit: d.isEarlyExit,
  missedPunch: d.missedPunch,
  leavePortion: dec(d.leavePortion),
  leaveTypeId: d.leaveTypeId,
  permissionMinutes: d.permissionMinutes,
  remote: d.remote,
  corrected: d.corrected,
  finalizedAt: iso(d.finalizedAt),
  updatedAt: iso(d.updatedAt),
});

export const presentLeaveType = (t: LeaveType) => ({
  object: 'leave_type' as const,
  id: t.id,
  code: t.code,
  name: t.name,
  paid: t.paid,
  active: t.active,
  unit: t.unit,
  allowHalfDay: t.allowHalfDay,
  createdAt: iso(t.createdAt),
  updatedAt: iso(t.updatedAt),
});

export const presentLeaveRequest = (r: LeaveRequest) => ({
  object: 'leave_request' as const,
  id: r.id,
  employeeId: r.employeeId,
  leaveTypeId: r.leaveTypeId,
  startDate: ymd(r.startDate),
  endDate: ymd(r.endDate),
  startHalf: r.startHalf,
  endHalf: r.endHalf,
  startTime: r.startTime,
  endTime: r.endTime,
  minutes: r.minutes,
  days: dec(r.days),
  reason: r.reason,
  status: r.status,
  decidedAt: iso(r.decidedAt),
  decisionNote: r.decisionNote,
  createdAt: iso(r.createdAt),
  updatedAt: iso(r.updatedAt),
});

/** A row of the leave_balances view (raw SQL: numerics may arrive as Decimal or string). */
const num1 = (v: unknown) => (v === null || v === undefined ? null : Number(v).toFixed(1));
export const presentLeaveBalance = (b: { employee_id: string; leave_type_id: string; leave_year: number; balance: unknown; pending: unknown; available: unknown }) => ({
  object: 'leave_balance' as const,
  employeeId: b.employee_id,
  leaveTypeId: b.leave_type_id,
  leaveYear: b.leave_year,
  balance: num1(b.balance),
  pending: num1(b.pending),
  available: num1(b.available),
});
