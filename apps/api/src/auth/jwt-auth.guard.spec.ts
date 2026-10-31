import { Reflector } from '@nestjs/core';
import { AuthUser, SKIP_MFA } from './auth.types';
import { JwtAuthGuard } from './jwt-auth.guard';

const user = (over: Partial<AuthUser>): AuthUser => ({
  sub: 'u1', email: 'a@b.c', tenantId: 't1', role: 'EMPLOYEE', employeeId: null, siteIds: [], isSuperAdmin: false, mustChangePassword: false, aal: 'aal1', ...over,
});

function run(u: AuthUser, meta: Record<string, unknown> = {}) {
  const reflector = { getAllAndOverride: (key: string) => meta[key] } as unknown as Reflector;
  const guard = new JwtAuthGuard(reflector, {} as never);
  guard.verify = async () => u;
  guard.statusOf = async () => 'ACTIVE';
  const req = { headers: { authorization: 'Bearer x' } };
  const ctx = { getType: () => 'http', getHandler: () => null, getClass: () => null, switchToHttp: () => ({ getRequest: () => req }) };
  return guard.canActivate(ctx as never);
}

describe('JwtAuthGuard 2FA', () => {
  it('refuses a password-only session on web routes', async () => {
    await expect(run(user({}))).rejects.toMatchObject({ response: { code: 'MFA_REQUIRED' } });
  });
  it('lets a TOTP-verified session through', async () => {
    await expect(run(user({ aal: 'aal2' }))).resolves.toBe(true);
  });
  it('lets the mobile app (SkipMfa) through on a password-only session', async () => {
    await expect(run(user({}), { [SKIP_MFA]: true })).resolves.toBe(true);
  });
  it('asks for the temporary password first, before 2FA setup', async () => {
    await expect(run(user({ mustChangePassword: true }))).rejects.toMatchObject({ response: { code: 'PASSWORD_CHANGE_REQUIRED' } });
  });
});
