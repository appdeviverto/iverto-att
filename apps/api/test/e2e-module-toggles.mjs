// End-to-end: switching modules on and off never changes stored data.
// Hashes every table, then: HR / payroll off, an admin edit made while they are off, the public API
// disabled, every API module off, policy reverted, all keys revoked, webhooks disabled, modules
// back on. Hashes again: business tables must be byte-identical (only logs and API config move).
// LOCAL ONLY: run after `node test/restart-stack.mjs && node test/seed-demo.mjs`.
import { execSync } from 'node:child_process';

const API = 'http://127.0.0.1:8040/v1';
const MOCK = 'http://127.0.0.1:54321';
const PASSWORD = 'Acme-Demo-2026!'; // seed-demo.mjs DEMO_PASSWORD
let failures = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures++;
    console.log(`  ✗ ${msg}`, extra !== undefined ? JSON.stringify(extra).slice(0, 800) : '');
  }
};
async function call(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
}
async function login(email) {
  const r = await fetch(`${MOCK}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  const j = await r.json();
  if (!j.access_token) throw new Error(`login failed for ${email}`);
  return j.access_token;
}
const sql = (q) => execSync('docker exec -i att-pg psql -U postgres -tA -F"|"', { input: q }).toString().trim();

// Tables that are expected to move: logs, and the API configuration being toggled.
const CONFIG_OR_LOG = new Set(['audit_logs', 'api_policy_versions', 'api_keys', 'api_request_logs', 'api_events', 'webhook_endpoints', 'webhook_deliveries', 'app_notifications']);
/** table -> "rows:md5" over every column but updated_at (bookkeeping the API bumps on any write). */
function snapshot() {
  const tables = sql("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' ORDER BY 1").split('\n');
  const q = tables.map((t) => `SELECT '${t}', count(*) || ':' || md5(coalesce(string_agg((to_jsonb(r) - 'updated_at')::text, E'\\n' ORDER BY (to_jsonb(r) - 'updated_at')::text), '')) FROM public.${t} r`).join(' UNION ALL ');
  return new Map(sql(`SET TimeZone='UTC'; ${q};`).split('\n').filter((l) => l.includes('|')).map((l) => l.split('|')));
}

try {
  const platform = await login('ops@iverto.test');
  const admin = await login('asha@acme.test');
  const tenantId = sql("SELECT id FROM tenants WHERE settings->'branding'->>'displayName' = 'Acme Industries' OR name LIKE 'Acme%' LIMIT 1");
  ok(!!tenantId, 'demo tenant found');
  const featuresBefore = JSON.parse(sql(`SELECT coalesce(settings->'features', '{}'::jsonb) FROM tenants WHERE id = '${tenantId}'`));
  const settingsBefore = sql(`SELECT settings::text FROM tenants WHERE id = '${tenantId}'`);

  console.log('1. Turn the public API on with a key and a webhook, so the toggles have something to act on');
  const FULL = {
    enabled: true, modules: { org: ['GET'], employees: ['GET', 'POST'], punches: ['GET', 'POST'], attendance: ['GET'], leave: ['GET', 'POST'], reports: ['POST'] },
    approvalRequired: [], piiAllowed: true, maxKeys: 10, maxKeyLifetimeDays: 365, requireIpAllowlist: false, orgIpAllowlist: [],
    rateLimit: { perMinute: 600, burst: 600, perDay: 200000, concurrency: 20 }, keyRateCeiling: 300,
    credits: { enabled: false, monthlyGrant: 100000, onExhausted: 'block', costs: {} },
  };
  let r = await call(platform, 'PUT', `/platform/api/tenants/${tenantId}/policy`, { policy: FULL, note: 'toggle test' });
  ok(r.status === 200 && r.body.policy.enabled, 'API enabled for the org', r.body);
  r = await call(admin, 'POST', '/api-keys', { name: 'Toggle test', scopes: ['employees:read', 'employees:write', 'punches:read'], piiAccess: true });
  ok(r.status === 201 && r.body.key, 'key created', r.body);
  const KEY = r.body.key;
  r = await call(admin, 'POST', '/api-webhooks', { url: 'http://127.0.0.1:9/hook', events: ['employee.updated'] });
  ok(r.status === 201, 'webhook endpoint created', r.body);
  const hookId = r.body.endpoint?.id ?? r.body.id;
  r = await fetch(`${API}/public/employees?limit=5`, { headers: { authorization: `Bearer ${KEY}` } });
  ok(r.status === 200, 'key reads employees');

  const emp = JSON.parse(sql(`SELECT to_jsonb(e) FROM employees e WHERE tenant_id = '${tenantId}' AND date_of_birth IS NOT NULL AND bank_account_number IS NOT NULL LIMIT 1`) || 'null');
  ok(!!emp, 'an employee with HR and bank data to watch', emp?.employee_code);

  console.log('   payroll locks hold with payroll off; settings writers never clobber each other');
  const lockedPunch = () => call(admin, 'POST', '/punches', { employeeId: emp.id, at: '2026-10-07T09:00:00+05:30', direction: 'in', reason: 'toggle test' });
  r = await lockedPunch();
  ok(r.status === 409 && r.body.code === 'PAYROLL_LOCKED', 'paid October is locked (payroll on)', r.body);
  await call(platform, 'PATCH', `/platform/tenants/${tenantId}/features`, { payroll: false });
  r = await lockedPunch();
  ok(r.status === 409 && r.body.code === 'PAYROLL_LOCKED', 'still locked with payroll off', r.body);
  await call(platform, 'PATCH', `/platform/tenants/${tenantId}/features`, { payroll: true });
  r = await call(admin, 'PATCH', '/org', { reportRetentionDays: 90 });
  ok(r.status === 200 && sql(`SELECT settings::text FROM tenants WHERE id = '${tenantId}'`) === settingsBefore, 'a one-field org save keeps every other setting', r.body);
  let raced = true;
  for (let i = 1; i <= 6; i++) {
    await Promise.all([
      call(platform, 'PATCH', `/platform/tenants/${tenantId}/features`, { hr: i % 2 === 0 }),
      call(admin, 'PATCH', '/org', { punchPhotoRetentionDays: 90 + i }),
      call(admin, 'PUT', '/payroll/settings', { payDay: i }),
    ]);
    const s = JSON.parse(sql(`SELECT settings FROM tenants WHERE id = '${tenantId}'`));
    raced &&= s.features.hr === (i % 2 === 0) && s.punchPhotoRetentionDays === 90 + i && s.payroll.payDay === i && s.payroll.defaultPtState === 'KA';
  }
  ok(raced, 'concurrent module / org / payroll saves all land (no lost update)');
  await call(admin, 'PATCH', '/org', { punchPhotoRetentionDays: 90 });
  await call(admin, 'PUT', '/payroll/settings', { payDay: 1 });
  await call(platform, 'PATCH', `/platform/tenants/${tenantId}/features`, featuresBefore);
  ok(sql(`SELECT settings::text FROM tenants WHERE id = '${tenantId}'`) === settingsBefore, 'settings back to the start');

  const before = snapshot();
  console.log(`   snapshot: ${before.size} tables`);

  console.log('2. HR and payroll off; an admin edit while they are off');
  r = await call(platform, 'PATCH', `/platform/tenants/${tenantId}/features`, { hr: false, payroll: false });
  ok(r.status === 200, 'modules off', r.body);
  r = await call(admin, 'GET', '/assets');
  ok(r.status === 403 && r.body.code === 'FEATURE_DISABLED', 'HR routes refused while off', r.body);
  r = await call(admin, 'PATCH', `/employees/${emp.id}`, { designation: 'Temp title' });
  ok(r.status === 200, 'core edit works while HR is off', r.body);
  r = await call(admin, 'PATCH', `/employees/${emp.id}`, { designation: emp.designation });
  ok(r.status === 200, 'edit reverted', r.body);
  const hrNow = JSON.parse(sql(`SELECT jsonb_build_object('dob', date_of_birth, 'bank', bank_account_number, 'pan', pan) FROM employees WHERE id = '${emp.id}'`));
  ok(hrNow.bank === emp.bank_account_number && hrNow.pan === emp.pan && String(hrNow.dob).slice(0, 10) === String(emp.date_of_birth).slice(0, 10), 'HR / bank fields untouched by an edit made while HR is off', hrNow);

  console.log('3. Public API: disabled, every module off, reverted to default, keys revoked, webhook disabled');
  r = await call(platform, 'PUT', `/platform/api/tenants/${tenantId}/policy`, { policy: { ...FULL, enabled: false } });
  ok(r.status === 200, 'API disabled', r.body);
  r = await fetch(`${API}/public/employees`, { headers: { authorization: `Bearer ${KEY}` } });
  ok(r.status === 403, 'key refused while disabled');
  r = await call(platform, 'PUT', `/platform/api/tenants/${tenantId}/policy`, { policy: { ...FULL, modules: {} } });
  ok(r.status === 200, 'every module off', r.body);
  r = await call(platform, 'PUT', `/platform/api/tenants/${tenantId}/policy`, { policy: FULL });
  ok(r.status === 200, 'modules back on', r.body);
  r = await call(platform, 'DELETE', `/platform/api/tenants/${tenantId}/policy`);
  ok(r.status === 200, 'reverted to the platform default', r.body);
  r = await call(platform, 'POST', `/platform/api/webhooks/${hookId}/disable`, { reason: 'toggle test' });
  ok(r.status === 200 || r.status === 201, 'webhook disabled by platform', r.body);
  r = await call(platform, 'POST', `/platform/api/tenants/${tenantId}/revoke-all`);
  ok((r.status === 200 || r.status === 201) && r.body.revoked >= 1, 'all keys revoked', r.body);

  console.log('4. Modules back as they were');
  r = await call(platform, 'PATCH', `/platform/tenants/${tenantId}/features`, featuresBefore);
  ok(r.status === 200, 'modules restored', r.body);
  ok(sql(`SELECT settings::text FROM tenants WHERE id = '${tenantId}'`) === settingsBefore, 'tenant settings identical to before (branding etc. kept)');

  console.log('5. Compare every table');
  await new Promise((res) => setTimeout(res, 1500)); // let in-flight webhook/event writers settle
  const after = snapshot();
  const changed = [...before.keys()].filter((t) => before.get(t) !== after.get(t));
  const unexpected = changed.filter((t) => !CONFIG_OR_LOG.has(t));
  console.log(`   changed (expected: logs / API config): ${changed.filter((t) => CONFIG_OR_LOG.has(t)).join(', ') || 'none'}`);
  ok(unexpected.length === 0, `all ${before.size - changed.length} business tables byte-identical`, unexpected.map((t) => `${t}: ${before.get(t)} -> ${after.get(t)}`));
} catch (e) {
  failures++;
  console.error(e);
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
