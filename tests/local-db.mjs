// With no ADM_APP_DATABASE_URL set, the tests run on PGlite (Postgres in the test process): the program's own
// migration, then every query runs as adm_app, a role without BYPASSRLS, exactly as the hosted login does.
// So both locks (each query's WHERE vault and the database's forced row security) are tested with no database to set up.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as store from '../lib/store.mjs';

export let local = false;
if (!process.env.ADM_APP_DATABASE_URL) {
  const {PGlite} = await import('@electric-sql/pglite');
  const pg = new PGlite();
  const here = path.dirname(fileURLToPath(import.meta.url));
  await pg.exec(fs.readFileSync(path.join(here, '..', 'db', '001-vaults.sql'), 'utf8'));
  await pg.exec(`create role adm_app nobypassrls;
    grant usage on schema public to adm_app;
    grant select, insert, update, delete on vaults, docs, links, tokens, receipts, code_graphs, models, sessions to adm_app;
    grant execute on function adm_token(text), adm_session(text), adm_open_vault(text, text, text) to adm_app;
    set role adm_app;`);
  // PGlite is one connection: BEGIN/COMMIT pass straight through; connect() hands back a client over it.
  const run = (sql, args) => pg.query(sql, args);
  store.usePool({query: run, connect: async () => ({query: run, release() {}}), end: async () => pg.close()});
  local = true;
}
