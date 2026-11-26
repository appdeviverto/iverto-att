import { computePayslip, DayInput, DEFAULT_PAYROLL, DEFAULT_STRUCTURE, monthOfDate, nextPeriod, payableDays, payPeriod, PayrollSettings, SalaryInput } from './engine';

const day = (workDate: string, status = 'PRESENT', extra: Partial<DayInput> = {}): DayInput => ({
  workDate,
  status,
  leavePortion: 0,
  leaveTypeId: null,
  isLate: false,
  isEarlyExit: false,
  overtimeMinutes: 0,
  finalized: true,
  policy: { absenceDeduction: 1, lateDeduction: 'HALF_DAY', lateDeductionEvery: 3 },
  ...extra,
});
const month = (from: string, n: number, status = 'PRESENT') => Array.from({ length: n }, (_, i) => day(`${from.slice(0, 8)}${String(Number(from.slice(8)) + i).padStart(2, '0')}`, status));

describe('pay periods', () => {
  it('cycle day 1 is the calendar month', () => {
    expect(payPeriod('2026-02', 1)).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(payPeriod('2028-02', 1)).toEqual({ start: '2028-02-01', end: '2028-02-29' });
  });

  it('cycle day 26 runs 26th to 25th, across the year boundary', () => {
    expect(payPeriod('2026-11', 26)).toEqual({ start: '2026-10-26', end: '2026-11-25' });
    expect(payPeriod('2027-01', 26)).toEqual({ start: '2026-12-26', end: '2027-01-25' });
  });

  it('rejects a cycle day above 28', () => {
    expect(() => payPeriod('2026-03', 29)).toThrow();
  });

  it('a cycle change makes one transition period with no gap or overlap', () => {
    // Calendar months until October, then 26th–25th.
    const p = nextPeriod('2026-11', 26, '2026-10-31');
    expect(p).toEqual({ start: '2026-11-01', end: '2026-11-25', transition: true });
    expect(nextPeriod('2026-12', 26, p.end)).toEqual({ start: '2026-11-26', end: '2026-12-25', transition: false });
    expect(() => nextPeriod('2026-11', 26, '2026-11-25')).toThrow();
  });

  it('maps a date to its payroll month', () => {
    expect(monthOfDate('2026-11-25', 26)).toBe('2026-11');
    expect(monthOfDate('2026-11-26', 26)).toBe('2026-12');
    expect(monthOfDate('2026-12-30', 26)).toBe('2027-01');
    expect(monthOfDate('2026-12-30', 1)).toBe('2026-12');
  });
});

describe('payable days', () => {
  const nov = payPeriod('2026-11', 1);

  it('full month present: paid = days in period', () => {
    const r = payableDays(month('2026-11-01', 30), nov, '2020-01-01', null, new Set());
    expect(r).toMatchObject({ periodDays: 30, employedDays: 30, lopDays: 0, paidDays: 30 });
  });

  it('absences at the policy rate, late penalty, unpaid leave; A/½L counts half', () => {
    const days = month('2026-11-01', 30);
    days[2] = day('2026-11-03', 'ABSENT');
    days[3] = day('2026-11-04', 'HALF_DAY');
    days[4] = day('2026-11-05', 'ABSENT', { leavePortion: 0.5, leaveTypeId: 'CL' }); // paid half leave, other half absent
    days[5] = day('2026-11-06', 'ON_LEAVE', { leavePortion: 1, leaveTypeId: 'LOP' });
    for (const i of [10, 11, 12]) days[i] = day(days[i].workDate, 'PRESENT', { isLate: true });
    const r = payableDays(days, nov, '2020-01-01', null, new Set(['LOP']));
    expect(r.absenceDeduction).toBe(2); // 1 + ½ + ½
    expect(r.lateDeduction).toBe(0.5); // 3 lates, half day per 3
    expect(r.unpaidLeave).toBe(1);
    expect(r.lopDays).toBe(3.5);
    expect(r.paidDays).toBe(26.5);
  });

  it('a mid-month joiner is paid only from joining', () => {
    const r = payableDays(month('2026-11-16', 15), nov, '2026-11-16', null, new Set());
    expect(r).toMatchObject({ employedDays: 15, paidDays: 15, periodDays: 30 });
  });

  it('a leaver is paid up to the exit date; days after it are ignored', () => {
    const r = payableDays(month('2026-11-01', 30, 'ABSENT'), nov, '2020-01-01', '2026-11-10', new Set());
    expect(r.employedDays).toBe(10);
    expect(r.paidDays).toBe(0); // LOP never exceeds employed days
  });

  it('reports unfinalised days and overtime hours', () => {
    const days = month('2026-11-01', 30);
    days[29] = day('2026-11-30', 'PENDING', { finalized: false });
    days[0] = day('2026-11-01', 'PRESENT', { overtimeMinutes: 90 });
    const r = payableDays(days, nov, '2020-01-01', null, new Set());
    expect(r.pendingDays).toBe(1);
    expect(r.overtimeHours).toBe(1.5);
  });
});

describe('payslip', () => {
  const settings: PayrollSettings = { ...DEFAULT_PAYROLL, defaultPtState: 'KA' };
  const salary = (gross: number, extra: Partial<SalaryInput> = {}): SalaryInput => ({
    monthlyGross: gross * 100,
    components: DEFAULT_STRUCTURE,
    overrides: {},
    pf: true,
    esi: true,
    pt: true,
    ptState: null,
    ...extra,
  });
  const days = (paid: number, period = 30, ot = 0) =>
    ({ periodDays: period, employedDays: period, paidDays: paid, lopDays: period - paid, overtimeHours: ot }) as any;
  const line = (r: ReturnType<typeof computePayslip>, code: string) => r.lines.find((l) => l.code === code)?.amount ?? 0;

  it('full month: structure splits gross, PF capped at ₹15,000, no ESI above threshold, KA PT', () => {
    const r = computePayslip({ month: '2026-11', days: days(30), salary: salary(40000), settings, adjustments: [], loans: [], reimbursements: [] });
    expect(line(r, 'BASIC')).toBe(2000000);
    expect(line(r, 'HRA')).toBe(1000000);
    expect(line(r, 'SPECIAL')).toBe(1000000);
    expect(r.gross).toBe(4000000);
    expect(line(r, 'PF')).toBe(180000); // 12% of 15,000
    expect(line(r, 'EMPLOYER_PF')).toBe(180000);
    expect(line(r, 'ESI')).toBe(0);
    expect(line(r, 'PT')).toBe(20000);
    expect(r.net).toBe(4000000 - 180000 - 20000);
    expect(r.employerContrib).toBe(180000);
  });

  it('LOP prorates earnings by paid days ÷ days in the period', () => {
    const r = computePayslip({ month: '2026-11', days: days(27), salary: salary(30000, { pt: false, pf: false, esi: false }), settings, adjustments: [], loans: [], reimbursements: [] });
    expect(r.gross).toBe(2700000);
  });

  it('PF on earned Basic below the cap', () => {
    const r = computePayslip({ month: '2026-11', days: days(15), salary: salary(20000, { esi: false, pt: false }), settings, adjustments: [], loans: [], reimbursements: [] });
    expect(line(r, 'BASIC')).toBe(500000);
    expect(line(r, 'PF')).toBe(60000);
  });

  it('ESI when gross ≤ ₹21,000: 0.75% / 3.25% of earned gross, rounded up to the rupee', () => {
    const r = computePayslip({ month: '2026-11', days: days(30), salary: salary(18000, { pf: false, pt: false }), settings, adjustments: [], loans: [], reimbursements: [] });
    expect(line(r, 'ESI')).toBe(13500); // 135.00
    expect(line(r, 'EMPLOYER_ESI')).toBe(58500); // 585.00
    const odd = computePayslip({ month: '2026-11', days: days(30), salary: salary(18001, { pf: false, pt: false }), settings, adjustments: [], loans: [], reimbursements: [] });
    expect(line(odd, 'ESI')).toBe(13600); // 135.0075 → 136
  });

  it('PT: below the slab is nil; February uses the February amount', () => {
    const low = computePayslip({ month: '2026-11', days: days(30), salary: salary(20000, { pf: false, esi: false }), settings, adjustments: [], loans: [], reimbursements: [] });
    expect(line(low, 'PT')).toBe(0);
    const feb = computePayslip({ month: '2027-02', days: days(28, 28), salary: salary(40000, { pf: false, esi: false }), settings, adjustments: [], loans: [], reimbursements: [] });
    expect(line(feb, 'PT')).toBe(30000);
    const mh = computePayslip({ month: '2026-11', days: days(30), salary: salary(9000, { pf: false, esi: false, ptState: 'MH' }), settings, adjustments: [], loans: [], reimbursements: [] });
    expect(line(mh, 'PT')).toBe(17500);
  });

  it('overtime, adjustments, loan EMI capped at outstanding, reimbursement outside gross', () => {
    const r = computePayslip({
      month: '2026-11',
      days: days(30, 30, 10),
      salary: salary(24000, { pf: false, esi: false, pt: false }),
      settings,
      adjustments: [
        { id: 'a1', kind: 'EARNING', code: 'BONUS', amount: 500000, note: 'Diwali' },
        { id: 'a2', kind: 'DEDUCTION', code: 'OTHER', amount: 10000 },
      ],
      loans: [{ id: 'l1', emi: 300000, outstanding: 120000 }],
      reimbursements: [{ id: 'x1', amount: 45050, category: 'Travel' }],
    });
    // 24,000 / 30 / 8 = 100/h, × 2 × 10 h = 2,000
    expect(line(r, 'OT')).toBe(200000);
    expect(r.gross).toBe(2400000 + 200000 + 500000);
    expect(line(r, 'LOAN')).toBe(120000);
    expect(r.reimbursements).toBe(45050);
    expect(r.net).toBe(r.gross + 45050 - 10000 - 120000);
  });

  it('overrides replace a component, and the balance absorbs the rest', () => {
    const r = computePayslip({ month: '2026-11', days: days(30), salary: salary(30000, { pf: false, esi: false, pt: false, overrides: { HRA: 400000 } }), settings, adjustments: [], loans: [], reimbursements: [] });
    expect(line(r, 'HRA')).toBe(400000);
    expect(line(r, 'SPECIAL')).toBe(3000000 - 1500000 - 400000);
  });

  it('warns when components exceed the gross', () => {
    const r = computePayslip({ month: '2026-11', days: days(30), salary: salary(10000, { pf: false, esi: false, pt: false, overrides: { BASIC: 1200000 } }), settings, adjustments: [], loans: [], reimbursements: [] });
    expect(line(r, 'SPECIAL')).toBe(0);
    expect(r.warnings.join()).toMatch(/more than the gross/);
  });
});

describe('amount in words', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { rupeesInWords } = require('../hr/pdf-docs');
  it('uses lakh/crore and spells out paise', () => {
    expect(rupeesInWords(4158383)).toBe('Rupees Forty One Thousand Five Hundred Eighty Three and Eighty Three Paise Only');
    expect(rupeesInWords(1234567800)).toBe('Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Only');
    expect(rupeesInWords(0)).toBe('Rupees Zero Only');
  });
});
