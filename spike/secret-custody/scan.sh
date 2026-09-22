#!/usr/bin/env bash
# Canary scan for the M7 secret-custody spike. Reports, per canary kind, where
# a plaintext copy exists. Prints presence only — never the values.
set -euo pipefail
LABEL="${1:-now}"
E=evidence/$LABEL
mkdir -p "$E"
compose() { docker compose "$@"; }

compose exec -T postgres pg_dump -U n8n -d n8n >"$E/db.sql"
compose exec -T n8n n8n export:workflow --all --output=/tmp/wf.json >/dev/null 2>&1 && compose exec -T n8n cat /tmp/wf.json >"$E/export-workflow.json"
compose exec -T n8n n8n export:credentials --all --output=/tmp/cred.json >/dev/null 2>&1 && compose exec -T n8n cat /tmp/cred.json >"$E/export-credentials.json"
compose exec -T n8n n8n export:credentials --all --decrypted --output=/tmp/cred-dec.json >/dev/null 2>&1 && compose exec -T n8n cat /tmp/cred-dec.json >"$E/export-credentials-decrypted.json"
compose exec -T n8n sh -c 'rm -f /tmp/wf.json /tmp/cred.json /tmp/cred-dec.json'
compose logs --no-color n8n >"$E/log-main.txt" 2>&1
compose logs --no-color worker >"$E/log-worker.txt" 2>&1
[ -f "evidence/api-$LABEL.json" ] && cp "evidence/api-$LABEL.json" "$E/api.json"

printf '%-34s %-6s %-6s %-6s\n' "artefact" "NODE" "FLOW" "CRED"
for file in "$E"/*; do
  row=$(basename "$file")
  printf '%-34s' "$row"
  for kind in NODE FLOW CRED; do
    if grep -q "M7CANARY-$kind-" "$file"; then printf ' %-6s' "yes"; else printf ' %-6s' "-"; fi
  done
  echo
done
