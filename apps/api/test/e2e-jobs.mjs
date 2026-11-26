// End-to-end: public API jobs (docs/public-api.md §12) — bulk employee upsert (validation shared
// with the CSV import, validateOnly, onInvalid, externalId, managers, site scope, unchanged rows),
// report jobs with download URLs, job visibility, job.completed webhooks.
// LOCAL ONLY: run after `node test/restart-stack.mjs`.
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

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
    console.log(`  ✗ ${msg}`, extra !== undefined ? JSON.stringify(extra).slice(0, 1200) : '');
  }
};
async function call(token, method, path, body, headers = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
const pub = (key, method, path, body, headers = {}) => call(key, method, '/public' + path, body, headers);
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
const idem = () => ({ 'idempotency-key': `t-${Math.random().toString(36).slice(2)}` });
const sql = (q) => execSync(`docker exec att-pg psql -U postgres -tA -c "${q}"`).toString().trim();
/** Webhooks and the event log are asynchronous (1 s dispatcher, commit-lag cap): poll, don't sleep. */
async function eventually(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(300);
  }
}
async function settle(key, id, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await pub(key, 'GET', `/jobs/${id}`);
    if (['succeeded', 'partially_succeeded', 'failed'].includes(r.body.status)) return r.body;
    await sleep(500);
  }
  return null;
}

const received = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => { received.push(JSON.parse(body)); res.end('ok'); });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const FULL = {
  enabled: true,
  modules: { org: ['GET'], employees: ['GET', 'POST'], punches: ['GET'], attendance: ['GET'], leave: ['GET'], reports: ['POST'] },
  approvalRequired: [],
  piiAllowed: true,
  maxKeys: 10,
  maxKeyLifetimeDays: 365,
  requireIpAllowlist: false,
  orgIpAllowlist: [],
  rateLimit: { perMinute: 600, burst: 600, perDay: 200000, concurrency: 20 },
  keyRateCeiling: 300,
  credits: { enabled: false, monthlyGrant: 100000, onExhausted: 'block', costs: {} },
  webhooks: { enabled: true, maxEndpoints: 5 },
  bulk: { maxRecordsPerRequest: 5, concurrentJobs: 1 },
};

try {
  console.log('1. Setup');
  const seed = execSync('npx ts-node scripts/platform-admin.ts --email jobops@iverto.test --name JobOps', { cwd: API_DIR, env }).toString();
  const platform = await firstLogin('jobops@iverto.test', seed.match(/Temporary password: (\S+)/)[1]);
  let r = await call(platform, 'POST', '/platform/tenants', { name: 'Jobs Co', slug: 'jobs-co', site: { name: 'Chennai', timezone: 'Asia/Kolkata' }, admin: { fullName: 'Jaya Admin', email: 'jaya@jobsco.test' } });
  const tenantId = r.body.tenant.id;
  const admin = await firstLogin('jaya@jobsco.test', r.body.admin.temporaryPassword);
  const chennai = (await call(admin, 'GET', '/sites')).body[0];
  const pune = (await call(admin, 'POST', '/sites', { name: 'Pune', timezone: 'Asia/Kolkata' })).body;
  const dept = (await call(admin, 'POST', '/departments', { name: 'Ops' })).body;
  const e0 = (await call(admin, 'POST', '/employees', { employeeCode: 'E0', fullName: 'Esha Zero', siteId: chennai.id, joinedOn: '2026-01-01', designation: 'Clerk' })).body;
  ok(e0.id && dept.id && pune.id, 'tenant, two sites, a department, one employee', { e0, dept });
  r = await call(platform, 'PUT', `/platform/api/tenants/${tenantId}/policy`, { policy: FULL });
  ok(r.status === 200 && r.body.policy.bulk.maxRecordsPerRequest === 5, 'policy: employees POST, reports POST, bulk max 5', r.body);
  const mk = async (name, scopes, extra = {}) => (await call(admin, 'POST', '/api-keys', { name, scopes, ...extra })).body.key;
  const BULK = await mk('HRIS sync', ['employees:read', 'employees:write'], { piiAccess: true });
  const REP = await mk('Reports', ['reports:generate']);
  const RO = await mk('Read only', ['employees:read']);
  const PUNE = await mk('Pune HRIS', ['employees:read', 'employees:write'], { siteIds: [pune.id] });
  ok(BULK && REP && RO && PUNE, 'keys created');
  r = await call(admin, 'POST', '/api-webhooks', { url: `http://127.0.0.1:${server.address().port}/hook`, events: ['job.completed'] });
  ok(r.status === 201, 'job.completed endpoint', r.body);

  console.log('2. Submit-time checks');
  const rec = (i, extra = {}) => ({ employeeCode: `N${i}`, fullName: `New ${i}`, joinedOn: '2026-02-01', siteId: chennai.id, ...extra });
  r = await pub(BULK, 'POST', '/employees/bulk', { records: [rec(1)] });
  ok(r.status === 400 && r.body.code === 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key required', r.body);
  r = await pub(BULK, 'POST', '/employees/bulk', { records: [1, 2, 3, 4, 5, 6].map((i) => rec(i)) }, idem());
  ok(r.status === 400 && r.body.code === 'TOO_MANY_RECORDS', 'records per request capped by policy', r.body);
  r = await pub(BULK, 'POST', '/employees/bulk', { records: [rec(1, { salary: 5 })] }, idem());
  ok(r.status === 400 && r.body.code === 'VALIDATION_FAILED' && r.body.errors[0].field === 'salary', 'unknown fields refused with index + field', r.body);
  r = await pub(PUNE, 'POST', '/employees/bulk', { records: [rec(1, { pan: 'ABCDE1234F' })] }, idem());
  ok(r.status === 400 && /PII/.test(r.body.errors?.[0]?.message), 'PII fields need a PII key', r.body);
  r = await pub(RO, 'POST', '/employees/bulk', { records: [rec(1)] }, idem());
  ok(r.status === 403 && r.body.code === 'INSUFFICIENT_PERMISSION', 'employees:write needed', r.body);

  console.log('3. validateOnly');
  r = await pub(BULK, 'POST', '/employees/bulk', { validateOnly: true, records: [rec(1), { employeeCode: 'E0', designation: 'Senior clerk' }, rec(3, { joinedOn: '2026-02-30' })] }, idem());
  ok(r.status === 202 && r.body.object === 'job' && r.body.status === 'queued' && r.body.progress.total === 3, '202 + queued job', r.body);
  let job = await settle(BULK, r.body.id);
  ok(job?.status === 'partially_succeeded' && job.result.rows.map((x) => x.status).join() === 'created,updated,failed', 'dry run reports what would happen', job);
  ok(job?.result.rows[2].errors[0].field === 'joinedOn', 'import validation (bad date) per row', job?.result.rows[2]);
  ok(sql(`SELECT count(*) FROM employees WHERE tenant_id='${tenantId}'`) === '1', 'nothing written');

  console.log('4. Upsert: create, update, managers, externalId');
  const records = [
    rec(1, { externalId: 'hris-1', departmentId: dept.id, managerEmployeeCode: 'N2', pan: 'ABCDE1234F' }),
    rec(2, { designation: 'Supervisor' }),
    { employeeCode: 'E0', designation: 'Senior clerk', departmentId: null },
    rec(4, { joinedOn: 'soon' }),
  ];
  const first = await pub(BULK, 'POST', '/employees/bulk', { records }, idem());
  r = await pub(BULK, 'POST', '/employees/bulk', { records: [rec(9)] }, idem());
  ok(r.status === 409 && r.body.code === 'JOB_LIMIT_REACHED', 'one bulk job at a time per org', r.body);
  job = await settle(BULK, first.body.id);
  ok(job?.status === 'partially_succeeded' && job.result.summary.created === 2 && job.result.summary.updated === 1 && job.result.summary.failed === 1, 'partial success summary', job?.result);
  ok(job?.progress.processed === 4 && job.completedAt, 'progress + completedAt', job);
  r = await pub(BULK, 'GET', '/employees?externalId=hris-1');
  const n1 = r.body.data[0];
  const n2id = job.result.rows[1].id;
  ok(n1?.employeeCode === 'N1' && n1.managerId === n2id && n1.departmentId === dept.id && n1.pii?.pan === 'ABCDE1234F', 'externalId, manager (a later record), department, PII saved', n1);
  r = await pub(BULK, 'GET', `/employees/${e0.id}`);
  ok(r.body.designation === 'Senior clerk' && r.body.departmentId === null, 'update: set + null clears', r.body);
  ok(await eventually(() => received.some((e) => e.type === 'job.completed' && e.data.id === first.body.id && e.data.status === 'partially_succeeded')), 'job.completed webhook', received);
  r = await eventually(async () => { const x = await pub(BULK, 'GET', '/events?type=employee.created'); return x.body.data?.filter((e) => [n1.id, n2id].includes(e.data.id)).length === 2 && x; });
  ok(r, 'employee.created events for bulk creates');
  ok(sql(`SELECT count(*) FROM audit_logs WHERE tenant_id='${tenantId}' AND action='EMPLOYEE_CREATED' AND actor_type='api_key'`) === '2', 'each create audited with the key as actor');
  ok(sql(`SELECT count(*) FROM audit_logs WHERE tenant_id='${tenantId}' AND action='EMPLOYEES_BULK_UPSERT'`) === '1', 'job audited');

  console.log('5. Idempotent re-run, match by externalId, reject mode');
  job = await settle(BULK, (await pub(BULK, 'POST', '/employees/bulk', { records: records.slice(0, 3) }, idem())).body.id);
  ok(job?.status === 'succeeded' && job.result.summary.unchanged === 3, 'same records again → unchanged, nothing written', job?.result);
  job = await settle(BULK, (await pub(BULK, 'POST', '/employees/bulk', { records: [{ externalId: 'hris-1', designation: 'Lead' }] }, idem())).body.id);
  ok(job?.result.rows[0].status === 'updated' && job.result.rows[0].id === n1.id, 'match by externalId alone', job?.result);
  job = await settle(BULK, (await pub(BULK, 'POST', '/employees/bulk', { onInvalid: 'reject', records: [rec(7), rec(8, { siteId: 'nope' })] }, idem())).body.id);
  ok(job?.status === 'failed' && job.error.code === 'VALIDATION_FAILED' && job.result.rows.map((x) => x.status).join() === 'skipped,failed', 'reject: nothing written when any record is invalid', job);
  ok(sql(`SELECT count(*) FROM employees WHERE tenant_id='${tenantId}' AND employee_code='N7'`) === '0', 'N7 not created');
  job = await settle(BULK, (await pub(BULK, 'POST', '/employees/bulk', { records: [{ externalId: 'hris-1', employeeCode: 'N2' }] }, idem())).body.id);
  ok(job?.result.rows[0].status === 'failed' && job.result.rows[0].errors[0].field === 'externalId', 'externalId owned by another employee refused', job?.result);

  console.log('6. Site-restricted key');
  job = await settle(PUNE, (await pub(PUNE, 'POST', '/employees/bulk', { records: [rec(5, { siteId: pune.id }), rec(6), { employeeCode: 'E0', designation: 'X' }] }, idem())).body.id);
  const st = job?.result.rows.map((x) => `${x.status}:${x.errors[0]?.code ?? ''}`);
  ok(st?.[0] === 'created:' && st[1] === 'failed:SITE_FORBIDDEN' && st[2] === 'failed:EMPLOYEE_NOT_FOUND', 'creates in its site; other sites refused; others’ employees not found', job?.result.rows);

  console.log('7. Report jobs');
  const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  r = await pub(REP, 'POST', '/reports', { type: 'custom:abcdefgh12', format: 'csv', filters: { dateFrom: today, dateTo: today } }, idem());
  ok(r.status === 400, 'tenant templates are not public report types', r.body);
  r = await pub(REP, 'POST', '/reports', { type: 'daily-summary', format: 'csv', filters: { dateFrom: today, dateTo: today } }, idem());
  ok(r.status === 202 && r.body.type === 'report', 'report job accepted', r.body);
  job = await settle(REP, r.body.id);
  ok(job?.status === 'succeeded' && /^https?:/.test(job.result.downloadUrl) && job.result.urlExpiresAt && job.result.rowCount >= 1, 'report done with a fresh download URL', job);
  if (job?.result.downloadUrl) {
    const file = await fetch(job.result.downloadUrl);
    const buf = Buffer.from(await file.arrayBuffer());
    ok(file.status === 200 && createHash('sha256').update(buf).digest('hex') === job.result.sha256, 'download matches sha256', { status: file.status });
  }
  r = await pub(REP, 'GET', '/jobs');
  ok(r.status === 200 && r.body.data.length === 1 && r.body.data[0].result.downloadUrl === null, 'list: own visible types; URL only on GET /jobs/:id', r.body);
  ok(await eventually(() => received.some((e) => e.type === 'job.completed' && e.data.id === job?.id && e.data.status === 'succeeded')), 'job.completed for the report', received.map((x) => x.data));
  ok(sql(`SELECT count(*) FROM audit_logs WHERE tenant_id='${tenantId}' AND action='REPORT_EXPORTED' AND actor_type='api_key'`) === '1', 'report export audited as the key');

  console.log('8. Visibility');
  r = await pub(RO, 'GET', '/jobs');
  ok(r.status === 200 && r.body.data.length === 0, 'a key without the job type’s permission sees no jobs', r.body);
  r = await pub(RO, 'GET', `/jobs/${first.body.id}`);
  ok(r.status === 404, '… and gets 404 by id', r.body);
  r = await pub(REP, 'GET', `/jobs/${first.body.id}`);
  ok(r.status === 404, 'report key cannot see bulk jobs', r.body);
  r = await pub(BULK, 'GET', '/jobs?type=employees.bulk_upsert');
  ok(r.body.data.length >= 6 && r.body.data.every((j) => j.type === 'employees.bulk_upsert'), 'bulk key lists bulk jobs (org-wide)', r.body.data?.length);

  console.log('9. Revoked key stops a queued job; crash resume');
  // Job rows written directly so the worker can't race the setup.
  const keys = (await call(admin, 'GET', '/api-keys')).body;
  const insertJob = (keyName, input, extra = '') => {
    const id = `job${Math.random().toString(36).slice(2, 12)}`;
    const json = JSON.stringify(input).replace(/"/g, '\\"');
    sql(`INSERT INTO api_jobs (id, tenant_id, api_key_id, type, input, progress, expires_at${extra ? ', status, checkpoint, locked_until, result' : ''}) VALUES ('${id}', '${tenantId}', '${keys.find((k) => k.name === keyName).id}', 'employees.bulk_upsert', '${json}', '{}', now() + interval '30 days'${extra})`);
    return id;
  };
  const input = (...rs) => ({ records: rs, validateOnly: false, onInvalid: 'skip' });
  await mk('Temp', ['employees:write']);
  await call(admin, 'POST', `/api-keys/${(await call(admin, 'GET', '/api-keys')).body.find((k) => k.name === 'Temp').id}/revoke`);
  keys.push(...(await call(admin, 'GET', '/api-keys')).body.filter((k) => k.name === 'Temp'));
  const revokedJob = insertJob('Temp', input(rec(10)));
  await sleep(4000);
  const revoked = sql(`SELECT status || ':' || (error->>'code') FROM api_jobs WHERE id='${revokedJob}'`);
  ok(revoked === 'FAILED:API_KEY_INACTIVE', 'revoked key → queued job fails, nothing written', revoked);
  ok(sql(`SELECT count(*) FROM employees WHERE tenant_id='${tenantId}' AND employee_code='N10'`) === '0', 'N10 not created');
  // A worker that died after the first record: checkpoint 1, expired lease.
  const done0 = JSON.stringify({ rows: [{ index: 0, status: 'created', id: 'x', errors: [] }] }).replace(/"/g, '\\"');
  const resumed = insertJob('HRIS sync', input(rec(11), rec(12)), `, 'RUNNING', 1, now() - interval '1 second', '${done0}'`);
  job = await settle(BULK, resumed);
  ok(job?.result.rows[1].status === 'created' && job.result.rows[0].id === 'x', 'resumes from the checkpoint', job?.result);
  ok(sql(`SELECT count(*) FROM employees WHERE tenant_id='${tenantId}' AND employee_code IN ('N11','N12')`) === '1', 'only the unfinished record was processed');
} catch (err) {
  failures++;
  console.error(err);
}

server.close();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
