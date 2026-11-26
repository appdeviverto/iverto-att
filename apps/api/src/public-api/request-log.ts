import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createHash, randomUUID } from 'crypto';
import Redis from 'ioredis';
import { PrismaService } from '../common/prisma.service';
import { redisOptions, RedisService } from '../common/redis.service';
import { runAsSystem } from '../common/rls';
import type { ApiRequestContext } from './api-key.guard';
import { LimiterService } from './limiter';
import { OPERATION_BY_ID } from './registry';

const STREAM = 'api:logs';
const GROUP = 'api-log-writers';

export interface LogEntry {
  id: string;
  tenantId: string | null;
  apiKeyId: string | null;
  operationId: string | null;
  method: string;
  path: string;
  status: number;
  errorCode: string | null;
  latencyMs: number;
  reqBytes: number;
  resBytes: number;
  ip: string | null;
  userAgent: string | null;
  credits: number;
  createdAt: string;
}

/** `/v1/public/...` — the app-side prefix of https://api.iverto.ai/v1/... */
export const isPublicApiUrl = (url: string) => url.startsWith(`/${process.env.API_PREFIX || 'v1'}/public/`);

/**
 * Every public request is logged (§9): the response hook XADDs to a Redis stream and a
 * consumer-group worker batch-inserts every ~2 s, so no request waits on the database.
 * Redis down → direct insert. Unacked entries are re-claimed after a minute; the row id is the
 * request id, so a retried batch can't duplicate.
 */
@Injectable()
export class RequestLogService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RequestLogService.name);
  private reader?: Redis;
  private running = false;
  private readonly consumer = `c-${process.pid}-${randomUUID().slice(0, 8)}`;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  enqueue(entry: LogEntry) {
    this.redis.client
      .xadd(STREAM, 'MAXLEN', '~', '200000', '*', 'e', JSON.stringify(entry))
      .catch(() => this.insert([entry]).catch((err) => this.logger.error(`Request log lost (${entry.id}): ${(err as Error).message}`)));
  }

  private insert(entries: LogEntry[]) {
    return runAsSystem(() =>
      this.prisma.apiRequestLog.createMany({ data: entries.map((e) => ({ ...e, createdAt: new Date(e.createdAt) })), skipDuplicates: true }),
    );
  }

  async onModuleInit() {
    this.reader = new Redis({ ...redisOptions(), maxRetriesPerRequest: null, lazyConnect: true });
    this.reader.on('error', (err) => this.logger.warn(`log reader: ${err.message}`));
    try {
      await this.reader.connect();
      await this.reader.xgroup('CREATE', STREAM, GROUP, '0', 'MKSTREAM').catch((err) => {
        if (!String(err.message).includes('BUSYGROUP')) throw err;
      });
    } catch (err) {
      this.logger.warn(`Request-log stream unavailable; logging directly: ${(err as Error).message}`);
      return;
    }
    this.running = true;
    void this.loop();
  }

  async onModuleDestroy() {
    this.running = false;
    await this.reader?.quit().catch(() => undefined);
  }

  private async loop() {
    let lastClaim = 0;
    while (this.running) {
      try {
        let batch: Array<[string, string[]]> = [];
        if (Date.now() - lastClaim > 60_000) {
          lastClaim = Date.now();
          const claimed = (await this.reader!.xautoclaim(STREAM, GROUP, this.consumer, 60_000, '0', 'COUNT', 500)) as [string, Array<[string, string[]]>];
          batch = claimed[1] ?? [];
        }
        if (!batch.length) {
          const res = (await this.reader!.xreadgroup('GROUP', GROUP, this.consumer, 'COUNT', 500, 'BLOCK', 2000, 'STREAMS', STREAM, '>')) as
            | Array<[string, Array<[string, string[]]>]>
            | null;
          batch = res?.[0]?.[1] ?? [];
        }
        if (!batch.length) continue;
        const entries: LogEntry[] = [];
        for (const [, fields] of batch) {
          try {
            entries.push(JSON.parse(fields[1]));
          } catch {
            /* unparseable entry: acked below and dropped */
          }
        }
        if (entries.length) await this.insert(entries);
        await this.reader!.xack(STREAM, GROUP, ...batch.map(([id]) => id));
        // Processed entries leave Redis at once; MAXLEN on XADD only caps a stalled writer.
        await this.reader!.xdel(STREAM, ...batch.map(([id]) => id)).catch(() => undefined);
      } catch (err) {
        if (!this.running) return;
        this.logger.error(`Request-log writer: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
}

/**
 * Fastify hooks for /v1/public/*: request id + timer, cache headers + ETag/304, then settle
 * (concurrency, credits) and log. Registered in main.ts before routes are built.
 */
export function registerPublicApiHooks(app: NestFastifyApplication) {
  const fastify = app.getHttpAdapter().getInstance();
  const logs = app.get(RequestLogService);
  const limiter = app.get(LimiterService);

  fastify.addHook('onRequest', async (req: any, reply: any) => {
    if (!isPublicApiUrl(req.url)) return;
    const ctx: ApiRequestContext = { requestId: randomUUID(), start: performance.now(), credits: 0, concurrencyHeld: false };
    req.apiCtx = ctx;
    reply.header('X-Request-Id', ctx.requestId);
  });

  fastify.addHook('onSend', async (req: any, reply: any, payload: unknown) => {
    const ctx: ApiRequestContext | undefined = req.apiCtx;
    if (!ctx) return payload;
    if (reply.statusCode >= 400 && typeof payload === 'string') {
      try {
        ctx.errorCode = JSON.parse(payload).code;
      } catch {
        /* not JSON */
      }
    }
    const op = ctx.operationId ? OPERATION_BY_ID.get(ctx.operationId) : undefined;
    if (op?.deprecated) {
      reply.header('Deprecation', `@${Math.floor(Date.parse(op.deprecated.since) / 1000)}`);
      reply.header('Sunset', new Date(op.deprecated.sunset).toUTCString());
    }
    if (req.method !== 'GET' || reply.statusCode !== 200 || typeof payload !== 'string') {
      reply.header('Cache-Control', 'no-store');
      return payload;
    }
    // Revalidate every time, never stored by shared caches (§6). A match costs no credits.
    reply.header('Cache-Control', 'private, no-cache');
    const etag = `"${createHash('sha256').update(payload).digest('base64url').slice(0, 27)}"`;
    reply.header('ETag', etag);
    const inm = req.headers['if-none-match'];
    if (typeof inm === 'string' && inm.split(',').some((t: string) => t.trim().replace(/^W\//, '') === etag)) {
      reply.code(304);
      reply.removeHeader('content-type');
      return '';
    }
    return payload;
  });

  fastify.addHook('onResponse', async (req: any, reply: any) => {
    const ctx: ApiRequestContext | undefined = req.apiCtx;
    if (!ctx) return;
    const status: number = reply.statusCode;
    if (ctx.concurrencyHeld && ctx.tenantId) limiter.release(ctx.tenantId, ctx.requestId);
    let credits = ctx.credits;
    if (credits && ctx.tenantId && ctx.apiKeyId && (status >= 500 || status === 429 || status === 304)) {
      limiter.refund(ctx.tenantId, ctx.apiKeyId, credits);
      credits = 0;
    }
    const path = String(req.url).split('?')[0];
    logs.enqueue({
      id: ctx.requestId,
      tenantId: ctx.tenantId ?? null,
      apiKeyId: ctx.apiKeyId ?? null,
      operationId: ctx.operationId ?? null,
      method: req.method,
      path: path.slice(0, 500),
      status,
      errorCode: ctx.errorCode?.slice(0, 100) ?? null,
      latencyMs: Math.round(performance.now() - ctx.start),
      reqBytes: Number(req.headers['content-length'] ?? 0) || 0,
      resBytes: Number(reply.getHeader('content-length') ?? 0) || 0,
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined)?.slice(0, 300) ?? null,
      credits,
      createdAt: new Date().toISOString(),
    });
  });
}
