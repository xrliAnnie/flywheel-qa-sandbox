#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/canonical" "$TMP/managed"
printf '{}' > "$TMP/canonical/auth.json";chmod 600 "$TMP/canonical/auth.json"
ln -s "$TMP/canonical/auth.json" "$TMP/managed/auth.json"
node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify([{home:process.argv[2],ownership:"managed"}]))' "$TMP/homes.json" "$TMP/managed"
node "$ROOT/scripts/codex-quota-readiness-receipt.mjs" --approved-homes "$TMP/homes.json" --canonical-home "$TMP/canonical" --state-root "$TMP/state" --build-sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
node --input-type=module -e 'import {readFileSync} from "node:fs";import {computeCodexHomeInventoryDigest} from "./packages/claude-runner/dist/index.js";const r=JSON.parse(readFileSync(process.argv[1]));if(r.schemaVersion!==1||r.homes.length!==1||r.homes[0].credentialShared!==true||r.inventoryDigest!==computeCodexHomeInventoryDigest(r.homes))process.exit(1)' "$TMP/state/codex-quota/readiness-receipt.json"
rm "$TMP/managed/auth.json";printf '{}' > "$TMP/managed/auth.json"
if node "$ROOT/scripts/codex-quota-readiness-receipt.mjs" --approved-homes "$TMP/homes.json" --canonical-home "$TMP/canonical" --state-root "$TMP/invalid" --build-sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;then exit 1;fi
[ ! -e "$TMP/invalid/codex-quota/readiness-receipt.json" ]
echo 'PASS explicit approved-home readiness receipt'
