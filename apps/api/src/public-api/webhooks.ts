import { Body, Controller, Delete, Get, Injectable, Logger, OnModuleDestroy, OnModuleInit, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Prisma, WebhookEndpoint } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'crypto';
import { lookup as dnsLookup, LookupAddress } from 'dns';
import { ClientRequest, request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { BlockList, isIP } from 'net';
import { AuditableActionService } from '../audit/audit.service';
import { actorOf, AuthUser, CurrentUser, Roles } from '../auth/auth.types';
import { AppError } from '../common/errors';
import { escapeHtml, sendMail } from '../common/mail';
import { PrismaService } from '../common/prisma.service';
import { runAsSystem } from '../common/rls';
import { NotificationsService } from '../notifications/notifications';
import { CURRENT_API_VERSION } from './admin';
import { assertPepperConfigured, currentPepperVersion, derivedKey } from './keys';
import { ApiPolicy, PolicyService, policyAllows } from './policy';
import { EVENTS, isEventType } from './registry';

/** Event log and delivery retention (docs/public-api.md §10). */
export const EVENT_RETENTION_DAYS = 30;
/** Delay after attempt n (1-based) before attempt n + 1; 11 attempts over ≈ 2 days. */
export const RETRY_DELAYS_S = [5, 30, 120, 600, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 24 * 3600];
const MAX_ATTEMPTS = RETRY_DELAYS_S.length + 1;
const AUTO_DISABLE_MS = 3 * 86_400_000;
const ROTATION_OVERLAP_MS = 24 * 3_600_000;
const TIMEOUT_MS = 10_000;
const SNIPPET_BYTES = 1024;
const PER_ENDPOINT_IN_FLIGHT = 5;
const MAX_IN_FLIGHT = 100;
const MAX_REPLAY = 10_000;
const DAY_MS = 86_400_000;

// ── Secrets: Standard Webhooks whsec_, encrypted at rest ────────────────────

export const generateSecret = () => `whsec_${randomBytes(32).toString('base64')}`;

/** AES-256-GCM under a key derived from the API pepper; `v<pepperVersion>.<iv>.<tag>.<ciphertext>`. */
export function encryptSecret(secret: string): string {
  const version = currentPepperVersion();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derivedKey('webhook-secret-v1', version), iv);
  const ct = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return ['v' + version, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptSecret(stored: string): string {
  const [v, iv, tag, ct] = stored.split('.');
  const decipher = createDecipheriv('aes-256-gcm', derivedKey('webhook-secret-v1', Number(v.slice(1))), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

/** Standard Webhooks `webhook-signature`: one `v1,<base64>` per secret, space-separated (rotation). */
export function sign(secrets: string[], id: string, timestamp: number, body: string): string {
  return secrets
    .map((s) => 'v1,' + createHmac('sha256', Buffer.from(s.slice('whsec_'.length), 'base64')).update(`${id}.${timestamp}.${body}`).digest('base64'))
    .join(' ');
}

// ── SSRF (§16 API7): public HTTPS targets only, checked at connect time ─────

const PRIVATE = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) PRIVATE.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23],
  ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) PRIVATE.addSubnet(net, bits, 'ipv6');
// No ::ffff:0:0/96 rule: BlockList checks IPv4-mapped IPv6 against the IPv4 rules above (and an
// IPv6 rule for it would match every IPv4 address).

/** Local test stacks only; refused in production. */
const allowPrivate = () => process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS === 'true' && process.env.NODE_ENV !== 'production';

export function isPublicAddress(ip: string): boolean {
  const v4 = ip.toLowerCase().startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  const type = isIP(v4);
  return type !== 0 && !PRIVATE.check(v4, type === 4 ? 'ipv4' : 'ipv6');
}

/** Static checks; the address check happens on every connection (no DNS rebinding). Returns a problem or null. */
export function urlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'not a valid URL';
  }
  if (raw.length > 2000) return 'URL is too long';
  if (u.protocol !== 'https:' && !(allowPrivate() && u.protocol === 'http:')) return 'URL must use https://';
  if (u.username || u.password) return 'URL must not contain credentials';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !isPublicAddress(host) && !allowPrivate()) return 'URL points to a private address';
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host) && !allowPrivate()) return 'URL points to a private host';
  return null;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** dns.lookup that only ever hands public addresses to the socket. */
function safeLookup(hostname: string, options: { all?: boolean }, cb: LookupCb) {
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) return cb(err, '');
    const ok = addresses.filter((a) => allowPrivate() || isPublicAddress(a.address));
    if (!ok.length) return cb(Object.assign(new Error(`${hostname} resolves to a private address`), { code: 'EPRIVATE' }), '');
    if (options.all) cb(null, ok);
    else cb(null, ok[0].address, ok[0].family);
  });
}

export async function resolvesPublic(raw: string): Promise<boolean> {
  return new Promise((resolve) => safeLookup(new URL(raw).hostname.replace(/^\[|\]$/g, ''), {}, (err) => resolve(!err)));
}

export interface SendResult {
  status?: number;
  snippet?: string;
  latencyMs: number;
  error?: string;
}

/** POST, no redirects, 10 s deadline, response read up to 1 KB as text and never parsed (§16 API10). */
export function post(url: string, headers: Record<string, string>, body: string): Promise<SendResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    let done = false;
    let req: ClientRequest | undefined;
    const finish = (r: Omit<SendResult, 'latencyMs'>) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      req?.destroy();
      resolve({ ...r, latencyMs: Date.now() - start });
    };
    const deadline = setTimeout(() => finish({ error: `No response within ${TIMEOUT_MS / 1000} s` }), TIMEOUT_MS);
    try {
      const u = new URL(url);
      req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, {
        method: 'POST',
        headers: { ...headers, 'content-length': Buffer.byteLength(body).toString() },
        lookup: safeLookup as never,
        agent: false,
      });
    } catch (err) {
      return finish({ error: (err as Error).message.slice(0, 300) });
    }
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const end = () => finish({ status: res.statusCode, snippet: Buffer.concat(chunks).toString('utf8').slice(0, SNIPPET_BYTES) });
      res.on('data', (c: Buffer) => {
        chunks.push(c);
        size += c.length;
        if (size >= SNIPPET_BYTES) end();
      });
      res.on('end', end);
      res.on('error', end);
    });
    req.on('error', (err) => finish({ error: err.message.slice(0, 300) }));
    req.end(body);
  });
}

/** The envelope (thin: ids only, §10). Same shape on webhooks and GET /events. */
export function envelope(e: { id: string; type: string; createdAt: Date; data: Prisma.JsonValue }) {
  return { id: e.id, type: e.type, createdAt: e.createdAt.toISOString(), apiVersion: CURRENT_API_VERSION, data: e.data };
}

const eventAllowed = (policy: ApiPolicy, type: string) =>
  type === 'ping' ||
  (isEventType(type) && policy.enabled && policy.webhooks.enabled && (EVENTS[type].permission === null || policyAllows(policy, EVENTS[type].permission!)));

// ── Dispatcher + sender ─────────────────────────────────────────────────────

/**
 * Polls the outbox every second (crash-safe: anything undispatched or unfinished is picked up
 * after a restart). Dispatch fans each event out to the subscribed ACTIVE endpoints; sending
 * claims due deliveries with a lease, at most 5 in flight per endpoint, so one slow customer
 * never holds up the others. Multi-instance safe (SKIP LOCKED + leases); the per-endpoint cap
 * is per instance. At-least-once: consumers dedupe on `webhook-id`.
 */
@Injectable()
export class WebhookWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookWorker.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private readonly inFlight = new Map<string, number>();
  private total = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly policies: PolicyService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    if (process.env.WEBHOOK_WORKER === 'off') return;
    this.schedule(2000);
  }

  onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      try {
        if (process.env.API_KEY_PEPPER) {
          await this.dispatch();
          await this.claimAndSend();
        }
      } catch (err) {
        this.logger.error(`Webhook worker: ${(err as Error).message}`);
      }
      this.schedule(1000);
    }, ms);
  }

  /** Outbox → deliveries, in one transaction per batch. */
  async dispatch() {
    for (;;) {
      const n = await runAsSystem(() =>
        this.prisma.$transaction(async (tx) => {
          const events = await tx.$queryRaw<Array<{ id: string; tenant_id: string; type: string; endpoint_id: string | null }>>`
            SELECT id, tenant_id, type, endpoint_id FROM api_events WHERE dispatched_at IS NULL
            ORDER BY created_at LIMIT 500 FOR UPDATE SKIP LOCKED`;
          if (!events.length) return 0;
          const tenantIds = [...new Set(events.map((e) => e.tenant_id))];
          const [endpoints, policies] = await Promise.all([
            tx.webhookEndpoint.findMany({ where: { tenantId: { in: tenantIds }, status: 'ACTIVE' }, select: { id: true, tenantId: true, events: true } }),
            Promise.all(tenantIds.map(async (t) => [t, (await this.policies.forTenant(t)).policy] as const)).then((p) => new Map(p)),
          ]);
          const rows: Prisma.WebhookDeliveryCreateManyInput[] = [];
          for (const e of events) {
            if (e.endpoint_id) {
              rows.push({ tenantId: e.tenant_id, endpointId: e.endpoint_id, eventId: e.id });
              continue;
            }
            if (!eventAllowed(policies.get(e.tenant_id)!, e.type)) continue;
            for (const ep of endpoints) {
              if (ep.tenantId === e.tenant_id && ep.events.includes(e.type)) rows.push({ tenantId: e.tenant_id, endpointId: ep.id, eventId: e.id });
            }
          }
          if (rows.length) await tx.webhookDelivery.createMany({ data: rows });
          await tx.apiEvent.updateMany({ where: { id: { in: events.map((e) => e.id) } }, data: { dispatchedAt: new Date() } });
          return events.length;
        }),
      );
      if (n < 500) return;
    }
  }

  private async claimAndSend() {
    if ((await this.policies.platform()).killSwitch) return; // paused, not dropped
    const room = MAX_IN_FLIGHT - this.total;
    if (room <= 0) return;
    const busy = [...this.inFlight.keys()];
    // Endpoints with sends in flight here sit out this round; everyone else gets up to 5.
    const claimed = await runAsSystem(() =>
      this.prisma.$queryRaw<Array<{ id: string }>>`
        UPDATE webhook_deliveries SET locked_until = (now() AT TIME ZONE 'UTC') + interval '60 seconds'
        WHERE id IN (
          SELECT id FROM (
            SELECT d.id, row_number() OVER (PARTITION BY d.endpoint_id ORDER BY d.next_attempt_at) AS n
            FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
            WHERE d.status = 'PENDING' AND d.next_attempt_at <= (now() AT TIME ZONE 'UTC')
              AND (d.locked_until IS NULL OR d.locked_until < (now() AT TIME ZONE 'UTC'))
              AND e.status = 'ACTIVE' AND NOT (d.endpoint_id = ANY(${busy}::text[]))
          ) due WHERE n <= ${PER_ENDPOINT_IN_FLIGHT}
          LIMIT ${room}
        )
        AND status = 'PENDING' AND (locked_until IS NULL OR locked_until < (now() AT TIME ZONE 'UTC'))
        RETURNING id`,
    );
    if (!claimed.length) return;
    const deliveries = await runAsSystem(() =>
      this.prisma.webhookDelivery.findMany({ where: { id: { in: claimed.map((c) => c.id) } }, include: { event: true, endpoint: true } }),
    );
    for (const d of deliveries) {
      this.inFlight.set(d.endpointId, (this.inFlight.get(d.endpointId) ?? 0) + 1);
      this.total++;
      void this.send(d)
        .catch((err) => this.logger.error(`Delivery ${d.id}: ${(err as Error).message}`))
        .finally(() => {
          this.total--;
          const left = (this.inFlight.get(d.endpointId) ?? 1) - 1;
          if (left > 0) this.inFlight.set(d.endpointId, left);
          else this.inFlight.delete(d.endpointId);
        });
    }
  }

  private async send(d: Prisma.WebhookDeliveryGetPayload<{ include: { event: true; endpoint: true } }>) {
    const { endpoint, event } = d;
    const attempts = d.attempts + 1;
    // Checked again at delivery time: a tightened policy stops deliveries at once (§10).
    if (!eventAllowed((await this.policies.forTenant(d.tenantId)).policy, event.type)) {
      await this.settle(d.id, { status: 'FAILED', attempts, error: "Blocked by your organisation's API policy" });
      return;
    }
    let r: SendResult;
    try {
      const body = JSON.stringify(envelope(event));
      const secrets = [decryptSecret(endpoint.secretEncrypted)];
      if (endpoint.previousSecretEncrypted && endpoint.previousSecretUntil && endpoint.previousSecretUntil.getTime() > Date.now()) {
        secrets.push(decryptSecret(endpoint.previousSecretEncrypted));
      }
      const ts = Math.floor(Date.now() / 1000);
      const headers = {
        'content-type': 'application/json',
        'user-agent': 'Iverto-Webhooks/1.0',
        'webhook-id': event.id,
        'webhook-timestamp': String(ts),
        'webhook-signature': sign(secrets, event.id, ts, body),
      };
      r = await post(endpoint.url, headers, body);
    } catch (err) {
      // e.g. a secret encrypted under a pepper version no longer configured: counts as a failed attempt, never loops.
      this.logger.error(`Delivery ${d.id} could not be prepared: ${(err as Error).message}`);
      r = { error: 'Internal error preparing the delivery', latencyMs: 0 };
    }
    const result = { attempts, responseStatus: r.status ?? null, responseSnippet: r.snippet ?? null, latencyMs: r.latencyMs, error: r.error ?? null };

    if (r.status && r.status >= 200 && r.status < 300) {
      await this.settle(d.id, { ...result, status: 'SUCCEEDED', deliveredAt: new Date() });
      if (endpoint.failingSince) await runAsSystem(() => this.prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { failingSince: null } }));
      return;
    }
    if (r.status === 410) {
      await this.settle(d.id, { ...result, status: 'FAILED' });
      await this.disable(endpoint, 'The endpoint returned 410 Gone');
      return;
    }
    const last = attempts >= MAX_ATTEMPTS;
    const delay = RETRY_DELAYS_S[attempts - 1] * 1000 * (0.9 + Math.random() * 0.2);
    await this.settle(d.id, { ...result, status: last ? 'FAILED' : 'PENDING', nextAttemptAt: last ? undefined : new Date(Date.now() + delay) });
    const since = endpoint.failingSince ?? new Date();
    if (!endpoint.failingSince) await runAsSystem(() => this.prisma.webhookEndpoint.updateMany({ where: { id: endpoint.id, failingSince: null }, data: { failingSince: since } }));
    else if (Date.now() - since.getTime() > AUTO_DISABLE_MS) await this.disable(endpoint, 'Deliveries failed for 3 days');
  }

  private settle(id: string, data: Prisma.WebhookDeliveryUpdateInput) {
    return runAsSystem(() => this.prisma.webhookDelivery.update({ where: { id }, data: { ...data, lockedUntil: null } }));
  }

  /** Auto-disable (410 or 3 days failing) and tell the org's admins in-app and by email. */
  private async disable(endpoint: WebhookEndpoint, reason: string) {
    const changed = await runAsSystem(() =>
      this.prisma.webhookEndpoint.updateMany({ where: { id: endpoint.id, status: 'ACTIVE' }, data: { status: 'DISABLED', disabledReason: reason } }),
    );
    if (!changed.count) return;
    this.logger.warn(`Webhook endpoint ${endpoint.id} disabled: ${reason}`);
    const admins = await runAsSystem(() =>
      this.prisma.userProfile.findMany({ where: { tenantId: endpoint.tenantId, role: 'ADMIN', status: 'ACTIVE' }, select: { userId: true, email: true } }),
    );
    const title = 'Webhook endpoint disabled';
    const body = `${endpoint.url} was disabled: ${reason}. Fix it, then re-enable it in Settings → API & integrations and replay the missed events.`;
    await this.notifications.notify(endpoint.tenantId, admins.map((a) => a.userId), { type: 'API_WEBHOOK_DISABLED', title, body });
    for (const a of admins) {
      await sendMail(a.email, title, `<p>${escapeHtml(body)}</p>`).catch((err) => this.logger.warn(`Mail failed: ${(err as Error).message}`));
    }
  }
}

// ── Admin ───────────────────────────────────────────────────────────────────

export class CreateEndpointDto {
  @IsString() @MaxLength(2000) url: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @IsString({ each: true }) events: string[];
}

export class UpdateEndpointDto {
  @IsOptional() @IsString() @MaxLength(2000) url?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @IsString({ each: true }) events?: string[];
  @IsOptional() @IsBoolean() enabled?: boolean;
}

class DeliveryQuery {
  @IsOptional() @IsIn(['PENDING', 'SUCCEEDED', 'FAILED']) status?: string;
  @IsOptional() @IsString() @MaxLength(64) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

class ReplayDto {
  @IsISO8601({ strict: true }) since: string;
}

/** An endpoint as admins see it: never the secret. */
function presentEndpoint(e: WebhookEndpoint) {
  const { secretEncrypted: _s, previousSecretEncrypted: _p, ...rest } = e;
  return { ...rest, previousSecretActive: !!e.previousSecretUntil && e.previousSecretUntil.getTime() > Date.now() };
}

@Injectable()
export class WebhookAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditableActionService,
    private readonly policies: PolicyService,
  ) {}

  async list(user: AuthUser) {
    const [{ policy }, endpoints] = await Promise.all([
      this.policies.forTenant(user.tenantId),
      this.prisma.webhookEndpoint.findMany({ where: { tenantId: user.tenantId }, orderBy: { createdAt: 'asc' } }),
    ]);
    return {
      policy: { enabled: policy.enabled && policy.webhooks.enabled, maxEndpoints: policy.webhooks.maxEndpoints },
      events: Object.entries(EVENTS).map(([type, e]) => ({ type, label: e.label, permission: e.permission, allowed: eventAllowed(policy, type) })),
      endpoints: endpoints.map(presentEndpoint),
    };
  }

  private async get(tenantId: string, id: string) {
    const e = await this.prisma.webhookEndpoint.findFirst({ where: { id, tenantId } });
    if (!e) throw new AppError(404, 'WEBHOOK_NOT_FOUND', 'Webhook endpoint not found');
    return e;
  }

  private assertTenantAdmin(user: AuthUser) {
    assertPepperConfigured();
    if (user.isSuperAdmin) throw new AppError(403, 'PLATFORM_CANNOT_MINT', 'Platform administrators cannot create or change tenant webhook endpoints');
  }

  private async validate(policy: ApiPolicy, dto: { url?: string; events?: string[] }) {
    const problems: string[] = [];
    if (!policy.enabled || !policy.webhooks.enabled) throw new AppError(403, 'WEBHOOKS_DISABLED', 'Webhooks are not enabled for your organisation; contact Iverto');
    for (const t of dto.events ?? []) {
      if (!isEventType(t)) problems.push(`unknown event "${t}"`);
      else if (!eventAllowed(policy, t)) problems.push(`"${t}" isn't allowed for your organisation`);
    }
    if (dto.url !== undefined) {
      const p = urlProblem(dto.url);
      if (p) problems.push(p);
      else if (!(await resolvesPublic(dto.url))) problems.push("the URL's host doesn't resolve to a public address");
    }
    if (problems.length) throw new AppError(400, 'WEBHOOK_INVALID', problems[0], problems);
  }

  async create(user: AuthUser, dto: CreateEndpointDto) {
    this.assertTenantAdmin(user);
    const { policy } = await this.policies.forTenant(user.tenantId);
    await this.validate(policy, dto);
    const count = await this.prisma.webhookEndpoint.count({ where: { tenantId: user.tenantId } });
    if (count >= policy.webhooks.maxEndpoints) throw new AppError(409, 'WEBHOOK_LIMIT', `Your organisation may have at most ${policy.webhooks.maxEndpoints} endpoints`);
    const secret = generateSecret();
    const endpoint = await this.audit.run<WebhookEndpoint>({
      action: 'API_WEBHOOK_CREATED',
      targetType: 'WebhookEndpoint',
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: (e) => ({ url: e.url, events: e.events }),
      run: (tx) =>
        tx.webhookEndpoint.create({
          data: {
            tenantId: user.tenantId,
            url: dto.url,
            description: dto.description,
            events: [...new Set(dto.events)],
            secretEncrypted: encryptSecret(secret),
            createdBy: user.sub,
          },
        }),
    });
    return { secret, endpoint: presentEndpoint(endpoint) };
  }

  async update(user: AuthUser, id: string, dto: UpdateEndpointDto) {
    this.assertTenantAdmin(user);
    await this.get(user.tenantId, id);
    const { policy } = await this.policies.forTenant(user.tenantId);
    // Disabling or renaming always works, even after Iverto turns webhooks off.
    if (dto.url !== undefined || dto.events || dto.enabled === true) await this.validate(policy, dto);
    const e = await this.audit.run<WebhookEndpoint>({
      action: 'API_WEBHOOK_UPDATED',
      targetType: 'WebhookEndpoint',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ ...dto }),
      run: (tx) =>
        tx.webhookEndpoint.update({
          where: { id },
          data: {
            url: dto.url,
            description: dto.description,
            events: dto.events ? [...new Set(dto.events)] : undefined,
            ...(dto.enabled === true && { status: 'ACTIVE', disabledReason: null, failingSince: null }),
            ...(dto.enabled === false && { status: 'DISABLED', disabledReason: 'Disabled by an admin' }),
          },
        }),
    });
    return presentEndpoint(e);
  }

  /** New secret signs at once; the old one keeps signing for 24 h alongside it. */
  async rotate(user: AuthUser, id: string) {
    this.assertTenantAdmin(user);
    const current = await this.get(user.tenantId, id);
    const secret = generateSecret();
    const e = await this.audit.run<WebhookEndpoint>({
      action: 'API_WEBHOOK_SECRET_ROTATED',
      targetType: 'WebhookEndpoint',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      run: (tx) =>
        tx.webhookEndpoint.update({
          where: { id },
          data: {
            secretEncrypted: encryptSecret(secret),
            previousSecretEncrypted: current.secretEncrypted,
            previousSecretUntil: new Date(Date.now() + ROTATION_OVERLAP_MS),
          },
        }),
    });
    return { secret, endpoint: presentEndpoint(e) };
  }

  async remove(user: AuthUser, id: string) {
    this.assertTenantAdmin(user);
    const e = await this.get(user.tenantId, id);
    await this.audit.run({
      action: 'API_WEBHOOK_DELETED',
      targetType: 'WebhookEndpoint',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ url: e.url }),
      run: (tx) => tx.webhookEndpoint.delete({ where: { id } }),
    });
    return { deleted: true };
  }

  /** A `ping` event for this endpoint only. */
  async test(user: AuthUser, id: string) {
    const e = await this.get(user.tenantId, id);
    const event = await this.prisma.apiEvent.create({
      data: {
        id: `evt_${randomBytes(16).toString('hex')}`,
        tenantId: user.tenantId,
        type: 'ping',
        endpointId: e.id,
        data: { object: 'ping', endpointId: e.id },
      },
    });
    return { eventId: event.id };
  }

  async deliveries(user: AuthUser, id: string, q: DeliveryQuery) {
    await this.get(user.tenantId, id);
    const limit = q.limit ?? 50;
    const rows = await this.prisma.webhookDelivery.findMany({
      where: { endpointId: id, tenantId: user.tenantId, ...(q.status && { status: q.status }) },
      include: { event: { select: { type: true, createdAt: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(q.cursor && { cursor: { id: q.cursor }, skip: 1 }),
    });
    return { data: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].id : null };
  }

  /** Another full round of attempts for one delivery; same webhook-id, so consumers dedupe. */
  async retry(user: AuthUser, deliveryId: string) {
    this.assertTenantAdmin(user);
    const d = await this.prisma.webhookDelivery.findFirst({ where: { id: deliveryId, tenantId: user.tenantId } });
    if (!d) throw new AppError(404, 'DELIVERY_NOT_FOUND', 'Delivery not found');
    if (d.status === 'PENDING') throw new AppError(409, 'DELIVERY_PENDING', 'This delivery is still being attempted');
    await this.prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lockedUntil: null } });
    return { retried: true };
  }

  /** Re-send every subscribed event since `since` (≤ 30 days, ≤ 10,000 events), e.g. after re-enabling. */
  async replay(user: AuthUser, id: string, dto: ReplayDto) {
    this.assertTenantAdmin(user);
    const e = await this.get(user.tenantId, id);
    const since = new Date(dto.since);
    if (since.getTime() < Date.now() - EVENT_RETENTION_DAYS * DAY_MS) {
      throw new AppError(400, 'REPLAY_TOO_OLD', `Events are kept for ${EVENT_RETENTION_DAYS} days`);
    }
    const { policy } = await this.policies.forTenant(user.tenantId);
    const types = e.events.filter((t) => eventAllowed(policy, t));
    const queued = await this.prisma.$executeRaw`
      INSERT INTO webhook_deliveries (id, tenant_id, endpoint_id, event_id, status, attempts, next_attempt_at, created_at)
      SELECT 'whd_' || replace(gen_random_uuid()::text, '-', ''), ev.tenant_id, ${e.id}, ev.id, 'PENDING', 0, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC'
      FROM (
        SELECT id, tenant_id FROM api_events
        WHERE tenant_id = ${user.tenantId} AND endpoint_id IS NULL AND type = ANY(${types}::text[]) AND created_at >= ${since}
        ORDER BY created_at LIMIT ${MAX_REPLAY}
      ) ev`;
    await this.audit.log({ tenantId: user.tenantId, actor: actorOf(user), action: 'API_WEBHOOK_REPLAYED', targetType: 'WebhookEndpoint', targetId: id, payload: { since: dto.since, queued } });
    return { queued };
  }

  // ── Platform ────────────────────────────────────────────────────────────

  tenantEndpoints(tenantId: string) {
    return runAsSystem(async () => (await this.prisma.webhookEndpoint.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } })).map(presentEndpoint));
  }

  async platformDisable(user: AuthUser, id: string) {
    const e = await runAsSystem(() => this.prisma.webhookEndpoint.findUnique({ where: { id } }));
    if (!e) throw new AppError(404, 'WEBHOOK_NOT_FOUND', 'Webhook endpoint not found');
    await runAsSystem(() =>
      this.audit.run({
        action: 'API_WEBHOOK_DISABLED_BY_PLATFORM',
        targetType: 'WebhookEndpoint',
        targetId: id,
        actor: actorOf(user),
        tenantId: e.tenantId,
        run: (tx) => tx.webhookEndpoint.update({ where: { id }, data: { status: 'DISABLED', disabledReason: 'Disabled by Iverto' } }),
      }),
    );
    return { disabled: true };
  }

  /** Retention, from the daily job. */
  purge() {
    const before = new Date(Date.now() - EVENT_RETENTION_DAYS * DAY_MS);
    return runAsSystem(async () => {
      await this.prisma.webhookDelivery.deleteMany({ where: { createdAt: { lt: before } } });
      await this.prisma.apiEvent.deleteMany({ where: { createdAt: { lt: before } } });
    });
  }
}

@ApiTags('api-keys')
@Controller('api-webhooks')
@Roles('ADMIN')
export class OrgWebhooksController {
  constructor(private readonly admin: WebhookAdminService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.admin.list(user);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateEndpointDto) {
    return this.admin.create(user, dto);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateEndpointDto) {
    return this.admin.update(user, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.admin.remove(user, id);
  }

  @Post(':id/rotate-secret')
  rotate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.admin.rotate(user, id);
  }

  @Post(':id/test')
  test(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.admin.test(user, id);
  }

  @Post(':id/replay')
  replay(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReplayDto) {
    return this.admin.replay(user, id, dto);
  }

  @Get(':id/deliveries')
  deliveries(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query() q: DeliveryQuery) {
    return this.admin.deliveries(user, id, q);
  }

  @Post('deliveries/:deliveryId/retry')
  retry(@CurrentUser() user: AuthUser, @Param('deliveryId') deliveryId: string) {
    return this.admin.retry(user, deliveryId);
  }
}

@ApiTags('platform')
@Controller('platform/api')
@Roles('PLATFORM_ADMIN')
export class PlatformWebhooksController {
  constructor(private readonly admin: WebhookAdminService) {}

  @Get('tenants/:tenantId/webhooks')
  list(@Param('tenantId') tenantId: string) {
    return this.admin.tenantEndpoints(tenantId);
  }

  @Post('webhooks/:id/disable')
  disable(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.admin.platformDisable(user, id);
  }
}
