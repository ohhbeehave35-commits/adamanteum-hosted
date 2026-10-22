import crypto from 'node:crypto';
import * as store from './store.mjs';
import {DOOR_BASE, doorFor, handleDoor, listTokens, mintToken, revokeToken, route15} from './door.mjs';

// Everything a browser or an AI reaches: the door (bearer tokens), the home app hand-off, and the
// screen's own calls (a session cookie made by the hand-off). One function, so tests drive it without Vercel.
const COOKIE = 'adm_session', SESSION_HOURS = 12;
// The optional sign-in hand-off from a home app is off until ADM_HANDOFF_URL and ADM_EXCHANGE_SECRET are both set.
const HANDOFF_HEADER = process.env.ADM_HANDOFF_HEADER || 'X-App-Secret';
const OWNER_ROLES = new Set(['owner', 'admin', 'administrator', 'hq_owner', 'operator', 'founder']);
export const isOwner = role => OWNER_ROLES.has(String(role || '').toLowerCase()) || /owner/i.test(String(role || ''));
export const vaultIdFor = tenant => String(tenant || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 80);
const json = (status, body, headers = {}) => ({status, headers: {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers}, body: JSON.stringify(body)});
const redirect = (location, headers = {}) => ({status: 303, headers: {location, 'cache-control': 'no-store', ...headers}, body: ''});
const cookieOf = (header, name) => { for (const part of String(header || '').split(';')) { const [k, ...v] = part.trim().split('='); if (k === name) return decodeURIComponent(v.join('=')); } return ''; };

// A new company's vault is never empty: it opens with a welcome note that names the company and how to use it.
async function seedIfNew(vault, company, actor) {
  const d = doorFor({vault, actor, scope: 'write'});
  const n = await store.inVault(vault, async c => (await c.query('select count(*)::int n from docs where vault = $1', [vault])).rows[0].n);
  if (n > 0) return false;
  const name = company || vault;
  await d.write({path: 'Welcome.md', expectedHash: null, body: `---\ntags: [welcome]\n---\n# Welcome to ${name}'s vault\n\nThis vault belongs to **${name}** and only ${name} can read it. Every note written here leaves a receipt: who wrote it, when, and its fingerprint.\n\n- Write a note with **New note**.\n- Find anything with the search box.\n- Ask Assistant to search, read or draft notes for you; she asks before she writes.\n- See [[How this vault works]].\n`});
  await d.write({path: 'How this vault works.md', expectedHash: null, body: `# How this vault works\n\n${name}'s notes live in their own vault. Another company using Adamanteum cannot search, open or change them, and a key made for another company is refused here.\n\nThe owner can give an AI helper its own key on the **Keys** page, and switch any key off at once.\n\nBack to [[Welcome]].\n`});
  return true;
}

export async function cchandoff(token, {fetchImpl = fetch} = {}) {
  const base = String(process.env.ADM_HANDOFF_URL || '').replace(/\/+$/, ''), secret = process.env.ADM_EXCHANGE_SECRET || '';
  if (!token) return redirect('/?signin=missing');
  if (!base || secret.length < 32) return redirect('/?signin=not-set-up');
  let who;
  try {
    const res = await fetchImpl(base + '/api/apps/handoff/exchange', {method: 'POST', headers: {'content-type': 'application/json', [HANDOFF_HEADER]: secret}, body: JSON.stringify({token}), signal: AbortSignal.timeout(15000)});
    who = await res.json().catch(() => ({}));
    if (!res.ok || !who.ok) return redirect('/?signin=failed');
  } catch { return redirect('/?signin=unreachable'); }
  if (who.app_id && who.app_id !== 'adamanteum') return redirect('/?signin=failed');
  const vault = vaultIdFor(who.tenant);
  if (!vault || !who.username) return redirect('/?signin=failed');
  const company = String(who.company || who.tenant || '');
  await store.openVault(vault, company, 'cc:' + who.username);
  const sid = crypto.randomBytes(32).toString('base64url');
  await store.inVault(vault, async c => {
    await c.query(`insert into sessions(id, vault, username, role, company, display_name, assistant_url, expires_at) values ($1,$2,$3,$4,$5,$6,$7, now() + interval '${SESSION_HOURS} hours')`,
      [store.sha(sid), vault, String(who.username), String(who.role || ''), company, String(who.display_name || who.username), String(who.assistantUrl || '')]);
    await store.receipt(c, vault, 'person:' + who.username, 'signed-in', {from: 'home-app', role: String(who.role || '')});
  });
  await seedIfNew(vault, company, 'adamanteum');
  return redirect('/', {'set-cookie': `${COOKIE}=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}`});
}

// Server-to-server calls from a home app (never a browser): the same per-program pass value the hand-off uses.
function fromCommandCenter(req) {
  const expected = process.env.ADM_EXCHANGE_SECRET || '', got = String(req.headers[HANDOFF_HEADER.toLowerCase()] || '');
  if (expected.length < 32 || got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}
// A company's vault is created when the home app signs it up. Idempotent: a second call opens the same vault.
export async function provisionVault({tenant, company}) {
  const vault = vaultIdFor(tenant);
  if (!vault) throw Object.assign(Error('Give the company (tenant) the vault is for.'), {status: 400});
  await store.openVault(vault, String(company || ''), 'home-app');
  const created = await seedIfNew(vault, String(company || tenant), 'adamanteum');
  await store.inVault(vault, c => store.receipt(c, vault, 'home-app', 'vault-provisioned', {created, company: String(company || '')}));
  const documents = await store.inVault(vault, async c => (await c.query('select count(*)::int n from docs where vault = $1', [vault])).rows[0].n);
  return {ok: true, vault, created, documents};
}

async function person(req) {
  const sid = cookieOf(req.headers.cookie, COOKIE); if (!sid) return null;
  const row = await store.sessionRow(store.sha(sid));
  if (!row || new Date(row.expires_at) <= new Date()) return null;
  return {...row, sid};
}

export async function handle(req, {fetchImpl = fetch} = {}) {
  const url = new URL(req.url, 'https://adamanteum.local'), p = url.pathname, q = Object.fromEntries(url.searchParams);
  try {
    if (p === '/api/health') return json(200, {ok: true, program: 'Adamanteum', door: DOOR_BASE});
    if (p.startsWith(DOOR_BASE)) {
      const route = p.slice(DOOR_BASE.length) || '/', bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const requestedVault = String(req.headers['x-adamanteum-vault'] || q.vault || '');
      const [status, body] = await handleDoor({method: req.method, route, query: q, body: req.body || {}, bearer, requestedVault});
      return json(status, body);
    }
    if (p === '/api/service/provision' || p === '/api/service/assistant-key') {
      if (req.method !== 'POST' || !fromCommandCenter(req)) return json(404, {ok: false});
      const b = req.body || {};
      if (p === '/api/service/provision') return json(200, await provisionVault({tenant: b.tenant, company: b.company}));
      // Assistant's own key for ONE company's vault, an hour long, so the home app never stores a long-lived key.
      const vault = vaultIdFor(b.tenant), exists = vault && (await store.inVault(vault, async c => (await c.query('select 1 from vaults where vault = $1', [vault])).rowCount));
      if (!exists) return json(404, {ok: false, error: 'That company has no vault yet.'});
      const k = await mintToken(vault, {actor: 'assistant', scope: b.scope === 'read' ? 'read' : 'write', by: 'home-app', ttlSeconds: 3600});
      return json(200, {ok: true, vault, actor: k.actor, scope: k.scope, token: k.token, expiresInSeconds: 3600});
    }
    if (p === '/api/cc-handoff' || p === '/cc-handoff') return await cchandoff(q.cc_handoff || q.token || '', {fetchImpl});
    if (p.startsWith('/api/ui/')) {
      const me = await person(req);
      if (!me) return json(401, {error: 'Open Adamanteum from your home app to sign in.'});
      if (req.method === 'POST' && req.headers['x-adamanteum'] !== '1') return json(403, {error: 'Refused: not sent by the Adamanteum screen.'});
      const owner = isOwner(me.role), who = {vault: me.vault, actor: 'person:' + me.username, scope: 'write'};
      const sub = p.slice('/api/ui'.length);
      if (sub === '/me') return json(200, {vault: me.vault, company: me.company, username: me.username, displayName: me.display_name, role: me.role, owner, assistantUrl: me.assistant_url || ''});
      if (sub === '/signout' && req.method === 'POST') { await store.inVault(me.vault, c => c.query('delete from sessions where vault = $1 and id = $2', [me.vault, store.sha(me.sid)])); return json(200, {ok: true}, {'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`}); }
      if (sub === '/tokens') {
        if (!owner) return json(403, {error: 'Only the company owner manages keys.'});
        if (req.method === 'GET') return json(200, {vault: me.vault, tokens: await listTokens(me.vault)});
        const b = req.body || {}; return json(200, await mintToken(me.vault, {actor: String(b.actor || ''), scope: String(b.scope || 'read'), by: who.actor}));
      }
      if (sub === '/tokens/off' && req.method === 'POST') { if (!owner) return json(403, {error: 'Only the company owner manages keys.'}); return json(200, await revokeToken(me.vault, String((req.body || {}).id || ''), who.actor)); }
      if (sub.startsWith('/door/')) {
        const route = sub.slice('/door'.length);
        if (['/code/scan', '/model/attach'].includes(route) && !owner) return json(403, {error: 'Only the company owner does this.'});
        return json(200, await route15(doorFor(who), who, req.method, route, q, req.body || {}));
      }
      return json(404, {error: 'Unknown screen call.'});
    }
    return json(404, {error: 'Not found.'});
  } catch (e) {
    return json(e.status || 500, {error: e.status ? e.message : 'Something went wrong on our side. Try again.', ...(e.extra || {})});
  }
}
