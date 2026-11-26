import { applyDecorators, CanActivate, ExecutionContext, Injectable, Logger, UseGuards } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKey } from '@prisma/client';
import { createHash } from 'crypto';
import { AuthUser, Public } from '../auth/auth.types';
import { AppError } from '../common/errors';
import { tenantState } from '../common/features';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { runAsSystem } from '../common/rls';
import { assertPepperConfigured, ipAllowed, parseKey, verifySecret } from './keys';
import { LimiterService } from './limiter';
import { checkSignature, SIGNATURE_SKEW_S } from './signing';
import { ApiPolicy, costOf, effectivePermissions, PolicyService } from './policy';
import { OP_KEY, OPERATION_BY_ID } from './registry';

/** What the request hooks (request-log.ts) need from the guard to settle and log the request. */
export interface ApiRequestContext {
  requestId: string;
  start: number;
  tenantId?: string;
  apiKeyId?: string;
  operationId?: string;
  /** Credits reserved; refunded on 5xx / 429 / 304. */
  credits: number;
  concurrencyHeld: boolean;
  errorCode?: string;
}

const KEY_TTL_MS = 30_000;

/**
 * Authenticates `Authorization: Bearer ivk_…` and enforces, in order: browser rejection, IP
 * block, key validity, tenant + policy state, registry permission, IP allowlists,
 * Idempotency-Key on POST, rate limits and credits (docs/public-api.md §6). Fails closed:
 * a handler without a registry entry is unreachable.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);
  private readonly keyCache = new Map<string, { key: ApiKey | null; at: number }>();

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly policies: PolicyService,
    private readonly limiter: LimiterService,
  ) {
    policies.onInvalidate((msg) => {
      if (msg.startsWith('key:')) this.keyCache.delete(msg.slice(4));
      if (msg === 'key:*') this.keyCache.clear();
    });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const reply = context.switchToHttp().getResponse();
    const ctx: ApiRequestContext = req.apiCtx;
    const ip: string = req.ip;
    assertPepperConfigured();

    // Keys are for servers. A browser always sends Origin on cross-site requests; refusing it keeps keys out of web apps.
    if (req.headers.origin) throw new AppError(403, 'BROWSER_NOT_ALLOWED', 'API keys may only be used server-to-server');
    if (await this.limiter.isBlocked(ip)) throw new AppError(429, 'TOO_MANY_AUTH_FAILURES', 'Too many invalid keys from this address; try again later');

    const header: string | undefined = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const parsed = parseKey(token);
    if (!parsed) {
      if (token) void this.limiter.authFailed(ip);
      throw new AppError(401, 'INVALID_API_KEY', token ? 'Invalid API key' : 'Missing API key: send Authorization: Bearer ivk_…');
    }
    const key = await this.lookup(parsed.keyId);
    // Always hash, so an unknown keyId costs the same as a wrong secret.
    if (!verifySecret(parsed.secret, key?.secretHash ?? null, key?.pepperVersion) || !key || key.environment !== parsed.environment) {
      void this.limiter.authFailed(ip);
      throw new AppError(401, 'INVALID_API_KEY', 'Invalid API key');
    }
    ctx.tenantId = key.tenantId;
    ctx.apiKeyId = key.id;

    if (key.status === 'REVOKED') throw new AppError(401, 'API_KEY_REVOKED', 'This API key has been revoked');
    if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) throw new AppError(401, 'API_KEY_EXPIRED', 'This API key has expired');
    if (key.status === 'PENDING_APPROVAL') throw new AppError(403, 'API_KEY_PENDING_APPROVAL', 'This API key is waiting for platform approval');
    if (key.status !== 'ACTIVE') throw new AppError(403, 'API_KEY_DISABLED', 'This API key is disabled; an org admin can re-enable it');
    // Test keys belong to sandbox orgs, which don't exist yet (docs/public-api.md §13, docs/future/sandbox).
    if (key.environment !== 'live') throw new AppError(401, 'INVALID_API_KEY', 'Invalid API key');

    const [tenant, platform, { policy }] = await Promise.all([
      tenantState(this.prisma, key.tenantId),
      this.policies.platform(),
      this.policies.forTenant(key.tenantId),
    ]);
    if (tenant.status !== 'ACTIVE') throw new AppError(403, 'TENANT_SUSPENDED', 'This organisation is not active');
    if (platform.killSwitch) throw new AppError(503, 'API_UNAVAILABLE', 'The API is temporarily unavailable');
    if (!policy.enabled) throw new AppError(403, 'API_DISABLED', 'API access is not enabled for this organisation');

    const op = OPERATION_BY_ID.get(this.reflector.get<string>(OP_KEY, context.getHandler()) ?? '');
    if (!op) throw new AppError(404, 'NOT_FOUND', 'Not found');
    ctx.operationId = op.id;
    const permissions = effectivePermissions(key.scopes, policy);
    if (op.permission) {
      if (!key.scopes.includes(op.permission)) {
        throw new AppError(403, 'INSUFFICIENT_PERMISSION', `This key lacks the ${op.permission} permission`, { required: op.permission });
      }
      if (!permissions.includes(op.permission)) {
        throw new AppError(403, 'BLOCKED_BY_POLICY', `${op.method} on this resource isn't allowed for your organisation`, { required: op.permission });
      }
    }

    if (policy.requireIpAllowlist && !key.ipAllowlist.length) {
      throw new AppError(403, 'IP_ALLOWLIST_REQUIRED', 'Your organisation requires an IP allowlist on every key');
    }
    if ((key.ipAllowlist.length && !ipAllowed(ip, key.ipAllowlist)) || (policy.orgIpAllowlist.length && !ipAllowed(ip, policy.orgIpAllowlist))) {
      throw new AppError(403, 'IP_NOT_ALLOWED', 'Requests from this address are not allowed for this key');
    }
    await this.checkSignature(key, req);
    if (op.method === 'POST' && !req.headers['idempotency-key']) {
      throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header with every POST');
    }

    const cost = costOf(policy, op.id);
    const keyRate = Math.min(key.rateLimitPerMin ?? policy.keyRateCeiling, policy.keyRateCeiling);
    const r = await this.limiter.take({
      tenantId: key.tenantId,
      keyId: key.id,
      requestId: ctx.requestId,
      cost: Math.max(cost, 1),
      keyRate,
      orgRate: policy.rateLimit.perMinute,
      orgBurst: policy.rateLimit.burst,
      perDay: policy.rateLimit.perDay,
      concurrency: policy.rateLimit.concurrency,
    });
    reply.header('RateLimit-Policy', `"key";q=${keyRate};w=60, "org";q=${policy.rateLimit.perMinute};w=60, "day";q=${policy.rateLimit.perDay};w=86400`);
    const left = Math.max(0, Math.min(r.keyLeft, r.orgLeft));
    reply.header('RateLimit', `"${r.keyLeft <= r.orgLeft ? 'key' : 'org'}";r=${left};t=${Math.ceil(r.retryAfterMs / 1000)}`);
    if (r.code !== 0) {
      const secondsToMidnight = Math.ceil((86_400_000 - (Date.now() % 86_400_000)) / 1000);
      const retryAfter = r.code === 3 ? secondsToMidnight : Math.max(1, Math.ceil(r.retryAfterMs / 1000));
      reply.header('Retry-After', String(retryAfter));
      const [code, message] =
        r.code === 3
          ? ['DAILY_QUOTA_EXCEEDED', 'Daily request quota reached for your organisation']
          : r.code === 4
            ? ['CONCURRENCY_LIMIT', 'Too many requests in flight for your organisation']
            : ['RATE_LIMITED', r.code === 1 ? 'Rate limit reached for this key' : 'Rate limit reached for your organisation'];
      throw new AppError(429, code, message, { retryAfter });
    }
    ctx.concurrencyHeld = true;

    if (policy.credits.enabled && cost > 0) {
      try {
        const allowance = await this.limiter.allowance(key.tenantId, policy.credits.monthlyGrant);
        const s = await this.limiter.spend({
          tenantId: key.tenantId,
          apiKeyId: key.id,
          cost,
          allowance,
          keyCap: key.creditCap,
          block: policy.credits.onExhausted === 'block',
        });
        if (s.code === 1) throw new AppError(402, 'CREDITS_EXHAUSTED', 'Your organisation has used its API credits for this month');
        if (s.code === 2) throw new AppError(402, 'KEY_CREDIT_CAP_REACHED', 'This key has used its monthly credit cap');
        ctx.credits = cost;
        reply.header('X-Credits-Remaining', String(Math.max(0, allowance - s.spent)));
      } catch (err) {
        if (err instanceof AppError) throw err;
        // Credits can't be checked: refuse writes, let reads through (reconciled from the log later).
        this.logger.error(`Credits unavailable: ${(err as Error).message}`);
        if (op.method !== 'GET') throw new AppError(503, 'CREDITS_UNAVAILABLE', 'Temporarily unable to check API credits; retry shortly');
      }
    }

    req.user = apiKeyPrincipal(key, policy);
    this.touch(key, ip);
    return true;
  }

  /** Optional Ed25519 signatures (signing.ts): checked when sent, required when the key says so. */
  private async checkSignature(key: ApiKey, req: { method: string; url: string; headers: Record<string, string | undefined>; rawBody?: Buffer }) {
    const signature = req.headers['iverto-signature'];
    const timestamp = req.headers['iverto-timestamp'];
    if (!signature && !timestamp) {
      if (key.requireSignature) throw new AppError(401, 'SIGNATURE_REQUIRED', 'This key requires signed requests: send Iverto-Timestamp and Iverto-Signature');
      return;
    }
    if (!key.signingPublicKey) throw new AppError(401, 'SIGNING_KEY_NOT_SET', 'This key has no signing key; register one or omit the signature headers');
    // The client signs the public path (/v1/…); the app sees it under /v1/public/….
    const paths = [req.url.replace(/^\/v1\/public(?=[/?]|$)/, '/v1'), req.url];
    const problem = checkSignature(key.signingPublicKey, { method: req.method, paths, timestamp, signature, body: req.rawBody });
    if (problem === 'BAD_TIMESTAMP') throw new AppError(401, 'SIGNATURE_EXPIRED', `Iverto-Timestamp must be within ${SIGNATURE_SKEW_S} seconds of now`);
    if (problem) throw new AppError(401, 'INVALID_SIGNATURE', 'The request signature does not verify');
    // Replay cache: a valid signature is accepted once.
    const fresh = await this.redis.client.set(`api:sig:${createHash('sha256').update(signature!).digest('hex')}`, '1', 'EX', SIGNATURE_SKEW_S * 2, 'NX');
    if (!fresh) throw new AppError(401, 'SIGNATURE_REPLAYED', 'This signature was already used');
  }

  private async lookup(keyId: string): Promise<ApiKey | null> {
    const hit = this.keyCache.get(keyId);
    if (hit && Date.now() - hit.at < KEY_TTL_MS) return hit.key;
    const key = await runAsSystem(() => this.prisma.apiKey.findUnique({ where: { keyId } }));
    if (key) this.keyCache.set(keyId, { key, at: Date.now() });
    return key;
  }

  /** lastUsedAt / lastUsedIp at most once a minute per key. */
  private touch(key: ApiKey, ip: string) {
    void this.redis.client
      .set(`api:lastused:${key.id}`, '1', 'EX', 60, 'NX')
      .then((set) =>
        set ? runAsSystem(() => this.prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date(), lastUsedIp: ip } })) : null,
      )
      .catch((err) => this.logger.warn(`lastUsedAt update failed: ${(err as Error).message}`));
  }
}

/** The caller a key acts as: whole tenant within its sites, permissions = key ∩ policy. Also used by job workers. */
export function apiKeyPrincipal(key: ApiKey, policy: ApiPolicy): AuthUser {
  return {
    sub: `apikey:${key.id}`,
    email: '',
    tenantId: key.tenantId,
    role: 'API_KEY',
    employeeId: null,
    siteIds: key.siteIds,
    isSuperAdmin: false,
    mustChangePassword: false,
    aal: 'aal2',
    apiKey: { id: key.id, name: key.name, permissions: effectivePermissions(key.scopes, policy), piiAccess: key.piiAccess && policy.piiAllowed },
  };
}

/** Class decorator for public controllers: skips the JWT guard, applies the key guard. Use nothing else. */
export const PublicApi = () => applyDecorators(Public(), UseGuards(ApiKeyGuard));
