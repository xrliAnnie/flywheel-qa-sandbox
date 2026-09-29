#!/bin/bash
# Dry-run harness for FLY-3033 plan.md. Usage: run.sh <plan.md>
PLAN=$1
H=$(cd "$(dirname "$0")" && pwd -P)
# 所有临时产物（抽出的块、每场景世界）都放仓库外
T=$(mktemp -d "${TMPDIR:-/tmp}/fly3033-dry.XXXXXX") || exit 1
PLAN=$(cd "$(dirname "$PLAN")" && pwd -P)/$(basename "$PLAN")
SRC=$(cd "$(dirname "$0")" && git rev-parse --show-toplevel)
block() { # $1 = heading prefix
  awk -v h="$1" 'index($0,h)==1{f=1;next} f&&/^```sh$/{p=1;next} p&&/^```$/{exit} p{print}' "$PLAN"
}
CONST=$(block "## 1. 常量与助手")
[ -n "$CONST" ] || { echo "no const block"; exit 1; }
for t in 0 1 2 3 4 5 6 6b; do
  if [ "$t" = 6 ]; then b=$(block "### Task 6 —"); else b=$(block "### Task $t "); fi
  [ -n "$b" ] || { echo "no block for task $t"; exit 1; }
  printf '%s\n%s\n' "$CONST" "$b" > "$T/blk-$t.sh"
done
setup() { # fresh world in $W
  W=$(mktemp -d "$T/w.XXXX"); export STATE=$W/state; mkdir -p "$STATE/push-guard/hooks"
  bash "$H/stubs.sh" "$W" >/dev/null
  export PATH="$W/bin:$PATH" FLYWHEEL_COMM_CLI=$W/comm.cjs FLYWHEEL_EXEC_ID=exec-dry
  git init -q --bare "$STATE/origin.git"
  git init -q -b main "$W/repo"; cd "$W/repo" || exit 1
  git config user.email d@d; git config user.name d
  (cd "$SRC" && git show origin/main:README.md) > README.md
  echo x > other.txt; git add .; git commit -qm base
  git remote add origin "$STATE/origin.git"; git push -q origin main
  git switch -qc project-slot-2-FLY-3033
  mkdir -p engineering/doc/FLY-3033-n-to-n-restart-probe
  cp "$PLAN" engineering/doc/FLY-3033-n-to-n-restart-probe/plan.md
  printf -- '---\nphase: design\nphaseCursor: 5/5\n---\n' > engineering/doc/FLY-3033-n-to-n-restart-probe/progress.md
  git add .; git commit -qm design; git push -q -u origin project-slot-2-FLY-3033
  git config core.hooksPath "$STATE/push-guard/hooks"
  git fetch -q origin
}
run() { # run task blocks in order; stop at first failure; echo trace
  for t in "$@"; do
    out=$(/bin/sh "$T/blk-$t.sh" 2>&1); rc=$?
    echo "  [T$t rc=$rc] $(printf '%s' "$out" | grep -E 'STOP|FROZEN|已冻结|跳过|回收' | head -2 | tr '\n' ' ')"
    [ $rc = 0 ] || return $rc
  done
}
final() {
  local ok=1 h; h=$(git rev-parse HEAD)
  [ "$(wc -c < README.md | tr -d ' ')" = 74 ] || ok=0
  [ "$(grep -cxF 'FLY-2920 N-to-N restart probe' README.md)" = 1 ] || ok=0
  [ "$(git log --format=%H origin/main..HEAD -- README.md | wc -l | tr -d ' ')" = 1 ] || ok=0
  [ "$(git log -1 --format=%H -- engineering/doc/milestones/FLY-3033.md)" = "$h" ] || ok=0
  [ "$(git --git-dir="$STATE/origin.git" rev-parse refs/heads/project-slot-2-FLY-3033)" = "$h" ] || ok=0
  [ -z "$(git status --porcelain)" ] || ok=0
  [ "$(cut -d'|' -f2 "$STATE/pr")" = OPEN ] || ok=0
  echo "  final: $([ $ok = 1 ] && echo OK || echo BAD) head=$(git log --oneline -1 | cut -c1-60) asks=$(grep -c '^ask' "$STATE/comm.log") completes=$(grep -c '^complete' "$STATE/comm.log") prcreates=$(grep -c 'pr create' "$STATE/gh.log")"
}
scen() { echo "== $1"; }

scen "A 全流程 + 完工后换体全部重跑"; setup; run 0 1 2 3 4 5 6; final; H1=$(git rev-parse HEAD); run 0 1 2 3 4 5 6; final; [ "$(git rev-parse HEAD)" = "$H1" ] && echo "  rerun HEAD unchanged: OK"; git log --format=%s origin/main..HEAD | sed 's/^/    /'
scen "M 未冻结就评审/交卷"; setup; run 0 1 2 3; run 5; run 6
scen "B 追加后被杀（未暂存）"; setup; run 0 1; run 0 1 2 3 4 5 6; final
scen "B2 追加并 git add 后被杀"; setup; run 0 1; git add README.md; run 0 1 2 3 4 5 6; final
scen "C milestone 写入并暂存后被杀"; setup; run 0 1 2 3; mkdir -p engineering/doc/milestones; echo junk > engineering/doc/milestones/FLY-3033.md; git add engineering/doc/milestones/FLY-3033.md; run 0 1 2 3 4 5 6; final
scen "C2 gh pr create 成功后被杀"; setup; run 0 1 2; git push -q origin HEAD:refs/heads/project-slot-2-FLY-3033; echo "101|OPEN|old|main" > "$STATE/pr"; run 0 1 2 3 4 5 6; final
scen "D milestone 已提交、push 失败后换体"; setup; run 0 1 2 3; printf '#!/bin/sh\nexit 1\n' > "$STATE/origin.git/hooks/pre-receive"; chmod +x "$STATE/origin.git/hooks/pre-receive"; run 4; rm "$STATE/origin.git/hooks/pre-receive"; run 0 1 2 3 4 5 6; final
scen "E 越界提交"; setup; echo y > foo.txt; git add foo.txt; git commit -qm foo; run 0
scen "E2 越界未跟踪文件"; setup; echo y > junk.txt; run 0
scen "L 2 分钟前的孤儿 index.lock"; setup; run 0 1; touch -t "$(date -v-5M +%Y%m%d%H%M)" .git/index.lock; run 2; run 0 1 2 3 4 5 6; final
scen "L2 新鲜锁"; setup; touch .git/index.lock; run 0; [ -e .git/index.lock ] && echo "  lock kept: OK"
scen "T TURN not-yours"; setup; H0=$(git rev-parse HEAD); TURN=not-yours run 0; [ "$(git rev-parse HEAD)" = "$H0" ] && [ -z "$(git status --porcelain)" ] && echo "  no writes: OK"
scen "G CI 失败"; setup; run 0 1 2 3 4 5; CHECKS_RC=1 run 6; echo "  asks=$(grep -c '^ask' "$STATE/comm.log") completes=$(grep -c '^complete' "$STATE/comm.log")"
scen "K complete exit 3 → 6b"; setup; run 0 1 2 3 4 5; COMPLETE_RC=3 run 6; run 6b; final
scen "R 冻结后 git show 失败"; setup; run 0 1 2 3 4; H0=$(git rev-parse HEAD); GIT_SHOW_FAIL=1 run 2; GIT_SHOW_FAIL=1 run 5; [ "$(git rev-parse HEAD)" = "$H0" ] && echo "  HEAD unchanged: OK"
scen "N 无临时目录"; setup; TMPDIR=/nonexistent run 0 1 2 3 4 5 6; final
