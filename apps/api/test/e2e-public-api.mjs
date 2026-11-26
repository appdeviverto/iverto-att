// End-to-end: public developer API (docs/public-api.md) — keys, policy ceiling, permissions, sync,
// idempotency, ETag, rate limits, credits, logs, approvals, rotation, kill switch.
// LOCAL ONLY: run after `node test/restart-stack.mjs` (local Postgres :55432, Redis :56379, mock Supabase).
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
/** The public API as integrators see it (https://api.iverto.ai/v1/... → app /v1/public/...). */
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

const FULL = {
  enabled: true,
  modules: { org: ['GET'], employees: ['GET'], punches: ['GET', 'POST'], attendance: ['GET'], leave: ['GET', 'POST'] },
  approvalRequired: ['leave:approve'],
  piiAllowed: true,
  maxKeys: 10,
  maxKeyLifetimeDays: 365,
  requireIpAllowlist: false,
  orgIpAllowlist: [],
  rateLimit: { perMinute: 600, burst: 600, perDay: 200000, concurrency: 20 },
  keyRateCeiling: 300,
  credits: { enabled: false, monthlyGrant: 100000, onExhausted: 'block', costs: {} },
};

try {
  console.log('1. Setup: platform, tenant, sites, employees');
  const seed = execSync('npx ts-node scripts/platform-admin.ts --email apiops@iverto.test --name ApiOps', { cwd: API_DIR, env }).toString();
  const platform = await firstLogin('apiops@iverto.test', seed.match(/Temporary password: (\S+)/)[1]);
  let r = await call(platform, 'POST', '/platform/tenants', { name: 'API Test Co', slug: 'api-test', site: { name: 'Chennai', timezone: 'Asia/Kolkata' }, admin: { fullName: 'Anu Admin', email: 'anu@apitest.test' } });
  ok(r.status === 201, 'tenant created', r.body);
  const tenantId = r.body.tenant.id;
  const admin = await firstLogin('anu@apitest.test', r.body.admin.temporaryPassword);
  const site1 = (await call(admin, 'GET', '/sites')).body[0];
  r = await call(admin, 'POST', '/sites', { name: 'Pune', timezone: 'Asia/Kolkata' });
  ok(r.status === 201, 'second site', r.body);
  const site2 = r.body;
  const e1 = (await call(admin, 'POST', '/employees', { employeeCode: 'A1', fullName: 'Arun One', siteId: site1.id, joinedOn: '2026-01-01', pan: 'ABCDE1234F' })).body;
  const e2 = (await call(admin, 'POST', '/employees', { employeeCode: 'B1', fullName: 'Bala Two', siteId: site2.id, joinedOn: '2026-01-01' })).body;
  ok(e1.id && e2.id, 'two employees in two sites', { e1, e2 });

  console.log('2. Policy ceiling and key creation');
  r = await call(admin, 'POST', '/api-keys', { name: 'Too early', scopes: ['employees:read'] });
  ok(r.status === 403 && r.body.code === 'API_DISABLED', 'no keys while the platform has not enabled the API', r.body);
  r = await call(platform, 'PUT', `/platform/api/tenants/${tenantId}/policy`, { policy: FULL, note: 'enable' });
  ok(r.status === 200 && r.body.policy.enabled && r.body.inherited === false, 'superadmin enables the org with a custom ceiling', r.body);
  r = await call(platform, 'PUT', `/platform/api/tenants/${tenantId}/policy`, { policy: { ...FULL, modules: { bogus: ['GET'] } } });
  ok(r.status === 400 && r.body.code === 'POLICY_INVALID', 'unknown module rejected', r.body);
  r = await call(platform, 'POST', '/api-keys', { name: 'Backdoor', scopes: ['employees:read'] }, { 'x-tenant-id': tenantId });
  ok(r.status === 403 && r.body.code === 'PLATFORM_CANNOT_MINT', 'platform override cannot mint tenant keys', r.body);
  r = await call(admin, 'GET', '/api-keys/catalog');
  ok(r.status === 200 && r.body.permissions.find((p) => p.id === 'leave:approve')?.requiresApproval === true, 'catalog shows ceiling and approval rules', r.body);

  r = await call(admin, 'POST', '/api-keys', { name: 'Payroll sync', integratorName: 'Acme Payroll', scopes: ['employees:read', 'org:read', 'punches:read', 'punches:write', 'attendance:read', 'leave:read'], piiAccess: true });
  ok(r.status === 201 && /^ivk_live_[0-9A-Za-z]{12}_[0-9A-Za-z]{49}$/.test(r.body.key) && r.body.apiKey.status === 'ACTIVE', 'key created, plaintext shown once', r.body);
  ok(r.body.apiKey.secretHash === undefined, 'hash never returned', r.body.apiKey);
  const KEY = r.body.key;
  const keyRow = r.body.apiKey;
  r = await call(admin, 'GET', '/api-keys');
  ok(r.status === 200 && !JSON.stringify(r.body).includes(KEY.slice(22)), 'list never contains the secret', r.body);
  r = await call(admin, 'POST', '/api-keys', { name: 'Bad scope', scopes: ['payroll:read'] });
  ok(r.status === 400 && r.body.code === 'API_KEY_INVALID', 'unknown permission rejected', r.body);
  r = await call(admin, 'POST', '/api-keys', { name: 'Too fast', scopes: ['org:read'], rateLimitPerMin: 99999 });
  ok(r.status === 400, 'per-key rate above the ceiling rejected', r.body);

  console.log('3. Authentication and transport rules');
  r = await pub(KEY, 'GET', '/me');
  ok(r.status === 200 && r.body.organisationId === tenantId && r.body.permissions.includes('punches:write'), '/me introspection', r.body);
  ok(r.headers.get('x-request-id') && r.headers.get('ratelimit-policy'), 'request id + RateLimit-Policy headers', Object.fromEntries(r.headers));
  r = await pub(KEY, 'GET', '/me', undefined, { origin: 'https://evil.example' });
  ok(r.status === 403 && r.body.code === 'BROWSER_NOT_ALLOWED', 'browser (Origin) requests refused', r.body);
  r = await pub(KEY.slice(0, -1) + (KEY.endsWith('a') ? 'b' : 'a'), 'GET', '/me');
  ok(r.status === 401 && r.body.code === 'INVALID_API_KEY' && r.headers.get('content-type').includes('application/problem+json') && r.body.requestId, 'bad checksum → 401 problem+json', r.body);
  r = await pub(undefined, 'GET', '/me');
  ok(r.status === 401, 'missing key → 401', r.body);
  r = await call(KEY, 'GET', '/employees');
  ok(r.status === 401, 'API key does not work on internal routes', r.body);

  console.log('4. Reads, PII, ETag');
  r = await pub(KEY, 'GET', '/employees');
  ok(r.status === 200 && r.body.object === 'list' && r.body.data.length === 2, 'employees list', r.body);
  const arun = r.body.data.find((e) => e.employeeCode === 'A1');
  ok(arun?.pii?.pan === 'ABCDE1234F' && arun.object === 'employee' && !('photoKey' in arun), 'PII present for a PII key; explicit field allowlist', arun);
  const etag = r.headers.get('etag');
  r = await pub(KEY, 'GET', '/employees', undefined, { 'if-none-match': etag });
  ok(r.status === 304, 'If-None-Match → 304', r.status);
  r = await pub(KEY, 'GET', `/employees/${e2.id}`);
  ok(r.status === 200 && r.body.id === e2.id, 'employee by id', r.body);
  r = await pub(KEY, 'GET', '/employees?bogus=1');
  ok(r.status === 400, 'unknown query params refused', r.body);
  r = await pub(KEY, 'GET', '/sites');
  ok(r.status === 200 && r.body.data.length === 2, 'sites', r.body);
  r = await pub(KEY, 'GET', '/attendance-days?from=2026-01-01&to=2026-12-31');
  ok(r.status === 400 && r.body.code === 'RANGE_TOO_LARGE', 'date range capped', r.body);

  console.log('5. Narrow keys: permissions, sites, PII');
  r = await call(admin, 'POST', '/api-keys', { name: 'Org only', scopes: ['org:read'] });
  const ORG_ONLY = r.body.key;
  r = await pub(ORG_ONLY, 'GET', '/employees');
  ok(r.status === 403 && r.body.code === 'INSUFFICIENT_PERMISSION', 'missing permission → 403', r.body);
  r = await call(admin, 'POST', '/api-keys', { name: 'Pune only', scopes: ['employees:read'], siteIds: [site2.id] });
  const PUNE = r.body.key;
  r = await pub(PUNE, 'GET', '/employees');
  ok(r.status === 200 && r.body.data.length === 1 && r.body.data[0].id === e2.id && r.body.data[0].pii === null, 'site-restricted key sees its site only, no PII', r.body);
  r = await pub(PUNE, 'GET', `/employees/${e1.id}`);
  ok(r.status === 404, 'other site → 404', r.body);

  console.log('6. Writes: idempotency');
  const punch = { employeeId: e1.id, punchedAt: new Date(Date.now() - 3600_000).toISOString(), direction: 'in', reason: 'Imported from gate system' };
  r = await pub(KEY, 'POST', '/punches', punch);
  ok(r.status === 400 && r.body.code === 'IDEMPOTENCY_KEY_REQUIRED', 'POST without Idempotency-Key refused', r.body);
  const ik = idem();
  r = await pub(KEY, 'POST', '/punches', punch, ik);
  ok(r.status === 201 && r.body.object === 'punch' && r.body.source === 'MANUAL', 'punch recorded', r.body);
  const punchId = r.body.id;
  r = await pub(KEY, 'POST', '/punches', punch, ik);
  ok(r.status === 201 && r.body.id === punchId, 'retry with the same key replays the first response', r.body);
  r = await pub(KEY, 'POST', '/punches', { ...punch, direction: 'out' }, ik);
  ok(r.status === 422 && r.body.code === 'IDEMPOTENCY_KEY_REUSED', 'same key, different body → 422', r.body);
  r = await call(admin, 'GET', `/audit-logs?action=PUNCH_MANUAL`);
  ok(r.status === 200 && JSON.stringify(r.body).includes(`apikey:${keyRow.id}`), 'write audited with the key as actor', r.body);

  console.log('7. Incremental sync with tombstones');
  r = await pub(KEY, 'GET', '/departments');
  const cursor0 = r.body.nextCursor;
  r = await call(admin, 'POST', '/departments', { name: 'Logistics' });
  ok(r.status === 201, 'department created internally', r.body);
  const dept = r.body;
  await sleep(1200); // cap cache
  r = await pub(KEY, 'GET', `/departments${cursor0 ? `?cursor=${encodeURIComponent(cursor0)}` : ''}`);
  ok(r.status === 200 && r.body.data.some((d) => d.id === dept.id), 'new department appears in the feed', r.body);
  const cursor1 = r.body.nextCursor;
  r = await call(admin, 'DELETE', `/departments/${dept.id}`);
  ok(r.status === 200 || r.status === 204, 'department deleted internally', r.body);
  await sleep(1200);
  r = await pub(KEY, 'GET', `/departments?cursor=${encodeURIComponent(cursor1)}`);
  ok(r.status === 200 && r.body.data.some((d) => d.id === dept.id && d.deleted === true), 'deletion arrives as a tombstone', r.body);
  r = await pub(KEY, 'GET', `/departments?cursor=${encodeURIComponent(cursor1.slice(0, -2) + 'xx')}`);
  ok(r.status === 400 && r.body.code === 'INVALID_CURSOR', 'tampered cursor refused', r.body);
  r = await pub(KEY, 'GET', `/punches?updatedSince=${new Date(Date.now() - 3600_000).toISOString()}`);
  ok(r.status === 200 && r.body.data.some((p) => p.id === punchId), 'updatedSince feed', r.body);
  r = await pub(KEY, 'GET', `/punches?updatedSince=2020-01-01T00:00:00Z`);
  ok(r.status === 410 && r.body.code === 'SYNC_CURSOR_EXPIRED', 'position older than tombstone retention → 410', r.body);

  console.log('8. Approval-required permission and leave decisions');
  r = await call(admin, 'POST', '/api-keys', { name: 'Leave bot', scopes: ['leave:read', 'leave:approve'] });
  ok(r.status === 201 && r.body.apiKey.status === 'PENDING_APPROVAL', 'approval-required permission → pending', r.body);
  const LEAVE = r.body.key;
  const leaveKeyId = r.body.apiKey.id;
  r = await pub(LEAVE, 'GET', '/leave-types');
  ok(r.status === 403 && r.body.code === 'API_KEY_PENDING_APPROVAL', 'pending key cannot call', r.body);
  r = await call(platform, 'GET', '/platform/api/keys?status=PENDING_APPROVAL');
  ok(r.status === 200 && r.body.some((k) => k.id === leaveKeyId && k.tenantName === 'API Test Co'), 'platform approval queue', r.body);
  r = await call(platform, 'POST', `/platform/api/keys/${leaveKeyId}/approve`);
  ok(r.status === 201 && r.body.status === 'ACTIVE', 'platform approves', r.body);
  r = await pub(LEAVE, 'GET', '/leave-types');
  ok(r.status === 200 && r.body.data.length > 0, 'leave types', r.body);
  const lt = (await call(admin, 'POST', '/leave/types', { code: 'APIT', name: 'API test leave', accrualKind: 'UNLIMITED' })).body;
  ok(lt.id, 'leave type for the test', lt);
  const lop = { id: lt.id };
  const future = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
  r = await call(admin, 'POST', '/leave/requests', { employeeId: e2.id, leaveTypeId: lop.id, from: future, to: future, reason: 'Family' });
  ok(r.status === 201, 'HR files a leave request', r.body);
  const leaveId = r.body.id;
  r = await pub(LEAVE, 'POST', `/leave-requests/${leaveId}/reject`, { note: 'no' }, idem());
  ok(r.status === 400, 'reject needs a 3+ character note', r.body);
  r = await pub(LEAVE, 'POST', `/leave-requests/${leaveId}/approve`, { note: 'ok via API' }, idem());
  ok(r.status === 200 && r.body.object === 'leave_request' && ['APPROVED', 'PENDING'].includes(r.body.status), 'key approves the request', r.body);
  r = await pub(LEAVE, 'GET', `/leave-balances?employeeId=${e2.id}`);
  ok(r.status === 200 && r.body.object === 'list', 'leave balances', r.body);

  console.log('9. Tightening the ceiling bites immediately');
  r = await call(platform, 'POST', `/platform/api/tenants/${tenantId}/policy/preview`, { policy: { ...FULL, modules: { ...FULL.modules, punches: ['GET'] } } });
  ok(r.status === 201 && r.body.affectedKeys.some((k) => k.restricted.includes('punches:write')), 'preview lists affected keys', r.body);
  r = await call(platform, 'PUT', `/platform/api/tenants/${tenantId}/policy`, { policy: { ...FULL, modules: { ...FULL.modules, punches: ['GET'] } } });
  ok(r.status === 200, 'POST on punches removed', r.body);
  r = await pub(KEY, 'POST', '/punches', { ...punch, punchedAt: new Date(Date.now() - 1800_000).toISOString() }, idem());
  ok(r.status === 403 && r.body.code === 'BLOCKED_BY_POLICY', 'write now blocked by policy', r.body);
  r = await call(admin, 'GET', '/api-keys');
  ok(r.body.find((k) => k.id === keyRow.id)?.restrictedByPolicy.includes('punches:write'), 'org admin sees the restriction', r.body);
  const versions = (await call(platform, 'GET', `/platform/api/tenants/${tenantId}/policy`)).body.versions;
  r = await call(platform, 'POST', `/platform/api/tenants/${tenantId}/policy/rollback`, { version: versions[versions.length - 1].version });
  ok(r.status === 201 && r.body.policy.modules.punches.includes('POST'), 'rollback restores the earlier version', r.body);

  console.log('10. Rate limits and credits');
  r = await call(admin, 'POST', '/api-keys', { name: 'Slow', scopes: ['org:read'], rateLimitPerMin: 3 });
  const SLOW = r.body.key;
  const statuses = [];
  let limited;
  for (let i = 0; i < 5; i++) {
    const x = await pub(SLOW, 'GET', '/sites');
    statuses.push(x.status);
    if (x.status === 429) limited = x;
  }
  ok(statuses.slice(0, 3).every((s) => s === 200) && limited?.body.code === 'RATE_LIMITED' && Number(limited.headers.get('retry-after')) > 0, 'per-key token bucket → 429 + Retry-After', { statuses, b: limited?.body });
  r = await call(platform, 'PUT', `/platform/api/tenants/${tenantId}/policy`, { policy: { ...FULL, credits: { enabled: true, monthlyGrant: 0, onExhausted: 'block', costs: {} } } });
  ok(r.status === 200, 'credits enabled with no grant', r.body);
  r = await pub(KEY, 'GET', '/sites');
  ok(r.status === 402 && r.body.code === 'CREDITS_EXHAUSTED', 'no credits → 402', r.body);
  r = await call(platform, 'POST', `/platform/api/tenants/${tenantId}/credits`, { amount: 2, note: 'test' });
  ok(r.status === 201 && r.body.allowance === 2, 'superadmin tops up', r.body);
  r = await pub(KEY, 'GET', '/sites');
  ok(r.status === 200 && r.headers.get('x-credits-remaining') !== null, 'calls work again, credits header present', Object.fromEntries(r.headers));
  r = await call(platform, 'PUT', `/platform/api/tenants/${tenantId}/policy`, { policy: FULL });

  console.log('11. Revoke, rotate, IP allowlist, kill switch, suspension');
  r = await call(admin, 'POST', `/api-keys/${keyRow.id}/rotate`, { overlapHours: 1 });
  ok(r.status === 201 && r.body.key !== KEY && r.body.apiKey.rotatedFromId === keyRow.id, 'rotated', r.body);
  const NEW = r.body.key;
  ok((await pub(KEY, 'GET', '/me')).status === 200 && (await pub(NEW, 'GET', '/me')).status === 200, 'old and new key both work during overlap');
  r = await call(admin, 'POST', `/api-keys/${keyRow.id}/revoke`);
  ok(r.status === 201 && r.body.status === 'REVOKED', 'old key revoked', r.body);
  r = await pub(KEY, 'GET', '/me');
  ok(r.status === 401 && r.body.code === 'API_KEY_REVOKED', 'revoked key → 401 at once', r.body);
  r = await call(admin, 'POST', '/api-keys', { name: 'Office only', scopes: ['org:read'], ipAllowlist: ['10.0.0.0/8'] });
  r = await pub(r.body.key, 'GET', '/sites');
  ok(r.status === 403 && r.body.code === 'IP_NOT_ALLOWED', 'IP allowlist enforced', r.body);
  const settings = (await call(platform, 'GET', '/platform/api/settings')).body;
  r = await call(platform, 'PUT', '/platform/api/settings', { settings: { ...settings, killSwitch: true } });
  ok(r.status === 200, 'kill switch on', r.body);
  r = await pub(NEW, 'GET', '/me');
  ok(r.status === 503 && r.body.code === 'API_UNAVAILABLE', 'kill switch → 503', r.body);
  await call(platform, 'PUT', '/platform/api/settings', { settings: { ...settings, killSwitch: false } });
  await call(platform, 'POST', `/platform/tenants/${tenantId}/suspend`, { reason: 'test' });
  r = await pub(NEW, 'GET', '/me');
  ok(r.status === 403 && r.body.code === 'TENANT_SUSPENDED', 'suspended org → 403', r.body);
  await call(platform, 'POST', `/platform/tenants/${tenantId}/reactivate`);

  console.log('12. Logs and usage');
  await sleep(4000);
  r = await call(admin, 'GET', `/api-keys/logs?apiKeyId=${keyRow.id}&limit=200`);
  ok(r.status === 200 && r.body.data.length >= 10 && r.body.data.some((l) => l.status === 304) && r.body.data.some((l) => l.errorCode === 'BLOCKED_BY_POLICY'), 'every call logged with status and error code', r.body.data?.slice(0, 3));
  ok(!JSON.stringify(r.body).includes(KEY.slice(22)), 'logs never contain key material');
  r = await call(platform, 'GET', '/platform/api/logs?limit=200');
  ok(r.status === 200 && r.body.data.some((l) => l.tenantId === null && l.errorCode === 'INVALID_API_KEY'), 'platform sees rejected (tenant-less) requests', r.body.data?.slice(0, 3));
  r = await call(admin, 'GET', '/platform/api/logs');
  ok(r.status === 403, 'org admin cannot read platform logs', r.body);
  r = await call(admin, 'GET', '/api-keys/usage?days=1');
  ok(r.status === 200 && r.body.byKey.length > 0 && r.body.daily.length === 1, 'usage summary', r.body);

  console.log('13. Bad-auth throttle');
  let blocked;
  for (let i = 0; i < 22; i++) {
    const x = await pub('ivk_live_AAAAAAAAAAAA_' + 'A'.repeat(49), 'GET', '/me');
    if (x.status === 429) { blocked = x; break; }
  }
  ok(blocked?.body.code === 'TOO_MANY_AUTH_FAILURES', '20 bad keys from one address → blocked', blocked?.body);
  r = await pub(NEW, 'GET', '/me');
  ok(r.status === 429, 'even a valid key is refused from a blocked address', r.body);
  execSync('docker exec att-redis redis-cli DEL api:block:127.0.0.1 api:badauth:127.0.0.1', { stdio: 'ignore' });
} catch (err) {
  failures++;
  console.error(err);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
