import crypto from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import {frontmatter, tagsOf} from './vault-workspace.mjs';
import {targets, resolver, title as titleOf} from './lib.mjs';

// The hosted vault store: Neon Postgres, one vault per company. Every call names its vault, and every
// transaction sets adm.vault so row-level security holds even if a query forgets its WHERE clause.
export const VAULT_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
let pool = null;
export function db() {
  if (pool) return pool;
  const connectionString = process.env.ADM_APP_DATABASE_URL;
  if (!connectionString) throw Error('ADM_APP_DATABASE_URL is not set.');
  pool = new pg.Pool({connectionString, max: 5, idleTimeoutMillis: 10000});
  return pool;
}
export function usePool(p) { pool = p; }
export const sha = text => crypto.createHash('sha256').update(text).digest('hex');

export async function inVault(vault, fn) {
  if (!VAULT_ID.test(String(vault || ''))) throw Object.assign(Error('No vault for this request.'), {status: 403});
  const client = await db().connect();
  try {
    await client.query('begin');
    await client.query("select set_config('adm.vault', $1, true)", [vault]);
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (error) {
    try { await client.query('rollback'); } catch {}
    throw error;
  } finally { client.release(); }
}
// The two cross-vault lookups, answered by the database's own owner-side functions.
export async function tokenRow(id) { return (await db().query('select * from adm_token($1)', [id])).rows[0] || null; }
export async function sessionRow(id) { return (await db().query('select * from adm_session($1)', [id])).rows[0] || null; }
export async function openVault(vault, company, who) {
  if (!VAULT_ID.test(String(vault || ''))) throw Object.assign(Error('That company has no vault id.'), {status: 400});
  await db().query('select adm_open_vault($1, $2, $3)', [vault, String(company || ''), String(who || '')]);
}

export async function receipt(c, vault, actor, kind, data = {}) {
  const row = {receiptId: crypto.randomUUID(), at: new Date().toISOString(), actor, kind, ...data};
  await c.query('insert into receipts(receipt_id, vault, at, actor, kind, data) values ($1,$2,$3,$4,$5,$6)',
    [row.receiptId, vault, row.at, actor, kind, JSON.stringify(data)]);
  return row;
}

// Search: operators path:, folder:, file:, tag:, "phrase", -word, OR. Filename matches rank first.
export function parseQuery(q) {
  const filters = {path: [], file: [], tag: []}; let rest = String(q || '');
  rest = rest.replace(/\b(path|folder|file|tag):("([^"]+)"|\S+)/gi, (_, k, v, quoted) => {
    const key = k.toLowerCase() === 'folder' ? 'path' : k.toLowerCase();
    filters[key].push((quoted ?? v).replace(/^#/, '')); return ' ';
  });
  return {text: rest.trim(), ...filters};
}
export async function search(c, vault, {q = '', folder = '', offset = 0, limit = 20} = {}) {
  const parsed = parseQuery(q), where = ['vault = $1'], args = [vault];
  const add = (sql, value) => { args.push(value); where.push(sql.replaceAll('?', '$' + args.length)); };
  if (folder) add("path like ? || '%'", String(folder).replace(/\/?$/, '/'));
  for (const p of parsed.path) add("path ilike '%' || ? || '%'", p);
  for (const f of parsed.file) add("path ilike '%' || ? || '%'", f);
  for (const t of parsed.tag) add('? = any(tags)', t.toLowerCase());
  let rank = '0';
  if (parsed.text) {
    args.push(parsed.text); const n = args.length;
    args.push(parsed.text.replace(/["-]/g, ' ').trim()); const m = args.length;
    where.push(`(tsv @@ websearch_to_tsquery('english', $${n}) or (length($${m}) > 0 and path ilike '%' || $${m} || '%'))`);
    rank = `(case when path ilike '%' || $${m} || '%' then 10 else 0 end) + ts_rank(tsv, websearch_to_tsquery('english', $${n}))`;
  }
  args.push(Math.max(1, Math.min(80, Number(limit) || 20))); const lim = args.length;
  args.push(Math.max(0, Number(offset) || 0)); const off = args.length;
  const rows = (await c.query(`select path, title, folder, mtime, bytes, body, ${rank} as score from docs where ${where.join(' and ')}
    order by score desc, mtime desc limit $${lim} offset $${off}`, args)).rows;
  return rows;
}
export async function doc(c, vault, p) {
  return (await c.query('select * from docs where vault = $1 and path = $2', [vault, p])).rows[0] || null;
}
export async function connections(c, vault, p) {
  const out = (await c.query('select target as path from links where vault = $1 and source = $2 order by target', [vault, p])).rows;
  const back = (await c.query('select source as path from links where vault = $1 and target = $2 order by source', [vault, p])).rows;
  return {links: out, backlinks: back};
}
// Wiki links are resolved against the vault's own paths when written.
async function relink(c, vault, p, body) {
  const paths = (await c.query('select path from docs where vault = $1', [vault])).rows.map(r => r.path);
  const resolve = resolver(paths);
  const found = [...new Set([...targets(body)].map(t => resolve(p, t) || ('?' + t)))];
  await c.query('delete from links where vault = $1 and source = $2', [vault, p]);
  for (const t of found) await c.query('insert into links(vault, source, target) values ($1,$2,$3) on conflict do nothing', [vault, p, t]);
  // Notes that linked to this path before it existed now resolve.
  const base = path.posix.basename(p).replace(/\.md$/i, '').toLowerCase(), noExt = p.replace(/\.md$/i, '').toLowerCase();
  await c.query(`update links set target = $2 where vault = $1 and target like '?%' and (lower(substr(target, 2)) = $3 or lower(substr(target, 2)) = $4)
    and not exists (select 1 from links l2 where l2.vault = links.vault and l2.source = links.source and l2.target = $2)`, [vault, p, base, noExt]);
  return found.length;
}
export async function put(c, vault, {path: p, content, actor, expectedHash}) {
  const current = await doc(c, vault, p);
  if (expectedHash === null && current) throw Object.assign(Error('That note already exists. Read it and send its sha256 as expectedHash.'), {status: 409, extra: {currentHash: current.sha256}});
  if (expectedHash !== null && (!current || current.sha256 !== expectedHash))
    throw Object.assign(Error('Stale write refused: the note changed since you read it.'), {status: 409, extra: {currentHash: current?.sha256 ?? null}});
  const {properties} = frontmatter(content), hash = sha(content), bytes = Buffer.byteLength(content);
  const t = /\.md$/i.test(p) ? titleOf(content, p) : path.posix.basename(p);
  const tags = [...tagsOf(content)].map(x => String(x).replace(/^#/, '').toLowerCase());
  const folder = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
  const revision = (current?.revision || 0) + 1;
  if (current) await c.query(`update docs set body=$3, title=$4, folder=$5, properties=$6, tags=$7, sha256=$8, bytes=$9, revision=$10, mtime=now(), updated_by=$11
    where vault=$1 and path=$2 and sha256=$12`, [vault, p, content, t, folder, JSON.stringify(properties), tags, hash, bytes, revision, actor, expectedHash]);
  else await c.query(`insert into docs(vault, path, body, title, folder, properties, tags, sha256, bytes, revision, created_by, updated_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$10)`, [vault, p, content, t, folder, JSON.stringify(properties), tags, hash, bytes, actor]);
  const links = /\.md$/i.test(p) ? await relink(c, vault, p, content) : 0;
  const stored = (await doc(c, vault, p))?.sha256;
  return {path: p, sha256: hash, previousHash: current?.sha256 ?? null, bytes, created: !current, revision, links, verifiedInStore: stored === hash};
}
