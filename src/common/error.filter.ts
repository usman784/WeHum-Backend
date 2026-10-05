import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from './errors';

const httpCode: Record<number, string> = { 400: 'VALIDATION_FAILED', 401: 'AUTH_REQUIRED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 413: 'PAYLOAD_TOO_LARGE', 429: 'RATE_LIMITED' };

@Catch()
export class AppErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('Error');

  catch(err: unknown, host: ArgumentsHost) {
    if (host.getType() !== 'http') throw err;
    const req = host.switchToHttp().getRequest<FastifyRequest>();
    const res = host.switchToHttp().getResponse<FastifyReply>();
    let status = 500, code = 'INTERNAL', message = 'Something went wrong', details: unknown;

    if (err instanceof AppError) {
      status = err.status; code = err.code; message = err.message; details = err.details;
      if (err.headers) res.headers(err.headers);
    } else if (err instanceof ZodError) {
      status = 400; code = 'VALIDATION_FAILED'; message = 'Invalid input';
      details = { fields: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
    } else if (err instanceof HttpException) {
      status = err.getStatus(); code = httpCode[status] ?? (status >= 500 ? 'INTERNAL' : 'VALIDATION_FAILED'); message = err.message;
    } else if ((err as { statusCode?: number })?.statusCode && (err as { statusCode: number }).statusCode < 500) {
      // Fastify errors (bad JSON, body too large)
      status = (err as { statusCode: number }).statusCode; code = httpCode[status] ?? 'VALIDATION_FAILED'; message = (err as Error).message;
    }

    let traceId = String(req.id);
    if (status >= 500) {
      this.log.error(err instanceof Error ? err.stack : String(err));
      traceId = Sentry.captureException(err) || traceId;
    }
    res.status(status).send({ error: { code, message, details, traceId } });
  }
}
