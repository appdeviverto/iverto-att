import { createHash, createPublicKey, KeyObject, verify } from 'crypto';

/**
 * Optional Ed25519 request signing (docs/public-api.md §2). The integrator registers a public
 * key on their API key; each request then carries
 *   Iverto-Timestamp: <unix seconds>
 *   Iverto-Signature: base64(Ed25519(method + "\n" + path + "\n" + timestamp + "\n" + hex(sha256(body))))
 * where path is the request path with its query string as sent (/v1/employees?limit=50).
 * HMAC with the key secret is impossible: the server only holds its hash.
 */
export const SIGNATURE_SKEW_S = 300;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** A public key as base64 of the 32 raw bytes, or a PEM "PUBLIC KEY". null if it isn't Ed25519. */
export function parseSigningKey(value: string): KeyObject | null {
  try {
    const v = value.trim();
    const key = v.startsWith('-----BEGIN')
      ? createPublicKey(v)
      : (() => {
          const raw = Buffer.from(v, 'base64');
          if (raw.length !== 32) return null;
          return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
        })();
    return key && key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

/** Canonical form stored on the key: base64 of the 32 raw bytes. */
export const rawSigningKey = (key: KeyObject) => key.export({ format: 'der', type: 'spki' }).subarray(ED25519_SPKI_PREFIX.length).toString('base64');

export const signingPayload = (method: string, path: string, timestamp: string, body: Buffer | string | undefined) =>
  `${method.toUpperCase()}\n${path}\n${timestamp}\n${createHash('sha256').update(body ?? '').digest('hex')}`;

export type SignatureProblem = 'MISSING' | 'BAD_TIMESTAMP' | 'INVALID';

/**
 * Checks one request. `paths` are the forms the client may have signed (public and app path).
 * Returns null when valid.
 */
export function checkSignature(
  publicKey: string,
  req: { method: string; paths: string[]; timestamp?: string; signature?: string; body?: Buffer | string },
  now = Date.now(),
): SignatureProblem | null {
  if (!req.timestamp || !req.signature) return 'MISSING';
  if (!/^\d{1,12}$/.test(req.timestamp) || Math.abs(now / 1000 - Number(req.timestamp)) > SIGNATURE_SKEW_S) return 'BAD_TIMESTAMP';
  const key = parseSigningKey(publicKey);
  const sig = Buffer.from(req.signature, 'base64');
  if (!key || sig.length !== 64) return 'INVALID';
  return req.paths.some((p) => verify(null, Buffer.from(signingPayload(req.method, p, req.timestamp!, req.body)), key, sig)) ? null : 'INVALID';
}
