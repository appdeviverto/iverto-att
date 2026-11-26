// Security regression suite against the LOCAL stack (Docker Postgres + Redis, mock Supabase, API on :8040),
// seeded by test/seed-demo.mjs. Every test asserts the SECURE behaviour: a failing test is an open finding.
//
//   node test/restart-stack.mjs && node test/mock-blob.mjs   (separate terminal)
//   node test/seed-demo.mjs
//   node --test --test-concurrency=1 test/security.test.mjs
//
// Writes only into the seeded demo tenant ("acme") and a throwaway second tenant ("sec-probe").
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { networkInterfaces } from 'node:os';
const require = createRequire(new URL('../package.json', import.meta.url));
const jose = require('jose');

const API = process.env.SEC_API || 'http://127.0.0.1:8040/v1';
const MOCK = process.env.SEC_MOCK || 'http://127.0.0.1:54321';
const PASSWORD = 'Acme-Demo-2026!';
const EVIL = 'https://evil.example';

async function call(token, method, path, body, headers = {}) {
  const res = await fetch(API + path, {
    method,
    redirect: 'manual',
    signal: AbortSignal.timeout(20000), // the mock Supabase never answers some routes; fail instead of hanging
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
async function login(email, password = PASSWORD) {
  const r = await fetch(`${MOCK}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const j = await r.json();
  if (!j.access_token) throw new Error(`login failed for ${email} (is the demo seeded?): ${JSON.stringify(j)}`);
  return j.access_token;
}
const denied = (r) => r.status === 401 || r.status === 403 || r.status === 404;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const claims = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());

/** Tokens by persona; ids resolved from the seed. */
const T = {};
const ID = {};

// Top-level await: node:test runs describe() bodies before a root before() hook.
{
  for (const [k, email] of Object.entries({ admin: 'asha@acme.test', hr: 'hema@acme.test', meera: 'meera@acme.test', suresh: 'suresh@acme.test', ravi: 'ravi@acme.test', priya: 'priya@acme.test', ops: 'ops@iverto.test' })) {
    T[k] = await login(email);
  }
  ID.tenant = claims(T.ravi).app_metadata.tenant_id;
  ID.ravi = claims(T.ravi).app_metadata.employee_id;
  ID.priya = claims(T.priya).app_metadata.employee_id;
  ID.meera = claims(T.meera).app_metadata.employee_id;
  ID.suresh = claims(T.suresh).app_metadata.employee_id;
  ID.hema = claims(T.hr).app_metadata.employee_id;
  ID.employees = (await call(T.admin, 'GET', '/employees?size=100')).body.items;
  ID.byCode = Object.fromEntries(ID.employees.map((e) => [e.employeeCode, e.id]));
  const sites = (await call(T.admin, 'GET', '/sites')).body;
  ID.hq = sites.find((x) => /HQ/.test(x.name)).id;
  ID.plant = sites.find((x) => /Plant/.test(x.name)).id;
  ID.plantEmployees = ID.employees.filter((e) => e.siteId === ID.plant).map((e) => e.id);
}

// ───────────────────────────── Authentication ─────────────────────────────
describe('authentication', () => {
  test('protected routes refuse anonymous callers', async () => {
    for (const p of ['/employees', '/leave/requests', '/payroll/runs', '/audit-logs', '/users', '/platform/tenants']) {
      const r = await call(null, 'GET', p);
      assert.equal(r.status, 401, `${p} → ${r.status}`);
    }
  });

  test('alg=none token is rejected', async () => {
    const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...claims(T.ravi), app_metadata: { ...claims(T.ravi).app_metadata, role: 'ADMIN' } })}.`;
    assert.equal((await call(forged, 'GET', '/employees')).status, 401);
  });

  test('payload tampering (EMPLOYEE → ADMIN) breaks the signature', async () => {
    const [h, , s] = T.ravi.split('.');
    const c = claims(T.ravi);
    const forged = `${h}.${b64({ ...c, app_metadata: { ...c.app_metadata, role: 'ADMIN' } })}.${s}`;
    assert.equal((await call(forged, 'GET', '/users')).status, 401);
  });

  test('token signed by an attacker key with the same kid is rejected', async () => {
    const { privateKey } = await jose.generateKeyPair('RS256');
    const c = claims(T.ravi);
    const forged = await new jose.SignJWT({ ...c, app_metadata: { ...c.app_metadata, role: 'ADMIN' } })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).sign(privateKey);
    assert.equal((await call(forged, 'GET', '/users')).status, 401);
  });

  test('HS256 key-confusion (public JWK as HMAC secret) is rejected', async () => {
    const jwks = await (await fetch(`${MOCK}/auth/v1/.well-known/jwks.json`)).json();
    const c = claims(T.ravi);
    const forged = await new jose.SignJWT({ ...c, app_metadata: { ...c.app_metadata, is_super_admin: true } })
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' }).sign(new TextEncoder().encode(JSON.stringify(jwks.keys[0])));
    assert.equal((await call(forged, 'GET', '/platform/tenants')).status, 401);
  });

  test('X-Tenant-Id is ignored for non-platform users', async () => {
    const r = await call(T.ravi, 'GET', '/users', undefined, { 'x-tenant-id': ID.tenant });
    assert.equal(r.status, 403);
  });

  test('forgot-password does not reveal whether an account exists', async () => {
    const a = await call(null, 'POST', '/auth/forgot-password', { email: 'ravi@acme.test' }, { authorization: 'Bearer enum-a' });
    const b = await call(null, 'POST', '/auth/forgot-password', { email: 'no-such-user@acme.test' }, { authorization: 'Bearer enum-b' });
    assert.equal(a.status, b.status);
    assert.deepEqual(a.body, b.body);
  });

});

// ───────────────────────────── Vertical privilege (roles) ─────────────────────────────
describe('role enforcement', () => {
  const adminOnly = [
    ['GET', '/users'],
    ['GET', '/audit-logs'],
    ['POST', '/users', { email: 'x@acme.test', displayName: 'X', role: 'ADMIN' }],
    ['POST', '/sites', { name: 'Rogue', timezone: 'Asia/Kolkata' }],
    ['POST', '/employees', { fullName: 'Ghost', employeeCode: 'G999' }],
    ['GET', '/payroll/runs'],
  ];
  for (const [m, p, body] of adminOnly) {
    test(`EMPLOYEE cannot ${m} ${p}`, async () => {
      const r = await call(T.ravi, m, p, body);
      assert.ok(denied(r), `${m} ${p} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    });
  }

  test('tenant ADMIN cannot reach platform routes', async () => {
    assert.equal((await call(T.admin, 'GET', '/platform/tenants')).status, 403);
  });

  test('unknown body fields are rejected (mass assignment)', async () => {
    const r = await call(T.ravi, 'POST', '/auth/password', { currentPassword: PASSWORD, newPassword: 'Another-Passw0rd!', role: 'ADMIN', tenantId: 'x' });
    assert.equal(r.status, 400);
  });
});

// ───────────────────────────── Transport / browser hardening ─────────────────────────────
describe('http hardening', () => {
  test('CORS does not trust arbitrary origins', async () => {
    const r = await fetch(`${API}/employees`, { method: 'OPTIONS', headers: { origin: EVIL, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
    const allow = r.headers.get('access-control-allow-origin');
    assert.ok(allow !== '*' && allow !== EVIL, `access-control-allow-origin: ${allow} (credentials: ${r.headers.get('access-control-allow-credentials')})`);
  });

  test('security headers present', async () => {
    const r = await fetch(`${API}/health/live`);
    for (const h of ['x-content-type-options', 'strict-transport-security', 'x-frame-options']) assert.ok(r.headers.get(h), `missing ${h}`);
    assert.equal(r.headers.get('x-powered-by'), null);
  });

  test('errors do not leak stack traces or SQL', async () => {
    const r = await call(T.admin, 'GET', `/employees/${encodeURIComponent("' OR 1=1--")}`);
    const s = JSON.stringify(r.body);
    assert.ok(!/at \w+ \(|prisma|SELECT |\.ts:\d+/i.test(s), s.slice(0, 300));
  });
});

// ───────────────────────────── Horizontal privilege (IDOR) ─────────────────────────────
describe('employee cannot read a colleague (IDOR)', () => {
  let priyaPayslip, priyaDoc;
  test('setup', async () => {
    priyaPayslip = (await call(T.admin, 'GET', `/employees/${ID.priya}/payslips`)).body.find((p) => p.status === 'PAID')?.id;
    priyaDoc = (await call(T.admin, 'GET', `/employees/${ID.priya}/documents`)).body[0]?.id;
    assert.ok(priyaPayslip && priyaDoc, 'seed has a paid payslip and a document for Priya');
  });
  for (const [label, path] of [
    ['profile', () => `/employees/${ID.priya}`],
    ['payslip list', () => `/employees/${ID.priya}/payslips`],
    ['salary history', () => `/employees/${ID.priya}/salaries`],
    ['document list', () => `/employees/${ID.priya}/documents`],
    ['payslip by id', () => `/payroll/payslips/${priyaPayslip}`],
    ['document link', () => `/documents/${priyaDoc}/url`],
    ['mobile payslip', () => `/mobile/payslips/${priyaPayslip}`],
    ['mobile document link', () => `/mobile/documents/${priyaDoc}/url`],
  ]) {
    test(`EMPLOYEE → colleague ${label}`, async () => {
      const r = await call(T.ravi, 'GET', path());
      assert.ok(denied(r), `${path()} → ${r.status}`);
    });
  }
  test('MANAGER cannot read an employee outside their team', async () => {
    const r = await call(T.meera, 'GET', `/employees/${ID.plantEmployees.find((id) => id !== ID.suresh)}`);
    assert.ok(denied(r), `→ ${r.status}`);
  });
  test('EMPLOYEE list endpoints only return themselves', async () => {
    const r = await call(T.ravi, 'GET', '/employees?size=100');
    assert.ok(denied(r) || r.body.items.every((e) => e.id === ID.ravi), JSON.stringify(r.body).slice(0, 200));
  });

  // Finding: /mobile/* is @SkipMfa ("the caller's own data") but delegates to role-scoped services, so a
  // password-only HR/ADMIN session reads every payslip and document there (mobile/mobile-hr.ts:89-112).
  test('[A2] mobile self-service payslip route serves only the caller’s own payslip, even to HR', async () => {
    const r = await call(T.hr, 'GET', `/mobile/payslips/${priyaPayslip}`);
    assert.ok(denied(r), `HR read Priya’s payslip over the 2FA-exempt mobile route → ${r.status}`);
  });
  test('[A2] mobile document link serves only the caller’s own documents, even to HR', async () => {
    const r = await call(T.hr, 'GET', `/mobile/documents/${priyaDoc}/url`);
    assert.ok(denied(r), `HR got a SAS link to Priya’s document over the mobile route → ${r.status}`);
  });
});

// ───────────────────────────── Account takeover / identity ─────────────────────────────
/** Admin creates a login; returns { userId, token } after the forced password change. */
async function newLogin(role, extra = {}) {
  const email = `sec-${role.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e4)}@acme.test`;
  const r = await call(T.admin, 'POST', '/users', { email, displayName: `sec probe ${role}`, role, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const temp = await login(email, r.body.temporaryPassword);
  await call(temp, 'POST', '/auth/password', { currentPassword: r.body.temporaryPassword, newPassword: PASSWORD });
  return { userId: r.body.userId, email, token: await login(email) };
}

describe('account takeover', () => {
  // Finding: users.service.resetPassword never checks the target's role (users.controller.ts:81-91).
  test('[A1] HR cannot reset an ADMIN’s password (and receive it)', async () => {
    const victim = await newLogin('ADMIN');
    try {
      const r = await call(T.hr, 'POST', `/users/${victim.userId}/reset-password`);
      assert.ok(denied(r), `HR reset an ADMIN password → ${r.status}, temporaryPassword returned: ${Boolean(r.body.temporaryPassword)}`);
    } finally {
      await call(T.admin, 'DELETE', `/users/${victim.userId}`);
    }
  });

  // The unique index on user_profiles.employee_id already blocks this (the reviewer's "hijack" did not
  // reproduce); kept as a regression test for the explicit EMPLOYEE_HAS_LOGIN check.
  test('[A3] HR cannot bind a second login to an employee who already has one', async () => {
    const r = await call(T.hr, 'POST', '/users', { email: `sec-link-${Date.now()}@acme.test`, displayName: 'link', role: 'MANAGER', employeeId: ID.ravi });
    if (r.status === 201) await call(T.admin, 'DELETE', `/users/${r.body.userId}`);
    assert.equal(r.status, 409, `→ ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  });
});

// ───────────────────────────── Segregation of duties ─────────────────────────────
describe('no self-service on money / attendance', () => {
  // Finding: assertEmployee lets HR act on their own record (payroll.ts:290, leave.ts:565).
  test('[A4] HR cannot add a payroll bonus for themselves', async () => {
    const r = await call(T.hr, 'POST', '/payroll/adjustments', { employeeId: ID.hema, month: '2027-01', kind: 'EARNING', code: 'BONUS', amount: 1, note: 'sec-probe' });
    if (r.status < 300) {
      const list = (await call(T.admin, 'GET', '/payroll/adjustments?month=2027-01')).body;
      for (const a of (list.items ?? list)) if (a.note === 'sec-probe') await call(T.admin, 'DELETE', `/payroll/adjustments/${a.id}`);
    }
    assert.ok(denied(r), `self bonus → ${r.status}`);
  });

  test('[B2] HR cannot top up their own leave balance', async () => {
    const leaveTypeId = (await call(T.admin, 'GET', '/leave/types')).body[0].id;
    const body = { employeeId: ID.hema, leaveTypeId, year: 2026, delta: 1, note: 'sec-probe' };
    const r = await call(T.hr, 'POST', '/leave/adjustments', body);
    if (r.status < 300) await call(T.admin, 'POST', '/leave/adjustments', { ...body, delta: -1, note: 'sec-probe revert' });
    assert.ok(denied(r), `self leave credit → ${r.status}`);
  });

  // Finding: roster override scope includes the manager themselves (schedule.ts:272).
  test('[B3] MANAGER cannot roster their own day off', async () => {
    const item = { employeeId: ID.meera, date: '2027-03-01' };
    const r = await call(T.meera, 'PUT', '/roster/overrides', { items: [{ ...item, shiftId: null, reason: 'sec-probe' }] });
    if (r.status < 300) await call(T.admin, 'DELETE', '/roster/overrides', { items: [item] });
    assert.ok(denied(r), `self day-off → ${r.status}`);
  });

  // Finding: the punch instant is not tied to the correction date (corrections.ts:278).
  test('[B6] a correction cannot plant a punch months away from its date', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const r = await call(T.ravi, 'POST', '/attendance/corrections', { date: today, in: '2026-01-15T03:30:00Z', reason: 'sec-probe' });
    if (r.status < 300 && r.body.id) await call(T.meera, 'POST', `/attendance/corrections/${r.body.id}/reject`, { note: 'sec-probe' });
    assert.equal(r.status, 400, `→ ${r.status}`);
  });
});

// ───────────────────────────── Site restriction ─────────────────────────────
describe('site-restricted HR', () => {
  let hqHr;
  test('setup: HR limited to Bengaluru HQ', async () => {
    hqHr = await newLogin('HR', { siteIds: [ID.hq] });
  });
  test('sees no Peenya Plant employee in the directory', async () => {
    const r = await call(hqHr.token, 'GET', '/employees?size=100');
    assert.ok(r.body.items.every((e) => e.siteId === ID.hq));
  });
  // Finding: payroll run detail / bank file ignore user.siteIds (payroll.ts:279, 705).
  test('[A6] payroll run detail hides other sites’ payslips', async () => {
    const run = (await call(T.admin, 'GET', '/payroll/runs')).body[0];
    const r = await call(hqHr.token, 'GET', `/payroll/runs/${run.id}`);
    const leaked = (r.body.payslips ?? []).filter((p) => ID.plantEmployees.includes(p.employeeId));
    assert.equal(leaked.length, 0, `${leaked.length} Peenya Plant payslips visible`);
  });
  test('[A6] bank file hides other sites’ account numbers', async () => {
    const run = (await call(T.admin, 'GET', '/payroll/runs')).body[0];
    const r = await call(hqHr.token, 'GET', `/payroll/runs/${run.id}/bank-file.csv`);
    const plantCodes = ID.employees.filter((e) => e.siteId === ID.plant).map((e) => e.employeeCode);
    const leaked = r.status === 200 ? plantCodes.filter((c) => String(r.body).includes(c)) : [];
    assert.deepEqual(leaked, [], `bank file lists plant employees ${leaked.join(',')}`);
  });
  // Finding: validateRefs only checks the site is in the tenant (employees.ts:190). Postgres RLS (WITH CHECK)
  // stops the write today, but it surfaces as an unhandled 500 instead of a 403.
  test('[A7] moving an HQ employee to Peenya Plant is refused cleanly', async () => {
    const r = await call(hqHr.token, 'PATCH', `/employees/${ID.priya}`, { siteId: ID.plant });
    if (r.status < 300) await call(T.admin, 'PATCH', `/employees/${ID.priya}`, { siteId: ID.hq });
    assert.ok(denied(r) || r.status === 400, `→ ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  });
  test('teardown', async () => { if (hqHr) await call(T.admin, 'DELETE', `/users/${hqHr.userId}`); });
});

// ───────────────────────────── Tenant isolation ─────────────────────────────
describe('tenant isolation', () => {
  const P = {};
  test('setup: second tenant "secprobe"', async () => {
    const email = 'admin@secprobe.test';
    try { P.admin = await login(email); } catch {
      const r = await call(T.ops, 'POST', '/platform/tenants', { name: 'Sec Probe', slug: 'secprobe', site: { name: 'Probe Site', timezone: 'Asia/Kolkata' }, admin: { fullName: 'Probe Admin', email } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const t = await login(email, r.body.admin.temporaryPassword);
      await call(t, 'POST', '/auth/password', { currentPassword: r.body.admin.temporaryPassword, newPassword: PASSWORD });
      P.admin = await login(email);
    }
    const site = (await call(P.admin, 'GET', '/sites')).body[0].id;
    const list = (await call(P.admin, 'GET', '/employees?size=100')).body.items;
    P.emp = list[0]?.id ?? (await call(P.admin, 'POST', '/employees', { employeeCode: 'P001', fullName: 'Probe Person', siteId: site, joinedOn: '2026-01-01' })).body.id;
    assert.ok(P.emp);
  });
  test('another tenant’s admin cannot read acme employees, payslips or documents', async () => {
    for (const p of [`/employees/${ID.ravi}`, `/employees/${ID.ravi}/payslips`, `/employees/${ID.ravi}/documents`, `/users/${claims(T.ravi).sub}`]) {
      const r = await call(P.admin, 'GET', p);
      assert.ok(denied(r) || (Array.isArray(r.body) && r.body.length === 0), `${p} → ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    }
  });
  test('another tenant’s admin cannot reset an acme password', async () => {
    const r = await call(P.admin, 'POST', `/users/${claims(T.priya).sub}/reset-password`);
    assert.ok(denied(r), `→ ${r.status}`);
  });
  // Finding: department head/policy ids are not checked against the tenant (org.ts:298-308).
  test('[B9] a department cannot point at another tenant’s employee', async () => {
    const r = await call(T.admin, 'POST', '/departments', { name: `sec-probe-${Date.now()}`, headEmployeeId: P.emp });
    if (r.status < 300) await call(T.admin, 'DELETE', `/departments/${r.body.id}`);
    assert.ok(r.status >= 400, `cross-tenant headEmployeeId accepted → ${r.status}`);
  });
});

// ───────────────────────────── Terminal (M50) channel ─────────────────────────────
function m50(xmlFields) {
  const ws = new WebSocket(API.replace(/^http/, 'ws').replace(/\/v1$/, '') + '/m50');
  const xml = `<?xml version="1.0"?><Message>${Object.entries(xmlFields).map(([k, v]) => `<${k}>${v}</${k}>`).join('')}</Message>`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('no answer from /m50')); }, 10000);
    ws.onopen = () => ws.send(xml);
    ws.onerror = (e) => { clearTimeout(timer); reject(e.error ?? new Error('ws error')); };
    ws.onmessage = async (m) => { clearTimeout(timer); ws.close(); resolve(typeof m.data === 'string' ? m.data : Buffer.from(await m.data.arrayBuffer?.() ?? m.data).toString()); };
  });
}

describe('terminal channel', () => {
  test('unknown serials cannot register', async () => {
    const res = await m50({ Request: 'Register', DeviceSerialNo: `NOPE${Date.now()}`, TerminalType: 'F500' });
    assert.match(res, /<Result>Fail<\/Result>/);
  });
  // Finding: Register re-mints the token for any provisioned serial; no device secret (terminal-registry.service.ts:40-85).
  test('[B1] a registered terminal cannot be re-registered (hijacked) by anyone who knows its serial', async () => {
    const serialNo = `SECPROBE${Date.now()}`;
    const dev = await call(T.admin, 'POST', '/terminals', { serialNo, siteId: ID.hq, gateName: 'sec-probe', direction: 'BOTH' });
    assert.equal(dev.status, 201, JSON.stringify(dev.body));
    try {
      const legit = await m50({ Request: 'Register', DeviceSerialNo: serialNo, TerminalType: 'F500' });
      assert.match(legit, /<Result>OK<\/Result>/, 'first registration');
      const attacker = await m50({ Request: 'Register', DeviceSerialNo: serialNo, TerminalType: 'F500' });
      assert.doesNotMatch(attacker, /<Result>OK<\/Result>/, `attacker re-registered and got a fresh token: ${attacker.match(/<Token>[^<]+/)?.[0]}`);
      // The legitimate recovery path: an admin re-arms the terminal, then it can register once more.
      assert.equal((await call(T.hr, 'POST', `/terminals/${dev.body.id}/rearm`)).status, 403, 'only an ADMIN re-arms');
      assert.equal((await call(T.admin, 'POST', `/terminals/${dev.body.id}/rearm`)).status, 201);
      assert.match(await m50({ Request: 'Register', DeviceSerialNo: serialNo, TerminalType: 'F500' }), /<Result>OK<\/Result>/, 're-armed terminal registers');
    } finally {
      await call(T.admin, 'DELETE', `/terminals/${dev.body.id}`);
    }
  });
});

// Rate limiting last: it burns the per-IP bucket for a minute.
describe('rate limiting (/auth/*: 10/min)', () => {
  const burst = async (headersFor) => {
    const codes = [];
    for (let i = 0; i < 15; i++) codes.push((await call(null, 'POST', '/auth/forgot-password', { email: 'nobody@acme.test' }, headersFor(i))).status);
    return codes;
  };

  test('a throttled request answers 429, not 500', async () => {
    const codes = await burst(() => ({ authorization: 'Bearer same-bucket' }));
    assert.ok(codes.includes(429), `codes: ${codes.join(',')}`);
    assert.ok(!codes.includes(500), `codes: ${codes.join(',')}`);
  });

  test('rotating a junk Authorization header does not reset the limit', async () => {
    const codes = await burst((i) => ({ authorization: `Bearer rot-${Date.now()}-${i}` }));
    assert.ok(codes.some((c) => c === 429 || c === 500), `never throttled: ${codes.join(',')}`);
  });

  // Loopback is the trusted proxy (Caddy), so spoof from this machine's LAN address, as an outside client would.
  const lan = Object.values(networkInterfaces()).flat().find((n) => n?.family === 'IPv4' && !n.internal)?.address;
  test('spoofed X-Forwarded-For does not reset the limit', { skip: !lan && 'no non-loopback IPv4 address' }, async () => {
    const codes = [];
    for (let i = 0; i < 15; i++) {
      const r = await fetch(API.replace(/127\.0\.0\.1|localhost/, lan) + '/auth/forgot-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${i + 1}` },
        body: JSON.stringify({ email: 'nobody@acme.test' }),
      });
      codes.push(r.status);
    }
    assert.ok(codes.some((c) => c === 429 || c === 500), `never throttled: ${codes.join(',')}`);
  });
});
