#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d /tmp/fly2103-config-generators.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

generated="$(
  source "${ROOT}/scripts/lib/qa-multilead.sh"
  qa_multilead_config_yaml test-slot-1 generalized
)"

if grep -Eq '^[[:space:]]+enabled:[[:space:]]|^pipeline:' <<<"$generated"; then
  echo "FAIL: QA config generator emitted retired project flag keys" >&2
  exit 1
fi

if ! grep -A1 '^doc_flow:$' <<<"$generated" \
  | grep -Fq '  default_department: engineering'; then
  echo "FAIL: QA config generator omitted doc_flow.default_department metadata" >&2
  exit 1
fi

for mode in ordinary generalized; do
  config_path="${TMP}/${mode}.yaml"
  (
    source "${ROOT}/scripts/lib/qa-multilead.sh"
    qa_multilead_config_yaml test-slot-1 "$mode"
  ) > "$config_path"
  node --input-type=module - "$ROOT" "$config_path" <<'NODE'
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [, , root, file] = process.argv;
const { ConfigLoader } = await import(
  pathToFileURL(join(root, "packages/config/dist/index.js")).href
);
await new ConfigLoader((path) => readFile(path, "utf8")).load(file);
NODE
done

for script in setup-new-project.sh setup-doc-flow.sh; do
  if grep -Eq '^[[:space:]]+(enabled|split|dag|work_kind):[[:space:]]+(true|false)' "${ROOT}/scripts/${script}"; then
    echo "FAIL: ${script} still emits a retired YAML project flag" >&2
    exit 1
  fi
done

grep -Fq 'feature-flags set --name ponytail --to on --project <project>' \
  "${ROOT}/scripts/setup-ponytail.sh" || {
    echo "FAIL: setup-ponytail.sh still lacks scoped flag-store guidance" >&2
    exit 1
  }

if grep -Fq "ponytail: { enabled: true }" "${ROOT}/scripts/setup-ponytail.sh"; then
  echo "FAIL: setup-ponytail.sh still recommends the retired YAML key" >&2
  exit 1
fi

echo "fly2103 project config generator tests: passed"
