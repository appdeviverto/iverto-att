import { isLocked, LockableRun } from './lock';

const run = (status: string, lockedAt: Date | null = null): LockableRun => ({ month: '2026-11', periodStart: '2026-10-26', periodEnd: '2026-11-25', status, lockedAt });
const s = (lockOn: 'APPROVED' | 'PAID' | 'MANUAL', lockMode: 'BLOCK' | 'SNAPSHOT_ONLY' = 'BLOCK', lockGraceDays = 0) => ({ lockOn, lockMode, lockGraceDays });

describe('payroll lock', () => {
  it('locks on approval by default, after the period ends', () => {
    expect(isLocked(run('DRAFT'), s('APPROVED'), '2026-11-28')).toBe(false);
    expect(isLocked(run('APPROVED'), s('APPROVED'), '2026-11-28')).toBe(true);
    expect(isLocked(run('PAID'), s('APPROVED'), '2026-11-28')).toBe(true);
  });

  it('lockOn PAID waits for payment', () => {
    expect(isLocked(run('APPROVED'), s('PAID'), '2026-11-28')).toBe(false);
    expect(isLocked(run('PAID'), s('PAID'), '2026-11-28')).toBe(true);
  });

  it('MANUAL only locks with an explicit lock, which also holds in the other modes', () => {
    expect(isLocked(run('PAID'), s('MANUAL'), '2026-11-28')).toBe(false);
    expect(isLocked(run('DRAFT', new Date()), s('MANUAL'), '2026-11-28')).toBe(true);
    expect(isLocked(run('DRAFT', new Date()), s('PAID'), '2026-11-28')).toBe(true);
  });

  it('grace days keep the period open after it ends', () => {
    expect(isLocked(run('APPROVED'), s('APPROVED', 'BLOCK', 3), '2026-11-28')).toBe(false);
    expect(isLocked(run('APPROVED'), s('APPROVED', 'BLOCK', 3), '2026-11-29')).toBe(true);
  });

  it('SNAPSHOT_ONLY never blocks', () => {
    expect(isLocked(run('PAID', new Date()), s('APPROVED', 'SNAPSHOT_ONLY'), '2026-12-31')).toBe(false);
  });
});
