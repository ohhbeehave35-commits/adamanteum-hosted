// Applies db/*.sql in order as the database owner (direct connection), then makes sure the program's own
// login, adm_app, exists with only the rights it needs. Prints counts, never a connection string or password.
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const owner = process.env.DATABASE_URL_UNPOOLED, appPassword = process.env.ADM_APP_PASSWORD;
if (!owner) throw Error('DATABASE_URL_UNPOOLED is not set.');
if (!appPassword || appPassword.length < 24) throw Error('ADM_APP_PASSWORD (24+ characters) is not set.');
const client = new pg.Client({connectionString: owner});
await client.connect();
const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
  await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
  console.log('applied', file);
}
const exists = (await client.query("select 1 from pg_roles where rolname = 'adm_app'")).rowCount > 0;
const quoted = (await client.query('select quote_literal($1) as q', [appPassword])).rows[0].q;
await client.query(`${exists ? 'alter' : 'create'} role adm_app with login nobypassrls password ${quoted}`);
await client.query('grant usage on schema public to adm_app');
await client.query('grant select, insert, update, delete on vaults, docs, links, tokens, receipts, code_graphs, models, sessions to adm_app');
await client.query('grant execute on function adm_token(text), adm_session(text), adm_open_vault(text, text, text) to adm_app');
const r = (await client.query("select rolbypassrls, rolsuper from pg_roles where rolname = 'adm_app'")).rows[0];
console.log('adm_app', exists ? 'updated' : 'created', 'bypassrls=' + r.rolbypassrls, 'super=' + r.rolsuper);
const forced = (await client.query("select count(*)::int n from pg_class where relname = any($1) and relrowsecurity and relforcerowsecurity",
  [['vaults', 'docs', 'links', 'tokens', 'receipts', 'code_graphs', 'models', 'sessions']])).rows[0].n;
console.log('tables with forced row security:', forced, 'of 8');
await client.end();
