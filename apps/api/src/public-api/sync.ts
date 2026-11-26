import { Logger } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { createHmac, timingSafeEqual } from 'crypto';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';

/** Tombstone retention; a sync position older than this may have missed deletions → 410. */
export const TOMBSTONE_DAYS = 90;
const DAY_MS = 86_400_000;

/** Query params shared by every list (§11): cursor pagination that doubles as an incremental sync feed. */
export class ListQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @IsString() @MaxLength(500) cursor?: string;
  /** RFC 3339. Inclusive: rows changed at or after this instant, plus deletions. */
  @IsOptional() @IsISO8601({ strict: true }) updatedSince?: string;
}

// ── Signed opaque cursors ───────────────────────────────────────────────────

const secret = () => {
  const pepper = process.env.API_KEY_PEPPER;
  if (!pepper) throw new Error('API_KEY_PEPPER is not configured');
  return createHmac('sha256', pepper).update('cursor-v1').digest();
};

export function encodeCursor(data: object): string {
  const body = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = createHmac('sha256', secret()).update(body).digest('base64url').slice(0, 22);
  return `${body}.${sig}`;
}

export function decodeCursor<T>(cursor: string): T {
  const [body, sig] = cursor.split('.');
  const expected = body ? createHmac('sha256', secret()).update(body).digest('base64url').slice(0, 22) : '';
  if (!body || !sig || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new AppError(400, 'INVALID_CURSOR', 'The cursor is invalid');
  }
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    throw new AppError(400, 'INVALID_CURSOR', 'The cursor is invalid');
  }
}

// ── Commit-lag-safe high-water mark ─────────────────────────────────────────

let capCache: { at: number; cap: Date } | undefined;

/**
 * Rows are only returned once every transaction that could still commit an older timestamp
 * has finished: the cap is the start of the oldest running write transaction (one with an
 * xid). updated_at is stamped with clock_timestamp() by the trigger (post-init/007), so a
 * write can never land behind the cap. Cached 1 s — an older cap is only more conservative.
 */
export async function syncCap(prisma: PrismaService): Promise<Date> {
  if (capCache && Date.now() - capCache.at < 1000) return capCache.cap;
  let cap: Date;
  try {
    const [row] = await prisma.$transaction((tx) =>
      tx.$queryRaw<Array<{ ms: bigint }>>`
        SELECT floor(extract(epoch FROM LEAST(clock_timestamp(), COALESCE(MIN(xact_start), clock_timestamp()))) * 1000)::bigint AS ms
        FROM pg_stat_activity WHERE backend_xid IS NOT NULL AND pid <> pg_backend_pid()`,
    );
    cap = new Date(Number(row.ms));
  } catch (err) {
    // Conservative: may hide the last 5 minutes of changes until the next poll; never skips one.
    new Logger('SyncCap').warn(`pg_stat_activity unavailable, capping 5 min back: ${(err as Error).message}`);
    cap = new Date(Date.now() - 5 * 60_000);
  }
  capCache = { at: Date.now(), cap };
  return cap;
}

// ── The feed ────────────────────────────────────────────────────────────────

interface FeedCursor {
  /** updatedAt (ms) and id of the last item returned. */
  t: number;
  i: string;
  /** When the cursor was issued (ms): a feed not polled for TOMBSTONE_DAYS may have missed deletions. */
  c: number;
}

export interface Tombstone {
  object: string;
  id: string;
  deleted: true;
  deletedAt: string;
}

export interface Page<T> {
  object: 'list';
  data: Array<T | Tombstone>;
  hasMore: boolean;
  /** Pass back to continue; when hasMore is false, store it and poll with it later for changes. */
  nextCursor: string | null;
}

/**
 * One page of `resource`, ordered by (updatedAt, id), with deletions (from deleted_records)
 * merged in at their deletion time. At-least-once: a row may appear again on a later page;
 * clients upsert by id. Deletions ignore list filters (they carry no attributes).
 */
export async function feed<R extends { id: string; updatedAt: Date }, T>(
  prisma: PrismaService,
  opts: {
    tenantId: string;
    /** Table name, as written by the tombstone trigger. */
    table: string;
    object: string;
    query: ListQuery;
    where: object;
    find: (args: { where: object; orderBy: object[]; take: number }) => Promise<R[]>;
    present: (row: R) => T;
  },
): Promise<Page<T>> {
  const limit = opts.query.limit ?? 50;
  let after: { t: number; i: string } | null = null;
  if (opts.query.cursor) {
    const c = decodeCursor<FeedCursor>(opts.query.cursor);
    if (typeof c.t !== 'number' || typeof c.i !== 'string' || typeof c.c !== 'number') throw new AppError(400, 'INVALID_CURSOR', 'The cursor is invalid');
    if (c.c < Date.now() - TOMBSTONE_DAYS * DAY_MS) {
      throw new AppError(410, 'SYNC_CURSOR_EXPIRED', `This cursor is older than ${TOMBSTONE_DAYS} days; start a full sync`);
    }
    after = { t: c.t, i: c.i };
  } else if (opts.query.updatedSince) {
    const t = Date.parse(opts.query.updatedSince);
    if (t < Date.now() - TOMBSTONE_DAYS * DAY_MS) {
      throw new AppError(410, 'SYNC_CURSOR_EXPIRED', `updatedSince is older than ${TOMBSTONE_DAYS} days; start a full sync`);
    }
    after = { t, i: '' };
  }

  const cap = await syncCap(prisma);
  const afterWhere = (timeField: string, idField: string) =>
    after
      ? { OR: [{ [timeField]: { gt: new Date(after.t) } }, { [timeField]: new Date(after.t), [idField]: { gt: after.i } }] }
      : {};

  const [rows, tombs] = await Promise.all([
    opts.find({
      where: { AND: [opts.where, { updatedAt: { lt: cap } }, afterWhere('updatedAt', 'id')] },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    }),
    prisma.deletedRecord.findMany({
      where: { AND: [{ tenantId: opts.tenantId, resource: opts.table, deletedAt: { lt: cap } }, afterWhere('deletedAt', 'recordId')] },
      orderBy: [{ deletedAt: 'asc' }, { recordId: 'asc' }],
      take: limit + 1,
    }),
  ]);

  type Item = { t: number; i: string; out: T | Tombstone };
  const items: Item[] = [
    ...rows.map((r) => ({ t: r.updatedAt.getTime(), i: r.id, out: opts.present(r) })),
    ...tombs.map((d) => ({
      t: d.deletedAt.getTime(),
      i: d.recordId,
      out: { object: opts.object, id: d.recordId, deleted: true as const, deletedAt: d.deletedAt.toISOString() },
    })),
  ].sort((a, b) => a.t - b.t || (a.i < b.i ? -1 : a.i > b.i ? 1 : 0));

  const page = items.slice(0, limit);
  const last = page[page.length - 1];
  const position = last ? { t: last.t, i: last.i } : after;
  return {
    object: 'list',
    data: page.map((p) => p.out),
    hasMore: items.length > limit,
    // Issue time at day granularity: enough for the 90-day check, and an unchanged page keeps its ETag.
    nextCursor: position ? encodeCursor({ ...position, c: Math.floor(Date.now() / DAY_MS) * DAY_MS } satisfies FeedCursor) : null,
  };
}
