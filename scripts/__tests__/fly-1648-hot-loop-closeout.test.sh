#!/usr/bin/env bash
set -euo pipefail

FLY1648_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$FLY1648_REPO_ROOT"

pnpm --filter flywheel-teamlead build >/dev/null
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/fly-1648-hot-loop-closeout.test.ts
