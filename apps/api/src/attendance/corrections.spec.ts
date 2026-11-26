import { AuthUser } from '../auth/auth.types';
import { CorrectionsService } from './corrections';

const user = { sub: 'u1', tenantId: 't1', role: 'EMPLOYEE', employeeId: 'e1' } as AuthUser;

/** `owned` = how many of the asked-for visits belong to the employee. */
function setup(owned: number) {
  const created: unknown[] = [];
  const prisma = {
    site: { findUniqueOrThrow: async () => ({ timezone: 'Asia/Kolkata' }) },
    fieldVisit: { count: async () => owned },
    payrollRun: { findMany: async () => [] }, // no closed payroll period
  };
  const audit = { run: async (o: { run: (tx: unknown) => unknown }) => o.run({ attendanceCorrection: { create: async (a: { data: unknown }) => (created.push(a.data), { id: 'c1' }) } }) };
  const scope = { self: async () => ({ id: 'e1', siteId: 's1', fullName: 'A' }) };
  const notifications = { approvalPending: async () => undefined };
  const svc = new CorrectionsService(prisma as never, scope as never, audit as never, {} as never, notifications as never, {} as never);
  const create = (proof: { fieldVisitIds?: string[]; fieldVisitId?: string }) => svc.create(user, { date: '2026-01-05', in: '09:00', reason: 'client visits', ...proof });
  return { create, created };
}

describe('Correction proof', () => {
  it('stores several visits, merging the legacy single id without duplicates', async () => {
    const { create, created } = setup(3);
    await create({ fieldVisitIds: ['v1', 'v2', 'v3'], fieldVisitId: 'v1' });
    expect(created[0]).toMatchObject({ fieldVisitIds: ['v1', 'v2', 'v3'] });
  });
  it('rejects a list that includes a visit that is not the employee’s', async () => {
    await expect(setup(1).create({ fieldVisitIds: ['v1', 'theirs'] })).rejects.toMatchObject({ response: { code: 'BAD_PROOF' } });
  });
  it('stores an empty list when no proof is given', async () => {
    const { create, created } = setup(0);
    await create({});
    expect(created[0]).toMatchObject({ fieldVisitIds: [] });
  });
});
