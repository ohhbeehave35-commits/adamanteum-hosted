# Adamanteum hosted

One private notes vault per company, on Postgres, with one door that any AI can use with a plain key.

- Each company's notes live in their own vault. Two locks keep them apart: every query names its vault, and the database's forced row-level security refuses any row from another vault even if a query forgets.
- Bring your own AI: make a key, call the routes. No model of ours is needed.
- Every call leaves a receipt: who, when, what, and the note's sha256.

MIT licensed. The desktop version (one person, your own folder, no server) is in the companion repository `adamanteum`.

## Try it on your computer

You need [Node.js](https://nodejs.org) 24 or newer. No database to set up: with nothing configured it runs on an in-memory Postgres (PGlite) that is emptied when it stops.

```bash
git clone <this repository URL> adamanteum-hosted
cd adamanteum-hosted
npm install && npm start
```

Open http://127.0.0.1:4291/api/cc-handoff?cc_handoff=mock-a to sign in as the owner of a made-up company (`mock-b` is a second company, to see that neither can read the other).

Run the tests, including the cross-company leak test:

```bash
npm test
```

## Put it on Vercel with a real Postgres

1. Create a Postgres database (any provider; Neon works well with Vercel).
2. Apply the schema and create the program's own login, `adm_app`, which cannot bypass row security:
   ```bash
   DATABASE_URL_UNPOOLED=<owner connection> ADM_APP_PASSWORD=<24+ characters> npm run migrate
   ```
3. Import the repository into Vercel and set these environment variables:

| Variable | What it is |
|---|---|
| `ADM_APP_DATABASE_URL` | Connection string for the `adm_app` login (pooled) |
| `ADM_KEY_SECRET` | 32+ random characters; seals model keys attached to a vault |
| `ADAMANTIUM_LOG_DIR` | Folder for decision and results files (default `Log`) |
| `ADM_HANDOFF_URL`, `ADM_EXCHANGE_SECRET` | Optional. Sign-in hand-off and sign-up hook from a home app you run; off unless both are set |
| `ADM_HANDOFF_HEADER` | Optional. Header name for that hand-off (default `X-App-Secret`) |

## Bring your own AI: make a key, call the routes

A company owner makes a key on the vault's **Keys** page. A `read` key can look; a `write` key can also save. Then any AI, script or tool calls the door at `/api/door/v1` with `Authorization: Bearer <key>`:

```bash
curl -H "Authorization: Bearer $KEY" https://your-deployment.example/api/door/v1/search?q=refunds
```

| Route | Key | One example |
|---|---|---|
| `GET /status` | read | `/status` — who you are, which vault, document count |
| `GET /search` | read | `/search?q=tag:pricing "annual plan"` |
| `GET /navigate` | read | `/navigate?q=what did we decide about refunds` — hits with the line, the reason and the sha256 |
| `GET /path` | read | `/path?from=Price book&to=Team/Dana` — the shortest chain of links |
| `GET /note` | read | `/note?path=Customers/Cho residence.md` |
| `GET /context` | read | `/context?path=Projects/Spring.md&depth=2` |
| `GET /changed-since` | read | `/changed-since?since=24h` |
| `GET /link-health` | read | `/link-health` — broken links, orphans, duplicate names |
| `GET /code` | read | `/code?q=handleCheckout` — symbols, callers and callees with file:line |
| `GET /graph` | read | `/graph?format=mermaid&limit=200` |
| `GET /receipts` | read | `/receipts?since=7d&actor=my-ai` |
| `GET /models` | read | `/models` — model connections on this vault, never their keys |
| `POST /ask` | read | `{"connectionId":"c1","question":"Who owns pricing?","consent":true}` |
| `POST /note` | write | `{"path":"Notes/Call.md","body":"# Call\n...","expectedHash":null}` |
| `POST /results` | write | `{"seat":"AGENT1","body":"# Results\n..."}` |
| `POST /decision` | write | `{"text":"Refunds never move money.","topic":"Refunds"}` |
| `POST /code/scan` | write | `{"graph": <code map JSON from the desktop scan>}` |
| `POST /model/attach` | write | `{"profile":{...},"key":"<your provider key>"}` — sealed for this vault only |

A key belongs to exactly one vault. A key from one company is refused at every other company's vault. Writing a note that changed since you read it is refused (send its current sha256 as `expectedHash`).

## Use it from an MCP app

`mcp-server.mjs` turns the door into MCP tools for Claude Desktop, Cursor, Codex, Grok and other MCP apps. Set `ADAMANTIUM_DOOR_URL` to your deployment and `ADAMANTIUM_DOOR_TOKEN_FILE` to a file holding the key. Details in `MCP.md`.

## Licence

MIT. See `LICENSE` and `NOTICE`.
