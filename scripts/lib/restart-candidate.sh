#!/bin/bash
# FLY-231: production-candidate resolver helpers for restart-services.sh.
#
# Extracted into a sourceable lib so the deploy-gating classification can be
# unit-tested (restart-services.sh itself is not sourceable — its top-level setup
# does git/lock/network). Sourced by restart-services.sh and by
# scripts/__tests__/fly231-restart-candidate.test.sh.
#
# Requires: FLYWHEEL_DIR set (path to the deployed flywheel repo), node, jq.

# _prod_membership <projectName> <leadId> → echoes "ok" | "missing" | "error"
# Resolves against the HOST production projects.json. Forces host config via
# `env -u FLYWHEEL_PROJECTS` so a leaked test fixture in the environment can never
# distort the production candidate set (Codex design R6 BLOCKER-1).
_prod_membership() {
  local pn="$1" lid="$2"
  env -u FLYWHEEL_PROJECTS node -e "
    import('file://${FLYWHEEL_DIR}/packages/teamlead/dist/ProjectConfig.js').then(({ loadProjects }) => {
      let ps; try { ps = loadProjects(); } catch { process.stdout.write('error'); return; }
      const p = ps.find(e => e.projectName === process.argv[1]);
      const lead = p && (p.leads || []).find(l => l.agentId === process.argv[2]);
      process.stdout.write(lead ? 'ok' : 'missing');
    }).catch(() => { process.stdout.write('error'); });
  " "$pn" "$lid" 2>/dev/null
}

# _classify_restart_manifest <leadId> <projectName> → "restart" | "skip-test" | "fail"
#   restart   — exact production match; restart it.
#   skip-test — test-slot-owned (leadId flywheel-test-*); skip WITHOUT counting
#               (must not block deployed-sha advance).
#   fail      — anything else (config drift / removed projects entry / typo /
#               loadProjects error). NOT silently skipped: caller counts it as a
#               failed restart → blocks the deploy (fail-closed). "Cannot match"
#               is NEVER treated as a test slot.
_classify_restart_manifest() {
  local lid="$1" pn="$2"
  case "$lid" in
    flywheel-test-*) echo "skip-test"; return 0 ;;
  esac
  case "$(_prod_membership "$pn" "$lid")" in
    ok) echo "restart" ;;
    *)  echo "fail" ;;
  esac
}
