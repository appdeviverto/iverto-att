// End-to-end: webhooks + event log (docs/public-api.md §10) — outbox triggers, signing, retries,
// rotation, 410 auto-disable, replay, policy at delivery time, GET /v1/events.
// LOCAL ONLY: run after `node test/restart-stack.mjs` (it sets WEBHOOK_ALLOW_PRIVATE_TARGETS so a
// local receiver is reachable; production refuses private targets).
import { execSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
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

// ── A local receiver ─────────────────────────────────────────────────────────
const received = [];
let reply = 200;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ headers: req.headers, body, json: JSON.parse(body), status: reply });
    res.writeHead(reply, { 'content-type': 'text/plain' });
    res.end(reply === 200 ? 'ok' : 'nope');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const HOOK = `http://127.0.0.1:${server.address().port}/hook`;
const waitFor = async (pred, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = received.find(pred);
    if (hit) return hit;
    await sleep(200);
  }
  return null;
};
/** Standard Webhooks verification, written independently of the server's code. */
const signatures = (secret, h, body) => {
  const expected = 'v1,' + createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${h['webhook-id']}.${h['webhook-timestamp']}.${body}`).digest('base64');
  return h['webhook-signature'].split(' ').map((s) => s === expected);
};

const FULL = {
  enabled: true,
  modules: { org: ['GET'], employees: ['GET'], punches: ['GET', 'POST'], attendance: ['GET'], leave: ['GET', 'POST'] },
  approvalRequired: [],
  piiAllowed: false,
  maxKeys: 10,
  maxKeyLifetimeDays: 365,
  requireIpAllowlist: false,
  orgIpAllowlist: [],
  rateLimit: { perMinute: 600, burst: 600, perDay: 200000, concurrency: 20 },
  keyRateCeiling: 300,
  credits: { enabled: false, monthlyGrant: 100000, onExhausted: 'block', costs: {} },
  webhooks: { enabled: true, maxEndpoints: 2 },
};

try {
  console.log('1. Setup');
  const seed = execSync('npx ts-node scripts/platform-admin.ts --email whops@iverto.test --name WhOps', { cwd: API_DIR, env }).toString();
  const platform = await firstLogin('whops@iverto.test', seed.match(/Temporary password: (\S+)/)[1]);
  let r = await call(platform, 'POST', '/platform/tenants', { name: 'Hook Co', slug: 'hook-co', site: { name: 'Chennai', timezone: 'Asia/Kolkata' }, admin: { fullName: 'Hari Admin', email: 'hari@hookco.test' } });
  ok(r.status === 201, 'tenant created', r.body);
  const tenantId = r.body.tenant.id;
  const admin = await firstLogin('hari@hookco.test', r.body.admin.temporaryPassword);
  const site = (await call(admin, 'GET', '/sites')).body[0];
  const e1 = (await call(admin, 'POST', '/employees', { employeeCode: 'H1', fullName: 'Hema One', siteId: site.id, joinedOn: '2026-01-01' })).body;

  console.log('2. Ceiling');
  r = await call(admin, 'POST', '/api-webhooks', { url: HOOK, events: ['punch.created'] });
  ok(r.status === 403 && r.body.code === 'WEBHOOKS_DISABLED', 'no endpoints while the API is off for the org', r.body);
  r = await call(platform, 'PUT', `/platform/api/tenants/${tenantId}/policy`, { policy: FULL });
  ok(r.status === 200 && r.body.policy.webhooks.maxEndpoints === 2, 'superadmin enables the org (webhooks: max 2)', r.body);
  r = await call(platform, 'POST', '/api-webhooks', { url: HOOK, events: ['punch.created'] }, { 'x-tenant-id': tenantId });
  ok(r.status === 403 && r.body.code === 'PLATFORM_CANNOT_MINT', 'platform override cannot create endpoints', r.body);
  r = await call(admin, 'POST', '/api-webhooks', { url: HOOK, events: ['punch.created', 'nope.event'] });
  ok(r.status === 400 && r.body.code === 'WEBHOOK_INVALID', 'unknown event rejected', r.body);
  r = await call(admin, 'POST', '/api-webhooks', { url: 'ftp://example.com/x', events: ['punch.created'] });
  ok(r.status === 400 && r.body.code === 'WEBHOOK_INVALID', 'non-http(s) URL rejected', r.body);
  r = await call(admin, 'GET', '/api-webhooks');
  ok(r.status === 200 && r.body.policy.enabled && r.body.events.every((e) => e.allowed), 'catalog lists events allowed by the policy', r.body);

  console.log('3. Create, ping, signature');
  r = await call(admin, 'POST', '/api-webhooks', { url: HOOK, description: 'Payroll', events: ['punch.created', 'employee.created', 'employee.updated', 'leave.request.created'] });
  ok(r.status === 201 && /^whsec_/.test(r.body.secret) && !('secretEncrypted' in r.body.endpoint), 'endpoint created, secret shown once, never stored in the clear', r.body);
  let secret = r.body.secret;
  const ep = r.body.endpoint;
  r = await call(admin, 'GET', '/api-webhooks');
  ok(!JSON.stringify(r.body).includes(secret.slice(6)), 'listing never reveals the secret');
  r = await call(admin, 'POST', `/api-webhooks/${ep.id}/test`);
  ok(r.status === 201 && /^evt_/.test(r.body.eventId), 'test event queued', r.body);
  let hit = await waitFor((x) => x.json.type === 'ping');
  ok(hit && hit.headers['webhook-id'] === hit.json.id && hit.json.apiVersion === '2026-12-01', 'ping delivered with envelope + webhook-id', hit?.json);
  ok(hit && signatures(secret, hit.headers, hit.body).some(Boolean), 'signature verifies (Standard Webhooks)', hit?.headers);
  ok(hit && Math.abs(Number(hit.headers['webhook-timestamp']) - Date.now() / 1000) < 60, 'webhook-timestamp is current');

  console.log('4. Outbox: changes become events');
  r = await call(admin, 'POST', '/api-keys', { name: 'Gate', scopes: ['punches:read', 'punches:write', 'employees:read'] });
  const KEY = r.body.key;
  r = await pub(KEY, 'POST', '/punches', { employeeId: e1.id, punchedAt: new Date(Date.now() - 600_000).toISOString(), direction: 'in', reason: 'Gate reader' }, idem());
  ok(r.status === 201, 'punch via API', r.body);
  const punchId = r.body.id;
  hit = await waitFor((x) => x.json.type === 'punch.created' && x.json.data.id === punchId);
  ok(hit && hit.json.data.employeeId === e1.id && hit.json.data.object === 'punch' && !('fullName' in hit.json.data), 'punch.created delivered, thin payload', hit?.json);
  const e2 = (await call(admin, 'POST', '/employees', { employeeCode: 'H2', fullName: 'Hari Two', siteId: site.id, joinedOn: '2026-01-01' })).body;
  hit = await waitFor((x) => x.json.type === 'employee.created' && x.json.data.id === e2.id);
  ok(hit, 'employee.created delivered (web change)', received.map((x) => x.json.type));
  const lt = (await call(admin, 'POST', '/leave/types', { code: 'WHT', name: 'Hook leave', accrualKind: 'UNLIMITED' })).body;
  const future = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
  r = await call(admin, 'POST', '/leave/requests', { employeeId: e1.id, leaveTypeId: lt.id, from: future, to: future, reason: 'Trip' });
  hit = await waitFor((x) => x.json.type === 'leave.request.created' && x.json.data.id === r.body.id);
  ok(hit && hit.json.data.employeeId === e1.id, 'leave.request.created delivered', hit?.json);
  ok(!received.some((x) => x.json.type.startsWith('attendance.')), 'unsubscribed types are not delivered');

  console.log('5. Event log (GET /v1/events)');
  await sleep(1500);
  r = await pub(KEY, 'GET', '/events?limit=200');
  const types = r.body.data?.map((e) => e.type) ?? [];
  ok(r.status === 200 && types.includes('punch.created') && types.includes('employee.created'), 'event log has the key’s event types', r.body);
  ok(!types.includes('leave.request.created') && !types.includes('ping'), 'types outside the key’s permissions (and pings) are hidden', types);
  ok(r.body.data?.find((e) => e.data.id === punchId)?.id === received.find((x) => x.json.data.id === punchId)?.json.id, 'same event id in the log and on the webhook');
  const cursor = r.body.nextCursor;
  r = await pub(KEY, 'GET', `/events?cursor=${encodeURIComponent(cursor)}`);
  ok(r.status === 200 && r.body.data.length === 0 && r.body.nextCursor === cursor, 'cursor at the end: nothing new, same cursor', r.body);
  r = await pub(KEY, 'GET', '/events?type=employee.created');
  ok(r.status === 200 && r.body.data.every((e) => e.type === 'employee.created'), 'type filter', r.body);
  r = await pub(KEY, 'GET', '/events?since=2020-01-01T00:00:00Z');
  ok(r.status === 410 && r.body.code === 'SYNC_CURSOR_EXPIRED', 'position older than 30 days → 410', r.body);

  console.log('6. Retries');
  reply = 500;
  await call(admin, 'PATCH', `/employees/${e2.id}`, { designation: 'Supervisor' });
  hit = await waitFor((x) => x.json.type === 'employee.updated' && x.status === 500);
  ok(hit, 'first attempt gets a 500');
  await sleep(500);
  r = await call(admin, 'GET', `/api-webhooks/${ep.id}/deliveries?status=PENDING`);
  const pending = r.body.data?.find((d) => d.event.type === 'employee.updated');
  ok(pending && pending.attempts === 1 && pending.responseStatus === 500 && pending.responseSnippet === 'nope', 'delivery pending with attempt + response recorded', r.body);
  r = await call(admin, 'GET', '/api-webhooks');
  ok(r.body.endpoints[0].failingSince, 'endpoint marked failing', r.body.endpoints);
  reply = 200;
  hit = await waitFor((x) => x.json.type === 'employee.updated' && x.status === 200, 20000);
  ok(hit && hit.json.id === pending?.eventId, 'retried after backoff with the same webhook-id', hit?.json);
  await sleep(500);
  r = await call(admin, 'GET', '/api-webhooks');
  ok(r.body.endpoints[0].failingSince === null, 'success clears the failing streak', r.body.endpoints);

  console.log('7. Secret rotation');
  r = await call(admin, 'POST', `/api-webhooks/${ep.id}/rotate-secret`);
  ok(r.status === 201 && r.body.secret !== secret && r.body.endpoint.previousSecretActive, 'rotated; old secret still active', r.body);
  const oldSecret = secret;
  secret = r.body.secret;
  await call(admin, 'POST', `/api-webhooks/${ep.id}/test`);
  const before = received.length;
  hit = await waitFor((x) => x.json.type === 'ping' && received.indexOf(x) >= before);
  const sigs = hit ? hit.headers['webhook-signature'].split(' ') : [];
  ok(sigs.length === 2 && signatures(secret, hit.headers, hit.body)[0] && signatures(oldSecret, hit.headers, hit.body)[1], 'both secrets sign during the overlap', hit?.headers);

  console.log('8. 410 Gone → disabled; re-enable + replay');
  reply = 410;
  await call(admin, 'PATCH', `/employees/${e1.id}`, { designation: 'Lead' });
  hit = await waitFor((x) => x.json.type === 'employee.updated' && x.status === 410);
  ok(hit, 'endpoint answered 410');
  await sleep(1000);
  r = await call(admin, 'GET', '/api-webhooks');
  ok(r.body.endpoints[0].status === 'DISABLED' && /410/.test(r.body.endpoints[0].disabledReason), '410 disables the endpoint', r.body.endpoints);
  reply = 200;
  const n = received.length;
  await pub(KEY, 'POST', '/punches', { employeeId: e1.id, punchedAt: new Date(Date.now() - 300_000).toISOString(), direction: 'out', reason: 'Gate reader' }, idem());
  await sleep(3000);
  ok(received.length === n, 'nothing is sent while disabled', received.slice(n).map((x) => x.json.type));
  r = await call(admin, 'PATCH', `/api-webhooks/${ep.id}`, { enabled: true });
  ok(r.status === 200 && r.body.status === 'ACTIVE' && r.body.disabledReason === null, 're-enabled', r.body);
  r = await call(admin, 'POST', `/api-webhooks/${ep.id}/replay`, { since: new Date(Date.now() - 3600_000).toISOString() });
  ok(r.status === 201 && r.body.queued >= 5, 'replay queues the missed window', r.body);
  hit = await waitFor((x) => x.json.type === 'punch.created' && x.json.data.id === punchId && received.indexOf(x) >= n);
  ok(hit && hit.json.id === received.find((x) => x.json.data.id === punchId).json.id, 'replays keep the original webhook-id', hit?.json);
  r = await call(admin, 'POST', `/api-webhooks/${ep.id}/replay`, { since: '2020-01-01T00:00:00Z' });
  ok(r.status === 400 && r.body.code === 'REPLAY_TOO_OLD', 'replay limited to the 30-day log', r.body);

  console.log('9. Manual retry');
  r = await call(admin, 'GET', `/api-webhooks/${ep.id}/deliveries?status=FAILED`);
  const failed = r.body.data?.[0];
  ok(failed, 'failed delivery listed', r.body);
  const m = received.length;
  r = await call(admin, 'POST', `/api-webhooks/deliveries/${failed.id}/retry`);
  ok(r.status === 201, 'retry accepted', r.body);
  hit = await waitFor((x) => x.json.id === failed.eventId && received.indexOf(x) >= m);
  ok(hit, 'manual retry delivered');

  await sleep(3000); // let the replay drain

  console.log('10. Policy is checked at delivery time');
  r = await call(platform, 'PUT', `/platform/api/tenants/${tenantId}/policy`, { policy: { ...FULL, modules: { ...FULL.modules, employees: [] } } });
  ok(r.status === 200, 'superadmin removes the employees module');
  const k = received.length;
  await call(admin, 'POST', '/employees', { employeeCode: 'H3', fullName: 'Hasan Three', siteId: site.id, joinedOn: '2026-01-01' });
  await pub(KEY, 'POST', '/punches', { employeeId: e1.id, punchedAt: new Date(Date.now() - 120_000).toISOString(), direction: 'in', reason: 'Gate reader' }, idem());
  hit = await waitFor((x) => x.json.type === 'punch.created' && received.indexOf(x) >= k);
  ok(hit && !received.slice(k).some((x) => x.json.type.startsWith('employee.')), 'employee events stop; punches still flow', received.slice(k).map((x) => x.json.type));
  r = await call(admin, 'PATCH', `/api-webhooks/${ep.id}`, { events: ['employee.created'] });
  ok(r.status === 400 && r.body.code === 'WEBHOOK_INVALID', 'cannot subscribe to a type the policy blocks', r.body);

  console.log('11. Limits, platform, delete');
  r = await call(admin, 'POST', '/api-webhooks', { url: HOOK + '2', events: ['punch.created'] });
  ok(r.status === 201, 'second endpoint');
  r = await call(admin, 'POST', '/api-webhooks', { url: HOOK + '3', events: ['punch.created'] });
  ok(r.status === 409 && r.body.code === 'WEBHOOK_LIMIT', 'maxEndpoints enforced', r.body);
  const second = (await call(admin, 'GET', '/api-webhooks')).body.endpoints.find((e) => e.url.endsWith('2'));
  r = await call(platform, 'GET', `/platform/api/tenants/${tenantId}/webhooks`);
  ok(r.status === 200 && r.body.length === 2 && !JSON.stringify(r.body).includes('secret_encrypted') && !r.body[0].secretEncrypted, 'platform lists endpoints without secrets', r.body);
  r = await call(platform, 'POST', `/platform/api/webhooks/${second.id}/disable`);
  ok(r.status === 201, 'platform disables an endpoint', r.body);
  r = await call(admin, 'GET', '/api-webhooks');
  ok(r.body.endpoints.find((e) => e.id === second.id).disabledReason === 'Disabled by Iverto', 'org sees why', r.body.endpoints);
  r = await call(admin, 'GET', '/platform/api/tenants/' + tenantId + '/webhooks');
  ok(r.status === 403, 'org admin cannot use platform routes', r.body);
  r = await call(admin, 'DELETE', `/api-webhooks/${second.id}`);
  ok(r.status === 200 && r.body.deleted, 'endpoint deleted', r.body);
  const audit = execSync(`docker exec att-pg psql -U postgres -tA -c "SELECT string_agg(DISTINCT action, ',') FROM audit_logs WHERE tenant_id='${tenantId}' AND action LIKE 'API_WEBHOOK%'"`).toString();
  ok(['CREATED', 'SECRET_ROTATED', 'UPDATED', 'REPLAYED', 'DELETED', 'DISABLED_BY_PLATFORM'].every((a) => audit.includes(`API_WEBHOOK_${a}`)), 'endpoint lifecycle audited', audit);
  const stored = execSync(`docker exec att-pg psql -U postgres -tA -c "SELECT secret_encrypted FROM webhook_endpoints WHERE id='${ep.id}'"`).toString();
  ok(stored.startsWith('v1.') && !stored.includes(secret.slice(6, 30)), 'secret encrypted at rest', stored.slice(0, 20));
} catch (err) {
  failures++;
  console.error(err);
}

server.close();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
