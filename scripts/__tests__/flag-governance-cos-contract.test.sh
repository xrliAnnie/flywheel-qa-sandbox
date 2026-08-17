#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
identity="$repo_root/.lead/flywheel-cos-lead/identity.md"

grep -Fq 'Flag-governance exception (FLY-1781, absolute)' "$identity"
grep -Fq 'never dispatch it, never assign a Runner' "$identity"
grep -Fq 'never add a department label (`Flywheel` / `Flywheel-Product`)' "$identity"
grep -Fq '<!-- flywheel:flag-governance run=... -->' "$identity"

echo "PASS: CoS prompt treats flag-governance ledgers as non-executable"
