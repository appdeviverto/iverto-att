import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';

export const ROLES = ['ADMIN', 'HR', 'MANAGER', 'EMPLOYEE'] as const;
/**
 * `API_KEY` is never read from a JWT (verify() only accepts ROLES): it marks a public-API key.
 * Every `role === 'ADMIN'` / isHrOrAdmin check treats it as unprivileged, so a service path that
 * doesn't handle keys explicitly fails closed; ScopeService grants it tenant ∩ key sites.
 */
export type Role = (typeof ROLES)[number] | 'PLATFORM_ADMIN' | 'API_KEY';

/** Set on the principal of a public-API request (public-api/api-key.guard.ts). */
export interface ApiKeyPrincipal {
  id: string;
  name: string;
  /** Effective permissions: key ∩ tenant policy. */
  permissions: string[];
  piiAccess: boolean;
}

/** The caller, from verified Supabase JWT claims (app_metadata cannot be self-edited), or an API key. */
export interface AuthUser {
  sub: string;
  email: string;
  /** Empty for platform admins not acting inside a tenant. */
  tenantId: string;
  role: Role;
  employeeId: string | null;
  siteIds: string[];
  isSuperAdmin: boolean;
  mustChangePassword: boolean;
  /** Supabase assurance level: 'aal2' once the session passed a TOTP challenge. */
  aal?: string;
  apiKey?: ApiKeyPrincipal;
}

export interface AuditActor {
  type: 'user' | 'system' | 'device' | 'api_key';
  userId?: string;
  deviceId?: string;
}

/** API keys audit as `api_key` with userId `apikey:<id>` (their `sub`). */
export const actorOf = (user: AuthUser): AuditActor => ({ type: user.apiKey ? 'api_key' : 'user', userId: user.sub });

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ROLES_KEY = 'roles';
/** Omitted = any authenticated tenant user. `PLATFORM_ADMIN` = Iverto staff only. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** Reachable while the account still has to replace its temporary password. */
export const ALLOW_PENDING_PASSWORD = 'allowPendingPassword';
export const AllowPendingPassword = () => SetMetadata(ALLOW_PENDING_PASSWORD, true);

/** Reachable with a password-only (aal1) session: the mobile app and first-login password change. 2FA is web-only. */
export const SKIP_MFA = 'skipMfa';
export const SkipMfa = () => SetMetadata(SKIP_MFA, true);

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);

export const isHrOrAdmin = (user: AuthUser) => user.role === 'ADMIN' || user.role === 'HR';
