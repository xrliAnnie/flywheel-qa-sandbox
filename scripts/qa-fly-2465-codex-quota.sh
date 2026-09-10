#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
bench_result_root="$(mktemp -d "${TMPDIR:-/tmp}/fly-2465-bench-evidence.XXXXXX")"
cd "$repo_root"
FLY2465_BENCH_OUTPUT="$bench_result_root/receipt.json" pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/codex-quota-bench.test.ts
printf 'Synthetic isolated bench receipt: %s/receipt.json\n' "$bench_result_root"
