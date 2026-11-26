import { Controller, Get, Injectable, Logger, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiKey, Prisma } from '@prisma/client';
import { IsOptional, IsString } from 'class-validator';
import { AuditableActionService } from '../audit/audit.service';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.types';
import { escapeHtml, sendMail } from '../common/mail';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { runAsSystem } from '../common/rls';
import { NotificationsService } from '../notifications/notifications';
import { LimiterService, utcDay } from './limiter';
import { PolicyService } from './policy';

/**
 * Usage alerts and key hygiene (docs/public-api.md §15), run hourly by the cron queue.
 * Each alert is stored (api_alerts), shown in-app and emailed to the org's admins and the
 * key's creator, and emitted as an `api.alert` event. One alert per (key, type, level) per
 * 24 h. Unused keys are auto-DISABLED (an admin can re-enable; revoked stays permanent).
 */

const THROTTLE_MS = 24 * 3_600_000;
const HOUR_MS = 3_600_000;
/** Fewer requests than this in the hour is too little to call a spike. */
const SPIKE_MIN_REQUESTS = 20;
const AUTH_STORM = 20;

interface Alert {
  tenantId: string;
  apiKeyId?: string | null;
  type: string;
  level: 'warning' | 'critical';
  message: string;
  data?: Record<string, unknown>;
}

@Injectable()
export class ApiAlertsService {
  private readonly logger = new Logger(ApiAlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly policies: PolicyService,
    private readonly limiter: LimiterService,
    private readonly audit: AuditableActionService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Hourly. Returns how many alerts were raised. */
  async run(now = new Date()): Promise<number> {
    const tenants = await runAsSystem(() =>
      this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT DISTINCT t.id FROM tenants t JOIN api_keys k ON k.tenant_id = t.id
        WHERE t.status = 'ACTIVE' AND k.status <> 'REVOKED'`,
    );
    let raised = 0;
    for (const { id } of tenants) {
      try {
        raised += await this.forTenant(id, now);
      } catch (err) {
        this.logger.error(`Alerts for ${id} failed: ${(err as Error).message}`);
      }
    }
    return raised;
  }

  async forTenant(tenantId: string, now = new Date()): Promise<number> {
    const { policy } = await this.policies.forTenant(tenantId);
    const a = policy.alerts;
    if (!a.enabled) return 0;
    const hourAgo = new Date(now.getTime() - HOUR_MS);
    const keys = await runAsSystem(() => this.prisma.apiKey.findMany({ where: { tenantId, status: { not: 'REVOKED' } } }));
    const alerts: Alert[] = [];

    // Key hygiene: expiring and unused keys.
    for (const k of keys.filter((k) => k.status === 'ACTIVE')) {
      if (k.expiresAt && k.expiresAt > now) {
        const days = (k.expiresAt.getTime() - now.getTime()) / 86_400_000;
        if (days <= a.expiryWarnDays) {
          alerts.push({ tenantId, apiKeyId: k.id, type: 'key_expiring', level: days <= 1 ? 'critical' : 'warning', message: `API key "${k.name}" expires on ${k.expiresAt.toISOString().slice(0, 10)}; rotate it before then`, data: { expiresAt: k.expiresAt.toISOString() } });
        }
      }
      const idleDays = Math.floor((now.getTime() - (k.lastUsedAt ?? k.createdAt).getTime()) / 86_400_000);
      if (a.staleDisableDays > 0 && idleDays >= a.staleDisableDays) {
        if (await this.disableStale(k, idleDays)) {
          alerts.push({ tenantId, apiKeyId: k.id, type: 'key_disabled', level: 'critical', message: `API key "${k.name}" was disabled after ${idleDays} days without use; an admin can re-enable it`, data: { idleDays } });
        }
      } else if (idleDays >= a.staleWarnDays) {
        const when = a.staleDisableDays > 0 ? ` and will be disabled after ${a.staleDisableDays}` : '';
        alerts.push({ tenantId, apiKeyId: k.id, type: 'key_stale', level: 'warning', message: `API key "${k.name}" has not been used for ${idleDays} days${when}; revoke it if it is no longer needed`, data: { idleDays } });
      }
    }

    // Traffic: rate limiting, daily quota, credits, error spike, auth anomalies.
    const [lastHour] = await runAsSystem(() =>
      this.prisma.$queryRaw<Array<{ total: bigint; errors: bigint; limited: bigint }>>`
        SELECT count(*) AS total, count(*) FILTER (WHERE status >= 400) AS errors, count(*) FILTER (WHERE status = 429) AS limited
        FROM api_request_logs WHERE tenant_id = ${tenantId} AND created_at >= ${hourAgo}`,
    );
    const total = Number(lastHour.total);
    if (Number(lastHour.limited) > 0) {
      alerts.push({ tenantId, type: 'rate_limit', level: 'warning', message: `${lastHour.limited} API requests were rate limited in the last hour`, data: { rateLimited: Number(lastHour.limited), perMinute: policy.rateLimit.perMinute } });
    }
    const usedToday = Number((await this.redis.client.get(`api:day:${tenantId}:${utcDay(now)}`)) ?? 0);
    const quotaPct = Math.floor((usedToday / policy.rateLimit.perDay) * 100);
    if (quotaPct >= a.quotaPct) {
      alerts.push({ tenantId, type: 'quota', level: quotaPct >= 100 ? 'critical' : 'warning', message: `Your organisation has used ${Math.min(quotaPct, 100)}% of today's API quota (${policy.rateLimit.perDay.toLocaleString('en-IN')} requests)`, data: { used: usedToday, perDay: policy.rateLimit.perDay } });
    }
    if (policy.credits.enabled) {
      const [allowance, spent] = await Promise.all([this.limiter.allowance(tenantId, policy.credits.monthlyGrant), this.limiter.spent(tenantId)]);
      const pct = allowance > 0 ? Math.floor((spent / allowance) * 100) : 100;
      if (pct >= a.creditPct) {
        alerts.push({ tenantId, type: 'credits', level: pct >= 100 ? 'critical' : 'warning', message: `Your organisation has used ${Math.min(pct, 100)}% of this month's API credits`, data: { spent, allowance } });
      }
    }
    if (total >= SPIKE_MIN_REQUESTS) {
      const [base] = await runAsSystem(() =>
        this.prisma.$queryRaw<Array<{ total: bigint; errors: bigint }>>`
          SELECT count(*) AS total, count(*) FILTER (WHERE status >= 400) AS errors FROM api_request_logs
          WHERE tenant_id = ${tenantId} AND created_at >= ${new Date(now.getTime() - 7 * 86_400_000)} AND created_at < ${hourAgo}`,
      );
      const rate = Number(lastHour.errors) / total;
      const baseline = Number(base.total) ? Number(base.errors) / Number(base.total) : 0;
      if (rate > a.errorSpikeFactor * Math.max(baseline, 0.02)) {
        alerts.push({ tenantId, type: 'error_spike', level: 'warning', message: `${Math.round(rate * 100)}% of API requests failed in the last hour (usually ${Math.round(baseline * 100)}%)`, data: { rate, baseline, requests: total } });
      }
    }
    const perKey = await runAsSystem(() =>
      this.prisma.$queryRaw<Array<{ api_key_id: string; unauthorized: bigint; new_ips: string[] }>>`
        SELECT l.api_key_id,
               count(*) FILTER (WHERE l.status = 401) AS unauthorized,
               coalesce(array_agg(DISTINCT l.ip) FILTER (WHERE l.ip IS NOT NULL AND NOT EXISTS (
                 SELECT 1 FROM api_request_logs o WHERE o.api_key_id = l.api_key_id AND o.ip = l.ip
                   AND o.created_at >= ${new Date(now.getTime() - 30 * 86_400_000)} AND o.created_at < ${hourAgo})), '{}') AS new_ips
        FROM api_request_logs l
        WHERE l.tenant_id = ${tenantId} AND l.api_key_id IS NOT NULL AND l.created_at >= ${hourAgo}
        GROUP BY l.api_key_id`,
    );
    for (const p of perKey) {
      const key = keys.find((k) => k.id === p.api_key_id);
      if (!key) continue;
      if (Number(p.unauthorized) >= AUTH_STORM) {
        alerts.push({ tenantId, apiKeyId: key.id, type: 'auth_anomaly', level: 'critical', message: `API key "${key.name}" had ${p.unauthorized} refused requests (401) in the last hour`, data: { unauthorized: Number(p.unauthorized) } });
      }
      // A key that has history and no allowlist, seen from an address it never used before.
      const hadHistory = key.createdAt.getTime() < hourAgo.getTime() && key.lastUsedAt;
      if (!key.ipAllowlist.length && hadHistory && p.new_ips.length) {
        alerts.push({ tenantId, apiKeyId: key.id, type: 'auth_anomaly', level: 'warning', message: `API key "${key.name}" was used from a new address: ${p.new_ips.slice(0, 3).join(', ')}`, data: { ips: p.new_ips } });
      }
    }

    // Webhooks failing for over an hour (auto-disable after 3 days is the dispatcher's job).
    const failing = await runAsSystem(() =>
      this.prisma.webhookEndpoint.findMany({ where: { tenantId, status: 'ACTIVE', failingSince: { lt: hourAgo } }, select: { id: true, url: true, failingSince: true } }),
    );
    for (const w of failing) {
      alerts.push({ tenantId, type: 'webhook_failing', level: 'warning', message: `Webhook ${w.url} has been failing since ${w.failingSince!.toISOString().slice(0, 16).replace('T', ' ')} UTC`, data: { endpointId: w.id } });
    }

    let raised = 0;
    for (const alert of alerts) if (await this.raise(alert, keys, now)) raised++;
    return raised;
  }

  /** ACTIVE → DISABLED, audited as the system. False if someone changed the key meanwhile. */
  private async disableStale(key: ApiKey, idleDays: number) {
    const changed = await this.audit.run({
      action: 'API_KEY_AUTO_DISABLED',
      targetType: 'ApiKey',
      targetId: key.id,
      actor: { type: 'system' },
      tenantId: key.tenantId,
      payloadFrom: () => ({ idleDays }),
      run: (tx) => tx.apiKey.updateMany({ where: { id: key.id, status: 'ACTIVE' }, data: { status: 'DISABLED', disabledReason: `Unused for ${idleDays} days` } }),
    });
    await this.policies.invalidate(`key:${key.keyId}`);
    return changed.count > 0;
  }

  /** Store, notify, email and emit, unless the same alert went out in the last 24 h. */
  private async raise(a: Alert, keys: ApiKey[], now: Date): Promise<boolean> {
    const recent = await runAsSystem(() =>
      this.prisma.apiAlert.findFirst({
        where: { tenantId: a.tenantId, apiKeyId: a.apiKeyId ?? null, type: a.type, level: a.level, createdAt: { gte: new Date(now.getTime() - THROTTLE_MS) } },
        select: { id: true },
      }),
    );
    if (recent) return false;
    const data = { ...(a.data ?? {}) } as Prisma.InputJsonValue;
    const row = await runAsSystem(() =>
      this.prisma.$transaction(async (tx) => {
        const alert = await tx.apiAlert.create({ data: { tenantId: a.tenantId, apiKeyId: a.apiKeyId ?? null, type: a.type, level: a.level, message: a.message, data } });
        await tx.apiEvent.create({
          data: {
            id: `evt_${alert.id}`,
            tenantId: a.tenantId,
            type: 'api.alert',
            data: { object: 'api_alert', id: alert.id, type: a.type, level: a.level, message: a.message, apiKeyId: a.apiKeyId ?? null },
          },
        });
        return alert;
      }),
    );
    const owner = a.apiKeyId ? keys.find((k) => k.id === a.apiKeyId)?.createdBy : null;
    const admins = await runAsSystem(() =>
      this.prisma.userProfile.findMany({
        where: { tenantId: a.tenantId, status: 'ACTIVE', OR: [{ role: 'ADMIN' }, ...(owner ? [{ userId: owner }] : [])] },
        select: { userId: true, email: true },
      }),
    );
    const title = a.level === 'critical' ? 'API alert' : 'API warning';
    await this.notifications.notify(a.tenantId, admins.map((u) => u.userId), { type: 'API_ALERT', title, body: a.message, data: { alertId: row.id, type: a.type } });
    for (const u of admins) {
      await sendMail(u.email, `${title}: ${a.message}`, `<p>${escapeHtml(a.message)}</p><p>Settings → API &amp; integrations shows usage, keys and alerts.</p>`).catch((err) =>
        this.logger.warn(`Alert mail failed: ${(err as Error).message}`),
      );
    }
    return true;
  }

  /** Daily: one email to platform admins with every org's alerts of the last 24 h. */
  async digest(now = new Date()) {
    const rows = await runAsSystem(() =>
      this.prisma.$queryRaw<Array<{ name: string; type: string; level: string; n: bigint }>>`
        SELECT t.name, a.type, a.level, count(*) AS n FROM api_alerts a JOIN tenants t ON t.id = a.tenant_id
        WHERE a.created_at >= ${new Date(now.getTime() - 86_400_000)} GROUP BY 1, 2, 3 ORDER BY 1, 3, 2`,
    );
    if (!rows.length) return 0;
    const staff = await runAsSystem(() => this.prisma.userProfile.findMany({ where: { role: 'PLATFORM_ADMIN', status: 'ACTIVE' }, select: { email: true } }));
    const html = `<p>API alerts in the last 24 hours:</p><ul>${rows.map((r) => `<li>${escapeHtml(r.name)}: ${r.n} × ${escapeHtml(r.type)} (${r.level})</li>`).join('')}</ul>`;
    for (const s of staff) await sendMail(s.email, `API alerts digest: ${rows.length} kinds across orgs`, html).catch(() => undefined);
    return rows.length;
  }

  /** Alerts are kept 90 days. */
  purge() {
    return runAsSystem(() => this.prisma.apiAlert.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 90 * 86_400_000) } } }));
  }

  list(tenantId: string | undefined, limit = 100) {
    return this.prisma.apiAlert.findMany({ where: tenantId ? { tenantId } : {}, orderBy: { createdAt: 'desc' }, take: limit });
  }
}

class AlertQuery {
  @IsOptional() @IsString() tenantId?: string;
}

@ApiTags('api-keys')
@Controller('api-keys/alerts')
@Roles('ADMIN')
export class OrgApiAlertsController {
  constructor(private readonly alerts: ApiAlertsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.alerts.list(user.tenantId);
  }
}

@ApiTags('platform')
@Controller('platform/api/alerts')
@Roles('PLATFORM_ADMIN')
export class PlatformApiAlertsController {
  constructor(private readonly alerts: ApiAlertsService) {}

  @Get()
  list(@Query() q: AlertQuery) {
    return runAsSystem(() => this.alerts.list(q.tenantId, 200));
  }

  /** Run the hourly check now (incident follow-up, tests). Throttling still applies. */
  @Post('run')
  async run() {
    return { raised: await runAsSystem(() => this.alerts.run()) };
  }
}

