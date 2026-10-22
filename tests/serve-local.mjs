// Local stand-in for the Vercel host: serves public/ and sends /api/* to the same handler Vercel runs.
// With --mock-cc it also answers the home app exchange for two made-up companies, so the
// sign-in path can be walked on this computer: /api/cc-handoff?cc_handoff=mock-a or mock-b.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {local} from './local-db.mjs';
import {handle} from '../lib/web.mjs';

// With no ADM_APP_DATABASE_URL the vaults live in memory (PGlite) and vanish when this stops.
const port = Number(process.env.PORT || 4291), root = path.resolve('public'), mock = process.argv.includes('--mock-cc');
const PEOPLE = {'mock-a': {tenant: 'zz-local-example-co', company: 'Example Co (local test)', username: 'maya', role: 'owner'},
  'mock-b': {tenant: 'zz-local-ridge-roofing', company: 'Ridge Roofing (local test)', username: 'devon', role: 'owner'}};
const fakeFetch = async (_url, opts) => {
  const {token} = JSON.parse(opts.body), p = PEOPLE[token];
  return {ok: !!p, json: async () => p ? {ok: true, app_id: 'adamanteum', display_name: p.username, ...p} : {ok: false}};
};
if (mock) { process.env.ADM_HANDOFF_URL ||= 'http://mock.invalid'; process.env.ADM_EXCHANGE_SECRET ||= 'x'.repeat(40); }
const TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json'};
http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/') || req.url.startsWith('/cc-handoff')) {
    let raw = ''; for await (const chunk of req) raw += chunk;
    try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = {}; }
    const out = await handle(req, mock ? {fetchImpl: fakeFetch} : {});
    const headers = {...out.headers}; if (headers['set-cookie']) headers['set-cookie'] = headers['set-cookie'].replace('; Secure', '');
    res.writeHead(out.status, headers); return res.end(out.body);
  }
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname === '/' ? '/index.html' : new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, {'content-type': TYPES[path.extname(file)] || 'application/octet-stream'}); fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`Adamanteum local on http://127.0.0.1:${port}${mock ? ' (mock home app)' : ''}`));
