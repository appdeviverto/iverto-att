// Demo tenant for clicking around locally: "Acme Industries" with two sites, 15 people with full
// directory data, Oct–Nov attendance (lates, absences, leave, overtime), a paid October payroll,
// expenses, loans, assets, documents, letters, announcements and checklists.
//
// LOCAL ONLY. Run on a fresh stack:
//   node test/restart-stack.mjs && node test/mock-blob.mjs   (separate terminal)
//   node test/seed-demo.mjs
// Then the web app: `.claude/launch.json` → web-local-e2e (http://localhost:5173).
//
// Sign-ins (mock auth, local only; every account uses DEMO_PASSWORD below):
//   asha@acme.test    Administrator (not an employee)
//   hema@acme.test    HR            (E005 Hema Nair)
//   meera@acme.test   Manager       (E002 Meera Iyer, Sales)
//   suresh@acme.test  Manager       (E008 Suresh Gowda, Peenya Plant)
//   ravi@acme.test    Employee      (E003 Ravi Kumar)
//   priya@acme.test   Employee      (E004 Priya Sharma)
//   ops@iverto.test   Platform admin
// The mock keeps accounts in memory: restarting mock-supabase means re-seeding.
import { execSync } from 'node:child_process';

export const DEMO_PASSWORD = 'Acme-Demo-2026!';
/** Company letterhead (Settings → Organisation) printed on payslips, letters and reports. */
export const DEMO_BRANDING = {
  displayName: 'Acme Industries',
  legalName: 'Acme Industries Pvt. Ltd.',
  address: '3rd Floor, Brigade Tech Park, Whitefield\nBengaluru, Karnataka 560066',
  phone: '+91 80 4567 8900',
  email: 'hr@acme.example',
  website: 'www.acme.example',
  registration: 'CIN U29100KA2015PTC081234  ·  GSTIN 29AABCA1234F1Z5',
};
const API = 'http://127.0.0.1:8040/v1';
const MOCK = 'http://127.0.0.1:54321';
const API_DIR = 'C:/Users/eshwa/Repos/iverto-att/apps/api';
const LOCAL_DB = 'postgresql://postgres:postgres@localhost:55432/postgres';
const env = { ...process.env, SUPABASE_URL: MOCK, SUPABASE_SERVICE_ROLE_KEY: 'x', DIRECT_URL: LOCAL_DB, DATABASE_URL: LOCAL_DB };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let warnings = 0;

async function call(token, method, path, body) {
  let res;
  // The local API can briefly run out of DB connections under load: back off and retry server errors.
  // The backfill also outruns the 600/min per-token rate limit: wait out each 429 as Retry-After says.
  for (let attempt = 0; ; attempt++) {
    res = await fetch(API + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && attempt < 20) {
      await sleep((Number(res.headers.get('retry-after')) || 5) * 1000 + 250);
      continue;
    }
    if (res.status < 500 || attempt === 5) break;
    await sleep(1500 * (attempt + 1));
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (res.status >= 400) {
    warnings++;
    console.log(`    ! ${method} ${path} → ${res.status} ${JSON.stringify(json).slice(0, 220)}`);
  }
  return json;
}
async function login(email, password) {
  const r = await fetch(`${MOCK}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const j = await r.json();
  if (!j.access_token) throw new Error(`login failed for ${email}: ${JSON.stringify(j)}`);
  return j.access_token;
}
async function firstLogin(email, temp) {
  const t = await login(email, temp);
  await call(t, 'POST', '/auth/password', { currentPassword: temp, newPassword: DEMO_PASSWORD });
  return login(email, DEMO_PASSWORD);
}
/** Run async jobs n at a time. */
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}
// Deterministic "random" so every seed looks the same.
let seedState = 20261118;
const rnd = () => ((seedState = (seedState * 1103515245 + 12345) % 2147483648) / 2147483648);
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => d.toISOString().slice(0, 10);
const range = (from, to) => { const out = []; for (let d = new Date(`${from}T00:00:00Z`); ymd(d) <= to; d.setUTCDate(d.getUTCDate() + 1)) out.push(ymd(d)); return out; };
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const csvCell = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));

/** A small but valid one-page PDF with a few lines of text. */
function samplePdf(title, lines) {
  const esc = (t) => t.replace(/[()\\]/g, '');
  const text = [`BT /F1 18 Tf 60 770 Td (${esc(title)}) Tj ET`, ...lines.map((l, i) => `BT /F1 11 Tf 60 ${735 - i * 18} Td (${esc(l)}) Tj ET`)].join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1').toString('base64');
}

// ── People ──────────────────────────────────────────────────────────────────
const HQ = 'Bengaluru HQ';
const PLANT = 'Peenya Plant';
const people = [
  ['E001', 'Vikram Rao', '2019-06-03', HQ, 'Management', 'Director', '', 'FULL_TIME', 'vikram@acme.test', '+91 98450 10001', '1978-03-14', 'MALE', 'MARRIED', 'B+', 'Ramesh Rao', 'Standard', 180000],
  ['E002', 'Meera Iyer', '2021-04-12', HQ, 'Sales', 'Sales Manager', 'E001', 'FULL_TIME', 'meera@acme.test', '+91 98450 10002', '1987-11-02', 'FEMALE', 'MARRIED', 'O+', 'Karthik Iyer', 'Standard', 85000],
  ['E003', 'Ravi Kumar', '2023-07-17', HQ, 'Sales', 'Sales Executive', 'E002', 'FULL_TIME', 'ravi@acme.test', '+91 98450 10003', '1995-08-21', 'MALE', 'SINGLE', 'A+', 'Suresh Kumar', 'Standard', 42000],
  ['E004', 'Priya Sharma', '2024-01-08', HQ, 'Sales', 'Sales Executive', 'E002', 'FULL_TIME', 'priya@acme.test', '+91 98450 10004', '1997-02-09', 'FEMALE', 'SINGLE', 'AB+', 'Anil Sharma', 'Standard', 38000],
  ['E005', 'Hema Nair', '2020-09-01', HQ, 'Human Resources', 'HR Manager', 'E001', 'FULL_TIME', 'hema@acme.test', '+91 98450 10005', '1985-05-30', 'FEMALE', 'MARRIED', 'O-', 'Gopal Nair', 'Standard', 75000],
  ['E006', 'Arjun Menon', '2022-02-14', HQ, 'Accounts', 'Accountant', 'E001', 'FULL_TIME', 'arjun@acme.test', '+91 98450 10006', '1991-12-12', 'MALE', 'MARRIED', 'B-', 'Mohan Menon', 'Standard', 52000],
  ['E007', 'Kavya Reddy', '2026-10-12', HQ, 'Human Resources', 'HR Executive', 'E005', 'FULL_TIME', 'kavya@acme.test', '+91 98450 10007', '1999-07-25', 'FEMALE', 'SINGLE', 'A-', 'Srinivas Reddy', 'Standard', 30000],
  ['E008', 'Suresh Gowda', '2018-11-19', PLANT, 'Production', 'Plant Manager', 'E001', 'FULL_TIME', 'suresh@acme.test', '+91 98450 10008', '1980-01-17', 'MALE', 'MARRIED', 'B+', 'Ninge Gowda', 'Standard', 95000],
  ['E009', 'Manjunath B', '2020-03-02', PLANT, 'Production', 'Shift Supervisor', 'E008', 'FULL_TIME', '', '+91 98450 10009', '1986-06-06', 'MALE', 'MARRIED', 'O+', 'Basavaraj', 'Factory', 32000],
  ['E010', 'Lakshmi Devi', '2022-08-22', PLANT, 'Production', 'Machine Operator', 'E009', 'FULL_TIME', '', '+91 98450 10010', '1993-09-15', 'FEMALE', 'MARRIED', 'A+', 'Raju', 'Factory', 16000],
  ['E011', 'Rahul Patil', '2023-05-15', PLANT, 'Production', 'Machine Operator', 'E009', 'FULL_TIME', '', '+91 98450 10011', '1998-04-01', 'MALE', 'SINGLE', 'B+', 'Shivaji Patil', 'Factory', 17500],
  ['E012', 'Anil Kumar', '2021-10-04', PLANT, 'Maintenance', 'Maintenance Technician', 'E008', 'FULL_TIME', '', '+91 98450 10012', '1990-10-10', 'MALE', 'MARRIED', 'O+', 'Krishna', 'Factory', 19500],
  ['E013', 'Deepa S', '2022-12-05', PLANT, 'Quality', 'Quality Inspector', 'E008', 'FULL_TIME', 'deepa@acme.test', '+91 98450 10013', '1994-01-28', 'FEMALE', 'SINGLE', 'AB-', 'Subramani', 'Factory', 23000],
  ['E014', 'Imran Khan', '2024-06-10', PLANT, 'Stores', 'Store Keeper', 'E008', 'FULL_TIME', '', '+91 98450 10014', '1992-03-03', 'MALE', 'MARRIED', 'A+', 'Salim Khan', 'Factory', 18500],
  ['E015', 'Sneha Joshi', '2026-06-01', HQ, 'Accounts', 'Accounts Assistant (contract)', 'E006', 'CONTRACT', 'sneha@acme.test', '+91 98450 10015', '2000-12-19', 'FEMALE', 'SINGLE', 'B+', 'Mahesh Joshi', 'Standard', 24000],
];
const banks = [['HDFC Bank', 'HDFC0001234'], ['ICICI Bank', 'ICIC0000567'], ['State Bank of India', 'SBIN0004321'], ['Canara Bank', 'CNRB0002468'], ['Axis Bank', 'UTIB0000789']];
const streets = ['12, 4th Cross, Indiranagar', '221, 8th Main, Jayanagar 4th Block', '45, Sampige Road, Malleshwaram', 'Flat 302, Prestige Lakeside, Whitefield', '9, 2nd Stage, Peenya', '17, MES Road, Yeshwanthpur', '88, 1st Main, Rajajinagar', '5, Bull Temple Road, Basavanagudi'];
const pan = (i) => `${'ABCDEFGHJK'[i % 10]}${'KLMNP'[i % 5]}QP${'RSTUV'[i % 5]}${String(4100 + i * 37).slice(-4)}${'FGHJK'[i % 5]}`;

try {
  console.log('Tenant');
  const seed = execSync('npx ts-node scripts/platform-admin.ts --email ops@iverto.test --name Ops', { cwd: API_DIR, env }).toString();
  const platform = await firstLogin('ops@iverto.test', seed.match(/Temporary password: (\S+)/)[1]);
  const tenant = await call(platform, 'POST', '/platform/tenants', { name: 'Acme Industries', slug: 'acme', site: { name: HQ, timezone: 'Asia/Kolkata' }, admin: { fullName: 'Asha Admin', email: 'asha@acme.test' }, features: { hr: true, payroll: true } });
  const admin = await firstLogin('asha@acme.test', tenant.admin.temporaryPassword);

  console.log('Organisation: sites, departments, holidays, policy, leave types, payroll');
  const [calendar] = await call(admin, 'GET', '/holiday-calendars');
  await call(admin, 'POST', `/holiday-calendars/${calendar.id}/holidays/import`, { holidays: [
    { date: '2026-10-02', name: 'Gandhi Jayanti' }, { date: '2026-10-20', name: 'Vijayadashami' }, { date: '2026-11-01', name: 'Kannada Rajyotsava' },
    { date: '2026-12-25', name: 'Christmas' },
  ] });
  const hqSite = (await call(admin, 'GET', '/sites'))[0];
  await call(admin, 'PATCH', `/sites/${hqSite.id}`, { name: HQ, timezone: 'Asia/Kolkata', address: '3rd Floor, Brigade Tech Park, Whitefield, Bengaluru 560066', holidayCalendarId: calendar.id });
  await call(admin, 'POST', '/sites', { name: PLANT, timezone: 'Asia/Kolkata', address: 'Plot 42, Peenya Industrial Area Phase II, Bengaluru 560058', holidayCalendarId: calendar.id });
  for (const [name, code] of [['Management', 'MGT'], ['Sales', 'SAL'], ['Human Resources', 'HR'], ['Accounts', 'ACC'], ['Production', 'PRD'], ['Maintenance', 'MNT'], ['Quality', 'QA'], ['Stores', 'STR']]) {
    await call(admin, 'POST', '/departments', { name, code });
  }
  await call(admin, 'PATCH', '/org', { branding: DEMO_BRANDING });
  const [policy] = await call(admin, 'GET', '/attendance-policies');
  await call(admin, 'PATCH', `/attendance-policies/${policy.id}`, { name: 'Default', overtimeEnabled: true, lateDeduction: 'HALF_DAY', lateDeductionEvery: 3 });
  const leaveTypes = await call(admin, 'GET', '/leave/types');
  for (const t of leaveTypes) await call(admin, 'PATCH', `/leave/types/${t.id}`, { code: t.code, name: t.name, active: true });
  const LT = Object.fromEntries(leaveTypes.map((t) => [t.code, t.id]));
  await call(admin, 'PUT', '/payroll/settings', { defaultPtState: 'KA', payDay: 1 });
  await call(admin, 'GET', '/payroll/structures'); // seeds "Standard"
  await call(admin, 'POST', '/payroll/structures', { name: 'Factory', components: [
    { code: 'BASIC', name: 'Basic', kind: 'EARNING', calc: 'PCT_GROSS', value: 60, prorate: true },
    { code: 'HRA', name: 'House rent allowance', kind: 'EARNING', calc: 'PCT_BASIC', value: 15, prorate: true },
    { code: 'CONV', name: 'Conveyance', kind: 'EARNING', calc: 'FIXED', value: 1600, prorate: true },
    { code: 'SPECIAL', name: 'Special allowance', kind: 'EARNING', calc: 'BALANCE', value: 0, prorate: true },
  ] });

  console.log('People (via the Excel/CSV import)');
  const header = ['employeeCode', 'fullName', 'joinedOn', 'siteName', 'departmentName', 'designation', 'managerCode', 'employmentType', 'email', 'phone', 'dateOfBirth', 'gender', 'maritalStatus', 'bloodGroup', 'fatherOrSpouseName',
    'personalEmail', 'altPhone', 'currentAddress', 'permanentAddress', 'emergencyName', 'emergencyRelation', 'emergencyPhone', 'pan', 'aadhaarLast4', 'uan', 'esicNumber',
    'paymentMode', 'bankAccountName', 'bankAccountNumber', 'bankIfsc', 'bankName', 'probationEndOn', 'noticePeriodDays', 'salaryStructure', 'monthlyGross'];
  const rows = people.map((p, i) => {
    const [code, name, joined, site, dept, desig, mgr, type, email, phone, dob, gender, marital, blood, father, structure, gross] = p;
    const [bank, ifsc] = banks[i % banks.length];
    const factory = structure === 'Factory';
    const noBank = code === 'E012'; // shows the "bank details missing" warning
    return [code, name, joined, site, dept, desig, mgr, type, email, phone, dob, gender, marital, blood, father,
      `${name.split(' ')[0].toLowerCase()}.${(name.split(' ')[1] ?? 'k').toLowerCase()}@gmail.com`, '', `${streets[i % streets.length]}, Bengaluru`, i % 3 ? `${streets[(i + 3) % streets.length]}, Mysuru` : '',
      father, i % 2 ? 'Father' : 'Spouse', `+91 99000 2${String(1000 + i).slice(1)}`, pan(i), String(1000 + ((i * 7919) % 9000)), `1009${String(87654321 + i * 1111).slice(0, 8)}`,
      factory ? `52${String(10000000 + i * 4321).slice(0, 8)}` : '', code === 'E014' ? 'CASH' : '', noBank ? '' : name.toUpperCase(), noBank || code === 'E014' ? '' : `50100${String(234567890 + i * 98765)}`,
      noBank || code === 'E014' ? '' : ifsc, noBank || code === 'E014' ? '' : bank, joined >= '2026-06-01' ? '2026-12-31' : '', factory ? 30 : 60, structure, gross];
  });
  const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
  const dry = await call(admin, 'POST', '/employees/import', { csv, mode: 'CREATE', biometricConsent: true });
  if (dry.invalid) console.log('    import problems:', JSON.stringify(dry.errors).slice(0, 600));
  await call(admin, 'POST', '/employees/import', { csv, mode: 'CREATE', biometricConsent: true, commit: true });
  const list = (await call(admin, 'GET', '/employees?size=200')).items;
  const E = Object.fromEntries(list.map((e) => [e.employeeCode, e]));

  console.log('Logins');
  const tokens = {};
  for (const [code, email, role] of [['E005', 'hema@acme.test', 'HR'], ['E002', 'meera@acme.test', 'MANAGER'], ['E008', 'suresh@acme.test', 'MANAGER'], ['E003', 'ravi@acme.test', 'EMPLOYEE'], ['E004', 'priya@acme.test', 'EMPLOYEE']]) {
    const u = await call(admin, 'POST', '/users', { email, displayName: E[code].fullName, role, employeeId: E[code].id });
    tokens[code] = await firstLogin(email, u.temporaryPassword);
  }
  const hr = tokens.E005;

  console.log('Leave: opening balances, approved and pending requests');
  for (const e of list) {
    await call(admin, 'POST', '/leave/adjustments', { employeeId: e.id, leaveTypeId: LT.CL, year: 2026, delta: 6, kind: 'OPENING', note: 'Opening balance' });
    await call(admin, 'POST', '/leave/adjustments', { employeeId: e.id, leaveTypeId: LT.SL, year: 2026, delta: 8, kind: 'OPENING', note: 'Opening balance' });
  }
  const leave = [
    ['E003', 'CL', '2026-10-15', '2026-10-15', 'Family function', true],
    ['E004', 'SL', '2026-10-27', '2026-10-28', 'Viral fever', true],
    ['E006', 'CL', '2026-11-03', '2026-11-03', 'Bank work', true],
    ['E010', 'LOP', '2026-10-09', '2026-10-10', 'Travel to native place', true],
    ['E013', 'SL', '2026-11-12', '2026-11-12', 'Dental appointment', true],
    ['E011', 'CL', '2026-11-16', '2026-11-16', 'Personal work', true],
    ['E003', 'CL', '2026-11-26', '2026-11-27', 'Cousin’s wedding', false],
    ['E009', 'CL', '2026-11-30', '2026-11-30', 'Personal work', false],
  ];
  const onLeave = new Set();
  for (const [code, type, from, to, reason, approve] of leave) {
    const r = await call(admin, 'POST', '/leave/requests', { employeeId: E[code].id, leaveTypeId: LT[type], from, to, reason });
    if (approve && r?.id) {
      await call(admin, 'POST', `/leave/requests/${r.id}/approve`, { note: 'Approved' });
      for (const d of range(from, to)) onLeave.add(`${code}:${d}`);
    }
  }

  console.log('Attendance: Oct 1 – today (manual punches, then recompute)');
  const holidays = new Set(['2026-10-02', '2026-10-20', '2026-11-01']);
  const days = range('2026-10-01', TODAY).filter((d) => new Date(`${d}T00:00:00Z`).getUTCDay() !== 0 && !holidays.has(d));
  const punches = [];
  for (const p of people) {
    const [code, , joined, site] = p;
    for (const d of days) {
      if (d < joined || onLeave.has(`${code}:${d}`)) continue;
      if (rnd() < 0.03) continue; // unplanned absence
      const late = rnd() < 0.1;
      const inAt = late ? `09:${20 + Math.floor(rnd() * 25)}` : `08:${45 + Math.floor(rnd() * 14)}`;
      const ot = site === PLANT && rnd() < 0.18;
      const outAt = ot ? `20:${pad(10 + Math.floor(rnd() * 40))}` : `18:${pad(2 + Math.floor(rnd() * 25))}`;
      punches.push([E[code].id, d, inAt, 'in']);
      if (d !== TODAY) punches.push([E[code].id, d, outAt, 'out']);
    }
  }
  let done = 0;
  await pool(punches, 4, async ([employeeId, d, hm, direction]) => {
    await call(admin, 'POST', '/punches', { employeeId, at: `${d}T${hm}:00+05:30`, direction, reason: 'Demo data' });
    if (++done % 250 === 0) console.log(`    ${done}/${punches.length} punches`);
  });
  await call(admin, 'POST', '/attendance/recompute', { from: '2026-10-01', to: TODAY, reason: 'Demo data backfill' });
  for (let i = 0; i < 90; i++) {
    const pending = await call(admin, 'GET', `/attendance/days?from=2026-10-01&to=2026-10-31&status=PENDING&size=1`);
    if (pending?.total === 0) break;
    await sleep(2000);
  }

  console.log('Expenses (approved ones are reimbursed in October)');
  const receipt = (t, amt) => ({ receiptBase64: samplePdf(t, [`Amount: Rs ${amt}`, 'Paid by card', 'Demo receipt']), receiptType: 'application/pdf' });
  const c1 = await call(tokens.E003, 'POST', '/mobile/expenses', { category: 'Travel', amount: 1450, claimDate: '2026-10-21', description: 'Cab to Infosys Electronic City for product demo', ...receipt('Uber trip', 1450) });
  const c2 = await call(tokens.E004, 'POST', '/mobile/expenses', { category: 'Client meeting', amount: 2380, claimDate: '2026-10-29', description: 'Lunch with Tata Motors procurement team', ...receipt('Truffles, Koramangala', 2380) });
  for (const c of [c1, c2]) {
    await call(tokens.E002, 'POST', `/expenses/${c.id}/approve`, { note: 'OK' });
    await call(hr, 'POST', `/expenses/${c.id}/approve`, {});
  }

  console.log('October payroll: bonus, incentive, loan → run → approve → paid');
  for (const code of ['E009', 'E010', 'E011', 'E012', 'E013', 'E014']) await call(hr, 'POST', '/payroll/adjustments', { employeeId: E[code].id, month: '2026-10', kind: 'EARNING', code: 'BONUS', amount: 2000, note: 'Dussehra bonus' });
  await call(hr, 'POST', '/payroll/adjustments', { employeeId: E.E003.id, month: '2026-10', kind: 'EARNING', code: 'INCENTIVE', amount: 7500, note: 'Q3 sales target' });
  await call(hr, 'POST', '/payroll/adjustments', { employeeId: E.E004.id, month: '2026-10', kind: 'EARNING', code: 'INCENTIVE', amount: 4000, note: 'Q3 sales target' });
  await call(hr, 'POST', '/payroll/loans', { employeeId: E.E011.id, principal: 15000, emi: 2500, startMonth: '2026-10', note: 'Two-wheeler advance' });
  await call(hr, 'POST', '/payroll/loans', { employeeId: E.E014.id, principal: 6000, emi: 2000, startMonth: '2026-11', note: 'Medical advance' });
  const run = await call(hr, 'POST', '/payroll/runs', { month: '2026-10', force: true });
  await call(hr, 'POST', `/payroll/runs/${run.id}/approve`);
  await call(hr, 'POST', `/payroll/runs/${run.id}/paid`);
  for (const code of ['E001', 'E002', 'E008']) await call(hr, 'POST', '/payroll/adjustments', { employeeId: E[code].id, month: '2026-11', kind: 'EARNING', code: 'BONUS', amount: 10000, note: 'Diwali bonus' });
  // HR cannot pay herself (SELF_ACTION): the administrator adds Hema's bonus.
  await call(admin, 'POST', '/payroll/adjustments', { employeeId: E.E005.id, month: '2026-11', kind: 'EARNING', code: 'BONUS', amount: 10000, note: 'Diwali bonus' });
  for (const code of ['E003', 'E004', 'E006', 'E009', 'E010', 'E011', 'E012', 'E013', 'E014']) await call(hr, 'POST', '/payroll/adjustments', { employeeId: E[code].id, month: '2026-11', kind: 'EARNING', code: 'BONUS', amount: 3000, note: 'Diwali bonus' });

  console.log('Pending items for approvers');
  const c3 = await call(tokens.E003, 'POST', '/mobile/expenses', { category: 'Fuel', amount: 900, claimDate: '2026-11-12', description: 'Fuel for client visits, Hosur Road', ...receipt('Indian Oil', 900) });
  const c4 = await call(tokens.E004, 'POST', '/mobile/expenses', { category: 'Food', amount: 640, claimDate: '2026-11-14', description: 'Team dinner after the Bosch pitch', ...receipt('Meghana Foods', 640) });
  await call(tokens.E002, 'POST', `/expenses/${c4.id}/approve`, { note: 'Fine' });
  void c3; // waits for Meera
  await call(tokens.E004, 'POST', '/mobile/profile/requests', { changes: { currentAddress: 'Flat 1104, Sobha Dream Acres, Panathur, Bengaluru', bankIfsc: 'ICIC0000567', bankName: 'ICICI Bank', bankAccountNumber: '002301556789' }, reason: 'Moved house and changed salary account' });
  const pr = await call(tokens.E003, 'POST', '/mobile/profile/requests', { changes: { altPhone: '+91 99001 23456', bloodGroup: 'A+' }, reason: 'Adding an alternate number' });
  await call(hr, 'POST', `/profile-requests/${pr.id}/approve`, {});

  console.log('Documents & letters');
  const doc = (category, name, expiresOn) => ({ category, name, fileName: `${name.replace(/\W+/g, '-').toLowerCase()}.pdf`, contentType: 'application/pdf', ...(expiresOn ? { expiresOn } : {}) });
  for (const code of ['E002', 'E003', 'E004', 'E005', 'E008', 'E010']) {
    const name = E[code].fullName;
    await call(hr, 'POST', `/employees/${E[code].id}/documents`, { ...doc('ID_PROOF', 'Aadhaar card'), dataBase64: samplePdf('Aadhaar (masked)', [name, 'XXXX XXXX ' + E[code].aadhaarLast4]) });
    await call(hr, 'POST', `/employees/${E[code].id}/documents`, { ...doc('ID_PROOF', 'PAN card'), dataBase64: samplePdf('Income Tax Department - PAN', [name, E[code].pan ?? '']) });
  }
  await call(hr, 'POST', `/employees/${E.E001.id}/documents`, { ...doc('ID_PROOF', 'Passport', '2026-12-05'), dataBase64: samplePdf('Passport', ['Vikram Rao', 'Expires 05 Dec 2026']) });
  await call(hr, 'POST', `/employees/${E.E009.id}/documents`, { ...doc('OTHER', 'Forklift licence', '2026-11-30'), dataBase64: samplePdf('Forklift operator licence', ['Manjunath B', 'Valid till 30 Nov 2026']) });
  await call(hr, 'POST', `/employees/${E.E003.id}/documents`, { ...doc('EDUCATION', 'MBA degree certificate'), dataBase64: samplePdf('Degree certificate', ['Ravi Kumar', 'MBA (Marketing), 2019']) });
  await call(tokens.E004, 'POST', '/mobile/documents', { ...doc('EDUCATION', 'B.Com marks card'), dataBase64: samplePdf('Marks card', ['Priya Sharma', 'B.Com, 2018']) });
  // Copy the starting points HR would pick from Settings → Letters.
  const tpl = {};
  for (const key of ['offer', 'appointment', 'confirmation', 'experience', 'relieving']) {
    const t = await call(hr, 'POST', `/letter-templates/library/${key}/adopt`);
    if (t?.kind) tpl[t.kind === 'OTHER' ? key.toUpperCase() : t.kind] = t.id;
  }
  await call(hr, 'POST', `/employees/${E.E007.id}/letters`, { templateId: tpl.OFFER });
  await call(hr, 'POST', `/employees/${E.E007.id}/letters`, { templateId: tpl.APPOINTMENT });
  await call(hr, 'POST', `/employees/${E.E004.id}/letters`, { templateId: tpl.APPOINTMENT });

  console.log('Assets');
  await call(hr, 'PUT', '/hr/settings', {});
  const assets = [
    ['LAP-001', 'Dell Latitude 5440', 'Laptop', 'DL5440-8H2K1', 'E002'], ['LAP-002', 'Dell Latitude 5440', 'Laptop', 'DL5440-9J3L2', 'E003'],
    ['LAP-003', 'Lenovo ThinkPad E14', 'Laptop', 'TPE14-77Q1', 'E004'], ['LAP-004', 'MacBook Air M3', 'Laptop', 'C02ZK1Q8MD6T', 'E001'],
    ['LAP-005', 'Lenovo ThinkPad E14', 'Laptop', 'TPE14-77Q9', 'E015'], ['LAP-006', 'HP ProBook 440', 'Laptop', 'HP440-1XZ', ''],
    ['PHN-001', 'Samsung Galaxy A35', 'Mobile phone', '35721911', 'E008'], ['PHN-002', 'Samsung Galaxy A35', 'Mobile phone', '35721914', ''],
    ['SIM-001', 'Airtel postpaid SIM', 'SIM card', '8991-0021', 'E003'], ['SIM-002', 'Airtel postpaid SIM', 'SIM card', '8991-0022', 'E015'],
    ['IDC-101', 'Access card – HQ', 'Access card', 'HID-1101', 'E007'], ['IDC-201', 'Access card – Plant', 'Access card', 'HID-2201', 'E010'],
  ];
  for (const [tag, name, category, serialNo, holder] of assets) {
    const a = await call(hr, 'POST', '/assets', { tag, name, category, serialNo });
    if (holder && a?.id) await call(hr, 'POST', `/assets/${a.id}/assign`, { employeeId: E[holder].id });
  }

  console.log('Announcements');
  const a1 = await call(hr, 'POST', '/announcements', { title: 'Diwali holidays and bonus', body: 'Offices and the plant are closed on Monday 9 November for Diwali. The Diwali bonus will be paid with November salary on 1 December.\n\nWishing you and your families a happy and safe Diwali!' });
  await call(hr, 'POST', `/announcements/${a1.id}/publish`);
  const a2 = await call(hr, 'POST', '/announcements', { title: 'Updated attendance & leave policy', body: 'From 1 November: three late arrivals in a month cost half a day, and overtime at the plant is paid at double the hourly rate. Please read the policy in the HR portal and acknowledge.', requiresAck: true });
  await call(hr, 'POST', `/announcements/${a2.id}/publish`);
  for (const code of ['E003', 'E002']) await call(tokens[code], 'POST', `/mobile/announcements/${a2.id}/ack`);
  await call(hr, 'POST', '/announcements', { title: 'Quarterly town hall – 5 December', body: 'Draft: agenda, venue and dial-in details to follow.' });

  console.log('Checklists: older joiners done; Kavya still onboarding; Sneha leaving');
  const tasks = await call(hr, 'GET', '/tasks/mine');
  for (const t of tasks.filter((t) => t.employee && !['E007'].includes(t.employee.employeeCode))) await call(hr, 'POST', `/tasks/${t.id}/done`, {});
  const kavyaTasks = (await call(hr, 'GET', `/employees/${E.E007.id}/tasks`)).filter((t) => t.assigneeRole === 'HR').slice(0, 2);
  for (const t of kavyaTasks) await call(hr, 'POST', `/tasks/${t.id}/done`, { note: 'Collected' });
  await call(admin, 'POST', `/employees/${E.E015.id}/offboard`, { exitOn: '2026-11-30', reason: 'Contract ends' });

  console.log(`\nDone${warnings ? ` with ${warnings} warning(s) above` : ''}. Web: http://localhost:5173 — sign-ins are listed at the top of test/seed-demo.mjs.`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
