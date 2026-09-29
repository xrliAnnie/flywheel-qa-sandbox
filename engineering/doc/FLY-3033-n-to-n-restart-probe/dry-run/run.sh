#!/bin/bash
# Dry-run harness for FLY-3033 plan.md. Usage: bash run.sh <plan.md>
# 从 plan.md 逐字抽出 §1 + 各 Task 代码块，每块作为一次独立 /bin/sh 执行；每个场景一个全新临时世界。
export LC_ALL=en_US.UTF-8
PLAN=$1
H=$(cd "$(dirname "$0")" && pwd -P)
# 所有临时产物（抽出的块、每场景世界）都放仓库外
T=$(mktemp -d "${TMPDIR:-/tmp}/fly3033-dry.XXXXXX") || exit 1
PLAN=$(cd "$(dirname "$PLAN")" && pwd -P)/$(basename "$PLAN")
SRC=$(cd "$(dirname "$0")" && git rev-parse --show-toplevel)
# 真实 flywheel-comm 的 progress 实现（崩溃切点场景用）
REAL_PROGRESS_JS=$(dirname "${FLYWHEEL_COMM_CLI:?需要真实 FLYWHEEL_COMM_CLI}")/commands/progress.js
export REAL_PROGRESS_JS
[ -f "$REAL_PROGRESS_JS" ] || { echo "no $REAL_PROGRESS_JS"; exit 1; }
block() { # $1 = heading prefix
  awk -v h="$1" 'index($0,h)==1{f=1;next} f&&/^```sh$/{p=1;next} p&&/^```$/{exit} p{print}' "$PLAN"
}
CONST=$(block "## 1. 常量与助手")
[ -n "$CONST" ] || { echo "no const block"; exit 1; }
for t in 0 1 2 3 4 5a 5b 6 6b; do
  case "$t" in
    6) b=$(block "### Task 6 —") ;;
    5a|5b) b=$(block "#### Task $t ") ;;
    *) b=$(block "### Task $t ") ;;
  esac
  [ -n "$b" ] || { echo "no block for task $t"; exit 1; }
  printf '%s\n%s\n' "$CONST" "$b" > "$T/blk-$t.sh"
done
ALL="0 1 2 3 4 5a 5b 6"
setup() { # fresh world in $W
  W=$(mktemp -d "$T/w.XXXX"); export STATE=$W/state; mkdir -p "$STATE/push-guard/hooks"
  bash "$H/stubs.sh" "$W" >/dev/null
  export PATH="$W/bin:$PATH" FLYWHEEL_COMM_CLI=$W/comm.cjs FLYWHEEL_EXEC_ID=exec-dry
  git init -q --bare "$STATE/origin.git"
  git init -q -b main "$W/repo"; cd "$W/repo" || exit 1
  git config user.email d@d; git config user.name d
  printf '.flywheel/runs/\n' >> .git/info/exclude
  (cd "$SRC" && git show origin/main:README.md) > README.md
  echo x > other.txt; git add .; git commit -qm base
  git remote add origin "$STATE/origin.git"; git push -q origin main
  git switch -qc project-slot-2-FLY-3033
  mkdir -p engineering/doc/FLY-3033-n-to-n-restart-probe
  cp "$PLAN" engineering/doc/FLY-3033-n-to-n-restart-probe/plan.md
  printf -- '---\nissue: FLY-3033\nphase: design\nphaseCursor: 5/5\nchunks: []\npointers: {}\n---\n' > engineering/doc/FLY-3033-n-to-n-restart-probe/progress.md
  git add .; git commit -qm design; git push -q -u origin project-slot-2-FLY-3033
  git config core.hooksPath "$STATE/push-guard/hooks"
  git fetch -q origin
}
run() { # run task blocks in order; stop at first failure; echo trace
  for t in "$@"; do
    out=$(/bin/sh "$T/blk-$t.sh" 2>&1); rc=$?
    echo "  [T$t rc=$rc] $(printf '%s' "$out" | grep -E 'STOP|FROZEN|已冻结|跳过|回收|已注册' | head -2 | paste -sd' ' -)"
    [ $rc = 0 ] || return $rc
  done
}
cnt() { if [ -f "$1" ]; then grep -c "${2:-.}" "$1"; else echo 0; fi; }
final() {
  local ok=1 h; h=$(git rev-parse HEAD)
  [ "$(wc -c < README.md | tr -d ' ')" = 74 ] || ok=0
  [ "$(grep -cxF 'FLY-2920 N-to-N restart probe' README.md)" = 1 ] || ok=0
  [ "$(git log --format=%H origin/main..HEAD -- README.md | wc -l | tr -d ' ')" = 1 ] || ok=0
  [ "$(git log -1 --format=%H -- engineering/doc/milestones/FLY-3033.md)" = "$h" ] || ok=0
  [ "$(git --git-dir="$STATE/origin.git" rev-parse refs/heads/project-slot-2-FLY-3033)" = "$h" ] || ok=0
  [ -z "$(git status --porcelain --untracked-files=all)" ] || ok=0
  [ "$(cut -d'|' -f2 "$STATE/pr")" = OPEN ] || ok=0
  echo "  final: $([ $ok = 1 ] && echo OK || echo BAD) head=$(git log --oneline -1 | cut -c1-50) asks=$(cnt "$STATE/comm.log" '^ask') completes=$(cnt "$STATE/comm.log" '^complete') prcreates=$(cnt "$STATE/gh.log" 'pr create') gates=$(ls "$STATE" | grep -c '^gate-') requests=$(cnt "$STATE/requests.log")"
  echo "  ledger commits: $(git log --format=%s origin/main..HEAD | grep -o 'implement [0-9]/3' | tr '\n' ' ')"
}
age() { for f in "$@"; do [ -e "$f" ] && touch -t "$(date -v-5M +%Y%m%d%H%M)" "$f"; done; }
scen() { echo "== $1"; }

scen "A 全流程 + 完工后换体全部重跑"; setup; run $ALL; final; H1=$(git rev-parse HEAD); run $ALL; final; [ "$(git rev-parse HEAD)" = "$H1" ] && echo "  rerun HEAD unchanged: OK"; git log --format=%s origin/main..HEAD | sed 's/^/    /'
scen "M 未冻结就评审/交卷"; setup; run 0 1 2 3; run 5a; run 5b; run 6
scen "B 追加后被杀（未暂存）"; setup; run 0 1; run $ALL; final
scen "B2 追加并 git add 后被杀"; setup; run 0 1; git add README.md; run $ALL; final
scen "C milestone 写入并暂存后被杀"; setup; run 0 1 2 3; mkdir -p engineering/doc/milestones; echo junk > engineering/doc/milestones/FLY-3033.md; git add engineering/doc/milestones/FLY-3033.md; run $ALL; final
scen "C2 gh pr create 成功后被杀"; setup; run 0 1 2; git push -q origin HEAD:refs/heads/project-slot-2-FLY-3033; echo "101|OPEN|old|main" > "$STATE/pr"; run $ALL; final
scen "D milestone 已提交、push 失败后换体"; setup; run 0 1 2 3; printf '#!/bin/sh\nexit 1\n' > "$STATE/origin.git/hooks/pre-receive"; chmod +x "$STATE/origin.git/hooks/pre-receive"; run 4; rm "$STATE/origin.git/hooks/pre-receive"; run $ALL; final
scen "E 越界提交"; setup; echo y > foo.txt; git add foo.txt; git commit -qm foo; run 0
scen "E2 越界未跟踪文件"; setup; echo y > junk.txt; run 0
scen "L 5 分钟前的孤儿 index.lock"; setup; run 0 1; touch .git/index.lock; age .git/index.lock; run 2; run $ALL; final
scen "L2 新鲜锁"; setup; touch .git/index.lock; run 0; [ -e .git/index.lock ] && echo "  lock kept: OK"
scen "LC push -u 途中被杀留下 config.lock"; setup; run 0 1 2; echo x > .git/config.lock; age .git/config.lock; run 3; run $ALL; final
for m in after-lock before-rename after-rename after-commit; do
  scen "P[$m] 真实 progress 在切点被 SIGKILL"; setup; run 0 1; git add README.md; git commit -qm README -- README.md
  node "$H/progress-crash.mjs" "$m" >/dev/null 2>&1; echo "  crash rc=$? residue: $(git status --porcelain --untracked-files=all | tr '\n' ';')"
  run 0
  L=engineering/doc/FLY-3033-n-to-n-restart-probe/progress.md; age "$L" "$L".lock "$L".tmp-*
  run $ALL; final
done
scen "P-fresh 残留刚产生"; setup; run 0 1; git add README.md; git commit -qm README -- README.md; node "$H/progress-crash.mjs" after-lock >/dev/null 2>&1; run 0; [ -e engineering/doc/FLY-3033-n-to-n-restart-probe/progress.md.lock ] && echo "  residue kept: OK"
scen "P-live 仍有存活的 progress 写者"; setup; run 0 1; L=engineering/doc/FLY-3033-n-to-n-restart-probe/progress.md; echo x > "$L.lock"; age "$L.lock"
  HANG=1 node "$FLYWHEEL_COMM_CLI" progress --exec-id exec-dry --file "$L" & HP=$!; sleep 1; run 0; kill $HP; wait $HP 2>/dev/null; [ -e "$L.lock" ] && echo "  residue kept: OK"; run $ALL; final
scen "F 冻结后才出现账本锁残留"; setup; run 0 1 2 3 4; H0=$(git rev-parse HEAD); L=engineering/doc/FLY-3033-n-to-n-restart-probe/progress.md; echo x > "$L.lock"; age "$L.lock"; run 0 4 5a 5b 6; [ "$(git rev-parse HEAD)" = "$H0" ] && echo "  HEAD unchanged: OK"; final
scen "V1 注册完成后换体重跑（不开第二个门）"; setup; run 0 1 2 3 4 5a; run 0 4 5a 5b 6; final
scen "V2 开门后、记 questionId 前被杀"; setup; run 0 1 2 3 4; mkdir -p .flywheel/runs/exec-dry; printf 'head=%s\ngateOpening=x\n' "$(git rev-parse HEAD)" > .flywheel/runs/exec-dry/code-review.rec; run 5a; echo "  gates=$(ls "$STATE" | grep -c '^gate-')"
scen "V3 记 requestId 后、注册失败"; setup; run 0 1 2 3 4; REQ_RC=1 run 5a; run 5a 5b 6; final; echo "  distinct requestIds=$(cut -d' ' -f1 "$STATE/requests.log" | sort -u | wc -l | tr -d ' ')"
scen "V4 记录头与冻结头不同"; setup; run 0 1 2 3 4; mkdir -p .flywheel/runs/exec-dry; printf 'head=deadbeef\nquestionId=q-9\n' > .flywheel/runs/exec-dry/code-review.rec; run 5a; run 5b
scen "V5 CHANGES_REQUESTED 不交卷"; setup; run 0 1 2 3 4 5a; VERDICT=CHANGES_REQUESTED run 5b; echo "  (5b 只打印裁决；按 plan 由执行体读 reviewVerdict 决定 STOP + ask，不进 Task 6)"
scen "T TURN not-yours"; setup; H0=$(git rev-parse HEAD); TURN=not-yours run 0; [ "$(git rev-parse HEAD)" = "$H0" ] && [ -z "$(git status --porcelain)" ] && echo "  no writes: OK"
scen "G CI 失败"; setup; run 0 1 2 3 4 5a 5b; CHECKS_RC=1 run 6; echo "  asks=$(cnt "$STATE/comm.log" '^ask') completes=$(cnt "$STATE/comm.log" '^complete')"
scen "K complete exit 3 → 6b"; setup; run 0 1 2 3 4 5a 5b; COMPLETE_RC=3 run 6; run 6b; final
scen "R 冻结后 git show 失败"; setup; run 0 1 2 3 4; H0=$(git rev-parse HEAD); GIT_SHOW_FAIL=1 run 2; GIT_SHOW_FAIL=1 run 5a; [ "$(git rev-parse HEAD)" = "$H0" ] && echo "  HEAD unchanged: OK"
scen "N 无临时目录"; setup; TMPDIR=/nonexistent run $ALL; final
