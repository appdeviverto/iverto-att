/**
 * Renders sample HR/payroll artifacts with fake data, no DB: the Excel import
 * template, a payslip PDF and a letter PDF. For eyeballing layout changes.
 *   npx ts-node scripts/render-samples.ts <outDir>
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import { buildTemplate } from '../src/employees/import';
import { renderBranded } from '../src/hr/pdf-docs';
import { computePayslip, DEFAULT_PAYROLL, DEFAULT_STRUCTURE } from '../src/payroll/engine';
import { PayrollService } from '../src/payroll/payroll';

async function main() {
  const out = process.argv[2] ?? '.';
  writeFileSync(
    join(out, 'employee-template.xlsx'),
    await buildTemplate({
      orgName: 'Acme Industries',
      sites: ['Head Office', 'Peenya Plant'],
      departments: ['Sales', 'Production', 'Accounts'],
      categories: [{ code: 'FULL_TIME', label: 'Full time' }, { code: 'CONTRACT', label: 'Contract' }],
      structures: ['Standard', 'Factory'],
      managerCodes: ['EMP001', 'EMP002'],
      generatedOn: '2026-11-18',
      rows: [
        { employeeCode: 'EMP001', fullName: 'Priya Sharma', joinedOn: '2024-04-01', siteName: 'Head Office', departmentName: 'Sales', designation: 'Sales Manager', employmentType: 'FULL_TIME', mobilePunch: 'NEVER', gender: 'FEMALE', dateOfBirth: '1990-08-15', pan: 'ABCDE1234F', uan: '100200300400', bankAccountNumber: '001234567890123', bankIfsc: 'HDFC0001234', bankName: 'HDFC Bank', salaryStructure: 'Standard', monthlyGross: 65000 },
        { employeeCode: 'EMP002', fullName: 'Ravi Kumar', joinedOn: '2025-01-10', siteName: 'Peenya Plant', departmentName: 'Production', designation: 'Supervisor', managerCode: 'EMP001', employmentType: 'FULL_TIME', mobilePunch: 'NEVER', salaryStructure: 'Factory', monthlyGross: 18000 },
      ],
    }),
  );

  const days = { periodDays: 30, employedDays: 30, absentDays: 1, halfDays: 1, absenceDeduction: 1.5, lateCount: 3, lateDeduction: 0.5, unpaidLeave: 0, lopDays: 2, paidDays: 28, overtimeHours: 6, pendingDays: 0 };
  const settings = { ...DEFAULT_PAYROLL, defaultPtState: 'KA', payDay: 1 };
  const r = computePayslip({
    month: '2026-11', days, settings,
    salary: { monthlyGross: 4000000, components: DEFAULT_STRUCTURE, overrides: {}, pf: true, esi: true, pt: true, ptState: null },
    adjustments: [{ id: 'a', kind: 'EARNING', code: 'BONUS', amount: 500000, note: 'Diwali' }],
    loans: [{ id: 'l', emi: 200000, outstanding: 600000 }],
    reimbursements: [{ id: 'x', amount: 125050, category: 'Travel' }],
  });
  const branding = { displayName: 'Acme Industries', legalName: 'Acme Industries Pvt. Ltd.', address: '3rd Floor, Brigade Tech Park, Whitefield\nBengaluru, Karnataka 560066', phone: '+91 80 4567 8900', email: 'hr@acme.example', website: 'www.acme.example', registration: 'CIN U29100KA2015PTC081234  ·  GSTIN 29AABCA1234F1Z5' };
  const tenant = { id: 't', name: 'Acme Industries', settings: { payroll: settings, branding } };
  const slip = {
    id: 's', tenantId: 't', employeeId: 'e', attendance: days, lines: r.lines, gross: r.gross, deductions: r.deductions, net: r.net, employerContrib: r.employerContrib, paymentMode: 'BANK',
    run: { month: '2026-11', status: 'PAID', periodStart: new Date('2026-10-26'), periodEnd: new Date('2026-11-25') },
    employee: {
      employeeCode: 'EMP001', fullName: 'Priya Sharma', designation: 'Sales Manager', department: { name: 'Sales' }, site: { name: 'Head Office' }, joinedOn: new Date('2024-04-01'),
      pan: 'ABCDE1234F', uan: '100200300400', esicNumber: null, bankName: 'HDFC Bank', bankAccountNumber: '001234567890123',
    },
  };
  const prisma = { payslip: { findFirst: async () => slip }, tenant: { findUniqueOrThrow: async () => tenant } };
  const svc = new PayrollService(prisma as never, {} as never, {} as never, {} as never);
  const file = await svc.payslipPdf({ tenantId: 't', employeeId: 'e', role: 'HR' } as never, 's').catch(async () => {
    // HR path asserts scope; the employee path needs only the run to be PAID.
    return svc.payslipPdf({ tenantId: 't', employeeId: 'e', role: 'EMPLOYEE' } as never, 's');
  });
  const chunks: Buffer[] = [];
  for await (const c of file.getStream()) chunks.push(Buffer.from(c));
  writeFileSync(join(out, 'payslip.pdf'), Buffer.concat(chunks));

  const letter = `18 November 2026\n\nDear Priya Sharma,\n\nSubject: Letter of appointment\n\nFurther to your acceptance of our offer, we are pleased to appoint you as Sales Manager with Acme Industries with effect from 1 Apr 2024.\n\nYour gross salary is ₹65,000 per month.\n\nFor Acme Industries\n\nAuthorised Signatory`;
  writeFileSync(join(out, 'letter.pdf'), await renderBranded({ orgName: 'Acme Industries', ...branding }, letter.split(/\n{2,}/).map((p) => ({ text: p, margin: [0, 0, 0, 10] as [number, number, number, number] })), 'Appointment letter · Priya Sharma (EMP001) · 2026-11-18'));
  console.log('written to', out);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
