#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
node --test "$ROOT/scripts/__tests__/install-voice-launchd.test.mjs"
