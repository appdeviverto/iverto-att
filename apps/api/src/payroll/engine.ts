/**
 * Payroll maths, pure: pay periods, payable days, payslip lines. No I/O, so
 * every rule is pinned by engine.spec.ts. Money is integer paise; settings
 * hold rupees (what HR types) and are converted here.
 */
import { absenceDeductionDays, lateDays, lateDeductionDays } from '../attendance/engine/compute-day';
import { addDays, diffDays, Ymd } from '../common/time';

// ── Settings ────────────────────────────────────────────────────────────────

export interface PtSlab {
  /** Monthly gross (rupees) from which this slab applies. */
  min: number;
  amount: number;
  /** February amount, where the state collects the year's balance then. */
  febAmount?: number;
}

export interface PayrollSettings {
  /** 1–28: the period labelled month M runs from day D of M−1 to day D−1 of M (1 = calendar month). */
  cycleStartDay: number;
  /** Day of the month salary is credited (printed on the payslip). */
  payDay: number;
  lockOn: 'APPROVED' | 'PAID' | 'MANUAL';
  lockMode: 'BLOCK' | 'SNAPSHOT_ONLY';
  /** Days after the period end before an automatic lock takes effect. */
  lockGraceDays: number;
  otEnabled: boolean;
  otMultiplier: number;
  otBase: 'GROSS' | 'BASIC';
  standardHoursPerDay: number;
  pfRate: number;
  /** Rupees: PF is computed on at most this much Basic (+DA). */
  pfWageCap: number;
  esiEmployeeRate: number;
  esiEmployerRate: number;
  /** Rupees: ESI applies when the full monthly gross is at most this. */
  esiThreshold: number;
  /** State code → slabs. Seeded as examples: verify against the current state notification. */
  ptSlabs: Record<string, PtSlab[]>;
  defaultPtState: string | null;
}

export const DEFAULT_PAYROLL: PayrollSettings = {
  cycleStartDay: 1,
  payDay: 1,
  lockOn: 'APPROVED',
  lockMode: 'BLOCK',
  lockGraceDays: 0,
  otEnabled: true,
  otMultiplier: 2,
  otBase: 'GROSS',
  standardHoursPerDay: 8,
  pfRate: 12,
  pfWageCap: 15000,
  esiEmployeeRate: 0.75,
  esiEmployerRate: 3.25,
  esiThreshold: 21000,
  ptSlabs: {
    KA: [
      { min: 0, amount: 0 },
      { min: 25000, amount: 200, febAmount: 300 },
    ],
    MH: [
      { min: 0, amount: 0 },
      { min: 7501, amount: 175 },
      { min: 10001, amount: 200, febAmount: 300 },
    ],
  },
  defaultPtState: null,
};

export function payrollSettingsOf(settings: unknown): PayrollSettings {
  const raw = ((settings as Record<string, any> | null)?.payroll ?? {}) as Record<string, unknown>;
  // Unset keys (a DTO's omitted fields arrive as undefined) never override a default.
  const p = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)) as Partial<PayrollSettings>;
  return { ...DEFAULT_PAYROLL, ...p, ptSlabs: p.ptSlabs ?? DEFAULT_PAYROLL.ptSlabs };
}

// ── Pay periods ─────────────────────────────────────────────────────────────

export interface Period {
  start: Ymd;
  end: Ymd;
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const lastDayOf = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, '0');

/** The period a month label stands for under a cycle start day. 26 → "2026-11" = 2026-10-26 … 2026-11-25. */
export function payPeriod(month: string, cycleStartDay: number): Period {
  const m = MONTH_RE.exec(month);
  if (!m) throw new Error(`Bad month ${month}`);
  if (!Number.isInteger(cycleStartDay) || cycleStartDay < 1 || cycleStartDay > 28) throw new Error('cycleStartDay must be 1–28');
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (cycleStartDay === 1) return { start: `${month}-01`, end: `${month}-${pad(lastDayOf(y, mo))}` };
  const [py, pm] = mo === 1 ? [y - 1, 12] : [y, mo - 1];
  return { start: `${py}-${pad(pm)}-${pad(cycleStartDay)}`, end: `${month}-${pad(cycleStartDay - 1)}` };
}

/**
 * The period a new run covers. Periods are gapless: after an earlier run the
 * next one starts the day after it ended, so changing the cycle day produces
 * one longer or shorter transition period instead of a gap or an overlap.
 */
export function nextPeriod(month: string, cycleStartDay: number, previousEnd?: Ymd | null): Period & { transition: boolean } {
  const natural = payPeriod(month, cycleStartDay);
  if (!previousEnd) return { ...natural, transition: false };
  const start = addDays(previousEnd, 1);
  if (start > natural.end) throw new Error(`The previous run already covers up to ${previousEnd}`);
  return { start, end: natural.end, transition: start !== natural.start };
}

export const periodDays = (p: Period) => diffDays(p.start, p.end) + 1;

/** The payroll month whose period contains a date. */
export function monthOfDate(date: Ymd, cycleStartDay: number): string {
  const [y, m, d] = date.split('-').map(Number);
  if (cycleStartDay === 1 || d < cycleStartDay) return `${y}-${pad(m)}`;
  return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
}

// ── Payable days ────────────────────────────────────────────────────────────

export interface DayInput {
  workDate: Ymd;
  status: string;
  leavePortion: number;
  leaveTypeId: string | null;
  isLate: boolean;
  isEarlyExit: boolean;
  overtimeMinutes: number;
  finalized: boolean;
  policy: Record<string, unknown>;
}

export interface PayableDays {
  periodDays: number;
  employedDays: number;
  absentDays: number;
  halfDays: number;
  absenceDeduction: number;
  lateCount: number;
  lateDeduction: number;
  unpaidLeave: number;
  lopDays: number;
  paidDays: number;
  overtimeHours: number;
  pendingDays: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * LOP = unauthorised absence (at the policy's rate) + late penalty + unpaid
 * leave. A half-leave day whose other half was absent (ABSENT with
 * leavePortion 0.5, "A/½L") counts as half an absence. Days outside the
 * employment window are simply not employed days.
 */
export function payableDays(days: DayInput[], period: Period, joinedOn: Ymd, exitOn: Ymd | null, unpaidLeaveTypeIds: Set<string>): PayableDays {
  const from = joinedOn > period.start ? joinedOn : period.start;
  const to = exitOn && exitOn < period.end ? exitOn : period.end;
  const employedDays = from > to ? 0 : diffDays(from, to) + 1;
  const inWindow = days.filter((d) => d.workDate >= from && d.workDate <= to);
  const policy = (inWindow[inWindow.length - 1]?.policy ?? {}) as Record<string, unknown>;

  const absentDays = inWindow.filter((d) => d.status === 'ABSENT' && d.leavePortion === 0).length;
  const halfDays = inWindow.filter((d) => d.status === 'HALF_DAY' || (d.status === 'ABSENT' && d.leavePortion > 0 && d.leavePortion < 1)).length;
  const absenceDeduction = absenceDeductionDays(absentDays, halfDays, policy);
  const lateCount = lateDays(inWindow, policy);
  const lateDeduction = lateDeductionDays(lateCount, policy);
  const unpaidLeave = inWindow.reduce((s, d) => s + (d.leaveTypeId && unpaidLeaveTypeIds.has(d.leaveTypeId) ? d.leavePortion : 0), 0);
  const lopDays = Math.min(employedDays, r2(absenceDeduction + lateDeduction + unpaidLeave));
  return {
    periodDays: periodDays(period),
    employedDays,
    absentDays,
    halfDays,
    absenceDeduction,
    lateCount,
    lateDeduction,
    unpaidLeave: r2(unpaidLeave),
    lopDays,
    paidDays: r2(Math.max(0, employedDays - lopDays)),
    overtimeHours: r2(inWindow.reduce((s, d) => s + d.overtimeMinutes, 0) / 60),
    pendingDays: inWindow.filter((d) => !d.finalized).length,
  };
}

// ── Payslip ─────────────────────────────────────────────────────────────────

export interface Component {
  code: string;
  name: string;
  kind: 'EARNING' | 'DEDUCTION';
  calc: 'FIXED' | 'PCT_GROSS' | 'PCT_BASIC' | 'BALANCE';
  /** FIXED: rupees per month; PCT_*: percent. Ignored for BALANCE. */
  value: number;
  prorate: boolean;
}

export interface SalaryInput {
  /** Paise. */
  monthlyGross: number;
  components: Component[];
  /** componentCode → monthly paise. */
  overrides: Record<string, number>;
  pf: boolean;
  esi: boolean;
  pt: boolean;
  ptState: string | null;
}

export type LineKind = 'EARNING' | 'REIMBURSEMENT' | 'DEDUCTION' | 'EMPLOYER';

export interface Line {
  code: string;
  name: string;
  kind: LineKind;
  amount: number;
  /** Full-month amount before proration (earnings from the structure). */
  full?: number;
  /** Source row: adjustment / loan / expense id. */
  ref?: string;
}

export interface PayslipInput {
  /** Payroll month label, for February PT. */
  month: string;
  days: PayableDays;
  salary: SalaryInput;
  settings: PayrollSettings;
  adjustments: Array<{ id: string; kind: 'EARNING' | 'DEDUCTION'; code: string; amount: number; note?: string | null }>;
  /** outstanding = principal − recovered so far. */
  loans: Array<{ id: string; emi: number; outstanding: number }>;
  reimbursements: Array<{ id: string; amount: number; category: string }>;
}

export interface PayslipResult {
  lines: Line[];
  gross: number;
  reimbursements: number;
  deductions: number;
  net: number;
  employerContrib: number;
  warnings: string[];
}

const pct = (base: number, p: number) => Math.round((base * p) / 100);
/** ESIC rounds contributions up to the next rupee. */
const ceilRupee = (paise: number) => Math.ceil(paise / 100) * 100;
const ADJUSTMENT_NAMES: Record<string, string> = { BONUS: 'Bonus', INCENTIVE: 'Incentive', ARREARS: 'Arrears', ADVANCE: 'Advance recovery', OTHER: 'Other' };

/** The structure's monthly (unprorated) amounts: fixed and % first, then % of Basic, then the balancing allowance. */
export function structureAmounts(s: SalaryInput): { amounts: Map<string, number>; warnings: string[] } {
  const amounts = new Map<string, number>();
  const warnings: string[] = [];
  const order = (c: Component) => (c.calc === 'BALANCE' ? 2 : c.calc === 'PCT_BASIC' ? 1 : 0);
  for (const c of [...s.components].sort((a, b) => order(a) - order(b))) {
    let v: number;
    if (s.overrides[c.code] !== undefined) v = Math.round(s.overrides[c.code]);
    else if (c.calc === 'FIXED') v = Math.round(c.value * 100);
    else if (c.calc === 'PCT_GROSS') v = pct(s.monthlyGross, c.value);
    else if (c.calc === 'PCT_BASIC') v = pct(amounts.get('BASIC') ?? 0, c.value);
    else {
      const others = [...amounts.entries()].filter(([code]) => s.components.find((x) => x.code === code)?.kind === 'EARNING').reduce((t, [, a]) => t + a, 0);
      v = s.monthlyGross - others;
      if (v < 0) {
        warnings.push(`Components add up to more than the gross; ${c.name} set to 0`);
        v = 0;
      }
    }
    amounts.set(c.code, v);
  }
  return { amounts, warnings };
}

export function computePayslip(input: PayslipInput): PayslipResult {
  const { days, salary, settings } = input;
  const { amounts, warnings } = structureAmounts(salary);
  const factor = days.periodDays ? days.paidDays / days.periodDays : 0;
  const lines: Line[] = [];

  for (const c of salary.components) {
    const full = amounts.get(c.code) ?? 0;
    const amount = c.prorate ? Math.round(full * factor) : full;
    if (amount) lines.push({ code: c.code, name: c.name, kind: c.kind, amount, full });
  }
  const earned = (code: string) => lines.find((l) => l.code === code && l.kind === 'EARNING')?.amount ?? 0;

  // Overtime: hours × hourly rate × multiplier.
  if (settings.otEnabled && days.overtimeHours > 0) {
    const base = settings.otBase === 'BASIC' ? (amounts.get('BASIC') ?? 0) + (amounts.get('DA') ?? 0) : salary.monthlyGross;
    const hourly = base / days.periodDays / settings.standardHoursPerDay;
    const ot = Math.round(days.overtimeHours * hourly * settings.otMultiplier);
    if (ot) lines.push({ code: 'OT', name: `Overtime (${days.overtimeHours} h × ${settings.otMultiplier})`, kind: 'EARNING', amount: ot });
  }
  for (const a of input.adjustments) {
    lines.push({ code: a.code, name: a.note ? `${ADJUSTMENT_NAMES[a.code] ?? a.code}: ${a.note}` : (ADJUSTMENT_NAMES[a.code] ?? a.code), kind: a.kind, amount: a.amount, ref: a.id });
  }
  const gross = lines.filter((l) => l.kind === 'EARNING').reduce((s, l) => s + l.amount, 0);

  // PF on earned Basic + DA, capped.
  if (salary.pf) {
    const wage = Math.min(earned('BASIC') + earned('DA'), settings.pfWageCap * 100);
    if (!amounts.has('BASIC')) warnings.push('PF is on but the structure has no BASIC component');
    const pf = pct(wage, settings.pfRate);
    if (pf) {
      lines.push({ code: 'PF', name: 'Provident fund', kind: 'DEDUCTION', amount: pf });
      lines.push({ code: 'EMPLOYER_PF', name: 'Employer PF', kind: 'EMPLOYER', amount: pf });
    }
  }
  // ESI: eligibility on the full monthly gross, contribution on what was earned.
  if (salary.esi && salary.monthlyGross <= settings.esiThreshold * 100 && gross > 0) {
    lines.push({ code: 'ESI', name: 'ESI', kind: 'DEDUCTION', amount: ceilRupee((gross * settings.esiEmployeeRate) / 100) });
    lines.push({ code: 'EMPLOYER_ESI', name: 'Employer ESI', kind: 'EMPLOYER', amount: ceilRupee((gross * settings.esiEmployerRate) / 100) });
  }
  // Professional tax by state slab on earned gross.
  if (salary.pt) {
    const state = salary.ptState ?? settings.defaultPtState;
    const slabs = state ? settings.ptSlabs[state] : undefined;
    if (state && !slabs) warnings.push(`No professional tax slabs for state ${state}`);
    const slab = slabs?.filter((s) => gross >= s.min * 100).sort((a, b) => b.min - a.min)[0];
    const feb = input.month.endsWith('-02');
    const pt = slab ? (feb && slab.febAmount !== undefined ? slab.febAmount : slab.amount) * 100 : 0;
    if (pt) lines.push({ code: 'PT', name: `Professional tax (${state})`, kind: 'DEDUCTION', amount: pt });
  }
  for (const l of input.loans) {
    const emi = Math.min(l.emi, l.outstanding);
    if (emi > 0) lines.push({ code: 'LOAN', name: 'Loan / advance EMI', kind: 'DEDUCTION', amount: emi, ref: l.id });
  }
  for (const r of input.reimbursements) lines.push({ code: 'REIMBURSEMENT', name: `Reimbursement: ${r.category}`, kind: 'REIMBURSEMENT', amount: r.amount, ref: r.id });

  const sum = (k: LineKind) => lines.filter((l) => l.kind === k).reduce((s, l) => s + l.amount, 0);
  const reimbursements = sum('REIMBURSEMENT');
  const deductions = sum('DEDUCTION');
  const net = gross + reimbursements - deductions;
  if (net < 0) warnings.push('Deductions exceed earnings: net pay is negative');
  return { lines, gross, reimbursements, deductions, net, employerContrib: sum('EMPLOYER'), warnings };
}

/** Starter structure every org gets: Basic 50% of gross, HRA 50% of Basic, the rest special allowance. */
export const DEFAULT_STRUCTURE: Component[] = [
  { code: 'BASIC', name: 'Basic', kind: 'EARNING', calc: 'PCT_GROSS', value: 50, prorate: true },
  { code: 'HRA', name: 'House rent allowance', kind: 'EARNING', calc: 'PCT_BASIC', value: 50, prorate: true },
  { code: 'SPECIAL', name: 'Special allowance', kind: 'EARNING', calc: 'BALANCE', value: 0, prorate: true },
];
