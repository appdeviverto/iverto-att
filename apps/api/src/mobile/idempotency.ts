import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { createHash } from 'crypto';
import { from, Observable, of, switchMap, tap, catchError, throwError } from 'rxjs';
import { AppError } from '../common/errors';
import { RedisService } from '../common/redis.service';

const TTL_SECONDS = 24 * 3600;

/**
 * `Idempotency-Key` on mobile POSTs (§14): a retried request after a flaky
 * network returns the first response instead of punching or applying twice.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly redis: RedisService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const key = req.headers['idempotency-key'] as string | undefined;
    if (req.method !== 'POST' || !key || !req.user) return next.handle();
    if (key.length > 200) throw new AppError(400, 'BAD_IDEMPOTENCY_KEY', 'Idempotency-Key is too long');
    const redisKey = `idem:${req.user.sub}:${req.url}:${key}`;
    // Public API: the same key with a different body is a client bug, not a retry (docs/public-api.md §3).
    const fpKey = `${redisKey}:fp`;
    const fingerprint = req.user.apiKey ? createHash('sha256').update(JSON.stringify(req.body ?? null)).digest('hex') : null;

    return from(this.redis.client.set(redisKey, '__pending__', 'EX', TTL_SECONDS, 'NX')).pipe(
      switchMap((claimed) => {
        if (claimed) {
          if (fingerprint) void this.redis.client.set(fpKey, fingerprint, 'EX', TTL_SECONDS);
          return next.handle().pipe(
            tap((body) => void this.redis.client.set(redisKey, JSON.stringify(body ?? null), 'EX', TTL_SECONDS)),
            catchError((err) => from(this.redis.client.del(redisKey, fpKey)).pipe(switchMap(() => throwError(() => err)))),
          );
        }
        return from(Promise.all([this.redis.client.get(redisKey), fingerprint ? this.redis.client.get(fpKey) : null])).pipe(
          switchMap(([stored, storedFp]) => {
            if (fingerprint && storedFp && storedFp !== fingerprint) {
              throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request body');
            }
            if (!stored || stored === '__pending__') {
              throw new AppError(409, 'IDEMPOTENCY_IN_PROGRESS', 'The same request is still being processed');
            }
            return of(JSON.parse(stored));
          }),
        );
      }),
    );
  }
}
