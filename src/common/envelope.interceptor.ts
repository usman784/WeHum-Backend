import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map } from 'rxjs';

export const RAW = Symbol('raw');
/** Wraps every successful response as { data, meta? }. Return `{ data, meta }` yourself to add meta, or `{ [RAW]: true, … }` to skip. */
@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler) {
    if (ctx.getType() !== 'http') return next.handle();
    const res = ctx.switchToHttp().getResponse<{ statusCode: number }>();
    return next.handle().pipe(map((body) => {
      if (res.statusCode === 304 || res.statusCode === 204) return undefined; // no body allowed (ETag hits, deletes)
      if (body && typeof body === 'object' && (RAW in body || ('data' in body && Object.keys(body).every((k) => k === 'data' || k === 'meta')))) {
        if (RAW in body) { const { [RAW]: _r, ...rest } = body as Record<symbol | string, unknown>; return rest; }
        return body;
      }
      return { data: body ?? null };
    }));
  }
}
