import {attachDatabasePool} from '@vercel/functions';
import {db} from '../lib/store.mjs';
import {handle} from '../lib/web.mjs';

// Vercel entry: every /api/* address arrives here (vercel.json rewrites it, keeping the original path in ?__p).
let attached = false;
export default async function (req, res) {
  if (!attached) { try { attachDatabasePool(db()); } catch {} attached = true; }
  const url = new URL(req.url, 'https://x');
  const original = url.searchParams.get('__p');
  // Vercel also copies the rewrite's named part into the query; drop both so a caller's own ?path= survives.
  if (original !== null) { url.searchParams.delete('__p'); url.searchParams.delete('admroute'); req.url = '/api/' + original + (url.search || ''); }
  if (req.method === 'POST' && (req.body === undefined || typeof req.body === 'string')) {
    try { req.body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : {}; } catch { req.body = {}; }
  }
  const out = await handle(req);
  res.statusCode = out.status;
  for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
  res.end(out.body);
}
