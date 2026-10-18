import compression from 'compression';
import type { Request, Response } from 'express';

/** Matches the live team-plan SSE route (events/:eventId/teams/:teamId/stream), with or without a
 * query string / trailing slash. */
const SSE_PATH = /\/events\/[^/]+\/teams\/[^/]+\/stream\/?$/;

/** Decides whether a response may be gzipped. Server-Sent Events must never be compressed: the
 * middleware would buffer the stream and the browser would see no live updates. Excluded by
 * response content type (what is actually being sent), by the request's Accept header, and by
 * route path (the content type is only known once the handler has set headers). Everything else
 * falls through to the middleware's own default (compressible mime types only, honours
 * `Cache-Control: no-transform` and the `x-no-compression` request header). */
export function shouldCompress(req: Request, res: Response): boolean {
  const contentType = res.getHeader('Content-Type');
  if (typeof contentType === 'string' && contentType.toLowerCase().includes('text/event-stream')) return false;
  const accept = req.headers?.accept;
  if (typeof accept === 'string' && accept.toLowerCase().includes('text/event-stream')) return false;
  const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
  if (SSE_PATH.test(path)) return false;
  return compression.filter(req, res);
}
