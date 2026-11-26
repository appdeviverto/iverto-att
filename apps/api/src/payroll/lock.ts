import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { addDays, dbDate, ymdOf, Ymd } from '../common/time';
import { PayrollSettings, payrollSettingsOf } from './engine';

export interface LockableRun {
  month: string;
  periodStart: Ymd;
  periodEnd: Ymd;
  status: string;
  lockedAt: Date | null;
}

/**
 * Is this run's period closed to attendance edits today? A manual lock
 * (lockedAt) always holds. Otherwise the status named by lockOn closes it, but
 * only once the grace days after the period end have passed. SNAPSHOT_ONLY
 * never blocks: payslips keep their frozen copy and HR settles drift as arrears.
 */
export function isLocked(run: LockableRun, s: Pick<PayrollSettings, 'lockOn' | 'lockMode' | 'lockGraceDays'>, today: Ymd): boolean {
  if (s.lockMode === 'SNAPSHOT_ONLY') return false;
  if (run.lockedAt) return true;
  const reached = s.lockOn === 'APPROVED' ? run.status === 'APPROVED' || run.status === 'PAID' : s.lockOn === 'PAID' ? run.status === 'PAID' : false;
  return reached && today > addDays(run.periodEnd, s.lockGraceDays);
}

/**
 * Throws 409 PAYROLL_LOCKED when any part of from..to falls in a locked pay
 * period. Called by every path that changes attendance on request: corrections,
 * leave, remote work, mobile-punch review and manual punches. Terminal punches
 * are never refused (they happened); the run shows the drift instead.
 */
export async function assertPayrollOpen(prisma: PrismaService, tenantId: string, from: Ymd, to: Ymd = from) {
  const runs = await prisma.payrollRun.findMany({
    where: { tenantId, periodStart: { lte: dbDate(to) }, periodEnd: { gte: dbDate(from) }, OR: [{ status: { not: 'DRAFT' } }, { lockedAt: { not: null } }] },
    select: { month: true, periodStart: true, periodEnd: true, status: true, lockedAt: true },
  });
  if (!runs.length) return;
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } });
  // Holds whether or not the payroll module is on: switching a module off must never open
  // closed periods to edits (re-enable payroll to unlock a run).
  const settings = payrollSettingsOf(tenant.settings);
  const today = new Date().toISOString().slice(0, 10);
  const locked = runs
    .map((r) => ({ ...r, periodStart: ymdOf(r.periodStart), periodEnd: ymdOf(r.periodEnd) }))
    .find((r) => isLocked(r, settings, today));
  if (locked) {
    throw new AppError(409, 'PAYROLL_LOCKED', `Payroll for ${locked.periodStart} – ${locked.periodEnd} is closed; ask HR to add it as an adjustment in the next run`, {
      month: locked.month,
      periodStart: locked.periodStart,
      periodEnd: locked.periodEnd,
    });
  }
}
