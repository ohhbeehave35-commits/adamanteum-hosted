// The cross-company leak test. Two throwaway companies on one database:
// company A writes a note with a secret phrase; company B, through every read route and through raw SQL
// that forgets to name the vault, must see nothing of it. A's token must be refused at B's vault.
// Run: npm test (offline, PGlite) or node --env-file=<your env file> --test tests/leak.test.mjs (a real Postgres)
import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import './local-db.mjs';
import * as store from '../lib/store.mjs';
import {doorFor, handleDoor, mintToken} from '../lib/door.mjs';

const run = crypto.randomBytes(4).toString('hex');
const A = `zz-leaktest-a-${run}`, B = `zz-leaktest-b-${run}`;
const SECRET = `marmalade-${run}-quokka`, NOTE = `Private/Payroll-${run}.md`;
const a = doorFor({vault: A, actor: 'leaktest-a', scope: 'write'}), b = doorFor({vault: B, actor: 'leaktest-b', scope: 'write'});
let tokenA, tokenB;

before(async () => {
  await store.openVault(A, 'Leak Test Company A', 'leaktest');
  await store.openVault(B, 'Leak Test Company B', 'leaktest');
  await a.write({path: NOTE, body: `# Payroll ${run}\nOnly company A may read this: ${SECRET}. See [[Ledger-${run}]].\n#payroll`, expectedHash: null});
  await a.write({path: `Ledger-${run}.md`, body: `# Ledger ${run}\n${SECRET} ledger.`, expectedHash: null});
  await b.write({path: `Welcome-${run}.md`, body: `# Welcome to B ${run}\nNothing secret here.`, expectedHash: null});
  tokenA = (await mintToken(A, {actor: 'leaktest-a-reader', scope: 'read', by: 'leaktest'})).token;
  tokenB = (await mintToken(B, {actor: 'leaktest-b-reader', scope: 'read', by: 'leaktest'})).token;
});
after(async () => {
  for (const v of [A, B]) await store.inVault(v, async c => {
    for (const t of ['links', 'receipts', 'tokens', 'docs', 'code_graphs', 'models', 'sessions']) await c.query(`delete from ${t} where vault = $1`, [v]);
    await c.query('delete from vaults where vault = $1', [v]);
  });
  await store.db().end();
});

test('company A can read its own note (the test data is really there)', async () => {
  const hits = (await a.search({q: SECRET})).hits.map(h => h.path);
  assert.ok(hits.includes(NOTE), 'A finds its own note');
  assert.equal((await a.note({path: NOTE})).path, NOTE);
});
test('company B cannot find A\'s note by search', async () => {
  for (const q of [SECRET, `"${SECRET}"`, `path:Payroll-${run}`, `tag:payroll`, `Payroll ${run}`]) {
    const hits = (await b.search({q})).hits.map(h => h.path);
    assert.deepEqual(hits.filter(p => p.includes(run) && !p.startsWith('Welcome')), [], `search ${q} leaked: ${hits}`);
  }
});
test('company B cannot open A\'s note by path', async () => {
  await assert.rejects(b.note({path: NOTE}), e => e.status === 404);
  await assert.rejects(b.noteContext({path: NOTE}), e => e.status === 404);
});
test('company B\'s changed-since, receipts and link health show nothing of A', async () => {
  // B's own search receipts carry the words B typed; only what came back (paths, counts) may not point at A.
  const receipts = (await b.receipts({limit: 500})).receipts.map(({query, ...rest}) => rest);
  const text = JSON.stringify([await b.changedSince({since: '1h'}), receipts, await b.linkHealth(), await b.status()]);
  assert.ok(!text.includes(SECRET) && !text.includes(`Payroll-${run}`) && !text.includes(`Ledger-${run}`), `B's own reports mention A's notes: ${text.slice(0, 600)}`);
});
test('company B cannot overwrite or create over A\'s note', async () => {
  await b.write({path: NOTE, body: 'B wrote this', expectedHash: null});   // lands in B's own vault, not A's
  const mine = await a.note({path: NOTE});
  assert.ok(mine.raw.includes(SECRET), 'A\'s note is unchanged');
});
test('even SQL that forgets the vault sees only its own company (row-level security)', async () => {
  const seen = await store.inVault(B, async c => (await c.query('select path, body from docs')).rows);
  assert.ok(seen.every(r => !r.body.includes(SECRET)), `raw SQL in B's transaction saw A's rows: ${seen.map(r => r.path)}`);
  const receipts = await store.inVault(B, async c => (await c.query('select count(*)::int n from receipts where actor = $1', ['leaktest-a'])).rows[0].n);
  assert.equal(receipts, 0);
});
test('A\'s token is refused at B\'s vault, and B\'s token reads only B', async () => {
  const [code, body] = await handleDoor({method: 'GET', route: '/search', query: {q: SECRET}, bearer: tokenA, requestedVault: B});
  assert.equal(code, 403, JSON.stringify(body));
  const [okCode, own] = await handleDoor({method: 'GET', route: '/search', query: {q: SECRET}, bearer: tokenB, requestedVault: B});
  assert.equal(okCode, 200); assert.equal(own.vault, B); assert.equal(own.count, 0);
  const [, viaA] = await handleDoor({method: 'GET', route: '/search', query: {q: SECRET}, bearer: tokenA});
  assert.equal(viaA.vault, A); assert.ok(viaA.count >= 1);
  const refused = (await a.receipts({kind: 'refused'})).receipts;
  assert.ok(refused.some(r => r.reason === 'token is for another vault'), 'the refusal is on A\'s own receipts');
});
test('a switched-off token stops working at once', async () => {
  const t = await mintToken(A, {actor: 'leaktest-off', scope: 'read', by: 'leaktest'});
  assert.equal((await handleDoor({method: 'GET', route: '/status', query: {}, bearer: t.token}))[0], 200);
  const {revokeToken} = await import('../lib/door.mjs');
  assert.equal((await revokeToken(A, t.id, 'leaktest')).switchedOff, true);
  assert.equal((await handleDoor({method: 'GET', route: '/status', query: {}, bearer: t.token}))[0], 401);
});
