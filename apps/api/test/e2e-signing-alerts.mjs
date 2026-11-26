// End-to-end: Ed25519 request signing (§2), usage alerts and stale-key disabling (§15), and the
// OpenAPI document behind the in-app API reference (§14).
// LOCAL ONLY: run after `node test/restart-stack.mjs`.
import { execSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';

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
const idem = () => ({ 'idempotency-key': `t-${Math.random().toString(36).slice(2)}` });
const pub = (key, method, path, body, headers = {}) => call(key, method, '/public' + path, body, { ...(method === 'POST' ? idem() : {}), ...headers });
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
const sql = (q) => execSync('docker exec -i att-pg psql -U postgres -tA', { input: q }).toString().trim();
async function eventually(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(300);
  }
}


const FULL = {
  enabled: true,
  modules: { org: ['GET'], employees: ['GET', 'POST'], punches: ['GET', 'POST'], attendance: ['GET'], leave: ['GET', 'POST'], reports: ['POST'] },
  approvalRequired: [], piiAllowed: true, maxKeys: 20, maxKeyLifetimeDays: 365, requireIpAllowlist: false, orgIpAllowlist: [],
  rateLimit: { perMinute: 600, burst: 600, perDay: 200000, concurrency: 20 }, keyRateCeiling: 300,
  credits: { enabled: false, monthlyGrant: 100000, onExhausted: 'block', costs: {} },
};
const ALL = ['org:read', 'employees:read', 'punches:read', 'punches:write', 'attendance:read', 'leave:read'];

try {
  console.log('1. Setup: platform, a live org with one employee, API on');
  const seed = execSync('npx ts-node scripts/platform-admin.ts --email sigops@iverto.test --name SigOps', { cwd: API_DIR, env }).toString();
  const platform = await firstLogin('sigops@iverto.test', seed.match(/Temporary password: (\S+)/)[1]);
  let r = await call(platform, 'POST', '/platform/tenants', { name: 'Signing Test Co', slug: 'sig-test', site: { name: 'Madurai', timezone: 'Asia/Kolkata' }, admin: { fullName: 'Sam Admin', email: 'sam@sigtest.test' } });
  ok(r.status === 201, 'live tenant created', r.body);
  const tenantId = r.body.tenant.id;
  const admin = await firstLogin('sam@sigtest.test', r.body.admin.temporaryPassword);
  const site = (await call(admin, 'GET', '/sites')).body[0];
  const liveEmp = (await call(admin, 'POST', '/employees', { employeeCode: 'L1', fullName: 'Lata Live', siteId: site.id, joinedOn: '2026-01-01' })).body;
  r = await call(platform, 'PUT', `/platform/api/tenants/${tenantId}/policy`, { policy: FULL, note: 'enable' });
  ok(r.status === 200, 'API enabled', r.body);
  r = await call(admin, 'POST', '/api-keys', { name: 'Live', scopes: ALL });
  const LIVE = r.body.key;
  ok(/^ivk_live_/.test(LIVE), 'live key is ivk_live_', r.body);
  r = await call(admin, 'POST', '/api-keys', { name: 'Live 2', scopes: ALL });
  const LIVE2 = r.body.key;
  const liveKeyId = r.body.apiKey.id;
  ok((await pub(LIVE, 'GET', '/me')).status === 200, 'live key works');
  r = await call(admin, 'POST', '/api-keys', { name: 'Test', scopes: ALL }, { 'x-api-env': 'test' });
  ok(r.status === 201 && /^ivk_live_/.test(r.body.key), 'no test keys yet: every key is live (sandbox is a future update)', r.body);

  console.log('2. Ed25519 request signing');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
  r = await call(admin, 'PATCH', `/api-keys/${liveKeyId}`, { signingPublicKey: 'bm90IGEga2V5' });
  ok(r.status === 400 && r.body.code === 'API_KEY_INVALID', 'a non-Ed25519 key is refused', r.body);
  r = await call(admin, 'PATCH', `/api-keys/${liveKeyId}`, { signingPublicKey: raw });
  ok(r.status === 200 && r.body.signingPublicKey === raw, 'signing key registered', r.body);
  const signed = (method, path, body, ts = Math.floor(Date.now() / 1000)) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const payload = `${method}\n/v1${path}\n${ts}\n${createHash('sha256').update(text).digest('hex')}`;
    return { 'iverto-timestamp': String(ts), 'iverto-signature': edSign(null, Buffer.from(payload), privateKey).toString('base64') };
  };
  ok((await pub(LIVE2, 'GET', '/me')).status === 200, 'unsigned requests still work while signing is optional');
  const h = signed('GET', '/me');
  ok((await pub(LIVE2, 'GET', '/me', undefined, h)).status === 200, 'a signed request verifies');
  r = await pub(LIVE2, 'GET', '/me', undefined, h);
  ok(r.status === 401 && r.body.code === 'SIGNATURE_REPLAYED', 'the same signature is accepted once', r.body);
  r = await pub(LIVE2, 'GET', '/sites', undefined, signed('GET', '/me'));
  ok(r.status === 401 && r.body.code === 'INVALID_SIGNATURE', 'a signature for another path fails', r.body);
  r = await pub(LIVE2, 'GET', '/me', undefined, signed('GET', '/me', undefined, Math.floor(Date.now() / 1000) - 600));
  ok(r.status === 401 && r.body.code === 'SIGNATURE_EXPIRED', 'an old timestamp fails', r.body);
  const punchBody = { employeeId: liveEmp.id, punchedAt: new Date(Date.now() - 60_000).toISOString(), direction: 'in', reason: 'signed test' };
  r = await pub(LIVE2, 'POST', '/punches', punchBody, signed('POST', '/punches', punchBody));
  ok(r.status === 201, 'a signed POST (body hashed) verifies', r.body);
  r = await pub(LIVE2, 'POST', '/punches', { ...punchBody, reason: 'tampered body' }, signed('POST', '/punches', punchBody));
  ok(r.status === 401 && r.body.code === 'INVALID_SIGNATURE', 'a changed body fails', r.body);
  await call(admin, 'PATCH', `/api-keys/${liveKeyId}`, { requireSignature: true });
  r = await pub(LIVE2, 'GET', '/me');
  ok(r.status === 401 && r.body.code === 'SIGNATURE_REQUIRED', 'unsigned requests refused once signatures are required', r.body);
  await sleep(1100); // an identical request in the same second has the same signature: that is a replay
  r = await pub(LIVE2, 'GET', '/me', undefined, signed('GET', '/me'));
  ok(r.status === 200, 'signed requests still pass', r.body);

  console.log('3. Usage alerts and stale-key disabling');
  r = await call(admin, 'POST', '/api-keys', { name: 'Forgotten', scopes: ['org:read'] });
  const stale = r.body.apiKey.id;
  r = await call(admin, 'POST', '/api-keys', { name: 'Expiring', scopes: ['org:read'] });
  const expiring = r.body.apiKey.id;
  r = await call(admin, 'POST', '/api-keys', { name: 'Reader', scopes: ['org:read'] });
  const READER = r.body.key;
  sql(`UPDATE api_keys SET created_at = now() - interval '100 days', last_used_at = now() - interval '95 days' WHERE id = '${stale}'`);
  sql(`UPDATE api_keys SET expires_at = now() + interval '2 days' WHERE id = '${expiring}'`);
  r = await call(platform, 'POST', '/platform/api/alerts/run');
  ok(r.status === 201 && r.body.raised >= 2, 'hourly check raised alerts', r.body);
  ok(sql(`SELECT status || ':' || disabled_reason FROM api_keys WHERE id = '${stale}'`).startsWith('DISABLED:Unused for 95 days'), 'unused key auto-disabled');
  r = await call(admin, 'GET', '/api-keys/alerts');
  ok(r.body.some((a) => a.type === 'key_disabled' && a.apiKeyId === stale) && r.body.some((a) => a.type === 'key_expiring' && a.apiKeyId === expiring), 'alerts listed for the org', r.body);
  ok(Number(sql(`SELECT count(*) FROM app_notifications WHERE tenant_id = '${tenantId}' AND type = 'API_ALERT'`)) >= 2, 'admins notified in-app');
  r = await eventually(async () => (await pub(READER, 'GET', '/events?type=api.alert')).body.data?.length >= 2 && (await pub(READER, 'GET', '/events?type=api.alert')).body);
  ok(r && r.data.some((e) => e.data.type === 'key_disabled'), 'api.alert events in the event log', r);
  r = await call(platform, 'POST', '/platform/api/alerts/run');
  ok(r.body.raised === 0, 'the same alerts are not repeated within 24 h', r.body);
  ok(sql(`SELECT count(*) FROM audit_logs WHERE action = 'API_KEY_AUTO_DISABLED' AND target_id = '${stale}'`) === '1', 'auto-disable audited');
  r = await call(admin, 'POST', `/api-keys/${stale}/enable`);
  ok(r.status === 201 && r.body.status === 'ACTIVE', 'an admin can re-enable a disabled key', r.body);
  r = await call(platform, 'GET', `/platform/api/alerts?tenantId=${tenantId}`);
  ok(r.status === 200 && r.body.length >= 2, 'superadmin sees the alerts', r.body);

  console.log('4. OpenAPI document for the in-app API reference');
  r = await call(admin, 'GET', '/api-keys/openapi.json');
  ok(r.status === 200 && r.body.openapi === '3.0.3' && r.body.paths['/employees/bulk']?.post && !r.body.paths['/sandbox/reset'] && r.body['x-webhooks']['punch.created'], 'org admin gets the spec', Object.keys(r.body.paths ?? {}));
  r = await call(platform, 'GET', '/platform/api/openapi.json');
  ok(r.status === 200 && r.body.paths['/punches']?.get, 'superadmin gets the spec');
  r = await call(null, 'GET', '/api-keys/openapi.json');
  ok(r.status === 401, 'not public', r.body);
} catch (e) {
  failures++;
  console.error(e);
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
