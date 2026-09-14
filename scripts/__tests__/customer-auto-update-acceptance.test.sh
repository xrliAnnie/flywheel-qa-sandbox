#!/bin/bash
# Real endpoint + release CLI + packed public shell; all state lives in temp fixtures.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
node --test "$ROOT/scripts/__tests__/fixtures/customer-auto-update-acceptance.mjs"
