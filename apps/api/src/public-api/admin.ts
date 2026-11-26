import { Body, Controller, Delete, Get, Injectable, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiKey, Prisma } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { AuditableActionService } from '../audit/audit.service';
import { actorOf, AuthUser, CurrentUser, Roles } from '../auth/auth.types';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { runAsSystem } from '../common/rls';
import { assertPepperConfigured, generateKey, isValidCidr, KeyEnvironment } from './keys';
import { parseSigningKey, rawSigningKey } from './signing';
import { LimiterService, utcMonth } from './limiter';
import {
  ApiPolicy,
  ApiPolicyDto,
  assertPolicyShape,
  clippedPermissions,
  DEFAULT_PLATFORM,
  DEFAULT_POLICY,
  effectivePermissions,
  normalizePolicy,
  PlatformApiSettingsDto,
  PolicyService,
  policyAllows,
} from './policy';
import { CURRENT_API_VERSION, EVENTS, isPermission, methodsOf, MODULES, OPERATIONS, PermissionId, PERMISSIONS } from './registry';
import { buildOpenApi } from './openapi';

export { CURRENT_API_VERSION } from './registry';
const MAX_ROTATION_OVERLAP_HOURS = 168;

// ── DTOs ────────────────────────────────────────────────────────────────────

class KeyFieldsDto {
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsString() @MaxLength(200) purpose?: string;
  @IsOptional() @IsString() @MaxLength(120) integratorName?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) siteIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) ipAllowlist?: string[];
  @IsOptional() @IsInt() @Min(1) @Max(100_000) rateLimitPerMin?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000_000) creditCap?: number | null;
  @IsOptional() @IsBoolean() piiAccess?: boolean;
  @IsOptional() @IsISO8601({ strict: true }) expiresAt?: string | null;
  /** Ed25519 public key (base64 of 32 bytes, or PEM) for optional request signing; null removes it. */
  @IsOptional() @IsString() @MaxLength(400) signingPublicKey?: string | null;
  @IsOptional() @IsBoolean() requireSignature?: boolean;
}

export class CreateApiKeyDto extends KeyFieldsDto {
  @IsString() @MinLength(2) @MaxLength(80) name: string;
  @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) scopes: string[];
}

export class UpdateApiKeyDto extends KeyFieldsDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) scopes?: string[];
}

class RotateDto {
  @IsOptional() @IsInt() @Min(0) @Max(MAX_ROTATION_OVERLAP_HOURS) overlapHours?: number;
}

class LogQuery {
  @IsOptional() @IsString() tenantId?: string;
  @IsOptional() @IsString() apiKeyId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(100) @Max(599) status?: number;
  @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean() errorsOnly?: boolean;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

class UsageQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(31) days?: number;
}

class PolicyWriteDto {
  @ValidateNested() @Type(() => ApiPolicyDto) policy: ApiPolicyDto;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

class SettingsWriteDto {
  @ValidateNested() @Type(() => PlatformApiSettingsDto) settings: PlatformApiSettingsDto;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

class RollbackDto {
  @IsInt() @Min(1) version: number;
}

class KeyListQuery {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() tenantId?: string;
}

class TopupDto {
  @IsInt() @Min(-1_000_000_000) @Max(1_000_000_000) amount: number;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

// ── Service ─────────────────────────────────────────────────────────────────

/** A key as admins see it: never the hash. */
function presentKey(k: ApiKey, policy: ApiPolicy) {
  const { secretHash: _s, hashAlgo: _h, pepperVersion: _p, ...rest } = k;
  return {
    ...rest,
    prefix: `ivk_${k.environment}_${k.keyId}_`,
    effectivePermissions: effectivePermissions(k.scopes, policy),
    restrictedByPolicy: clippedPermissions(k.scopes, policy),
    expired: !!k.expiresAt && k.expiresAt.getTime() <= Date.now(),
  };
}

@Injectable()
export class ApiAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditableActionService,
    private readonly policies: PolicyService,
    private readonly limiter: LimiterService,
  ) {}

  // ── Org admin ────────────────────────────────────────────────────────────

  async catalog(tenantId: string) {
    const { policy, inherited } = await this.policies.forTenant(tenantId);
    return {
      apiVersion: CURRENT_API_VERSION,
      modules: Object.entries(MODULES).map(([id, label]) => ({ id, label, methods: policy.modules[id as keyof typeof MODULES] ?? [] })),
      permissions: Object.entries(PERMISSIONS).map(([id, p]) => ({
        id,
        module: p.module,
        label: p.label,
        methods: methodsOf(id as PermissionId),
        allowed: policyAllows(policy, id as PermissionId),
        requiresApproval: policy.approvalRequired.includes(id as PermissionId),
      })),
      operations: OPERATIONS.map(({ id, method, path, permission, summary }) => ({ id, method, path, permission, summary })),
      policy: {
        enabled: policy.enabled,
        inherited,
        piiAllowed: policy.piiAllowed,
        maxKeys: policy.maxKeys,
        maxKeyLifetimeDays: policy.maxKeyLifetimeDays,
        requireIpAllowlist: policy.requireIpAllowlist,
        keyRateCeiling: policy.keyRateCeiling,
        rateLimit: policy.rateLimit,
        credits: { enabled: policy.credits.enabled, monthlyGrant: policy.credits.monthlyGrant, onExhausted: policy.credits.onExhausted },
      },
    };
  }

  async list(user: AuthUser) {
    const [{ policy }, keys] = await Promise.all([
      this.policies.forTenant(user.tenantId),
      this.prisma.apiKey.findMany({ where: { tenantId: user.tenantId }, orderBy: { createdAt: 'desc' } }),
    ]);
    return keys.map((k) => presentKey(k, policy));
  }

  private async get(tenantId: string, id: string) {
    const key = await this.prisma.apiKey.findFirst({ where: { id, tenantId } });
    if (!key) throw new AppError(404, 'API_KEY_NOT_FOUND', 'API key not found');
    return key;
  }

  /** Everything an org admin may set is checked against the platform ceiling here, not just in the UI. */
  private async validate(tenantId: string, policy: ApiPolicy, dto: KeyFieldsDto & { scopes?: string[] }, current?: ApiKey) {
    const problems: string[] = [];
    if (dto.scopes) {
      for (const s of dto.scopes) {
        if (!isPermission(s)) problems.push(`unknown permission "${s}"`);
        else if (!policyAllows(policy, s)) problems.push(`"${s}" isn't allowed for your organisation`);
      }
    }
    for (const cidr of dto.ipAllowlist ?? []) if (!isValidCidr(cidr)) problems.push(`"${cidr}" is not an IP address or CIDR range`);
    const ipList = dto.ipAllowlist ?? current?.ipAllowlist ?? [];
    if (policy.requireIpAllowlist && !ipList.length) problems.push('your organisation requires an IP allowlist on every key');
    if (dto.rateLimitPerMin && dto.rateLimitPerMin > policy.keyRateCeiling) problems.push(`rate limit may be at most ${policy.keyRateCeiling}/min`);
    if (dto.piiAccess && !policy.piiAllowed) problems.push('PII access is not allowed for your organisation');
    if (dto.signingPublicKey && !parseSigningKey(dto.signingPublicKey)) problems.push('the signing key must be an Ed25519 public key (base64 of 32 bytes, or PEM)');
    const signingKey = dto.signingPublicKey === undefined ? current?.signingPublicKey : dto.signingPublicKey;
    if ((dto.requireSignature ?? current?.requireSignature) && !signingKey) problems.push('requiring signatures needs a signing key');
    if (dto.siteIds?.length) {
      const found = await this.prisma.site.count({ where: { tenantId, id: { in: dto.siteIds } } });
      if (found !== new Set(dto.siteIds).size) problems.push('one or more sites do not exist');
    }
    if (dto.expiresAt !== undefined) {
      const max = policy.maxKeyLifetimeDays ? Date.now() + policy.maxKeyLifetimeDays * 86_400_000 : Infinity;
      if (dto.expiresAt === null && policy.maxKeyLifetimeDays) problems.push(`keys must expire within ${policy.maxKeyLifetimeDays} days`);
      if (dto.expiresAt) {
        const t = Date.parse(dto.expiresAt);
        if (t <= Date.now()) problems.push('expiry must be in the future');
        if (t > max) problems.push(`keys must expire within ${policy.maxKeyLifetimeDays} days`);
      }
    }
    if (problems.length) throw new AppError(400, 'API_KEY_INVALID', problems[0], problems);
  }

  private defaultExpiry(policy: ApiPolicy) {
    return policy.maxKeyLifetimeDays ? new Date(Date.now() + policy.maxKeyLifetimeDays * 86_400_000) : null;
  }

  private assertTenantAdmin(user: AuthUser) {
    assertPepperConfigured();
    // Platform staff acting through X-Tenant-Id must not leave keys behind in a customer's org.
    if (user.isSuperAdmin) throw new AppError(403, 'PLATFORM_CANNOT_MINT', 'Platform administrators cannot create or change tenant API keys');
  }

  async create(user: AuthUser, dto: CreateApiKeyDto) {
    this.assertTenantAdmin(user);
    const { policy } = await this.policies.forTenant(user.tenantId);
    if (!policy.enabled) throw new AppError(403, 'API_DISABLED', 'API access is not enabled for your organisation; contact Iverto');
    await this.validate(user.tenantId, policy, dto);
    const live = await this.prisma.apiKey.count({ where: { tenantId: user.tenantId, status: { not: 'REVOKED' } } });
    if (live >= policy.maxKeys) throw new AppError(409, 'API_KEY_LIMIT', `Your organisation may have at most ${policy.maxKeys} keys`);
    const scopes = [...new Set(dto.scopes)];
    const needsApproval = scopes.some((s) => policy.approvalRequired.includes(s as PermissionId));
    const generated = generateKey('live');
    const key = await this.audit.run<ApiKey>({
      action: 'API_KEY_CREATED',
      targetType: 'ApiKey',
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: (k) => ({ name: k.name, scopes: k.scopes, siteIds: k.siteIds, status: k.status, keyId: k.keyId }),
      run: (tx) =>
        tx.apiKey.create({
          data: {
            tenantId: user.tenantId,
            keyId: generated.keyId,
            secretHash: generated.secretHash,
            pepperVersion: generated.pepperVersion,
            last4: generated.last4,
            name: dto.name,
            description: dto.description,
            purpose: dto.purpose,
            integratorName: dto.integratorName,
            environment: 'live',
            apiVersion: CURRENT_API_VERSION,
            scopes,
            siteIds: dto.siteIds ?? [],
            ipAllowlist: dto.ipAllowlist ?? [],
            rateLimitPerMin: dto.rateLimitPerMin ?? null,
            creditCap: dto.creditCap ?? null,
            piiAccess: dto.piiAccess ?? false,
            status: needsApproval ? 'PENDING_APPROVAL' : 'ACTIVE',
            expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : this.defaultExpiry(policy),
            signingPublicKey: dto.signingPublicKey ? rawSigningKey(parseSigningKey(dto.signingPublicKey)!) : null,
            requireSignature: dto.requireSignature ?? false,
            createdBy: user.sub,
          },
        }),
    });
    // The only time the plaintext exists outside the caller's hands.
    return { key: generated.plaintext, apiKey: presentKey(key, policy) };
  }

  async update(user: AuthUser, id: string, dto: UpdateApiKeyDto) {
    this.assertTenantAdmin(user);
    const current = await this.get(user.tenantId, id);
    if (current.status === 'REVOKED') throw new AppError(409, 'API_KEY_REVOKED', 'A revoked key cannot be changed');
    const { policy } = await this.policies.forTenant(user.tenantId);
    await this.validate(user.tenantId, policy, dto, current);
    const scopes = dto.scopes ? [...new Set(dto.scopes)] : undefined;
    // Gaining a permission that needs approval sends the key back to the platform queue.
    const gained = (scopes ?? []).filter((s) => !current.scopes.includes(s));
    const needsApproval = gained.some((s) => policy.approvalRequired.includes(s as PermissionId));
    const updated = await this.audit.run<ApiKey>({
      action: 'API_KEY_UPDATED',
      targetType: 'ApiKey',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: () => ({ ...dto, needsApproval }),
      run: (tx) =>
        tx.apiKey.update({
          where: { id },
          data: {
            name: dto.name,
            description: dto.description,
            purpose: dto.purpose,
            integratorName: dto.integratorName,
            scopes,
            siteIds: dto.siteIds,
            ipAllowlist: dto.ipAllowlist,
            rateLimitPerMin: dto.rateLimitPerMin,
            creditCap: dto.creditCap,
            piiAccess: dto.piiAccess,
            expiresAt: dto.expiresAt === undefined ? undefined : dto.expiresAt ? new Date(dto.expiresAt) : null,
            signingPublicKey: dto.signingPublicKey === undefined ? undefined : dto.signingPublicKey ? rawSigningKey(parseSigningKey(dto.signingPublicKey)!) : null,
            requireSignature: dto.signingPublicKey === null ? false : dto.requireSignature,
            ...(needsApproval && { status: 'PENDING_APPROVAL', approvedBy: null, approvedAt: null }),
          },
        }),
    });
    await this.policies.invalidate(`key:${current.keyId}`);
    return presentKey(updated, policy);
  }

  /** A new secret with the same settings; the old key keeps working for `overlapHours` (default 24). */
  async rotate(user: AuthUser, id: string, dto: RotateDto) {
    this.assertTenantAdmin(user);
    const old = await this.get(user.tenantId, id);
    if (old.status !== 'ACTIVE') throw new AppError(409, 'API_KEY_NOT_ACTIVE', 'Only an active key can be rotated');
    const { policy } = await this.policies.forTenant(user.tenantId);
    const overlapUntil = new Date(Date.now() + (dto.overlapHours ?? 24) * 3_600_000);
    const generated = generateKey(old.environment as KeyEnvironment);
    const created = await this.audit.run<ApiKey>({
      action: 'API_KEY_ROTATED',
      targetType: 'ApiKey',
      targetId: id,
      actor: actorOf(user),
      tenantId: user.tenantId,
      payloadFrom: (k) => ({ newKeyId: k.id, oldExpiresAt: overlapUntil.toISOString() }),
      run: async (tx) => {
        await tx.apiKey.update({
          where: { id },
          data: { expiresAt: old.expiresAt && old.expiresAt < overlapUntil ? old.expiresAt : overlapUntil },
        });
        const { id: _i, keyId: _k, secretHash: _s, last4: _l, pepperVersion: _p, createdAt: _c, updatedAt: _u, lastUsedAt: _lu, lastUsedIp: _li, ...copy } = old;
        return tx.apiKey.create({
          data: {
            ...copy,
            keyId: generated.keyId,
            secretHash: generated.secretHash,
            pepperVersion: generated.pepperVersion,
            last4: generated.last4,
            rotatedFromId: old.id,
            apiVersion: old.apiVersion,
            expiresAt: this.defaultExpiry(policy),
            createdBy: user.sub,
          },
        });
      },
    });
    await this.policies.invalidate(`key:${old.keyId}`);
    return { key: generated.plaintext, apiKey: presentKey(created, policy) };
  }

  async setStatus(actor: AuthUser, tenantId: string, id: string, action: 'revoke' | 'enable' | 'approve' | 'reject') {
    const key = await this.get(tenantId, id);
    const transitions = {
      revoke: { from: ['ACTIVE', 'DISABLED', 'PENDING_APPROVAL'], to: 'REVOKED', audit: 'API_KEY_REVOKED' },
      reject: { from: ['PENDING_APPROVAL'], to: 'REVOKED', audit: 'API_KEY_REJECTED' },
      enable: { from: ['DISABLED'], to: 'ACTIVE', audit: 'API_KEY_ENABLED' },
      approve: { from: ['PENDING_APPROVAL'], to: 'ACTIVE', audit: 'API_KEY_APPROVED' },
    }[action];
    if (!transitions.from.includes(key.status)) throw new AppError(409, 'API_KEY_STATE', `A ${key.status.toLowerCase()} key cannot be ${action}d`);
    const now = new Date();
    const updated = await this.audit.run<ApiKey>({
      action: transitions.audit,
      targetType: 'ApiKey',
      targetId: id,
      actor: actorOf(actor),
      tenantId,
      run: (tx) =>
        tx.apiKey.update({
          where: { id },
          data: {
            status: transitions.to,
            ...(transitions.to === 'REVOKED' && { revokedAt: now, revokedBy: actor.sub }),
            ...(action === 'approve' && { approvedAt: now, approvedBy: actor.sub }),
            ...(action === 'enable' && { disabledReason: null }),
          },
        }),
    });
    await this.policies.invalidate(`key:${key.keyId}`);
    const { policy } = await this.policies.forTenant(tenantId);
    return presentKey(updated, policy);
  }

  async logs(q: LogQuery, tenantId?: string) {
    const limit = q.limit ?? 50;
    const where: Prisma.ApiRequestLogWhereInput = {
      ...((tenantId ?? q.tenantId) && { tenantId: tenantId ?? q.tenantId }),
      ...(q.apiKeyId && { apiKeyId: q.apiKeyId }),
      ...(q.status && { status: q.status }),
      ...(q.errorsOnly && { status: { gte: 400 } }),
      ...((q.from || q.to) && { createdAt: { ...(q.from && { gte: new Date(q.from) }), ...(q.to && { lt: new Date(q.to) }) } }),
    };
    const rows = await this.prisma.apiRequestLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(q.cursor && { cursor: { id: q.cursor }, skip: 1 }),
    });
    return { data: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].id : null };
  }

  async usage(tenantId: string, days = 7) {
    const since = new Date(Date.now() - days * 86_400_000);
    const [byKey, daily, { policy }] = await Promise.all([
      this.prisma.apiRequestLog.groupBy({ by: ['apiKeyId', 'status'], where: { tenantId, createdAt: { gte: since } }, _count: { _all: true }, _sum: { credits: true } }),
      this.prisma.$transaction((tx) =>
        tx.$queryRaw<Array<{ day: Date; requests: bigint; errors: bigint; credits: bigint | null }>>`
          SELECT date_trunc('day', created_at) AS day, count(*) AS requests,
                 count(*) FILTER (WHERE status >= 400) AS errors, sum(credits) AS credits
          FROM api_request_logs WHERE tenant_id = ${tenantId} AND created_at >= ${since}
          GROUP BY 1 ORDER BY 1`,
      ),
      this.policies.forTenant(tenantId),
    ]);
    const keys = new Map<string, { apiKeyId: string | null; requests: number; errors: number; rateLimited: number; credits: number }>();
    for (const g of byKey) {
      const k = keys.get(g.apiKeyId ?? '') ?? { apiKeyId: g.apiKeyId, requests: 0, errors: 0, rateLimited: 0, credits: 0 };
      k.requests += g._count._all;
      if (g.status >= 400) k.errors += g._count._all;
      if (g.status === 429) k.rateLimited += g._count._all;
      k.credits += g._sum.credits ?? 0;
      keys.set(g.apiKeyId ?? '', k);
    }
    const month = utcMonth();
    return {
      days,
      byKey: [...keys.values()],
      daily: daily.map((d) => ({ day: d.day.toISOString().slice(0, 10), requests: Number(d.requests), errors: Number(d.errors), credits: Number(d.credits ?? 0) })),
      credits: policy.credits.enabled
        ? { enabled: true, month, allowance: await this.limiter.allowance(tenantId, policy.credits.monthlyGrant, month), spent: await this.limiter.spent(tenantId, month) }
        : { enabled: false },
    };
  }

  // ── Platform ─────────────────────────────────────────────────────────────

  private async nextVersion(tenantId: string | null, policy: object | null, note: string | undefined, actor: AuthUser) {
    return runAsSystem(() =>
      this.prisma.$transaction(async (tx) => {
        const last = await tx.apiPolicyVersion.findFirst({ where: { tenantId }, orderBy: { version: 'desc' }, select: { version: true } });
        const row = await tx.apiPolicyVersion.create({
          data: { tenantId, version: (last?.version ?? 0) + 1, policy: (policy ?? Prisma.DbNull) as Prisma.InputJsonValue, note, createdBy: actor.sub },
        });
        await tx.auditLog.create({
          data: {
            tenantId,
            actorUserId: actor.sub,
            actorType: 'user',
            action: tenantId ? 'API_POLICY_UPDATED' : 'API_PLATFORM_SETTINGS_UPDATED',
            targetType: 'ApiPolicyVersion',
            targetId: row.id,
            payload: { version: row.version, note: note ?? null, policy: (policy ?? null) as Prisma.InputJsonValue },
          },
        });
        return row;
      }),
    );
  }

  async settings() {
    return this.policies.platform();
  }

  async saveSettings(actor: AuthUser, dto: SettingsWriteDto) {
    assertPolicyShape(dto.settings);
    const settings = normalizePolicy(dto.settings, DEFAULT_PLATFORM);
    const row = await this.nextVersion(null, settings, dto.note, actor);
    await this.policies.invalidate('policy:*');
    return { version: row.version, settings };
  }

  private async assertTenant(tenantId: string) {
    const t = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true } });
    if (!t) throw new AppError(404, 'TENANT_NOT_FOUND', 'Tenant not found');
    return t;
  }

  /** Keys the policy would restrict, so a superadmin sees the blast radius before saving. */
  async impact(tenantId: string, policy: ApiPolicy) {
    const keys = await this.prisma.apiKey.findMany({ where: { tenantId, status: { not: 'REVOKED' } } });
    return keys
      .map((k) => ({ id: k.id, name: k.name, restricted: clippedPermissions(k.scopes, policy) }))
      .filter((k) => k.restricted.length || !policy.enabled);
  }

  async tenantPolicy(tenantId: string) {
    await this.assertTenant(tenantId);
    const [current, versions, keyCounts] = await Promise.all([
      this.policies.forTenant(tenantId),
      this.prisma.apiPolicyVersion.findMany({ where: { tenantId }, orderBy: { version: 'desc' }, take: 50 }),
      this.prisma.apiKey.groupBy({ by: ['status'], where: { tenantId }, _count: { _all: true } }),
    ]);
    return { ...current, versions, keys: Object.fromEntries(keyCounts.map((k) => [k.status, k._count._all])) };
  }

  async previewTenantPolicy(tenantId: string, dto: PolicyWriteDto) {
    await this.assertTenant(tenantId);
    assertPolicyShape(dto.policy);
    return { affectedKeys: await this.impact(tenantId, normalizePolicy(dto.policy, DEFAULT_POLICY)) };
  }

  async saveTenantPolicy(actor: AuthUser, tenantId: string, dto: PolicyWriteDto | null) {
    await this.assertTenant(tenantId);
    let policy: ApiPolicy | null = null;
    if (dto) {
      assertPolicyShape(dto.policy);
      policy = normalizePolicy(dto.policy, DEFAULT_POLICY);
    }
    const row = await this.nextVersion(tenantId, policy, dto?.note ?? (dto ? undefined : 'Reverted to the platform default'), actor);
    await this.policies.invalidate(`policy:${tenantId}`);
    const effective = await this.policies.forTenant(tenantId);
    return { version: row.version, ...effective, affectedKeys: await this.impact(tenantId, effective.policy) };
  }

  async rollback(actor: AuthUser, tenantId: string, version: number) {
    const old = await this.prisma.apiPolicyVersion.findFirst({ where: { tenantId, version } });
    if (!old) throw new AppError(404, 'VERSION_NOT_FOUND', 'Policy version not found');
    const row = await this.nextVersion(tenantId, old.policy as object | null, `Rolled back to version ${version}`, actor);
    await this.policies.invalidate(`policy:${tenantId}`);
    return { version: row.version, ...(await this.policies.forTenant(tenantId)) };
  }

  async allKeys(q: KeyListQuery) {
    const keys = await this.prisma.apiKey.findMany({
      where: { ...(q.status && { status: q.status }), ...(q.tenantId && { tenantId: q.tenantId }) },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const tenants = await this.prisma.tenant.findMany({ where: { id: { in: [...new Set(keys.map((k) => k.tenantId))] } }, select: { id: true, name: true } });
    const names = new Map(tenants.map((t) => [t.id, t.name]));
    const policies = new Map<string, ApiPolicy>();
    for (const id of names.keys()) policies.set(id, (await this.policies.forTenant(id)).policy);
    return keys.map((k) => ({ ...presentKey(k, policies.get(k.tenantId) ?? DEFAULT_POLICY), tenantName: names.get(k.tenantId) ?? null }));
  }

  async keyTenant(id: string) {
    const key = await this.prisma.apiKey.findUnique({ where: { id }, select: { tenantId: true } });
    if (!key) throw new AppError(404, 'API_KEY_NOT_FOUND', 'API key not found');
    return key.tenantId;
  }

  async revokeAll(actor: AuthUser, tenantId: string) {
    await this.assertTenant(tenantId);
    const res = await this.audit.run<{ count: number }>({
      action: 'API_KEYS_REVOKED_ALL',
      targetType: 'Tenant',
      targetId: tenantId,
      actor: actorOf(actor),
      tenantId,
      payloadFrom: (r) => ({ count: r.count }),
      run: (tx) =>
        tx.apiKey.updateMany({ where: { tenantId, status: { not: 'REVOKED' } }, data: { status: 'REVOKED', revokedAt: new Date(), revokedBy: actor.sub } }),
    });
    await this.policies.invalidate('key:*');
    return { revoked: res.count };
  }

  async credits(tenantId: string) {
    await this.assertTenant(tenantId);
    const { policy } = await this.policies.forTenant(tenantId);
    const month = utcMonth();
    const [ledger, allowance, spent] = await Promise.all([
      this.prisma.apiCreditLedger.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 100 }),
      this.limiter.allowance(tenantId, policy.credits.monthlyGrant, month),
      this.limiter.spent(tenantId, month),
    ]);
    return { enabled: policy.credits.enabled, month, monthlyGrant: policy.credits.monthlyGrant, allowance, spent, ledger };
  }

  async topup(actor: AuthUser, tenantId: string, dto: TopupDto) {
    await this.assertTenant(tenantId);
    const month = utcMonth();
    await this.audit.run({
      action: 'API_CREDITS_ADJUSTED',
      targetType: 'Tenant',
      targetId: tenantId,
      actor: actorOf(actor),
      tenantId,
      payloadFrom: () => ({ amount: dto.amount, month, note: dto.note ?? null }),
      run: (tx) =>
        tx.apiCreditLedger.create({
          data: { tenantId, month, delta: dto.amount, reason: dto.amount >= 0 ? 'TOPUP' : 'ADJUSTMENT', note: dto.note, createdBy: actor.sub },
        }),
    });
    await this.limiter.forgetAllowance(tenantId, month);
    return this.credits(tenantId);
  }

  /** Per-tenant API activity for the platform overview. */
  async overview() {
    const since = new Date(Date.now() - 86_400_000);
    const [requests, keys] = await Promise.all([
      this.prisma.apiRequestLog.groupBy({ by: ['tenantId'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
      this.prisma.apiKey.groupBy({ by: ['tenantId', 'status'], _count: { _all: true } }),
    ]);
    const rejected = await this.prisma.apiRequestLog.count({ where: { createdAt: { gte: since }, tenantId: null } });
    const out = new Map<string, { tenantId: string; requests24h: number; keys: Record<string, number> }>();
    const row = (id: string) => out.get(id) ?? out.set(id, { tenantId: id, requests24h: 0, keys: {} }).get(id)!;
    for (const r of requests) if (r.tenantId) row(r.tenantId).requests24h = r._count._all;
    for (const k of keys) row(k.tenantId).keys[k.status] = k._count._all;
    const pending = keys.filter((k) => k.status === 'PENDING_APPROVAL').reduce((s, k) => s + k._count._all, 0);
    return { tenants: [...out.values()], pendingApprovals: pending, rejectedRequests24h: rejected, settings: await this.policies.platform() };
  }
}

// ── Controllers ─────────────────────────────────────────────────────────────

@ApiTags('api-keys')
@Controller('api-keys')
@Roles('ADMIN')
export class OrgApiKeysController {
  constructor(private readonly admin: ApiAdminService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.admin.list(user);
  }

  @Get('catalog')
  catalog(@CurrentUser() user: AuthUser) {
    return this.admin.catalog(user.tenantId);
  }

  @Get('logs')
  logs(@CurrentUser() user: AuthUser, @Query() q: LogQuery) {
    return this.admin.logs(q, user.tenantId);
  }

  @Get('usage')
  usage(@CurrentUser() user: AuthUser, @Query() q: UsageQuery) {
    return this.admin.usage(user.tenantId, q.days);
  }

  /** The OpenAPI document behind the in-app API docs (org admins; superadmins use /platform/api/openapi.json). */
  @Get('openapi.json')
  openapi() {
    return buildOpenApi();
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateApiKeyDto) {
    return this.admin.create(user, dto);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateApiKeyDto) {
    return this.admin.update(user, id, dto);
  }

  @Post(':id/rotate')
  rotate(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RotateDto) {
    return this.admin.rotate(user, id, dto);
  }

  @Post(':id/revoke')
  revoke(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.admin.setStatus(user, user.tenantId, id, 'revoke');
  }

  @Post(':id/enable')
  enable(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.admin.setStatus(user, user.tenantId, id, 'enable');
  }
}

@ApiTags('platform')
@Controller('platform/api')
@Roles('PLATFORM_ADMIN')
export class PlatformApiController {
  constructor(private readonly admin: ApiAdminService) {}

  @Get('overview')
  overview() {
    return this.admin.overview();
  }

  @Get('openapi.json')
  openapi() {
    return buildOpenApi();
  }

  /** Modules, permissions and operations the policy editor offers. */
  @Get('catalog')
  catalog() {
    return {
      apiVersion: CURRENT_API_VERSION,
      modules: Object.entries(MODULES).map(([id, label]) => ({ id, label })),
      permissions: Object.entries(PERMISSIONS).map(([id, p]) => ({ id, module: p.module, label: p.label, methods: methodsOf(id as PermissionId) })),
      operations: OPERATIONS.map(({ id, method, path, permission, summary, cost }) => ({ id, method, path, permission, summary, cost })),
      events: Object.entries(EVENTS).map(([type, e]) => ({ type, ...e })),
    };
  }

  @Get('settings')
  settings() {
    return this.admin.settings();
  }

  @Put('settings')
  saveSettings(@CurrentUser() user: AuthUser, @Body() dto: SettingsWriteDto) {
    return this.admin.saveSettings(user, dto);
  }

  @Get('tenants/:tenantId/policy')
  tenantPolicy(@Param('tenantId') tenantId: string) {
    return this.admin.tenantPolicy(tenantId);
  }

  @Post('tenants/:tenantId/policy/preview')
  preview(@Param('tenantId') tenantId: string, @Body() dto: PolicyWriteDto) {
    return this.admin.previewTenantPolicy(tenantId, dto);
  }

  @Put('tenants/:tenantId/policy')
  saveTenantPolicy(@CurrentUser() user: AuthUser, @Param('tenantId') tenantId: string, @Body() dto: PolicyWriteDto) {
    return this.admin.saveTenantPolicy(user, tenantId, dto);
  }

  @Delete('tenants/:tenantId/policy')
  inherit(@CurrentUser() user: AuthUser, @Param('tenantId') tenantId: string) {
    return this.admin.saveTenantPolicy(user, tenantId, null);
  }

  @Post('tenants/:tenantId/policy/rollback')
  rollback(@CurrentUser() user: AuthUser, @Param('tenantId') tenantId: string, @Body() dto: RollbackDto) {
    return this.admin.rollback(user, tenantId, dto.version);
  }

  @Post('tenants/:tenantId/revoke-all')
  revokeAll(@CurrentUser() user: AuthUser, @Param('tenantId') tenantId: string) {
    return this.admin.revokeAll(user, tenantId);
  }

  @Get('tenants/:tenantId/credits')
  credits(@Param('tenantId') tenantId: string) {
    return this.admin.credits(tenantId);
  }

  @Post('tenants/:tenantId/credits')
  topup(@CurrentUser() user: AuthUser, @Param('tenantId') tenantId: string, @Body() dto: TopupDto) {
    return this.admin.topup(user, tenantId, dto);
  }

  @Get('tenants/:tenantId/usage')
  usage(@Param('tenantId') tenantId: string, @Query() q: UsageQuery) {
    return this.admin.usage(tenantId, q.days);
  }

  @Get('keys')
  keys(@Query() q: KeyListQuery) {
    return this.admin.allKeys(q);
  }

  @Post('keys/:id/approve')
  async approve(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.admin.setStatus(user, await this.admin.keyTenant(id), id, 'approve');
  }

  @Post('keys/:id/reject')
  async reject(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.admin.setStatus(user, await this.admin.keyTenant(id), id, 'reject');
  }

  @Post('keys/:id/revoke')
  async revoke(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.admin.setStatus(user, await this.admin.keyTenant(id), id, 'revoke');
  }

  @Get('logs')
  logs(@Query() q: LogQuery) {
    return this.admin.logs(q);
  }
}
