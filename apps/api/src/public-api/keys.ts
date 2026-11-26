import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { BlockList, isIP } from 'net';
import { crc32 } from 'zlib';
import { AppError } from '../common/errors';

/**
 * API key format (docs/public-api.md §2) — frozen once published:
 *   ivk_{live|test}_{keyId:12}_{secret:43}{crc:6}      all base62
 * keyId is the public lookup half; only HMAC(pepper, secret) is stored. The CRC
 * lets us reject typos/garbage without a DB hit and keeps secret-scanner false positives low.
 */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const KEY_ID_LEN = 12;
const SECRET_LEN = 43; // 43 × log2(62) ≈ 256 bits
const CRC_LEN = 6;
const KEY_RE = /^ivk_(live|test)_([0-9A-Za-z]{12})_([0-9A-Za-z]{49})$/;

export type KeyEnvironment = 'live' | 'test';

function base62(len: number): string {
  let out = '';
  while (out.length < len) {
    for (const b of randomBytes(len * 2)) {
      if (b < 248 && out.length < len) out += ALPHABET[b % 62]; // 248 = 4 × 62: no modulo bias
    }
  }
  return out;
}

function checksum(body: string): string {
  let n = crc32(body);
  let out = '';
  for (let i = 0; i < CRC_LEN; i++) {
    out = ALPHABET[n % 62] + out;
    n = Math.floor(n / 62);
  }
  return out;
}

/** HMAC peppers by version. Bump API_KEY_PEPPER_VERSION and keep the old value as API_KEY_PEPPER_V<n> to rotate. */
function pepper(version: number): string {
  const current = Number(process.env.API_KEY_PEPPER_VERSION || 1);
  const value = version === current ? process.env.API_KEY_PEPPER : process.env[`API_KEY_PEPPER_V${version}`];
  if (!value || value.length < 32) throw new Error('API_KEY_PEPPER is missing or shorter than 32 characters');
  return value;
}

/** 503 instead of a 500 when the deployment has no pepper: keys can be neither issued nor checked. */
export function assertPepperConfigured() {
  if (!process.env.API_KEY_PEPPER || process.env.API_KEY_PEPPER.length < 32) {
    throw new AppError(503, 'API_UNAVAILABLE', 'The API is not configured on this server');
  }
}

export const currentPepperVersion = () => Number(process.env.API_KEY_PEPPER_VERSION || 1);

/** A 32-byte key for one purpose, derived from a pepper version (webhook secret encryption). */
export const derivedKey = (purpose: string, version = currentPepperVersion()) => createHmac('sha256', pepper(version)).update(purpose).digest();

export function hashSecret(secret: string, version = currentPepperVersion()): string {
  return createHmac('sha256', pepper(version)).update(secret).digest('hex');
}

export function generateKey(environment: KeyEnvironment) {
  const keyId = base62(KEY_ID_LEN);
  const secret = base62(SECRET_LEN);
  const body = `ivk_${environment}_${keyId}_${secret}`;
  const plaintext = body + checksum(body);
  return { plaintext, keyId, secretHash: hashSecret(secret), pepperVersion: currentPepperVersion(), last4: plaintext.slice(-4) };
}

/** null for anything that isn't a well-formed key with a valid checksum. */
export function parseKey(token: string): { environment: KeyEnvironment; keyId: string; secret: string } | null {
  const m = KEY_RE.exec(token);
  if (!m) return null;
  const tail = m[3];
  const secret = tail.slice(0, SECRET_LEN);
  if (checksum(`ivk_${m[1]}_${m[2]}_${secret}`) !== tail.slice(SECRET_LEN)) return null;
  return { environment: m[1] as KeyEnvironment, keyId: m[2], secret };
}

/** Constant-time; hashes even when there is no stored hash so a missing keyId takes as long as a wrong secret. */
export function verifySecret(secret: string, stored: string | null, version = currentPepperVersion()): boolean {
  const actual = Buffer.from(hashSecret(secret, version), 'hex');
  const expected = stored ? Buffer.from(stored, 'hex') : Buffer.alloc(actual.length);
  return expected.length === actual.length && timingSafeEqual(actual, expected) && stored !== null;
}

// ── CIDR allowlists (native net.BlockList) ──────────────────────────────────

export function isValidCidr(cidr: string): boolean {
  const [addr, bits, extra] = cidr.split('/');
  const type = isIP(addr);
  if (!type || extra !== undefined) return false;
  if (bits === undefined) return true;
  const n = Number(bits);
  return Number.isInteger(n) && n >= 0 && n <= (type === 4 ? 32 : 128);
}

/** True when `ip` falls in any of the CIDRs (a bare address = /32 or /128). IPv4-mapped IPv6 is unwrapped. */
export function ipAllowed(ip: string, cidrs: string[]): boolean {
  const addr = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  const type = isIP(addr);
  if (!type) return false;
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [net, bits] = cidr.split('/');
    const netType = isIP(net);
    if (!netType) continue;
    list.addSubnet(net, bits === undefined ? (netType === 4 ? 32 : 128) : Number(bits), netType === 4 ? 'ipv4' : 'ipv6');
  }
  return list.check(addr, type === 4 ? 'ipv4' : 'ipv6');
}
