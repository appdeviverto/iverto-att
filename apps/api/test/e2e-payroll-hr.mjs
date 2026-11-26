// End-to-end: expanded directory, Excel import/update, HR modules, payroll run → lock → payslips.
// LOCAL ONLY: run after `node test/restart-stack.mjs` (local Postgres :55432, Redis :56379, mock Supabase,
// `node test/mock-blob.mjs` for files). Never point this at a shared database.
import { execSync } from 'node:child_process';

const API = 'http://127.0.0.1:8040/v1';
const MOCK = 'http://127.0.0.1:54321';
const API_DIR = 'C:/Users/eshwa/Repos/iverto-att/apps/api';
const LOCAL_DB = 'postgresql://postgres:postgres@localhost:55432/postgres';
const env = { ...process.env, SUPABASE_URL: MOCK, SUPABASE_SERVICE_ROLE_KEY: 'x', DIRECT_URL: LOCAL_DB, DATABASE_URL: LOCAL_DB };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures++;
    console.log(`  ✗ ${msg}`, extra !== undefined ? JSON.stringify(extra).slice(0, 900) : '');
  }
};
async function call(token, method, path, body, raw = false) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) return { status: res.status, type: res.headers.get('content-type'), disposition: res.headers.get('content-disposition'), buf: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
async function login(email, password) {
  const r = await fetch(`${MOCK}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const j = await r.json();
  if (!j.access_token) throw new Error(`login failed for ${email}: ${JSON.stringify(j)}`);
  return j.access_token;
}
async function firstLogin(email, temp, next = 'N3w-Passw0rd!x') {
  const t = await login(email, temp);
  const changed = await call(t, 'POST', '/auth/password', { currentPassword: temp, newPassword: next });
  if (changed.status !== 201) throw new Error(`password change failed ${JSON.stringify(changed.body)}`);
  return login(email, next);
}
const until = async (fn, ms = 60000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(1000);
  }
};
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
const PDF = Buffer.from('%PDF-1.4\n%%EOF').toString('base64');
// A finished month: October 2026 (calendar cycle), Sundays off.
const MONTH = '2026-10';
const days = Array.from({ length: 31 }, (_, i) => `${MONTH}-${String(i + 1).padStart(2, '0')}`);
const working = days.filter((d) => new Date(`${d}T00:00:00Z`).getUTCDay() !== 0);

try {
  console.log('0. Tenant & people');
  const seed = execSync('npx ts-node scripts/platform-admin.ts --email ops@iverto.test --name Ops', { cwd: API_DIR, env }).toString();
  const platform = await firstLogin('ops@iverto.test', seed.match(/Temporary password: (\S+)/)[1]);
  let r = await call(platform, 'POST', '/platform/tenants', { name: 'Payroll Test Co', slug: 'payroll-test', site: { name: 'Bengaluru HQ', timezone: 'Asia/Kolkata' }, admin: { fullName: 'Asha Admin', email: 'asha@payroll.test' }, features: { hr: true, payroll: true } });
  ok(r.status === 201, 'local test tenant', r.body);
  const admin = await firstLogin('asha@payroll.test', r.body.admin.temporaryPassword);
  const site = (await call(admin, 'GET', '/sites')).body[0];

  console.log('1. Expanded directory');
  r = await call(admin, 'POST', '/employees', { employeeCode: 'M1', fullName: 'Meera Manager', siteId: site.id, joinedOn: '2026-01-01', email: 'meera@payroll.test' });
  const mgr = r.body;
  r = await call(admin, 'POST', '/employees', {
    employeeCode: 'E1', fullName: 'Ravi Kumar', siteId: site.id, joinedOn: '2026-01-01', managerId: mgr.id, email: 'ravi@payroll.test',
    pan: 'abcde1234f', uan: '100200300400', bankAccountNumber: '001234567890', bankIfsc: 'hdfc0001234', bankName: 'HDFC Bank', dateOfBirth: '1994-02-03', gender: 'MALE',
  });
  ok(r.status === 201 && r.body.pan === 'ABCDE1234F' && r.body.bankIfsc === 'HDFC0001234' && r.body.dateOfBirth === '1994-02-03', 'create with directory fields, IDs normalised', r.body);
  const ravi = r.body;
  r = await call(admin, 'POST', '/employees', { employeeCode: 'E9', fullName: 'Bad', siteId: site.id, joinedOn: '2026-01-01', aadhaarLast4: '123456789012' });
  ok(r.status === 400 && r.body.code === 'INVALID_FIELD' && /last 4/.test(r.body.message), 'full Aadhaar refused', r.body);
  r = await call(admin, 'PATCH', `/employees/${ravi.id}`, { pan: 'NOTAPAN' });
  ok(r.status === 400 && r.body.details?.[0]?.field === 'pan', 'bad PAN refused on update', r.body);
  r = await call(admin, 'POST', '/users', { email: 'meera@payroll.test', displayName: 'Meera', role: 'MANAGER', employeeId: mgr.id });
  const manager = await firstLogin('meera@payroll.test', r.body.temporaryPassword);
  r = await call(admin, 'POST', '/users', { email: 'ravi@payroll.test', displayName: 'Ravi', role: 'EMPLOYEE', employeeId: ravi.id });
  const raviT = await firstLogin('ravi@payroll.test', r.body.temporaryPassword);
  r = await call(manager, 'GET', `/employees/${ravi.id}`);
  ok(r.status === 200 && !('pan' in r.body) && !('bankAccountNumber' in r.body) && r.body.dateOfBirth === '1994-02-03', 'manager sees the profile without PAN/bank', Object.keys(r.body));
  r = await call(admin, 'GET', `/employees/${ravi.id}`);
  ok(r.body.pan === 'ABCDE1234F', 'HR sees PAN');
  r = await call(raviT, 'GET', '/mobile/profile');
  ok(r.status === 200 && r.body.employee.pan === 'ABCDE1234F' && r.body.editable.includes('bankIfsc'), 'employee sees own PAN; bank is self-editable', r.body);
  r = await call(raviT, 'GET', `/employees/${ravi.id}/tasks`);
  ok(r.status === 200 && r.body.some((t) => t.kind === 'ONBOARDING' && t.assigneeRole === 'EMPLOYEE'), 'onboarding checklist created on join', r.body);

  console.log('2. Payroll setup: structure, salaries, Excel import/update');
  r = await call(admin, 'GET', '/payroll/structures');
  const standard = r.body.find((s) => s.name === 'Standard');
  ok(standard && standard.components.length === 3, 'Standard structure seeded', r.body);
  r = await call(admin, 'POST', `/employees/${ravi.id}/salaries`, { effectiveFrom: '2026-01-01', structureId: standard.id, monthlyGross: 40000, ptState: 'KA' });
  ok(r.status === 201 && r.body[0].monthlyGross === 40000, 'salary set for Ravi', r.body);
  r = await call(admin, 'PUT', '/payroll/settings', { defaultPtState: 'KA' });
  ok(r.status === 200 && r.body.cycleStartDay === 1 && r.body.lockOn === 'APPROVED', 'payroll settings defaults', r.body);
  r = await call(admin, 'GET', '/employees/import/template.xlsx?prefill=true', undefined, true);
  ok(r.status === 200 && /spreadsheetml/.test(r.type) && r.buf.subarray(0, 2).toString() === 'PK', 'prefilled Excel template downloads', { status: r.status, type: r.type });
  const read = await call(admin, 'POST', '/employees/import/read', { fileBase64: r.buf.toString('base64') });
  ok(read.status === 201 && read.body.rows[0][0] === 'Employee code' && read.body.rows.length === 3, 'workbook reads back: header + 2 employees', read.body.rows?.slice(0, 2));
  // Update mode: Meera gets a designation and a salary via the sheet; a new joiner mid-October is added.
  const hdr = ['Employee code', 'Full name', 'Joining date', 'Designation', 'Salary structure', 'Monthly gross (₹)', 'Phone', 'UAN'];
  const csv = [hdr, ['M1', '', '', 'Plant Manager', 'Standard', '60000', '-', ''], ['E2', 'Nisha New', '16/10/2026', 'Operator', 'Standard', '18000', '', '12345']]
    .map((row) => row.join(',')).join('\n');
  r = await call(admin, 'POST', '/employees/import', { csv, mode: 'UPSERT', siteId: site.id });
  ok(r.body.invalid === 1 && r.body.errors[0].errors[0].field === 'uan', 'dry run flags the bad UAN only', r.body);
  r = await call(admin, 'POST', '/employees/import', { csv: csv.replace(',12345', ','), mode: 'UPSERT', siteId: site.id, commit: true });
  ok(r.status === 201 && r.body.committed && r.body.creates === 1 && r.body.updates === 1, 'update + create committed', r.body);
  const all = (await call(admin, 'GET', '/employees?size=100')).body.items;
  const E2 = all.find((e) => e.employeeCode === 'E2');
  const M1 = all.find((e) => e.employeeCode === 'M1');
  ok(E2?.joinedOn === '2026-10-16' && M1?.designation === 'Plant Manager' && M1?.phone === null, 'import applied: DD/MM date, designation, "-" cleared phone', { E2, M1 });
  r = await call(admin, 'GET', `/employees/${E2.id}/salaries`);
  ok(r.body[0]?.monthlyGross === 18000 && r.body[0]?.effectiveFrom === '2026-10-16', 'import set the joiner salary from the joining date', r.body);

  console.log('3. October attendance (manual punches + recompute)');
  const absent = new Set([working[3], working[10]]); // Ravi misses 2 working days
  const punch = (employeeId, d, hm, direction) => call(admin, 'POST', '/punches', { employeeId, at: `${d}T${hm}:00+05:30`, direction, reason: 'e2e backfill' });
  for (const d of working) {
    for (const [e, skip] of [[ravi, absent.has(d)], [M1, false], [E2, d < '2026-10-16']]) {
      if (skip) continue;
      await punch(e.id, d, '09:00', 'in');
      await punch(e.id, d, '18:05', 'out');
    }
  }
  r = await call(admin, 'POST', '/attendance/recompute', { from: `${MONTH}-01`, to: `${MONTH}-31`, reason: 'e2e October backfill' });
  ok(r.status === 201 || r.status === 202, 'recompute queued', r.body);
  const settled = await until(async () => {
    const q = await call(admin, 'GET', `/attendance/days?employeeId=${ravi.id}&from=${MONTH}-01&to=${MONTH}-31&size=100`);
    const rows = q.body.items ?? [];
    return rows.length === 31 && rows.filter((x) => x.status === 'ABSENT').length === 2 && rows.filter((x) => x.status === 'PRESENT').length === working.length - 2 ? rows : null;
  }, 120000);
  ok(settled, 'Ravi: October = 2 absent, rest present', settled && settled.map((x) => x.status));

  console.log('4. Adjustments, loan, expense claim');
  r = await call(admin, 'POST', '/payroll/adjustments', { employeeId: ravi.id, month: MONTH, kind: 'EARNING', code: 'BONUS', amount: 5000, note: 'Diwali' });
  ok(r.status === 201, 'bonus added', r.body);
  r = await call(admin, 'POST', '/payroll/loans', { employeeId: ravi.id, principal: 6000, emi: 2000, startMonth: MONTH });
  ok(r.status === 201, 'loan recorded', r.body);
  r = await call(raviT, 'POST', '/mobile/expenses', { category: 'Travel', amount: 1250.5, claimDate: '2026-10-20', description: 'Cab to client', receiptBase64: JPEG, receiptType: 'image/jpeg' });
  ok(r.status === 201 && r.body.status === 'PENDING' && r.body.progress?.levels === 2, 'expense claim submitted (two-level)', r.body);
  const claim = r.body;
  r = await call(manager, 'POST', '/mobile/approvals/expense/' + claim.id + '/approve', {});
  ok(r.status === 201 && r.body.status === 'PENDING' && r.body.managerApproverId, 'manager approval passes it to HR', r.body);
  r = await call(admin, 'POST', `/expenses/${claim.id}/approve`, {});
  ok(r.status === 201 && r.body.status === 'APPROVED', 'HR approval is final', r.body);

  console.log('5. Payroll run');
  r = await call(admin, 'POST', '/payroll/runs', { month: '2026-12' });
  ok(r.status === 409 && r.body.code === 'PERIOD_NOT_OVER', 'a period that has not ended needs force', r.body);
  r = await call(admin, 'POST', '/payroll/runs', { month: MONTH, force: true });
  ok(r.status === 201 && r.body.status === 'DRAFT' && r.body.periodStart === '2026-10-01' && r.body.periodEnd === '2026-10-31', 'October draft computed', r.body);
  const run = r.body;
  const slipOf = (code) => run.payslips.find((s) => s.employee.employeeCode === code);
  const R = slipOf('E1');
  const line = (s, code) => s.lines.filter((l) => l.code === code).reduce((t, l) => t + l.amount, 0);
  ok(R && R.attendance.employedDays === 31 && R.attendance.lopDays === 2 && R.attendance.paidDays === 29, 'Ravi: 31 days, LOP 2, paid 29', R?.attendance);
  const basic = Math.round(2000000 * 29 / 31);
  ok(line(R, 'BASIC') === basic && line(R, 'PF') === 180000 && line(R, 'PT') === 20000, 'Ravi: prorated Basic, PF capped at ₹15k wage, KA PT ₹200', R?.lines);
  ok(line(R, 'BONUS') === 500000 && line(R, 'LOAN') === 200000 && line(R, 'REIMBURSEMENT') === 125050, 'bonus, loan EMI, reimbursement on the slip', R?.lines);
  const N = slipOf('E2');
  ok(N && N.attendance.employedDays === 16 && N.attendance.paidDays === 16 && line(N, 'ESI') > 0, 'Nisha: mid-month joiner paid 16 of 31 days, ESI applies under ₹21k', N?.attendance);
  ok(!slipOf('M1') && run.warnings.some((w) => /1 active employees have no salary/.test(w)), 'Meera (salary from 1 Nov via the update import) is left out and reported', run.warnings);

  r = await call(raviT, 'POST', '/attendance/corrections', { date: '2026-10-05', in: '09:00', reason: 'forgot to punch' });
  ok(r.status === 201, 'a draft run does not lock the period', r.body);
  r = await call(admin, 'POST', `/payroll/runs/${run.id}/approve`);
  ok(r.status === 201 && r.body.status === 'APPROVED' && r.body.locked, 'approved and locked', { status: r.body.status, locked: r.body.locked });
  r = await call(raviT, 'POST', '/attendance/corrections', { date: '2026-10-06', in: '09:00', reason: 'forgot again' });
  ok(r.status === 409 && r.body.code === 'PAYROLL_LOCKED' && r.body.details?.month === MONTH, 'correction in a locked period refused', r.body);
  r = await call(admin, 'POST', '/punches', { employeeId: ravi.id, at: '2026-10-07T09:00:00+05:30', direction: 'in', reason: 'late fix' });
  ok(r.status === 409 && r.body.code === 'PAYROLL_LOCKED', 'manual punch in a locked period refused', r.body);
  r = await call(raviT, 'POST', '/mobile/leave/requests', { leaveTypeId: (await call(raviT, 'GET', '/mobile/leave/types')).body?.[0]?.id, from: '2026-10-08', to: '2026-10-08', reason: 'x' });
  ok(r.status === 409 || r.status === 400, 'leave inside the locked period is not accepted', r.body);
  r = await call(admin, 'GET', `/expenses?unpaid=true`);
  ok(r.body.data.length === 0, 'approval consumed the reimbursement', r.body);
  r = await call(admin, 'POST', '/payroll/adjustments', { employeeId: ravi.id, month: MONTH, kind: 'EARNING', code: 'OTHER', amount: 10 });
  ok(r.status === 409 && r.body.code === 'RUN_CLOSED', 'no new adjustments for an approved month', r.body);

  console.log('6. Payslips, bank file, register');
  r = await call(raviT, 'GET', '/mobile/payslips');
  ok(r.status === 200 && r.body.length === 0, 'employee sees nothing before the run is paid', r.body);
  r = await call(raviT, 'GET', `/payroll/payslips/${R.id}`);
  ok(r.status === 404, 'and cannot open it directly', r.body);
  r = await call(admin, 'GET', `/payroll/runs/${run.id}/bank-file.csv`, undefined, true);
  const bank = r.buf.toString('utf8');
  ok(r.status === 200 && bank.includes('001234567890') && bank.includes('HDFC0001234') && bank.includes((R.net / 100).toFixed(2)), 'bank file has Ravi’s account and net', bank.slice(0, 300));
  ok(/Bank details missing/.test(bank), 'bank file flags people without bank details');
  r = await call(admin, 'GET', `/payroll/runs/${run.id}/register.csv`, undefined, true);
  ok(r.status === 200 && r.buf.toString('utf8').includes('Paid days'), 'register CSV');
  r = await call(admin, 'POST', `/payroll/runs/${run.id}/paid`);
  ok(r.status === 201 && r.body.status === 'PAID', 'marked paid', r.body.status);
  r = await call(raviT, 'GET', '/mobile/payslips');
  ok(r.body.length === 1 && Math.round(r.body[0].net * 100) === R.net, 'employee sees the paid payslip', r.body);
  r = await call(raviT, 'GET', `/mobile/payslips/${R.id}/pdf`, undefined, true);
  ok(r.status === 200 && r.type === 'application/pdf' && r.buf.subarray(0, 5).toString() === '%PDF-', 'payslip PDF', { status: r.status, type: r.type });
  r = await call(admin, 'GET', '/payroll/loans');
  ok(r.body[0].recovered === 2000 && r.body[0].outstanding === 4000, 'loan: one EMI recovered', r.body);
  r = await call(admin, 'POST', `/payroll/runs/${run.id}/unlock`);
  ok(r.status === 409 && r.body.code === 'PAID_RUN', 'a paid run cannot be unlocked', r.body);
  r = await call(raviT, 'GET', '/mobile/notifications');
  ok(JSON.stringify(r.body).includes('PAYSLIP_READY'), 'payslip notification', r.body);
  r = await call(admin, 'POST', '/payroll/runs', { month: '2026-11', force: true });
  ok(r.status === 201 && r.body.periodStart === '2026-11-01' && line(r.body.payslips.find((s) => s.employee.employeeCode === 'E1'), 'LOAN') === 200000, 'November draft follows on, EMI continues', r.body.periodStart);
  await call(admin, 'DELETE', `/payroll/runs/${r.body.id}`);

  console.log('7. Cycle change: 26th–25th');
  r = await call(admin, 'PUT', '/payroll/settings', { cycleStartDay: 26 });
  r = await call(admin, 'POST', '/payroll/runs', { month: '2026-11', force: true });
  ok(r.status === 201 && r.body.periodStart === '2026-11-01' && r.body.periodEnd === '2026-11-25' && r.body.warnings.some((w) => /Transition/.test(w)), 'transition period 1–25 Nov, no gap', { s: r.body.periodStart, e: r.body.periodEnd, w: r.body.warnings });
  await call(admin, 'DELETE', `/payroll/runs/${r.body.id}`);
  await call(admin, 'PUT', '/payroll/settings', { cycleStartDay: 1 });

  console.log('8. HR: profile change, documents, letters, assets, announcements, offboarding');
  r = await call(raviT, 'POST', '/mobile/profile/requests', { changes: { bankIfsc: 'icic0000123', currentAddress: '12 MG Road' }, reason: 'Changed bank' });
  ok(r.status === 201 && r.body.status === 'PENDING' && r.body.before.bankIfsc === 'HDFC0001234', 'profile change requested with before values', r.body);
  const pr = r.body;
  r = await call(raviT, 'POST', '/mobile/profile/requests', { changes: { designation: 'CEO' } });
  ok(r.status === 400 && r.body.code === 'NOT_SELF_EDITABLE', 'designation is not self-editable', r.body);
  r = await call(manager, 'POST', `/profile-requests/${pr.id}/approve`, {});
  ok(r.status === 403, 'a manager cannot approve profile changes', r.body);
  r = await call(admin, 'POST', `/profile-requests/${pr.id}/approve`, {});
  ok(r.status === 201 && r.body.status === 'APPROVED', 'HR approves', r.body);
  r = await call(admin, 'GET', `/employees/${ravi.id}`);
  ok(r.body.bankIfsc === 'ICIC0000123' && r.body.currentAddress === '12 MG Road', 'change applied to the profile', r.body);

  r = await call(raviT, 'POST', '/mobile/documents', { category: 'ID_PROOF', name: 'Aadhaar card', fileName: 'aadhaar.jpg', contentType: 'image/jpeg', dataBase64: JPEG });
  ok(r.status === 201 && !r.body.verifiedAt && !('fileKey' in r.body), 'employee uploads a document (unverified, key hidden)', r.body);
  const doc = r.body;
  r = await call(raviT, 'POST', '/mobile/documents', { category: 'ID_PROOF', name: 'Fake', fileName: 'x.pdf', contentType: 'application/pdf', dataBase64: JPEG });
  ok(r.status === 400 && r.body.code === 'FILE_TYPE_MISMATCH', 'type checked by magic bytes', r.body);
  r = await call(admin, 'POST', `/employees/${ravi.id}/documents`, { category: 'CONTRACT', name: 'Passport', expiresOn: '2026-12-01', fileName: 'p.pdf', contentType: 'application/pdf', dataBase64: PDF });
  ok(r.status === 201 && r.body.verifiedAt, 'HR upload is verified', r.body);
  r = await call(manager, 'GET', `/employees/${ravi.id}/documents`);
  ok(r.status === 404, 'a manager cannot list documents', r.body);
  r = await call(raviT, 'GET', `/mobile/documents/${doc.id}/url`);
  ok(r.status === 200 && /sig=/.test(r.body.url) && r.body.expiresInSeconds === 300, '5-minute SAS link', r.body);
  r = await call(admin, 'GET', '/documents/expiring?days=30');
  ok(r.body.some((d) => d.name === 'Passport'), 'expiring documents list', r.body);
  r = await call(admin, 'GET', '/letter-templates/library');
  ok(r.body.length >= 6 && r.body.some((l) => l.key === 'appointment'), 'letter starting points listed', r.body.map?.((t) => t.key));
  r = await call(admin, 'POST', '/letter-templates/library/appointment/adopt');
  ok(r.status === 201 && r.body.name === 'Appointment letter', 'starting point copied into the organisation', r.body);
  const appt = r.body;
  r = await call(admin, 'POST', '/letter-templates/library/appointment/adopt');
  ok(r.body.name === 'Appointment letter (2)', 'a second copy gets a numbered name', r.body.name);
  r = await call(admin, 'POST', '/letter-templates/render', { body: 'Dear {{employee.fullName}} of {{org.name}} {{nope}}', employeeId: ravi.id });
  ok(r.body.text.startsWith('Dear Ravi Kumar of ') && r.body.missing.includes('nope'), 'editor preview renders unsaved text for an employee', r.body);
  r = await call(admin, 'GET', '/letter-templates/fields');
  ok(r.body.some((f) => f.key === 'employee.joinedOn' && f.label === 'Joining date'), 'placeholder chips have labels', r.body.slice?.(0, 2));
  r = await call(admin, 'POST', `/employees/${ravi.id}/letters`, { templateId: appt.id, save: false });
  ok(r.status === 201 && r.body.text.includes('Ravi Kumar') && r.body.text.includes('40,000') && r.body.missing.includes('employee.probationEndOn'), 'letter preview fills placeholders, lists blanks', r.body);
  r = await call(admin, 'POST', `/employees/${ravi.id}/letters`, { templateId: appt.id });
  ok(r.status === 201 && r.body.document.category === 'LETTER', 'letter rendered and filed', r.body);

  r = await call(admin, 'PUT', '/hr/settings', { assetCategories: ['Laptop', 'Phone'] });
  r = await call(admin, 'POST', '/assets', { tag: 'LAP-1', name: 'ThinkPad', category: 'Laptop' });
  const asset = r.body;
  ok(r.status === 201 && asset.status === 'IN_STOCK', 'asset added', r.body);
  r = await call(admin, 'POST', '/assets', { tag: 'LAP-1', name: 'Dup', category: 'Laptop' });
  ok(r.status === 409, 'duplicate tag refused', r.body);
  r = await call(admin, 'POST', `/assets/${asset.id}/assign`, { employeeId: ravi.id });
  ok(r.status === 201 && r.body.status === 'ASSIGNED', 'assigned to Ravi', r.body);
  r = await call(raviT, 'GET', '/mobile/assets');
  ok(r.body.length === 1, 'Ravi sees his asset', r.body);

  r = await call(admin, 'POST', '/announcements', { title: 'New leave policy', body: 'Read it.', requiresAck: true });
  const ann = r.body;
  r = await call(raviT, 'GET', '/mobile/announcements');
  ok(r.body.length === 0, 'drafts are not visible', r.body);
  r = await call(admin, 'POST', `/announcements/${ann.id}/publish`);
  ok(r.status === 201 && r.body.notified >= 1, 'published + notified', r.body);
  r = await call(raviT, 'POST', `/mobile/announcements/${ann.id}/ack`);
  r = await call(admin, 'GET', `/announcements/${ann.id}/acks`);
  ok(r.body.find((p) => p.employeeCode === 'E1')?.ackAt && r.body.find((p) => p.employeeCode === 'M1')?.ackAt === null, 'ack tracked per person', r.body);
  r = await call(raviT, 'GET', '/mobile/org-chart');
  ok(r.body.find((p) => p.employeeCode === 'E1')?.managerId === mgr.id, 'org chart has reporting lines', r.body);

  r = await call(admin, 'POST', `/employees/${E2.id}/offboard`, { exitOn: '2026-11-30' });
  ok(r.status === 201, 'offboard Nisha', r.body);
  r = await call(admin, 'GET', `/employees/${E2.id}/tasks`);
  ok(r.body.some((t) => t.kind === 'OFFBOARDING'), 'offboarding checklist created', r.body);
  r = await call(admin, 'POST', `/employees/${ravi.id}/offboard`, { exitOn: '2026-12-31' });
  r = await call(admin, 'GET', `/employees/${ravi.id}/tasks`);
  ok(r.body.some((t) => /Return laptop LAP-1/.test(t.title)), 'offboarding lists the asset to return', r.body.map((t) => t.title));

  console.log('9. Payable-days report');
  r = await call(admin, 'POST', '/reports/exports', { type: 'payable-days', format: 'csv', filters: { dateFrom: `${MONTH}-01`, dateTo: `${MONTH}-31` } });
  ok(r.status === 201 || r.status === 202, 'payable-days export queued', r.body);
  const job = r.body.id ?? r.body.jobId;
  const done = await until(async () => { const j = (await call(admin, 'GET', `/reports/exports/${job}`)).body; return j.status === 'READY' || j.status === 'FAILED' ? j : null; });
  ok(done?.status === 'READY', 'payable-days report generated', done);

  console.log('10. Modules switched off by the platform');
  const tenantId = (await call(platform, 'GET', '/platform/tenants')).body.find((t) => t.slug === 'payroll-test').id;
  r = await call(admin, 'PATCH', '/org', { features: { payroll: false } });
  ok(r.status === 400, 'a tenant admin cannot switch modules', r.body);
  r = await call(platform, 'PATCH', `/platform/tenants/${tenantId}/features`, { payroll: false, hr: false });
  ok(r.status === 200 && r.body.settings.features.payroll === false, 'platform switches payroll and HR off', r.body);
  r = await call(admin, 'GET', '/payroll/runs');
  ok(r.status === 403 && r.body.code === 'FEATURE_DISABLED', 'payroll routes refused', r.body);
  r = await call(admin, 'GET', '/assets');
  ok(r.status === 403 && r.body.code === 'FEATURE_DISABLED', 'HR routes refused', r.body);
  r = await call(admin, 'GET', '/employees/import/columns');
  ok(r.status === 200 && !r.body.some((c) => c.section === 'Salary'), 'import has no salary columns without payroll', r.body.map((c) => c.key));
  r = await call(admin, 'GET', '/employees');
  ok(r.status === 200, 'core attendance & directory still work', r.body);
  r = await call(platform, 'PATCH', `/platform/tenants/${tenantId}/features`, { payroll: true });
  ok(r.body.settings.features.payroll === true && r.body.settings.features.hr === false, 'one switch changes only that module', r.body.settings.features);
  r = await call(platform, 'PATCH', `/platform/tenants/${tenantId}/features`, { hr: true });
  r = await call(admin, 'GET', '/payroll/runs');
  ok(r.status === 200 && r.body.length > 0, 'switched back on: runs are all still there', r.body);
} catch (err) {
  failures++;
  console.error(err);
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
