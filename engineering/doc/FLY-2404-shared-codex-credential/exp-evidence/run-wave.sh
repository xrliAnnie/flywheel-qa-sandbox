#!/bin/bash
# NON-PRODUCTION: design evidence / QA regression only. This driver must never
# be used to refresh or repair the host's production credential truth.
# usage: run-wave.sh <wave-name> ; runs 6 concurrent codex exec against symlinked homes
S="$(cd "$(dirname "$0")" && pwd)"; W="$S/$1"; mkdir -p "$W"
shasum -a 256 "$S/${TRUTH:-truth/auth.json}" | cut -c1-16 > "$W/truth.sha.before"; stat -f "%i %p" "$S/${TRUTH:-truth/auth.json}" > "$W/truth.stat.before"
date -u +%FT%TZ > "$W/started"
for i in 1 2 3 4 5 6; do
  ( CODEX_HOME="$S/h$i" RUST_LOG=info timeout 180 codex exec --skip-git-repo-check -s read-only "respond with only: ok" </dev/null >"$W/p$i.out" 2>"$W/p$i.err"; echo $? > "$W/p$i.exit" ) &
done
wait
date -u +%FT%TZ > "$W/finished"
shasum -a 256 "$S/${TRUTH:-truth/auth.json}" | cut -c1-16 > "$W/truth.sha.after"; stat -f "%i %p" "$S/${TRUTH:-truth/auth.json}" > "$W/truth.stat.after"
python3 -c "import json;j=json.load(open('$S/${TRUTH:-truth/auth.json}'));print('truth last_refresh',j.get('last_refresh'))" > "$W/truth.meta.after" 2>&1
for i in 1 2 3 4 5 6; do
  printf "p%s exit=%s link=%s auth=%s\n" "$i" "$(cat $W/p$i.exit)" "$( [ -L $S/h$i/auth.json ] && echo yes || echo NO)" \
    "$(grep -c -E 'usage limit|^ok$' $W/p$i.out)"
done
echo "truth sha before/after: $(cat $W/truth.sha.before) / $(cat $W/truth.sha.after)"; echo "truth inode+mode before/after: $(cat $W/truth.stat.before) / $(cat $W/truth.stat.after)"; cat "$W/truth.meta.after"
echo "refresh lines: $(cat $W/p*.err | grep -c -i 'Refreshing token')  skipped-after-reload: $(cat $W/p*.err | grep -c -i 'auth changed after guarded reload')  reused/401: $(cat $W/p*.err $W/p*.out | grep -c -i -E 'refresh_token_reused|401|unauthorized')"
