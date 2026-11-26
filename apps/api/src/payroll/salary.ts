import { Prisma } from '@prisma/client';
import { dbDate, Ymd } from '../common/time';

export interface SalaryInput {
  tenantId: string;
  employeeId: string;
  effectiveFrom: Ymd;
  structureId: string;
  /** Paise. */
  monthlyGross: number;
  overrides?: Record<string, number>;
  pf?: boolean;
  esi?: boolean;
  pt?: boolean;
  ptState?: string | null;
  createdBy?: string | null;
}

/** One salary row per (employee, effectiveFrom): re-saving the same date revises it. Shared by the payroll API and the import. */
export function saveSalary(tx: Prisma.TransactionClient, s: SalaryInput) {
  const data = {
    structureId: s.structureId,
    monthlyGross: s.monthlyGross,
    ...(s.overrides ? { overrides: s.overrides } : {}),
    ...(s.pf !== undefined ? { pf: s.pf } : {}),
    ...(s.esi !== undefined ? { esi: s.esi } : {}),
    ...(s.pt !== undefined ? { pt: s.pt } : {}),
    ...(s.ptState !== undefined ? { ptState: s.ptState } : {}),
  };
  return tx.employeeSalary.upsert({
    where: { employeeId_effectiveFrom: { employeeId: s.employeeId, effectiveFrom: dbDate(s.effectiveFrom) } },
    create: { tenantId: s.tenantId, employeeId: s.employeeId, effectiveFrom: dbDate(s.effectiveFrom), createdBy: s.createdBy ?? null, ...data },
    update: data,
  });
}
