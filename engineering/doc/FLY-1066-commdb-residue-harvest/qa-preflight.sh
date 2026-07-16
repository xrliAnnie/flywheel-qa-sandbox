#!/bin/bash
# FLY-1066 QA same-predicate preflight (READ-ONLY, log-only, non-destructive).
# Faithfully reproduces commdb-fsm-reconcile + statestore-ghost-reconcile harvest
# predicate against production DBs. No harvester is run; no row is deleted.
set -uo pipefail
SP=/private/tmp/claude-501/-Users-xiaorongli-Dev-flywheel-FLY-1066/3d6cde87-9071-47e8-af97-ad04200bae20/scratchpad
COMM=~/.flywheel/comm
NOW=$(date +%s)
DAY=$((24*3600)); MIN30=$((30*60))

# Fresh read-only copy of StateStore
cp ~/.flywheel/teamlead.db "$SP/ts.db" 2>/dev/null

fsm_status() { # execId -> StateStore status ("" if no row)
  sqlite3 "$SP/ts.db" "SELECT status FROM sessions WHERE execution_id='$1' LIMIT 1;" 2>/dev/null
}
ts_project() { sqlite3 "$SP/ts.db" "SELECT project_name FROM sessions WHERE execution_id='$1' LIMIT 1;" 2>/dev/null; }

probe() { # tmux target -> dead|alive|indeterminate (list-panes, read-only)
  local out rc
  out=$(tmux list-panes -t "$1" 2>&1); rc=$?
  if [ $rc -eq 0 ]; then echo alive
  elif echo "$out" | grep -qiE "session not found|can't find session|window not found|can't find window|can't find pane|no server running"; then echo dead
  else echo indeterminate; fi
}

age_secs() { # sqlite datetime -> seconds since (empty/invalid -> -1)
  local s="$1" e
  [ -z "$s" ] && { echo -1; return; }
  e=$(date -j -f "%Y-%m-%d %H:%M:%S" "${s%%.*}" +%s 2>/dev/null) || { echo -1; return; }
  echo $((NOW - e))
}

# Deletable-terminal FSM (FLY-817 RECONCILE_DELETABLE_STATES) + crash-preserve
is_deletable() { case "$1" in completed|rejected|deferred|shelved|terminated|approved) return 0;; *) return 1;; esac; }
is_preserve()  { case "$1" in failed|blocked) return 0;; *) return 1;; esac; }

CONFIGURED="geoforge3d joycon-typeless personal-assistant growth flywheel tidal-echo"
EXTRA="sub"   # not in main projects.json — harvested only by sub's own Bridge; audited for completeness

HARV=0; KEEP=0
classify_commdb() {
  local proj="$1" configured="$2"
  local db="$COMM/$proj/comm.db"
  [ -f "$db" ] || { echo "  ($proj: no comm.db)"; return; }
  cp "$db" "$SP/c-$proj.db" 2>/dev/null
  cp "$db-wal" "$SP/c-$proj.db-wal" 2>/dev/null
  cp "$db-shm" "$SP/c-$proj.db-shm" 2>/dev/null
  local rows; rows=$(sqlite3 "$SP/c-$proj.db" "SELECT execution_id||'|'||COALESCE(tmux_window,'')||'|'||COALESCE(started_at,'')||'|'||COALESCE(issue_id,'') FROM sessions WHERE status='running';" 2>/dev/null)
  [ -z "$rows" ] && { echo "  [$proj] CommDB running: 0"; return; }
  echo "  [$proj] CommDB running rows:"
  while IFS='|' read -r eid tw sa iid; do
    [ -z "$eid" ] && continue
    local fsm p a act reason
    fsm=$(fsm_status "$eid")
    a=$(age_secs "$sa")
    if is_preserve "$fsm"; then
      p=$(probe "$tw")
      if [ "$p" = dead ]; then act="HARVEST(face②preserve)"; reason="fsm=$fsm dead"; else act="KEEP"; reason="fsm=$fsm probe=$p"; fi
    elif [ -z "$fsm" ]; then
      if [ "$a" -lt 0 ]; then act="KEEP"; reason="orphan no-fsm age=invalid(failclosed)";
      elif [ "$a" -le "$DAY" ]; then act="KEEP"; reason="orphan no-fsm age=$((a/3600))h<24h";
      else p=$(probe "$tw"); if [ "$p" = dead ]; then act="HARVEST(face①orphan)"; reason="no-fsm age=$((a/3600))h dead"; else act="KEEP"; reason="no-fsm age=$((a/3600))h probe=$p"; fi; fi
    elif is_deletable "$fsm"; then
      p=$(probe "$tw")
      if [ "$p" = dead ]; then act="HARVEST(FLY817-fsm-terminal)"; reason="fsm=$fsm dead"; else act="KEEP"; reason="fsm=$fsm probe=$p"; fi
    else
      act="KEEP"; reason="fsm=$fsm non-terminal"
    fi
    [ "$configured" = "no" ] && act="$act[NOT-CONFIGURED:not-harvested-by-main-bridge]"
    case "$act" in HARVEST*) HARV=$((HARV+1));; KEEP*) KEEP=$((KEEP+1));; esac
    printf "    %-13s %-28s fsm=%-15s -> %s (%s)\n" "${eid:0:13}" "$tw" "${fsm:-<none>}" "$act" "$reason"
  done <<< "$rows"
}

echo "================ FLY-1066 same-predicate preflight (READ-ONLY) ================"
echo "now=$(date '+%Y-%m-%d %H:%M:%S')  24h-guard  30min-ghost-guard"
echo ""
echo "### CommDB face (①②+FLY-817) — configured projects (main Bridge harvests these) ###"
for p in $CONFIGURED; do classify_commdb "$p" yes; done
echo ""
echo "### CommDB face — sub (NOT in main projects.json; audited for completeness) ###"
for p in $EXTRA; do classify_commdb "$p" no; done
echo ""
echo "================ TOTALS: HARVEST=$HARV  KEEP=$KEEP ================"
