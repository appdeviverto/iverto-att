import { SetMetadata } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppError } from './errors';
import { PrismaService } from './prisma.service';
import { runAsSystem } from './rls';

/** Paid modules a platform admin switches on per tenant (Platform → tenant → Modules). */
export const FEATURES = ['hr', 'payroll'] as const;
export type Feature = (typeof FEATURES)[number];
export type Features = Record<Feature, boolean>;

/** tenant.settings.features; a tenant without the key (every tenant before modules existed) has them off. */
export const featuresOf = (settings: unknown): Features => {
  const f = (settings as { features?: Partial<Features> } | null)?.features ?? {};
  return { hr: f.hr === true, payroll: f.payroll === true };
};

export const FEATURE_KEY = 'requiredFeature';
/** The route (or every route of a controller) answers 403 FEATURE_DISABLED unless the tenant has this module. */
export const RequireFeature = (feature: Feature) => SetMetadata(FEATURE_KEY, feature);

export const FEATURE_LABEL: Record<Feature, string> = { hr: 'HR', payroll: 'Payroll' };

const TENANT_TTL_MS = 60_000;

/** Module-level so platform changes (suspend, modules) can drop an entry; other API instances catch up within the TTL. */
const tenantCache = new Map<string, { status: string; features: Features; at: number }>();
export const forgetTenant = (tenantId: string) => tenantCache.delete(tenantId);

/** Tenant status and modules, cached for a minute so a suspension or a module switched off bites within 60 s (§13.1). */
export async function tenantState(prisma: PrismaService, tenantId: string) {
  const hit = tenantCache.get(tenantId);
  if (hit && Date.now() - hit.at < TENANT_TTL_MS) return hit;
  const tenant = await runAsSystem(async () =>
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { status: true, settings: true } }),
  );
  const entry = { status: tenant?.status ?? 'MISSING', features: featuresOf(tenant?.settings), at: Date.now() };
  tenantCache.set(tenantId, entry);
  return entry;
}

/**
 * Merges `patch` into tenants.settings (or into settings[section]) in one UPDATE, so writers
 * never clobber each other's keys: no read-modify-write, no lost update between the org,
 * HR, payroll and module saves. Keys whose value is undefined are left as they are.
 */
export async function mergeTenantSettings(tx: Prisma.TransactionClient, tenantId: string, patch: Record<string, unknown>, section?: string) {
  const json = JSON.stringify(Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
  if (section) {
    await tx.$executeRaw`UPDATE public.tenants SET settings = jsonb_set(settings, ARRAY[${section}]::text[], COALESCE(settings -> ${section}, '{}'::jsonb) || ${json}::jsonb) WHERE id = ${tenantId}`;
  } else {
    await tx.$executeRaw`UPDATE public.tenants SET settings = settings || ${json}::jsonb WHERE id = ${tenantId}`;
  }
  return tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
}

/** For shared routes that reach a module conditionally (e.g. /mobile/approvals?type=expense). Same cache as the guard's @RequireFeature. */
export async function assertFeature(prisma: PrismaService, tenantId: string, feature: Feature) {
  if (!(await tenantState(prisma, tenantId)).features[feature]) {
    throw new AppError(403, 'FEATURE_DISABLED', `${FEATURE_LABEL[feature]} isn't enabled for this organisation`, { feature });
  }
}
