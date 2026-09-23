#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FENCE="$ROOT/scripts/codex-home-launch-fence.mjs"
RECONCILE="$ROOT/scripts/codex-home-reconcile.mjs"
TMP="$(mktemp -d /tmp/fly2523-launch-fence.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
USER_HOME="$TMP/home"
STATE_ROOT="$USER_HOME/.flywheel"
CANONICAL="$USER_HOME/.codex"
LEAD_HOME="$USER_HOME/.codex-raya"
REGISTRY="$TMP/registry.json"
APPROVED="$TMP/approved.json"
mkdir -p "$STATE_ROOT" "$CANONICAL/profiles/personal" "$LEAD_HOME"
PS_BIN="$TMP/ps"
cat > "$PS_BIN" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [ "${2:-}" = "ppid=" ]; then
  case "${4:-}" in
    "$FLY2523_TEST_ROOT_PID") printf '%s\n' 1 ;;
    1) printf '%s\n' 0 ;;
    *) printf '%s\n' "$FLY2523_TEST_ROOT_PID" ;;
  esac
  exit 0
fi
printf '%s\n' 'Thu Sep 18 00:00:00 2026'
SH
chmod +x "$PS_BIN"
export FLYWHEEL_CODEX_FENCE_PS_BIN="$PS_BIN" FLY2523_TEST_ROOT_PID="$$"

snapshot() {
	python3 - "$1" <<'PY'
import hashlib, json, os, pathlib, stat, sys
root = pathlib.Path(sys.argv[1])
items = []
for path in sorted([root, *root.rglob("*")], key=lambda item: str(item)):
    value = path.lstat()
    entry = {"path": str(path.relative_to(root)) if path != root else ".", "mode": stat.S_IMODE(value.st_mode), "mtime": value.st_mtime_ns, "ctime": value.st_ctime_ns, "size": value.st_size}
    if path.is_symlink(): entry["link"] = os.readlink(path)
    elif path.is_file(): entry["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    items.append(entry)
print(hashlib.sha256(json.dumps(items, sort_keys=True).encode()).hexdigest())
PY
}

printf '%s\n' '{"version":2,"primary":"personal"}' > "$REGISTRY"
python3 - "$CANONICAL/auth.json" <<'PY'
import base64, json, pathlib, sys
payload = base64.urlsafe_b64encode(json.dumps({"email":"personal@example.test","https://api.openai.com/auth":{"chatgpt_account_id":"acct-personal","chatgpt_plan_type":"pro"}}).encode()).decode().rstrip("=")
pathlib.Path(sys.argv[1]).write_text(json.dumps({"tokens":{"id_token":"e30.%s.sig" % payload,"access_token":"fixture-access","refresh_token":"fixture-refresh"}}))
PY
chmod 600 "$CANONICAL/auth.json"
cp "$CANONICAL/auth.json" "$CANONICAL/profiles/personal/auth.json"
printf 'lead-copy' > "$LEAD_HOME/auth.json"
printf 'pending\n' > "$LEAD_HOME/.credential-copy-pending"
node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify([{id:"raya/raya",home:process.argv[2],ownership:"managed",leadTuple:"raya/raya"}]))' "$APPROVED" "$LEAD_HOME"

node "$FENCE" acquire --home "$LEAD_HOME" --lead raya/raya --state-root "$STATE_ROOT" >/dev/null
lease="$(find "$STATE_ROOT/codex-quota/home-migration/lead-leases" -type f -name '*.json' -print -quit)"
[ -n "$lease" ]
jq -e --argjson pid "$$" --arg home "$LEAD_HOME" '.pid == $pid and .home == $home and .lead == "raya/raya"' "$lease" >/dev/null
before="$(shasum -a 256 "$lease" | awk '{print $1}')"
node "$FENCE" acquire --home "$LEAD_HOME" --lead raya/raya --state-root "$STATE_ROOT" >/dev/null
[ "$(shasum -a 256 "$lease" | awk '{print $1}')" = "$before" ]

# Descendants in the same launch generation reuse the exact live ancestor
# lease instead of self-locking when ensure-daemon runs in a child shell.
bash -c 'node "$1" acquire --home "$2" --lead raya/raya --state-root "$3" >/dev/null' \
	fly2523 "$FENCE" "$LEAD_HOME" "$STATE_ROOT"

# A live owner outside the caller's ancestor chain remains a hard conflict.
foreign_home="$USER_HOME/.codex-foreign"
mkdir "$foreign_home"
foreign_ready="$TMP/foreign-ready"
foreign_release="$TMP/foreign-release"
(
	node "$FENCE" acquire --home "$foreign_home" --lead raya/foreign --state-root "$STATE_ROOT" >/dev/null
	: > "$foreign_ready"
	while [ ! -e "$foreign_release" ]; do sleep 0.05; done
) &
foreign_pid=$!
for _ in $(seq 1 100); do
	[ -e "$foreign_ready" ] && break
	sleep 0.05
done
[ -e "$foreign_ready" ]
set +e
node "$FENCE" acquire --home "$foreign_home" --lead raya/foreign --state-root "$STATE_ROOT" >/dev/null 2>&1
busy_rc=$?
set -e
[ "$busy_rc" -eq 3 ]
: > "$foreign_release"
wait "$foreign_pid"

home_before="$(snapshot "$LEAD_HOME")"
HOME="$USER_HOME" \
FLYWHEEL_BUILD_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
FLYWHEEL_CODEX_SOURCE_HOME="$CANONICAL" \
FLYWHEEL_CODEX_ACCOUNT_REGISTRY_PATH="$REGISTRY" \
node "$RECONCILE" --approved-homes "$APPROVED" --state-root "$STATE_ROOT" --source manual > "$TMP/receipt.json"
home_after="$(snapshot "$LEAD_HOME")"
[ "$home_before" = "$home_after" ]
jq -e '.result == "skipped" and .reason == "active_lease" and .satisfied == false' "$TMP/receipt.json" >/dev/null

# A dead PID+start lease is reclaimed under the same fence.
dead_home="$USER_HOME/.codex-dead"
mkdir "$dead_home"
dead_key="$(printf '%s' "$dead_home" | shasum -a 256 | awk '{print $1}')"
dead_lease="$STATE_ROOT/codex-quota/home-migration/lead-leases/$dead_key.json"
printf '%s\n' '{"schemaVersion":1,"pid":99999999,"processStartTime":"dead","home":"'"$dead_home"'","lead":"raya/dead","acquiredAt":"2026-09-18T00:00:00.000Z"}' > "$dead_lease"
node "$FENCE" acquire --home "$dead_home" --lead raya/dead --state-root "$STATE_ROOT" >/dev/null
jq -e --argjson pid "$$" '.pid == $pid and .lead == "raya/dead"' "$dead_lease" >/dev/null

grep -Fq 'acquire_codex_home_launch_fence || return $?' "$ROOT/scripts/flywheel-lead.sh"
grep -Fq 'node "$FENCE_BIN" acquire' "$ROOT/packages/teamlead/scripts/codex-lead.sh"
grep -Fq 'FLYWHEEL_CODEX_LAUNCH_FENCE_REQUIRED' "$ROOT/packages/teamlead/scripts/codex-lead-tui-home.sh"

echo "PASS Codex Lead credential launch fence"
