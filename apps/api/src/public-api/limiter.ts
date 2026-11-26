import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { runAsSystem } from '../common/rls';

/**
 * Key bucket + org bucket + daily quota + concurrency, checked and charged in ONE Lua call so
 * an org-rejected request never spends key tokens and instances can't race (§7).
 * KEYS: key bucket, org bucket, org day counter, org in-flight zset
 * ARGV: cost, keyRate/min, keyBurst, orgRate/min, orgBurst, dayLimit, concurrency, requestId
 * → { code (0 ok, 1 key, 2 org, 3 day, 4 concurrency), retryAfterMs, keyLeft, orgLeft }
 */
const TAKE = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local cost = tonumber(ARGV[1])
local function level(k, rate, burst)
  local v = redis.call('HMGET', k, 't', 'ts')
  local tokens, ts = tonumber(v[1]), tonumber(v[2])
  if not tokens then return burst end
  return math.min(burst, tokens + (now - ts) * rate / 60000)
end
local kRate, kBurst, oRate, oBurst = tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5])
local kt = level(KEYS[1], kRate, kBurst)
local ot = level(KEYS[2], oRate, oBurst)
if kt < cost then return {1, math.ceil((cost - kt) * 60000 / kRate), math.floor(kt), math.floor(ot)} end
if ot < cost then return {2, math.ceil((cost - ot) * 60000 / oRate), math.floor(kt), math.floor(ot)} end
local day = tonumber(redis.call('GET', KEYS[3]) or '0')
if day + cost > tonumber(ARGV[6]) then return {3, 0, math.floor(kt), math.floor(ot)} end
redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', now - 120000)
if redis.call('ZCARD', KEYS[4]) >= tonumber(ARGV[7]) then return {4, 1000, math.floor(kt), math.floor(ot)} end
redis.call('HSET', KEYS[1], 't', kt - cost, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(kBurst / kRate * 60000) + 1000)
redis.call('HSET', KEYS[2], 't', ot - cost, 'ts', now)
redis.call('PEXPIRE', KEYS[2], math.ceil(oBurst / oRate * 60000) + 1000)
redis.call('INCRBY', KEYS[3], cost)
redis.call('EXPIRE', KEYS[3], 172800)
redis.call('ZADD', KEYS[4], now, ARGV[8])
redis.call('PEXPIRE', KEYS[4], 120000)
return {0, 0, math.floor(kt - cost), math.floor(ot - cost)}
`;

/**
 * Credits: spend this month vs allowance, plus an optional per-key cap.
 * KEYS: org spend, key spend   ARGV: cost, allowance (-1 = unlimited), keyCap (-1 = none), block (1/0)
 * → { code (0 ok, 1 org exhausted, 2 key cap), orgSpent }
 */
const SPEND = `
local cost = tonumber(ARGV[1])
local org = tonumber(redis.call('GET', KEYS[1]) or '0')
local key = tonumber(redis.call('GET', KEYS[2]) or '0')
local allowance, cap, block = tonumber(ARGV[2]), tonumber(ARGV[3]), ARGV[4] == '1'
if cap >= 0 and key + cost > cap then return {2, org} end
if block and allowance >= 0 and org + cost > allowance then return {1, org} end
redis.call('INCRBY', KEYS[1], cost)
redis.call('INCRBY', KEYS[2], cost)
redis.call('EXPIRE', KEYS[1], 3024000)
redis.call('EXPIRE', KEYS[2], 3024000)
return {0, org + cost}
`;

export type TakeResult = { code: 0 | 1 | 2 | 3 | 4; retryAfterMs: number; keyLeft: number; orgLeft: number };

const BAD_AUTH_LIMIT = 20;
const BAD_AUTH_BLOCK_S = 900;

export const utcDay = (d = new Date()) => d.toISOString().slice(0, 10).replace(/-/g, '');
export const utcMonth = (d = new Date()) => d.toISOString().slice(0, 7);

@Injectable()
export class LimiterService {
  private readonly logger = new Logger(LimiterService.name);
  /** Per-process fallback while Redis is unreachable (fail open, but not unbounded). */
  private readonly fallback = new Map<string, { minute: number; count: number }>();

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
  ) {
    this.redis.client.defineCommand('apiTake', { numberOfKeys: 4, lua: TAKE });
    this.redis.client.defineCommand('apiSpend', { numberOfKeys: 2, lua: SPEND });
  }

  async isBlocked(ip: string): Promise<boolean> {
    return (await this.redis.client.exists(`api:block:${ip}`).catch(() => 0)) === 1;
  }

  /** 20 bad keys a minute from one address blocks it for 15 minutes. */
  async authFailed(ip: string) {
    try {
      const n = await this.redis.client.incr(`api:badauth:${ip}`);
      if (n === 1) await this.redis.client.expire(`api:badauth:${ip}`, 60);
      if (n >= BAD_AUTH_LIMIT) await this.redis.client.set(`api:block:${ip}`, '1', 'EX', BAD_AUTH_BLOCK_S);
    } catch {
      /* best effort */
    }
  }

  async take(p: {
    tenantId: string;
    keyId: string;
    requestId: string;
    cost: number;
    keyRate: number;
    orgRate: number;
    orgBurst: number;
    perDay: number;
    concurrency: number;
  }): Promise<TakeResult> {
    try {
      const [code, retryAfterMs, keyLeft, orgLeft] = (await (this.redis.client as any).apiTake(
        `api:rl:k:${p.keyId}`,
        `api:rl:o:${p.tenantId}`,
        `api:day:${p.tenantId}:${utcDay()}`,
        `api:conc:${p.tenantId}`,
        p.cost,
        p.keyRate,
        p.keyRate, // a key's burst is one minute of its rate
        p.orgRate,
        p.orgBurst,
        p.perDay,
        p.concurrency,
        p.requestId,
      )) as number[];
      return { code: code as TakeResult['code'], retryAfterMs, keyLeft, orgLeft };
    } catch (err) {
      this.logger.error(`Rate limiter unavailable, failing open with a local cap: ${(err as Error).message}`);
      const minute = Math.floor(Date.now() / 60_000);
      const slot = this.fallback.get(p.tenantId);
      const count = slot?.minute === minute ? slot.count + p.cost : p.cost;
      this.fallback.set(p.tenantId, { minute, count });
      return count > p.orgRate
        ? { code: 2, retryAfterMs: 60_000 - (Date.now() % 60_000), keyLeft: 0, orgLeft: 0 }
        : { code: 0, retryAfterMs: 0, keyLeft: p.keyRate, orgLeft: p.orgRate - count };
    }
  }

  release(tenantId: string, requestId: string) {
    void this.redis.client.zrem(`api:conc:${tenantId}`, requestId).catch(() => undefined);
  }

  // ── Credits ───────────────────────────────────────────────────────────────

  private spendKeys(tenantId: string, apiKeyId: string, month: string) {
    return [`api:cred:${tenantId}:${month}`, `api:cred:${tenantId}:${month}:${apiKeyId}`];
  }

  /** Redis lost the counters (flush, failover): rebuild them from the request log, the source of truth. */
  private async ensureSpendCounters(tenantId: string, apiKeyId: string, month: string) {
    const [orgKey, keyKey] = this.spendKeys(tenantId, apiKeyId, month);
    if ((await this.redis.client.exists(orgKey, keyKey)) === 2) return;
    const start = new Date(`${month}-01T00:00:00Z`);
    const rows = await runAsSystem(() =>
      this.prisma.apiRequestLog.groupBy({ by: ['apiKeyId'], where: { tenantId, createdAt: { gte: start } }, _sum: { credits: true } }),
    );
    const org = rows.reduce((s, r) => s + (r._sum.credits ?? 0), 0);
    const key = rows.find((r) => r.apiKeyId === apiKeyId)?._sum.credits ?? 0;
    await this.redis.client.set(orgKey, org, 'EX', 3_024_000, 'NX');
    await this.redis.client.set(keyKey, key, 'EX', 3_024_000, 'NX');
  }

  /** Allowance for the month = policy grant + top-ups. */
  async allowance(tenantId: string, monthlyGrant: number, month = utcMonth()): Promise<number> {
    const cacheKey = `api:allow:${tenantId}:${month}`;
    const cached = await this.redis.client.get(cacheKey).catch(() => null);
    if (cached !== null) return monthlyGrant + Number(cached);
    const agg = await runAsSystem(() => this.prisma.apiCreditLedger.aggregate({ where: { tenantId, month }, _sum: { delta: true } }));
    const topups = agg._sum.delta ?? 0;
    await this.redis.client.set(cacheKey, topups, 'EX', 300).catch(() => undefined);
    return monthlyGrant + topups;
  }

  forgetAllowance(tenantId: string, month: string) {
    return this.redis.client.del(`api:allow:${tenantId}:${month}`).catch(() => undefined);
  }

  /** @returns 0 ok, 1 org exhausted, 2 key cap reached. Throws when Redis is down (caller decides). */
  async spend(p: { tenantId: string; apiKeyId: string; cost: number; allowance: number; keyCap: number | null; block: boolean }) {
    const month = utcMonth();
    await this.ensureSpendCounters(p.tenantId, p.apiKeyId, month);
    const [orgKey, keyKey] = this.spendKeys(p.tenantId, p.apiKeyId, month);
    const [code, spent] = (await (this.redis.client as any).apiSpend(orgKey, keyKey, p.cost, p.allowance, p.keyCap ?? -1, p.block ? 1 : 0)) as number[];
    return { code: code as 0 | 1 | 2, spent };
  }

  refund(tenantId: string, apiKeyId: string, cost: number) {
    const [orgKey, keyKey] = this.spendKeys(tenantId, apiKeyId, utcMonth());
    void this.redis.client.multi().decrby(orgKey, cost).decrby(keyKey, cost).exec().catch(() => undefined);
  }

  async spent(tenantId: string, month = utcMonth()): Promise<number> {
    const cached = await this.redis.client.get(`api:cred:${tenantId}:${month}`).catch(() => null);
    if (cached !== null) return Number(cached);
    const agg = await runAsSystem(() =>
      this.prisma.apiRequestLog.aggregate({ where: { tenantId, createdAt: { gte: new Date(`${month}-01T00:00:00Z`) } }, _sum: { credits: true } }),
    );
    return agg._sum.credits ?? 0;
  }
}
