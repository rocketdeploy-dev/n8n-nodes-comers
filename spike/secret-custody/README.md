# M7 secret-custody spike

Evidence harness for the Comers machine-credentials plan, M7 phase A: can a
community trigger node persist the HMAC signing secret that Comers returns once
at registration, in storage n8n encrypts, through the public node contract?

It is not part of the published package (`files` is `dist` only).

## What it runs

- `docker-compose.yml` — n8n (default 2.40.5, latest stable when run) in queue
  mode: main + worker on PostgreSQL and Redis, an explicit
  `N8N_ENCRYPTION_KEY`, and `extension/` loaded through `N8N_CUSTOM_EXTENSIONS`.
- `extension/` — a spike credential with a password field and a spike trigger
  whose `webhookMethods.create` writes canary values into workflow static data
  (`node` and `global`) — the only persistent storage `IHookFunctions` offers —
  and whose `webhook()` reports only whether each canary is present.
- `run-spike.mjs` — creates the credential (with its own canary) and the
  workflow through the REST API, activates it through the public API,
  delivers, and collects REST, public-API and execution responses.
- `scan.sh` — dumps the database, exports workflows and credentials (plain and
  `--decrypted`), collects logs, and prints where each canary appears. It prints
  presence only, never values.

```sh
docker compose up -d
# wait for "Editor is now accessible", then create the owner:
curl -s -X POST http://127.0.0.1:5679/rest/owner/setup -H 'content-type: application/json' \
  -d '{"email":"spike@example.test","firstName":"Spike","lastName":"Owner","password":"SpikeOwner123!"}'
node run-spike.mjs setup
node run-spike.mjs deliver          # once the webhook is published
node run-spike.mjs collect first
./scan.sh first
docker compose restart n8n worker   # then deliver/collect/scan again
docker compose down -v
```

## Result (2026-09-22, n8n 2.40.5, queue mode)

| Where | Static data canary (`node`, `global`) | Credential canary |
| --- | --- | --- |
| PostgreSQL | **plaintext** in `workflow_entity."staticData"` | encrypted |
| Workflow export (`n8n export:workflow`) | **plaintext** | absent |
| `GET /rest/workflows/:id`, `GET /api/v1/workflows/:id` | **plaintext** | absent |
| Credential export (`n8n export:credentials`) | absent | encrypted |
| Credential export `--decrypted` (operator) | absent | plaintext |
| `GET /rest/credentials/:id?includeData=true` | absent | masked |
| Execution data (REST and public API) | absent | absent |
| Logs (main and worker, debug level) | absent | absent |
| After restarting main and worker | readable | readable |
| Same database, different `N8N_ENCRYPTION_KEY` | still **plaintext** | cannot be decrypted |

The public hook context (`IHookFunctions`) and webhook context
(`IWebhookFunctions`) expose `getWorkflowStaticData` and a read-only
`getCredentials`; neither offers a way to create or update a credential.
Credential updates exist only on n8n's internal `ICredentialsHelper`.

Verdict: **custody gate FAIL** — see §16.5 of
`comers-docs-core/docs/services/comers-core-iam/machine-credentials-architecture-and-implementation-plan.md`.
