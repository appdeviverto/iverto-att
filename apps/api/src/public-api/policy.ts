import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import Redis from 'ioredis';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { redisOptions, RedisService } from '../common/redis.service';
import { runAsSystem } from '../common/rls';
import { isValidCidr } from './keys';
import { HTTP_METHODS, HttpMethod, isPermission, methodsOf, MODULES, ModuleId, OPERATION_BY_ID, PermissionId, PERMISSIONS } from './registry';

/** The superadmin's ceiling for one org (docs/public-api.md §5). */
export interface ApiPolicy {
  enabled: boolean;
  /** HTTP methods allowed per module; a module that is missing allows nothing. */
  modules: Partial<Record<ModuleId, HttpMethod[]>>;
  /** Keys asking for any of these wait for platform approval. */
  approvalRequired: PermissionId[];
  piiAllowed: boolean;
  maxKeys: number;
  maxKeyLifetimeDays: number | null;
  requireIpAllowlist: boolean;
  orgIpAllowlist: string[];
  rateLimit: { perMinute: number; burst: number; perDay: number; concurrency: number };
  /** Highest per-minute rate an org admin may give one key. */
  keyRateCeiling: number;
  credits: { enabled: boolean; monthlyGrant: number; onExhausted: 'block' | 'allow_overage'; costs: Record<string, number> };
  webhooks: { enabled: boolean; maxEndpoints: number };
  bulk: { maxRecordsPerRequest: number; concurrentJobs: number };
  /** Usage alerts and key hygiene (§15). staleDisableDays 0 = never auto-disable. */
  alerts: ApiAlertSettings;
}

export interface ApiAlertSettings {
  enabled: boolean;
  quotaPct: number;
  creditPct: number;
  errorSpikeFactor: number;
  expiryWarnDays: number;
  staleWarnDays: number;
  staleDisableDays: number;
}

/** The platform default row also carries platform-wide switches. */
export interface PlatformApiSettings extends ApiPolicy {
  killSwitch: boolean;
  logRetentionDays: number;
}

export const DEFAULT_POLICY: ApiPolicy = {
  enabled: false,
  modules: { org: ['GET'], employees: ['GET'], punches: ['GET'], attendance: ['GET'], leave: ['GET'] },
  approvalRequired: [],
  piiAllowed: false,
  maxKeys: 10,
  maxKeyLifetimeDays: 365,
  requireIpAllowlist: false,
  orgIpAllowlist: [],
  rateLimit: { perMinute: 600, burst: 600, perDay: 200_000, concurrency: 20 },
  keyRateCeiling: 300,
  credits: { enabled: false, monthlyGrant: 100_000, onExhausted: 'block', costs: {} },
  webhooks: { enabled: true, maxEndpoints: 10 },
  bulk: { maxRecordsPerRequest: 1000, concurrentJobs: 1 },
  alerts: { enabled: true, quotaPct: 80, creditPct: 80, errorSpikeFactor: 3, expiryWarnDays: 7, staleWarnDays: 60, staleDisableDays: 90 },
};

export const DEFAULT_PLATFORM: PlatformApiSettings = { ...DEFAULT_POLICY, killSwitch: false, logRetentionDays: 90 };

// ── Validation (class-validator, like every other DTO) ──────────────────────

class RateLimitDto {
  @IsInt() @Min(1) @Max(100_000) perMinute: number;
  @IsInt() @Min(1) @Max(100_000) burst: number;
  @IsInt() @Min(1) @Max(100_000_000) perDay: number;
  @IsInt() @Min(1) @Max(1000) concurrency: number;
}

class CreditsDto {
  @IsBoolean() enabled: boolean;
  @IsInt() @Min(0) @Max(1_000_000_000) monthlyGrant: number;
  @IsIn(['block', 'allow_overage']) onExhausted: 'block' | 'allow_overage';
  @IsObject() costs: Record<string, number>;
}

class WebhooksDto {
  @IsBoolean() enabled: boolean;
  @IsInt() @Min(0) @Max(100) maxEndpoints: number;
}

class BulkDto {
  @IsInt() @Min(1) @Max(5000) maxRecordsPerRequest: number;
  @IsInt() @Min(1) @Max(10) concurrentJobs: number;
}

class AlertsDto {
  @IsBoolean() enabled: boolean;
  @IsInt() @Min(1) @Max(100) quotaPct: number;
  @IsInt() @Min(1) @Max(100) creditPct: number;
  @IsInt() @Min(2) @Max(100) errorSpikeFactor: number;
  @IsInt() @Min(1) @Max(90) expiryWarnDays: number;
  @IsInt() @Min(1) @Max(3650) staleWarnDays: number;
  @IsInt() @Min(0) @Max(3650) staleDisableDays: number;
}

export class ApiPolicyDto {
  @IsBoolean() enabled: boolean;
  @IsObject() modules: Record<string, string[]>;
  @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) approvalRequired: string[];
  @IsBoolean() piiAllowed: boolean;
  @IsInt() @Min(0) @Max(1000) maxKeys: number;
  @IsOptional() @IsInt() @Min(1) @Max(3650) maxKeyLifetimeDays: number | null;
  @IsBoolean() requireIpAllowlist: boolean;
  @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) orgIpAllowlist: string[];
  @ValidateNested() @Type(() => RateLimitDto) rateLimit: RateLimitDto;
  @IsInt() @Min(1) @Max(100_000) keyRateCeiling: number;
  @ValidateNested() @Type(() => CreditsDto) credits: CreditsDto;
  /** Optional so policies saved before webhooks existed still validate; missing = default. */
  @IsOptional() @ValidateNested() @Type(() => WebhooksDto) webhooks?: WebhooksDto;
  @IsOptional() @ValidateNested() @Type(() => BulkDto) bulk?: BulkDto;
  @IsOptional() @ValidateNested() @Type(() => AlertsDto) alerts?: AlertsDto;
}

export class PlatformApiSettingsDto extends ApiPolicyDto {
  @IsBoolean() killSwitch: boolean;
  @IsInt() @Min(7) @Max(3650) logRetentionDays: number;
}

/** Semantic checks class-validator can't express. Throws 400 POLICY_INVALID. */
export function assertPolicyShape(p: ApiPolicyDto) {
  const problems: string[] = [];
  for (const [mod, methods] of Object.entries(p.modules)) {
    if (!(mod in MODULES)) problems.push(`unknown module "${mod}"`);
    if (!Array.isArray(methods) || methods.some((m) => !(HTTP_METHODS as readonly string[]).includes(m))) problems.push(`bad methods for "${mod}"`);
  }
  for (const perm of p.approvalRequired) if (!isPermission(perm)) problems.push(`unknown permission "${perm}"`);
  for (const cidr of p.orgIpAllowlist) if (!isValidCidr(cidr)) problems.push(`bad CIDR "${cidr}"`);
  for (const [opId, cost] of Object.entries(p.credits.costs)) {
    if (!OPERATION_BY_ID.has(opId)) problems.push(`unknown operation "${opId}" in credit costs`);
    if (!Number.isInteger(cost) || cost < 0 || cost > 10_000) problems.push(`bad cost for "${opId}"`);
  }
  if (p.rateLimit.burst > p.rateLimit.perMinute * 10) problems.push('burst may be at most 10× perMinute');
  if (p.alerts && p.alerts.staleDisableDays > 0 && p.alerts.staleDisableDays <= p.alerts.staleWarnDays) problems.push('stale keys must be warned about before they are disabled');
  if (problems.length) throw new AppError(400, 'POLICY_INVALID', 'The policy is invalid', problems);
}

/** Stored JSON → full policy; fields added in later releases take their defaults. */
export function normalizePolicy<T extends ApiPolicy>(stored: unknown, defaults: T): T {
  const s = (stored ?? {}) as Partial<T>;
  return {
    ...defaults,
    ...s,
    modules: { ...(s.modules ?? defaults.modules) },
    rateLimit: { ...defaults.rateLimit, ...(s.rateLimit ?? {}) },
    credits: { ...defaults.credits, ...(s.credits ?? {}), costs: { ...(s.credits?.costs ?? defaults.credits.costs) } },
    webhooks: { ...defaults.webhooks, ...(s.webhooks ?? {}) },
    bulk: { ...defaults.bulk, ...(s.bulk ?? {}) },
    alerts: { ...defaults.alerts, ...(s.alerts ?? {}) },
  };
}

// ── Effective permissions: key ∩ policy ─────────────────────────────────────

/** Does the policy allow every method this permission's operations use? */
export const policyAllows = (policy: ApiPolicy, perm: PermissionId) =>
  methodsOf(perm).every((m) => policy.modules[PERMISSIONS[perm].module]?.includes(m) ?? false);

export function effectivePermissions(scopes: string[], policy: ApiPolicy): PermissionId[] {
  return scopes.filter(isPermission).filter((p) => policyAllows(policy, p));
}

/** Key permissions the policy currently blocks (shown as "restricted by platform policy"). */
export const clippedPermissions = (scopes: string[], policy: ApiPolicy) => scopes.filter((p) => !isPermission(p) || !policyAllows(policy, p));

export const costOf = (policy: ApiPolicy, opId: string) => policy.credits.costs[opId] ?? OPERATION_BY_ID.get(opId)?.cost ?? 1;

// ── Loading + cache ─────────────────────────────────────────────────────────

const TTL_MS = 30_000;
const CHANNEL = 'api:invalidate';

export interface TenantPolicy {
  policy: ApiPolicy;
  /** True when the org has no override and runs on the platform default. */
  inherited: boolean;
  version: number | null;
}

/**
 * Policies cached for 30 s per process; changes are broadcast on Redis pub/sub so every
 * instance drops its copy at once (the TTL is only the backstop). The same channel carries
 * key-cache invalidations (`key:<keyId>`), see onInvalidate().
 */
@Injectable()
export class PolicyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PolicyService.name);
  private platformCache?: { value: PlatformApiSettings; at: number };
  private readonly tenantCache = new Map<string, { value: TenantPolicy; at: number }>();
  private readonly listeners: Array<(msg: string) => void> = [];
  private sub?: Redis;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async onModuleInit() {
    this.sub = new Redis({ ...redisOptions(), maxRetriesPerRequest: null, lazyConnect: true });
    this.sub.on('error', (err) => this.logger.warn(`pub/sub: ${err.message}`));
    this.sub.on('message', (_ch, msg) => this.drop(msg));
    await this.sub.connect().then(() => this.sub!.subscribe(CHANNEL)).catch((err) => this.logger.warn(`pub/sub unavailable, TTL only: ${err.message}`));
  }

  async onModuleDestroy() {
    await this.sub?.quit().catch(() => undefined);
  }

  onInvalidate(fn: (msg: string) => void) {
    this.listeners.push(fn);
  }

  /** `policy:*`, `policy:<tenantId>` or `key:<keyId>`. Local drop happens even when Redis is down. */
  async invalidate(msg: string) {
    this.drop(msg);
    await this.redis.client.publish(CHANNEL, msg).catch(() => undefined);
  }

  private drop(msg: string) {
    if (msg === 'policy:*') {
      this.platformCache = undefined;
      this.tenantCache.clear();
    } else if (msg.startsWith('policy:')) {
      this.tenantCache.delete(msg.slice(7));
    }
    for (const fn of this.listeners) fn(msg);
  }

  async platform(): Promise<PlatformApiSettings> {
    if (this.platformCache && Date.now() - this.platformCache.at < TTL_MS) return this.platformCache.value;
    const row = await runAsSystem(() =>
      this.prisma.apiPolicyVersion.findFirst({ where: { tenantId: null }, orderBy: { version: 'desc' } }),
    );
    const value = normalizePolicy(row?.policy, DEFAULT_PLATFORM);
    this.platformCache = { value, at: Date.now() };
    return value;
  }

  async forTenant(tenantId: string): Promise<TenantPolicy> {
    const hit = this.tenantCache.get(tenantId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const [platform, row] = await Promise.all([
      this.platform(),
      runAsSystem(() => this.prisma.apiPolicyVersion.findFirst({ where: { tenantId }, orderBy: { version: 'desc' } })),
    ]);
    const { killSwitch: _k, logRetentionDays: _l, ...platformPolicy } = platform;
    const value: TenantPolicy =
      row?.policy != null
        ? { policy: normalizePolicy(row.policy, DEFAULT_POLICY), inherited: false, version: row.version }
        : { policy: platformPolicy, inherited: true, version: row?.version ?? null };
    this.tenantCache.set(tenantId, { value, at: Date.now() });
    return value;
  }
}
