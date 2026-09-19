#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SUT="$ROOT/scripts/codex-home-reconcile.mjs"
TMP="$(mktemp -d /tmp/fly2523-reconcile.XXXXXX)"
if [ "${KEEP_TMP:-0}" = 1 ]; then
	printf 'fixture retained at %s\n' "$TMP" >&2
else
	trap 'rm -rf "$TMP"' EXIT
fi

USER_HOME="$TMP/user"
CANONICAL="$USER_HOME/.codex"
STATE_ROOT="$USER_HOME/.flywheel"
TARGET="$STATE_ROOT/codex-homes/agents/flywheel/implement"
REGISTRY="$TMP/registry.json"
APPROVED="$TMP/approved.json"
PS_BIN="$TMP/ps"
BUILD_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

mode_of() {
	stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null
}

mkdir -p "$CANONICAL" "$TARGET"
printf '%s\n' '{"version":1,"primary":"personal","profiles":[{"name":"school","email":"school@example.test","role":"manual_backup"},{"name":"personal","email":"personal@example.test","role":"primary"},{"name":"business","email":"business@example.test","role":"manual_backup"}]}' > "$REGISTRY"
python3 - "$CANONICAL/auth.json" <<'PY'
import base64, json, pathlib, sys
payload = base64.urlsafe_b64encode(json.dumps({"email":"personal@example.test","https://api.openai.com/auth":{"chatgpt_account_id":"acct-personal","chatgpt_plan_type":"pro"}}).encode()).decode().rstrip("=")
pathlib.Path(sys.argv[1]).write_text(json.dumps({"tokens":{"id_token":"e30.%s.sig" % payload,"access_token":"fixture-access","refresh_token":"fixture-refresh"}}))
PY
chmod 600 "$CANONICAL/auth.json"
CANONICAL_TRUTH="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$CANONICAL/auth.json")"
printf 'legacy-copy' > "$TARGET/auth.json"
chmod 600 "$TARGET/auth.json"
printf '2026-09-11T17:58:38Z\n' > "$TARGET/.credential-copy-pending"
node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify([{id:"flywheel/implement",home:process.argv[2],ownership:"managed",pendingAt:"2026-09-11T17:58:38.000Z"}]))' "$APPROVED" "$TARGET"

cat > "$PS_BIN" <<'SH'
#!/usr/bin/env bash
set -eu
case "${RECONCILE_PS_MODE:-empty}:${1:-}" in
	live:-axo) printf '991 1 codex\n' ;;
	live:-E) printf 'CODEX_HOME=%s codex app-server\n' "$RECONCILE_TARGET" ;;
	fail:*) exit 1 ;;
	empty:-axo) exit 0 ;;
	*) exit 1 ;;
esac
SH
chmod +x "$PS_BIN"

snapshot() {
	python3 - "$1" <<'PY'
import hashlib, json, os, pathlib, stat, sys
root = pathlib.Path(sys.argv[1])
items = []
for path in sorted([root, *root.rglob("*")], key=lambda p: str(p)):
    st = path.lstat()
    item = {"path": str(path.relative_to(root)) if path != root else ".", "mode": stat.S_IMODE(st.st_mode), "mtime": st.st_mtime_ns, "ctime": st.st_ctime_ns, "size": st.st_size}
    if path.is_symlink(): item["link"] = os.readlink(path)
    elif path.is_file(): item["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    items.append(item)
print(hashlib.sha256(json.dumps(items, sort_keys=True).encode()).hexdigest())
PY
}

run_reconcile() {
	HOME="$USER_HOME" \
	FLYWHEEL_BUILD_SHA="$BUILD_SHA" \
	FLYWHEEL_CODEX_SOURCE_HOME="$CANONICAL" \
	FLYWHEEL_CODEX_ACCOUNT_REGISTRY_PATH="$REGISTRY" \
	FLYWHEEL_CODEX_LINK_PS_BIN="$PS_BIN" \
	FLYWHEEL_CODEX_LINK_HELPER="$ROOT/packages/claude-runner/bin/flywheel-codex-link-truth.mjs" \
	FLYWHEEL_CODEX_LINK_TRUTH_BIN="${RECONCILE_LINK_BIN:-$ROOT/scripts/codex-home-link-truth.sh}" \
	RECONCILE_TARGET="$TARGET" \
	RECONCILE_PS_MODE="${RECONCILE_PS_MODE:-empty}" \
	node "$SUT" \
		--approved-homes "$APPROVED" \
		--state-root "$STATE_ROOT" \
		--source manual \
		--home-id flywheel/implement
}

before="$(snapshot "$TARGET")"
if ! RECONCILE_PS_MODE=live run_reconcile > "$TMP/skipped.json"; then
	cat "$TMP/skipped.json" >&2
	exit 1
fi
after="$(snapshot "$TARGET")"
[ "$before" = "$after" ]
jq -e '.result == "skipped" and .reason == "active_process" and .satisfied == false' "$TMP/skipped.json" >/dev/null
attempt="$(find "$STATE_ROOT/codex-quota/home-migration/attempts" -type f -name '*.json' -print -quit)"
jq -e '.result == "skipped" and .reason == "active_process"' "$attempt" >/dev/null

if ! RECONCILE_PS_MODE=empty run_reconcile > "$TMP/done.json"; then
	cat "$TMP/done.json" >&2
	exit 1
fi
jq -e '.result == "done" and .reason == "linked" and .satisfied == true' "$TMP/done.json" >/dev/null
[ -L "$TARGET/auth.json" ]
[ "$(readlink "$TARGET/auth.json")" = "$CANONICAL_TRUTH" ]
[ ! -e "$TARGET/.credential-copy-pending" ]
backup_count="$(find "$STATE_ROOT/codex-credential-backups" -type f | wc -l | tr -d ' ')"
[ "$backup_count" -eq 1 ]
backup="$(find "$STATE_ROOT/codex-credential-backups" -type f -print -quit)"
[ "$(cat "$backup")" = legacy-copy ]
[ "$(mode_of "$backup")" = 600 ]

before="$(snapshot "$TARGET")"
if ! RECONCILE_PS_MODE=fail run_reconcile > "$TMP/already.json"; then
	cat "$TMP/already.json" >&2
	exit 1
fi
after="$(snapshot "$TARGET")"
[ "$before" = "$after" ]
jq -e '.result == "already-satisfied" and .reason == "canonical_link_verified" and .satisfied == true' "$TMP/already.json" >/dev/null
[ "$(find "$STATE_ROOT/codex-credential-backups" -type f | wc -l | tr -d ' ')" -eq 1 ]

foreign="$TMP/foreign-auth.json"
printf 'foreign' > "$foreign"
rm "$TARGET/auth.json"
ln -s "$foreign" "$TARGET/auth.json"
before_foreign="$(shasum -a 256 "$foreign" | awk '{print $1}')"
set +e
RECONCILE_PS_MODE=empty run_reconcile > "$TMP/wrong.json"
wrong_rc=$?
set -e
[ "$wrong_rc" -ne 0 ]
jq -e '.result == "failed" and .satisfied == false' "$TMP/wrong.json" >/dev/null
[ "$(shasum -a 256 "$foreign" | awk '{print $1}')" = "$before_foreign" ]
[ -L "$TARGET/auth.json" ]
[ "$(readlink "$TARGET/auth.json")" = "$foreign" ]

rm "$TARGET/auth.json"
printf 'second-copy' > "$TARGET/auth.json"
chmod 600 "$TARGET/auth.json"
printf 'pending\n' > "$TARGET/.credential-copy-pending"
before_concurrent_backups="$(find "$STATE_ROOT/codex-credential-backups" -type f | wc -l | tr -d ' ')"
barrier="$TMP/barrier"
mkdir "$barrier"
barrier_link="$TMP/barrier-link.sh"
cat > "$barrier_link" <<SH
#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" --keep-backup "* ]]; then
	touch "$barrier/\$\$"
	for _ in {1..20}; do
		[ "\$(find "$barrier" -type f | wc -l | tr -d ' ')" -ge 2 ] && break
		sleep 0.05
	done
fi
exec "$ROOT/scripts/codex-home-link-truth.sh" "\$@"
SH
chmod +x "$barrier_link"
set +e
RECONCILE_LINK_BIN="$barrier_link" RECONCILE_PS_MODE=empty run_reconcile > "$TMP/concurrent-a.json" &
pid_a=$!
RECONCILE_LINK_BIN="$barrier_link" RECONCILE_PS_MODE=empty run_reconcile > "$TMP/concurrent-b.json" &
pid_b=$!
wait "$pid_a"; rc_a=$?
wait "$pid_b"; rc_b=$?
set -e
[ "$rc_a" -eq 0 ]
[ "$rc_b" -eq 0 ]
after_concurrent_backups="$(find "$STATE_ROOT/codex-credential-backups" -type f | wc -l | tr -d ' ')"
[ $((after_concurrent_backups - before_concurrent_backups)) -eq 1 ]
jq -s -e '(map(.result) | sort) == ["done", "skipped"] and ((map(.reason) | index("lock_busy")) != null)' "$TMP/concurrent-a.json" "$TMP/concurrent-b.json" >/dev/null

echo "PASS codex home reconcile active/idle/idempotent contract"
