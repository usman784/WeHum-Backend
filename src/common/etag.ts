import type { FastifyReply, FastifyRequest } from 'fastify';

/** Sets the ETag and answers 304 when the client already has it. Returns true when the caller should stop. */
export function notModified(req: FastifyRequest, res: FastifyReply, etag: string, cacheControl: string): boolean {
  res.header('etag', etag).header('cache-control', cacheControl);
  const inm = req.headers['if-none-match'];
  if (inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) { res.status(304); return true; }
  return false;
}

export const PRIVATE = 'private, max-age=0';
export const CDN_CACHE = 'public, max-age=300, stale-while-revalidate=600';
