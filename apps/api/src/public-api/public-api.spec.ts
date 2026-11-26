import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';
import { generateKey, ipAllowed, isValidCidr, parseKey, verifySecret } from './keys';
import { clippedPermissions, DEFAULT_POLICY, effectivePermissions, normalizePolicy, policyAllows } from './policy';
import { OP_KEY, OPERATIONS } from './registry';
import { decodeCursor, encodeCursor } from './sync';
import { PublicV1Controller } from './v1';
import { decryptSecret, encryptSecret, generateSecret, isPublicAddress, sign, urlProblem } from './webhooks';
import { EVENTS, PERMISSIONS } from './registry';
import { checkRecords, PII_FIELDS } from './jobs';
import { generateKeyPairSync, sign as edSign } from 'crypto';
import { buildOpenApi, OPERATION_DOCS, SCHEMAS } from './openapi';
import { checkSignature, parseSigningKey, rawSigningKey, signingPayload } from './signing';
import * as present from './serializers';
import { envelope } from './webhooks';

process.env.API_KEY_PEPPER = 'test-pepper-test-pepper-test-pepper-0123456789';

describe('API keys', () => {
  it('round-trips and verifies', () => {
    const k = generateKey('live');
    expect(k.plaintext).toMatch(/^ivk_live_[0-9A-Za-z]{12}_[0-9A-Za-z]{49}$/);
    const parsed = parseKey(k.plaintext)!;
    expect(parsed.keyId).toBe(k.keyId);
    expect(verifySecret(parsed.secret, k.secretHash)).toBe(true);
  });

  it('rejects a typo via the checksum, a wrong secret, and a missing key', () => {
    const k = generateKey('live');
    const i = 30;
    const typo = k.plaintext.slice(0, i) + (k.plaintext[i] === 'a' ? 'b' : 'a') + k.plaintext.slice(i + 1);
    expect(parseKey(typo)).toBeNull();
    const other = parseKey(generateKey('live').plaintext)!;
    expect(verifySecret(other.secret, k.secretHash)).toBe(false);
    expect(verifySecret(other.secret, null)).toBe(false);
    expect(parseKey('Bearer nonsense')).toBeNull();
  });

  it('matches IPv4/IPv6 CIDRs, including IPv4-mapped addresses', () => {
    expect(ipAllowed('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(ipAllowed('::ffff:10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(ipAllowed('11.0.0.1', ['10.0.0.0/8', '192.168.1.5'])).toBe(false);
    expect(ipAllowed('192.168.1.5', ['192.168.1.5'])).toBe(true);
    expect(ipAllowed('2001:db8::1', ['2001:db8::/32'])).toBe(true);
    expect(isValidCidr('10.0.0.0/33')).toBe(false);
    expect(isValidCidr('not-an-ip')).toBe(false);
  });
});

describe('policy', () => {
  it('effective permissions = key ∩ policy methods', () => {
    const policy = normalizePolicy({ ...DEFAULT_POLICY, modules: { leave: ['GET'], punches: ['GET', 'POST'] } }, DEFAULT_POLICY);
    expect(policyAllows(policy, 'leave:read')).toBe(true);
    expect(policyAllows(policy, 'leave:approve')).toBe(false); // POST not allowed on leave
    expect(effectivePermissions(['leave:read', 'leave:approve', 'punches:write', 'bogus'], policy)).toEqual(['leave:read', 'punches:write']);
    expect(clippedPermissions(['leave:approve', 'employees:read'], policy)).toEqual(['leave:approve', 'employees:read']);
  });

  it('fills fields missing from an older stored policy with defaults', () => {
    const p = normalizePolicy({ enabled: true, rateLimit: { perMinute: 5 } }, DEFAULT_POLICY);
    expect(p.enabled).toBe(true);
    expect(p.rateLimit).toEqual({ ...DEFAULT_POLICY.rateLimit, perMinute: 5 });
    expect(p.credits).toEqual(DEFAULT_POLICY.credits);
  });
});

describe('cursors', () => {
  it('are tamper-evident', () => {
    const c = encodeCursor({ t: 1, i: 'a', c: 2 });
    expect(decodeCursor(c)).toEqual({ t: 1, i: 'a', c: 2 });
    const [body] = c.split('.');
    const forged = Buffer.from(JSON.stringify({ t: 1, i: 'z', c: 2 })).toString('base64url') + '.' + c.split('.')[1];
    expect(() => decodeCursor(forged)).toThrow();
    expect(() => decodeCursor(body)).toThrow();
  });
});

describe('registry ↔ routes', () => {
  const controllers = [PublicV1Controller];
  const handlers = controllers.flatMap((c) => {
    const proto = c.prototype as unknown as Record<string, unknown>;
    const base = String(Reflect.getMetadata(PATH_METADATA, c)).replace(/^public/, '');
    return Object.getOwnPropertyNames(proto)
      .filter((n) => n !== 'constructor' && typeof proto[n] === 'function')
      .map((n) => ({ name: n, fn: proto[n] as object, base }))
      .filter((h) => Reflect.getMetadata(PATH_METADATA, h.fn) !== undefined);
  });

  it('every public route is bound to a registry operation with the same method and path', () => {
    for (const c of controllers) expect(String(Reflect.getMetadata(PATH_METADATA, c))).toMatch(/^public(\/|$)/);
    for (const h of handlers) {
      const opId = Reflect.getMetadata(OP_KEY, h.fn);
      const op = OPERATIONS.find((o) => o.id === opId);
      expect({ handler: h.name, op: op?.id }).toEqual({ handler: h.name, op: opId });
      expect(op).toBeDefined();
      expect(h.base + '/' + Reflect.getMetadata(PATH_METADATA, h.fn)).toBe(op!.path);
      expect(RequestMethod[Reflect.getMetadata(METHOD_METADATA, h.fn)]).toBe(op!.method);
    }
  });

  it('every registry operation has exactly one handler', () => {
    const bound = handlers.map((h) => Reflect.getMetadata(OP_KEY, h.fn));
    for (const op of OPERATIONS) expect(bound.filter((b) => b === op.id)).toHaveLength(1);
  });

  it('the controllers are behind the API key guard', () => {
    for (const c of controllers) expect(Reflect.getMetadata(GUARDS_METADATA, c)).toContain(ApiKeyGuard);
  });
});

describe('webhooks', () => {
  it('signs per Standard Webhooks (spec test vector)', () => {
    const sig = sign(['whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'], 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330, '{"test": 2432232314}');
    expect(sig).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });

  it('carries both signatures during rotation', () => {
    const [a, b] = [generateSecret(), generateSecret()];
    const sig = sign([a, b], 'evt_1', 1, '{}').split(' ');
    expect(sig).toHaveLength(2);
    expect(sig[1]).toBe(sign([b], 'evt_1', 1, '{}'));
  });

  it('encrypts secrets at rest and detects tampering', () => {
    const secret = generateSecret();
    const enc = encryptSecret(secret);
    expect(enc).not.toContain(secret.slice(6, 20));
    expect(decryptSecret(enc)).toBe(secret);
    const parts = enc.split('.');
    parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1);
    expect(() => decryptSecret(parts.join('.'))).toThrow();
  });

  it('blocks private, loopback, link-local, metadata and mapped addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a00:1']) {
      expect({ ip, ok: isPublicAddress(ip) }).toEqual({ ip, ok: false });
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(isPublicAddress(ip)).toBe(true);
  });

  it('accepts only public https URLs without credentials', () => {
    expect(urlProblem('https://hooks.example.com/iverto')).toBeNull();
    expect(urlProblem('http://hooks.example.com/')).toMatch(/https/);
    expect(urlProblem('https://user:pw@hooks.example.com/')).toMatch(/credentials/);
    expect(urlProblem('https://127.0.0.1/')).toMatch(/private/);
    expect(urlProblem('https://[::1]/')).toMatch(/private/);
    expect(urlProblem('https://localhost/')).toMatch(/private/);
    expect(urlProblem('not a url')).toMatch(/valid/);
  });

  it('every event needs a real permission', () => {
    for (const e of Object.values(EVENTS)) if (e.permission) expect(PERMISSIONS).toHaveProperty([e.permission]);
  });
});

describe('bulk records', () => {
  it('accepts well-formed records', () => {
    expect(checkRecords([{ employeeCode: 'E1', fullName: 'A', siteId: 's1', noticePeriodDays: 30, departmentId: null }, { externalId: 'x-1', designation: 'Lead' }], false)).toEqual([]);
  });

  it('needs a match key, known fields, scalar values and PII access for PII fields', () => {
    const problems = checkRecords([{ fullName: 'A' }, { employeeCode: 'E2', bogus: 1 }, { employeeCode: 'E3', pan: 'ABCDE1234F' }, { employeeCode: 'E4', fullName: { a: 1 } }, { employeeCode: 'E5', designation: '-' }, { employeeCode: null, externalId: 'z' }], false);
    expect(problems.map((p) => [p.index, p.field])).toEqual([[0, 'employeeCode'], [1, 'bogus'], [2, 'pan'], [3, 'fullName'], [4, 'designation'], [5, 'employeeCode']]);
    expect(checkRecords([{ employeeCode: 'E3', pan: 'ABCDE1234F' }], true)).toEqual([]);
  });

  it('never offers salary or virtual columns', () => {
    for (const k of ['monthlyGross', 'salaryStructure', 'siteName', 'managerCode', 'employeeCode']) expect(PII_FIELDS).not.toContain(k);
  });
});

describe('request signing (Ed25519)', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = rawSigningKey(publicKey);
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const now = Date.now();
  const ts = String(Math.floor(now / 1000));
  const body = Buffer.from('{"employeeId":"e1"}');
  const sig = edSign(null, Buffer.from(signingPayload('POST', '/v1/punches', ts, body)), privateKey).toString('base64');
  const req = (over: Partial<Parameters<typeof checkSignature>[1]> = {}) => ({ method: 'POST', paths: ['/v1/punches', '/v1/public/punches'], timestamp: ts, signature: sig, body, ...over });

  it('accepts raw base64 and PEM public keys, refuses other key types', () => {
    expect(raw).toHaveLength(44);
    expect(parseSigningKey(raw)).not.toBeNull();
    expect(parseSigningKey(pem)).not.toBeNull();
    expect(parseSigningKey(generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' }).toString())).toBeNull();
    expect(parseSigningKey('not a key')).toBeNull();
  });

  it('verifies a correct signature against either path form', () => {
    expect(checkSignature(raw, req(), now)).toBeNull();
    expect(checkSignature(pem, req({ paths: ['/v1/public/punches', '/v1/punches'] }), now)).toBeNull();
  });

  it('refuses a changed body, method or path, a stale timestamp and missing headers', () => {
    expect(checkSignature(raw, req({ body: Buffer.from('{"employeeId":"e2"}') }), now)).toBe('INVALID');
    expect(checkSignature(raw, req({ method: 'GET' }), now)).toBe('INVALID');
    expect(checkSignature(raw, req({ paths: ['/v1/punches?x=1'] }), now)).toBe('INVALID');
    expect(checkSignature(raw, req(), now + 301_000)).toBe('BAD_TIMESTAMP');
    expect(checkSignature(raw, req({ signature: undefined }), now)).toBe('MISSING');
    expect(checkSignature(raw, req({ signature: Buffer.alloc(64).toString('base64') }), now)).toBe('INVALID');
  });
});

describe('OpenAPI document', () => {
  const nulls = new Proxy({}, { get: () => null }) as never;
  const keysOf = (name: string) => Object.keys((SCHEMAS[name] as { properties: object }).properties).sort();

  it('documents every operation, and nothing else', () => {
    expect(Object.keys(OPERATION_DOCS).sort()).toEqual(OPERATIONS.map((o) => o.id).sort());
    const spec = buildOpenApi();
    for (const o of OPERATIONS) expect((spec.paths as Record<string, object>)[o.path.replace(/:(\w+)/g, '{$1}')]).toHaveProperty(o.method.toLowerCase());
  });

  it('schemas list exactly the fields the serializers return (no leaks, no gaps)', () => {
    const pairs: Array<[string, object]> = [
      ['Site', present.presentSite(nulls)],
      ['Department', present.presentDepartment(nulls)],
      ['Employee', present.presentEmployee(nulls, true)],
      ['EmployeePii', present.presentEmployee(nulls, true).pii!],
      ['Punch', present.presentPunch(nulls)],
      ['AttendanceDay', present.presentAttendanceDay(nulls)],
      ['LeaveType', present.presentLeaveType(nulls)],
      ['LeaveRequest', present.presentLeaveRequest(nulls)],
      ['LeaveBalance', present.presentLeaveBalance(nulls)],
      ['Event', envelope({ id: 'evt_1', type: 'punch.created', createdAt: new Date(), data: {} })],
    ];
    for (const [name, out] of pairs) expect({ name, keys: Object.keys(out).sort() }).toEqual({ name, keys: keysOf(name) });
  });

  it('matches the committed contract snapshot (a diff here is a public API change)', () => {
    expect(buildOpenApi()).toMatchSnapshot();
  });
});
