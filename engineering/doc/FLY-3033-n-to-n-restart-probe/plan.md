# FLY-3033 N-to-N 重启探针 — 实施计划
Issue: FLY-3033 (https://linear.app/geoforge3d/issue/FLY-3033/529-合成单勿派-fly-2920-真房-n-to-n-codex-实现体重启负载演练用)
日期: 2026-09-28
基于: research.md

## 0. 目标与不变量

在沙箱仓 `xrliAnnie/flywheel-qa-sandbox` 分支 `project-slot-2-FLY-3033` 上，`README.md` 末尾追加精确一行 `FLY-2920 N-to-N restart probe`，提交推送，开 PR，milestone 末提交冻结最终头 → 对冻结头请求代码复审 → 精确头 CI → `ask --report` → 注入的 complete 命令。

**终态**：README 4 行 / 74 字节——前 44 字节与 `origin/main:README.md` 逐字节相同，第 4 行为目标行；相对 `origin/main` 为 `+1/−0`；`origin/main..HEAD` 里恰 1 个改 README 的 commit；恰 1 个 OPEN PR；milestone 是 PR 头的字面最后一个 commit 且内容提到目标行；代码评审批准绑定这个最终头。

**核心不变量（为 FLY-2920 的重启 / 负载演练服务）**：每一步都 **幂等**——先用 git / GitHub / 文件判据判断「做过没」，做过就跳过，没做才动手。任何执行体在任何一步被杀，新体从 Task 0 重新跑同一套块都收敛到上面的终态。是否跳过某一步只看各 Task 的判据，**绝不看账本文字、进程或窗口**。

**顺序为什么是「先冻结、后评审」**：`await-codex-gate code` 校验 `reviewedHeadSha === HEAD`（`packages/flywheel-comm/src/commands/await-codex-gate.ts:243-254`）。评审之后再落任何 commit（账本、milestone）都会让批准失效。所以所有写入在评审 **之前** 完成并冻结，之后不再产生任何 commit。

**身份**：本设计 execution `f7ccb397-b37f-4ec4-ac05-0e20a0156121`（eng_design，attempt 1，TURN epoch 1）只记录本设计节点。实现节点一律使用自己注入的 `$FLYWHEEL_EXEC_ID` / activation / TURN，不复制设计身份。展示标签「Codex 实现体」不决定运行厂商，厂商由引擎按 models.json 分配。

所有命令都是 **POSIX sh**（Codex 体与 Claude 体都能逐字照抄；不用 here-doc、不依赖临时文件）。执行方式：**每个 Task 代码块前拼上 §1 常量块，作为一次独立的 `sh` 执行**（`stop` 用 `exit 1`，只终止这一次执行；块与块之间不共享变量，需要的值每块自己重新推导）。`stop` 之后的唯一正确动作：`node "$FLYWHEEL_COMM_CLI" ask --lead flywheel-test-2 --exec-id "$FLYWHEEL_EXEC_ID" "<STOP 原文 + git status --short + git log --oneline -5>"`，然后等 Lead，不自愈。

## 1. 常量与助手（拼在每个块前面）

```sh
cd "$(git rev-parse --show-toplevel)" || exit 1
BR=project-slot-2-FLY-3033
LINE='FLY-2920 N-to-N restart probe'
BASE_LAST='FLY-1375 land E2E marker 20260722T023540Z'
DOC=engineering/doc/FLY-3033-n-to-n-restart-probe
LEDGER=$DOC/progress.md
MS=engineering/doc/milestones/FLY-3033.md
REPO=xrliAnnie/flywheel-qa-sandbox
CLI="$FLYWHEEL_COMM_CLI"
EXEC="$FLYWHEEL_EXEC_ID"
stop() { echo "STOP: $*" >&2; exit 1; }
[ -n "$CLI" ] && [ -n "$EXEC" ] || stop "FLYWHEEL_COMM_CLI / FLYWHEEL_EXEC_ID 未注入"
# 冻结判据：HEAD 里存在 milestone 且其内容提到目标行。
# 新分支上 milestone 冻结前不存在：ls-tree 空输出 = 未冻结；git 出错 / 存在但不含目标行 = STOP（绝不当成未冻结）。
frozen() {
  t=$(git ls-tree --name-only HEAD -- "$MS") || stop "git ls-tree 失败，无法判定冻结状态"
  [ -n "$t" ] || return 1
  ms_body=$(git show "HEAD:$MS") || stop "读取 HEAD:$MS 失败，无法判定冻结状态"
  case "$ms_body" in
    *"$LINE"*) return 0 ;;
    *) stop "HEAD:$MS 存在但不含目标行（非本合同产物）" ;;
  esac
}
# 账本更新：冻结后自动 no-op（progress 每次都会落 commit）；账本已在本游标或更后时也 no-op（换体重放不让游标倒退）
prog() {
  if frozen; then echo "frozen: skip progress $1"; return 0; fi
  ph=$(sed -n 's/^phase: //p' "$LEDGER")
  cur=$(sed -n 's/^phaseCursor: \([0-9][0-9]*\)\/3$/\1/p' "$LEDGER")
  if [ "$ph" = implement ] && [ -n "$cur" ] && [ "$cur" -ge "${1%/*}" ]; then
    echo "ledger already at implement $cur/3: skip progress $1"; return 0
  fi
  node "$CLI" progress --exec-id "$EXEC" --file "$LEDGER" --phase implement --cursor "$1" --next "$2" || stop "progress failed"
}
# 范围白名单（§2）：先捕获列表并检查 git diff 退出码，再逐项匹配（不用 here-doc / 管道）
scope_ok() {
  files=$(git diff --name-only origin/main...HEAD) || stop "git diff 失败，无法判定范围"
  bad=
  old_ifs=$IFS
  IFS='
'
  set -f
  for f in $files; do
    case "$f" in
      README.md|"$DOC"/*|"$MS") : ;;
      *) bad="$bad $f" ;;
    esac
  done
  set +f
  IFS=$old_ifs
  [ -z "$bad" ] || stop "diff 超出白名单：$bad"
}
# 推送：推送前查范围，推送后核对远端头
pushbr() {
  scope_ok
  git push -u origin "HEAD:refs/heads/$BR" || stop "push 被拒（非快进需 Lead 确认 FORCE-PUSH ACK，禁止 --no-verify）"
  [ "$(git ls-remote origin "refs/heads/$BR" | cut -f1)" = "$(git rev-parse HEAD)" ] || stop "远端头 != 本地 HEAD"
}
# 当前分支唯一 OPEN PR 号（没有则为空）
open_pr() { gh pr list --repo "$REPO" --head "$BR" --state open --json number --jq '.[0].number // empty'; }
# 冻结头校验：已冻结 + milestone 为最后 commit + 远端头 = PR 头 = HEAD；成功时打印 "<HEAD_SHA> <PR>"
frozen_head() {
  frozen || { echo "STOP: 未冻结" >&2; return 1; }
  h=$(git rev-parse HEAD) || return 1
  [ "$(git log -1 --format=%H -- "$MS")" = "$h" ] || { echo "STOP: milestone 不是最后一个 commit" >&2; return 1; }
  [ "$(git ls-remote origin "refs/heads/$BR" | cut -f1)" = "$h" ] || { echo "STOP: 远端头 != HEAD" >&2; return 1; }
  p=$(open_pr) || { echo "STOP: gh pr list 失败" >&2; return 1; }
  [ -n "$p" ] || { echo "STOP: 取不到 PR 号" >&2; return 1; }
  [ "$(gh pr view "$p" --repo "$REPO" --json headRefOid --jq .headRefOid)" = "$h" ] || { echo "STOP: PR 头 != HEAD" >&2; return 1; }
  echo "$h $p"
}
```

凡是需要冻结头 / PR 号的块，都以 `fh=$(frozen_head) || stop "冻结头校验失败"; FROZEN_HEAD=${fh% *}; PR=${fh#* }` 开头重新推导，绝不引用别的块里 echo 过的值。`frozen` 在 `if`/`&&` 里调用时 `stop` 直接结束本次 sh；在 `frozen_head` 的 `$(…)` 里调用时结束子 shell、使 `frozen_head` 失败，调用方再 STOP。

## 2. 改动范围白名单（最终 PR diff）

`git diff --name-only origin/main...HEAD` 的每一行必须匹配下列之一（`scope_ok` 在 Task 0 与 **每次 push 之前** 检查）：

- `README.md`（相对 `origin/main` 恰好 `+1 −0`，Task 1 断言）
- `engineering/doc/FLY-3033-n-to-n-restart-probe/` 下的文件（设计文档、账本、founder HTML 及其 Mermaid 源 / SVG）
- `engineering/doc/milestones/FLY-3033.md`

## 3. 任务

实现节点账本游标（Task 0 不计数，总数 3）：Task 2 完成 → `1/3`；Task 3 完成 → `2/3`；Task 4 在 milestone commit **之前** 写 `3/3`（`next` 写明「已冻结：评审冻结头 → CI → 回报 → 交卷，这些步骤不再写账本」）。冻结之后账本不再更新（mutation freeze）。分支上的账本会留着设计阶段的 `design 5/5` 文字，**不影响任何判据**。

### Task 0 — 预检（每个新体第一件事）

```sh
[ "$(node "$CLI" turn --exec-id "$EXEC" | cut -d' ' -f1)" = yours ] || stop "TURN not yours（正常等待态：60–90s 后重跑本块，不算失败）"
[ "$(git remote get-url origin)" = "https://github.com/$REPO.git" ] || stop "remote 不是沙箱仓"
[ "$(git branch --show-current)" = "$BR" ] || stop "branch != $BR"
case "$(git config --get core.hooksPath)" in
  */state/push-guard/*) : ;;
  *) stop "core.hooksPath 不是 slot push-guard" ;;
esac
# 回收前体被杀时遗留的 git 锁（git commit / push 途中被杀会留下 *.lock，之后所有写操作都报 File exists）。
# 删除授权 = 已持有 TURN（上面第一行）+ 本工作区内没有任何存活的 git 进程（lsof 实查）。锁龄 ≥ 2 分钟只是等待条件，不是删除授权。
ROOT=$(pwd -P) || stop "pwd -P 失败"
for rel in index.lock HEAD.lock "refs/heads/$BR.lock" "refs/remotes/origin/$BR.lock"; do
  L=$(git rev-parse --git-path "$rel") || stop "git rev-parse --git-path $rel 失败"
  [ -e "$L" ] || continue
  [ -n "$(find "$L" -mmin +2 -print 2>/dev/null)" ] || stop "发现 2 分钟内的 $L，可能仍有 git 进程在写：90 秒后重跑 Task 0"
  command -v lsof >/dev/null 2>&1 || stop "无 lsof，无法确认前体 git 进程已退出，不删锁"
  # 单次枚举全部进程的 cwd（必须 exit 0）；同一份输出里必须含本 shell（$$）且 cwd = $ROOT 的记录（哨兵，证明枚举完整），
  # 再数其中命令名以 git 开头、cwd 在工作区内的进程。awk 失败 / 输出为空都落到 * 分支 STOP（fail-closed）。
  procs=$(lsof -d cwd -Fpcn 2>/dev/null) || stop "lsof 枚举失败（exit $?），无法确认前体 git 进程已退出，不删锁"
  verdict=$(printf '%s\n' "$procs" | awk -v me="$$" -v r="$ROOT" '
    /^p/ { pid = substr($0, 2); cmd = ""; next }
    /^c/ { cmd = substr($0, 2); next }
    /^n/ { d = substr($0, 2)
           if (pid == me && d == r) sentinel = 1
           if (cmd ~ /^git/ && (d == r || index(d, r "/") == 1)) live++ }
    END { if (sentinel) print "LIVE=" (live + 0); else print "NOSENTINEL" }')
  case "$verdict" in
    LIVE=0) : ;;
    LIVE=*) stop "本工作区仍有 ${verdict#LIVE=} 个存活的 git 进程：不删 $L，90 秒后重跑 Task 0；持续存在则 ask Lead" ;;
    *) stop "lsof 输出里找不到本 shell 的 cwd 记录（枚举不完整：$verdict），不删 $L" ;;
  esac
  rm -f "$L" || stop "删除孤儿锁 $L 失败"
  [ ! -e "$L" ] || stop "孤儿锁 $L 仍在"
  echo "已回收前体遗留的孤儿锁：$L"
done
git status --porcelain >/dev/null || stop "git status 失败（锁回收后仍无法读写仓库）"
git fetch -q origin || stop "fetch failed"
git merge-base --is-ancestor origin/main HEAD || stop "HEAD 不含 origin/main（需要技术同步，先 ask）"
if git ls-remote --exit-code origin "refs/heads/$BR" >/dev/null 2>&1; then
  git fetch -q origin "$BR" || stop "fetch $BR failed"
  git merge-base --is-ancestor "origin/$BR" HEAD || stop "远端 $BR 不是本地 HEAD 的祖先（分叉 / 前体推过更新的头）"
fi
scope_ok
# 允许的未提交残留只有前体在 Task 1–2 或 Task 4 中途被杀留下的 README / milestone；其它一律 STOP
dirty=$(git status --porcelain --untracked-files=all) || stop "git status 失败"
badd=
old_ifs=$IFS
IFS='
'
set -f
for d in $dirty; do
  case "$d" in
    ' M README.md'|'M  README.md'|'MM README.md'|"?? $MS"|"A  $MS"|"AM $MS") : ;;
    *) badd="$badd [$d]" ;;
  esac
done
set +f
IFS=$old_ifs
[ -z "$badd" ] || stop "工作区有白名单外的未提交改动：$badd"
if frozen; then
  [ "$(git log -1 --format=%H -- "$MS")" = "$(git rev-parse HEAD)" ] || stop "milestone 已存在但不是最后一个 commit"
  echo "FROZEN：跳到 Task 4（只做 push + 断言），再 Task 5、Task 6"
fi
cat "$LEDGER"
```

- TURN 为 `not-yours` 是正常等待态：**同一个体** 每 60–90 秒重跑 Task 0，拿到 `yours` 再继续。
- 工作区只允许「干净」、「README 已追加未提交 / 已暂存」（前体在 Task 1 与 Task 2 之间被杀）、「milestone 已写未提交 / 已暂存」（前体在 Task 4 中途被杀）；其它未提交改动一律 STOP，不清理别人的东西。README 残留的内容由 Task 1 断言兜底，milestone 残留由 Task 4 整体覆写（`>`）再提交。
- **锁回收为什么安全**（FLY-3030 R1–R3 已评审并演练）：删除前同时满足——持有 TURN（没有别的体会同时写）、锁已 ≥ 2 分钟未动、**同一次** `lsof -d cwd` 全进程枚举 exit 0 且含本 shell 的哨兵记录，并且其中没有 cwd 在本工作区内的存活 git 进程。`git commit` 先写 `index.lock` 再原子改名：改名前被杀 ⇒ 原索引完好，删锁即回到提交前；改名后被杀 ⇒ 提交已完成，锁已不存在。任何块因 `File exists` / `*.lock` STOP 时，一律回到 Task 0（它负责回收），不要手动删锁。

### Task 1 — 追加目标行（幂等）

```sh
orig=$(git show origin/main:README.md | od -An -tx1 | tr -d ' \n') || stop "读取 origin/main:README.md 失败"
[ "$(git show origin/main:README.md | wc -c | tr -d ' ')" = 44 ] || stop "origin/main 的 README 不是设计时的 44 字节（基线变了，先 ask）"
n=$(grep -cxF -- "$LINE" README.md) || n=0
case "$n" in
  0)
    frozen && stop "已冻结但 README 缺目标行"
    [ "$(tail -n 1 README.md)" = "$BASE_LAST" ] || stop "README 最后一行不是 FLY-1375 基线行，拒绝追加"
    [ "$(tail -c 1 README.md | od -An -tx1 | tr -d ' ')" = 0a ] || stop "README 末字节不是换行"
    printf '%s\n' "$LINE" >> README.md || stop "追加失败"
    ;;
  1)
    [ "$(tail -n 1 README.md)" = "$LINE" ] || stop "目标行已存在但不是最后一行"
    ;;
  *) stop "目标行出现 $n 次" ;;
esac
# 断言（任何状态下都必须成立）
[ "$(grep -cxF -- "$LINE" README.md)" = 1 ] || stop "目标行计数 != 1"
[ "$(head -c 44 README.md | od -An -tx1 | tr -d ' \n')" = "$orig" ] || stop "README 前 44 字节与 origin/main 不同"
[ "$(sed -n 4p README.md)" = "$LINE" ] || stop "第 4 行不是目标行"
[ "$(wc -l < README.md | tr -d ' ')" = 4 ] || stop "README 行数 != 4"
[ "$(wc -c < README.md | tr -d ' ')" = 74 ] || stop "README 字节数 != 74"
[ "$(git diff --numstat origin/main -- README.md)" = "$(printf '1\t0\tREADME.md')" ] || stop "README 相对 origin/main 不是 +1/-0"
```

`grep -c` 零命中时退出码为 1 但仍打印 `0`，所以用 `|| n=0` 兜住；`git diff --numstat origin/main -- README.md` 比较的是 **工作区 vs origin/main**，在未提交和已提交状态下都成立。

### Task 2 — 提交 README（幂等）

```sh
if git diff --quiet HEAD -- README.md; then
  echo "README 已提交，跳过"
else
  frozen && stop "已冻结但 README 有未提交改动"
  git add README.md || stop "git add README 失败（锁残留时回 Task 0）"
  git commit -m "docs(FLY-3033): append FLY-2920 N-to-N restart probe line" -- README.md || stop "commit failed（锁残留时回 Task 0）"
fi
git diff --quiet HEAD -- README.md || stop "README 仍有未提交改动"
[ "$(git log --format=%H origin/main..HEAD -- README.md | wc -l | tr -d ' ')" = 1 ] || stop "origin/main..HEAD 中 README commit 数 != 1"
[ "$(git diff --numstat origin/main HEAD -- README.md)" = "$(printf '1\t0\tREADME.md')" ] || stop "已提交的 README 相对 origin/main 不是 +1/-0"
prog 1/3 "Task 3: push + 开/更新 PR"
```

`progress` 只 path-limited 提交 `progress.md`，不带其它文件。

### Task 3 — 推送并开 / 更新 PR（幂等）

```sh
pushbr
TITLE='docs(FLY-3033): FLY-2920 N-to-N restart probe'
BODY=$(printf '%s\n' 'FLY-2920 QA 合成单（529 测试房专用，生产勿派）：README.md 末尾追加 `FLY-2920 N-to-N restart probe`。' '' 'Design: engineering/doc/FLY-3033-n-to-n-restart-probe/plan.md' '' '## Linear Issue' 'FLY-3033: [529 合成单·勿派] FLY-2920 真房 N-to-N · Codex 实现体（重启/负载演练用）' 'https://linear.app/geoforge3d/issue/FLY-3033' '' '## Test plan' '- [x] README 字节/行数/唯一性断言（plan Task 1：4 行 / 74 字节 / +1-0 / 前 44 字节不变）' '- [x] local-test-policy：选中测试集为空，未跑本地套件' '- [ ] PR 精确头 CI（全量证据）')
prs=$(gh pr list --repo "$REPO" --head "$BR" --state all --json number,state --jq '.[] | "\(.number) \(.state)"') || stop "gh pr list 失败（无法判定，别盲开 PR）"
case "$(printf '%s\n' "$prs" | grep -c .)" in
  0)
    gh pr create --repo "$REPO" --base main --head "$BR" --title "$TITLE" --body "$BODY" || stop "gh pr create 失败"
    ;;
  1)
    printf '%s\n' "$prs" | grep -q ' OPEN$' || stop "已有 PR 但不是 OPEN：$prs"
    P=${prs%% *}
    gh pr edit "$P" --repo "$REPO" --title "$TITLE" --body "$BODY" || stop "gh pr edit 失败"
    ;;
  *) stop "同分支有多个 PR：$prs" ;;
esac
PR=$(open_pr) || stop "gh pr list 失败"
[ -n "$PR" ] || stop "取不到 PR 号"
[ "$(gh pr view "$PR" --repo "$REPO" --json title,baseRefName --jq '.title + "|" + .baseRefName')" = "$TITLE|main" ] || stop "PR 标题或 base 不对"
echo "PR=$PR"
prog 2/3 "Task 4: 账本 3/3 → milestone 末提交（冻结）→ push"
pushbr
```

`gh pr create` 成功但在下一行前被杀：新体重跑时 `prs` 数到 1 个 OPEN，走 `edit` 分支（同标题同正文，无副作用），不会重复开 PR。body 用 `$(printf …)` 内联，避免 `--body-file` 路径与临时文件。

### Task 4 — 冻结：账本定稿 + milestone 末提交 + push（幂等）

顺序固定：**先写账本 3/3 → 再提交 milestone（字面最后一个 commit）→ push**。之后到交卷为止不再运行任何会产生 commit 的命令。

```sh
PR=$(open_pr) || stop "gh pr list 失败"
[ -n "$PR" ] || stop "取不到 PR 号"
if frozen; then
  [ "$(git log -1 --format=%H -- "$MS")" = "$(git rev-parse HEAD)" ] || stop "milestone 已存在但不是最后一个 commit"
  echo "已冻结（前体已提交 milestone）：跳过账本与 milestone 写入，只做 push + 断言"
else
  prog 3/3 "已冻结：评审冻结头 → 精确头 CI → ask --report → complete（这些步骤不再写账本）"
  mkdir -p engineering/doc/milestones || stop "mkdir 失败"
  printf '%s\n' \
    '# FLY-3033 implementation milestone' \
    '' \
    '**Issue**: FLY-3033 — [529 合成单·勿派] FLY-2920 真房 N-to-N · Codex 实现体（重启/负载演练用）' \
    "**Date**: $(date +%Y-%m-%d)" \
    "**PR**: https://github.com/$REPO/pull/$PR" \
    '' \
    '## Delivered scope' \
    '' \
    "- README.md 末尾追加 \`$LINE\`（第 4 行），前 44 字节与 origin/main 相同。" \
    '- README 相对 origin/main 为 +1/-0，无其它产品改动。' \
    '' \
    '## Verification evidence' \
    '' \
    '- README 断言：目标行恰 1 次且为第 4 行；4 行 / 74 字节；numstat 1/0。' \
    '- local-test-policy：选中测试集为空（纯文档改动），未跑本地套件；全量证据 = PR 精确头 CI。' \
    '- 代码评审：对本 commit（冻结头）请求，批准绑定该头。' \
    > "$MS" || stop "写 milestone 失败"
  [ "$(head -n 1 "$MS")" = '# FLY-3033 implementation milestone' ] || stop "milestone 内容异常"
  grep -qF "pull/$PR" "$MS" || stop "milestone 缺 PR 链接"
  grep -qF -- "$LINE" "$MS" || stop "milestone 未提到目标行"
  git add "$MS" || stop "git add milestone 失败（锁残留时回 Task 0）"
  git commit -m "docs(FLY-3033): implementation milestone" -- "$MS" || stop "milestone commit failed（锁残留时回 Task 0）"
fi
pushbr
fh=$(frozen_head) || stop "冻结头校验失败"
echo "冻结完成：HEAD=${fh% *} PR=${fh#* }（仅供人读；后续块自行重新推导）"
```

**换体安全性**：判据是 `frozen`（HEAD 里有提到目标行的 milestone），与是否已推送无关。`prog 3/3` 之后、milestone commit 之前被杀 → 新体再写一次账本（多一个账本 commit，在 milestone 之前，无害）后写 milestone，milestone 仍是最后；milestone 已写入工作区（或已 `git add`）但未提交时被杀 → HEAD 里没有 milestone，`frozen` 为假；Task 0 放行这条残留，Task 4 再写一次账本后用 `>` 整体覆写 milestone（PR 号重新推导）并提交；milestone commit 之后（无论推没推）被杀 → 新体所有写入都是 no-op，只做（幂等的）push 与断言。

### Task 5 — 对冻结头请求代码复审（只读，幂等）

每次进入 Task 5（包括换体后）先在 **同一次 sh 执行** 里跑下面的前置，再在同一次执行里接注入的评审命令：

```sh
fh=$(frozen_head) || stop "冻结头校验失败"
FROZEN_HEAD=${fh% *}
PR=${fh#* }
echo "评审对象：PR #$PR @ $FROZEN_HEAD"
# ↓ 在这里接实现节点注入的评审门命令（同一次执行，才能拿到上面的变量）。
#   Codex 作者族：注入的 `gate review_code --no-block` → `request-review --type code --question-id <id> …`（Bridge 复审）。
#   注入指令要求 await-codex-gate 时：
#   node "$CLI" await-codex-gate code --exec-id "$EXEC" || stop "code gate 未通过"
#   [ "$(git rev-parse HEAD)" = "$FROZEN_HEAD" ] || stop "评审期间 HEAD 变化"
```

- **评审对象** = 冻结头 `FROZEN_HEAD` 上相对 `origin/main` 的 PR diff（README 一行 + milestone + 设计文档）。若注入的实现协议要求评审提示词以 `local-test-policy` 块开头，照注入原文。
- **走注入的评审门**：本单 implement 按 models.json 分到 Codex，走 Bridge 复审（`request-review --type code`）；若实际运行体是 Claude 作者族，改走注入的 Claude 通道（`request-review` 会 409）。**具体命令以 Bridge 注入的指令为准**，本 plan 不替它发明参数。
- 评审是跨进程 / 异步时：每次需要冻结头 / PR 号都重跑上面三行前置，不手抄 SHA。
- **幂等**：已有绑定 `FROZEN_HEAD` 的 APPROVED（注入的 gate 命令立即通过）就跳过；否则重新请求——重复请求无副作用。
- **CHANGES_REQUESTED 且需要改任何文件** → STOP + ask Lead。冻结后不自行落 commit，由 Lead 决定是否解冻重来。
- **本地测试**：选中测试集为空（research §4），**不回退到任何宽命令**；Task 1 的字节断言即本地证据。不 `pnpm install`、不跑 `pnpm lint/test`（无依赖树，且 husky `prepare` 会改写 `core.hooksPath`）。

本 Task 不写账本（已冻结）。

### Task 6 — 精确头 CI + 回报 + 交卷（单块，只读直到 complete）

```sh
fh=$(frozen_head) || stop "冻结头校验失败，不能交卷"
HEAD_SHA=${fh% *}
PR=${fh#* }
i=0
while :; do
  n=$(gh pr view "$PR" --repo "$REPO" --json statusCheckRollup --jq '.statusCheckRollup | length') || stop "gh pr view 失败"
  [ "$n" != 0 ] && break
  i=$((i+1)); [ "$i" -le 20 ] || stop "10 分钟内 CI 未出现"
  sleep 30
done
gh pr checks "$PR" --repo "$REPO" --watch --interval 30
CI_RC=$?
[ "$CI_RC" = 0 ] || stop "精确头 CI 未全绿（gh pr checks exit $CI_RC）——对照 origin/main 最近 CI 判断是否 pre-existing，把证据 ask Lead，不修代码、不重推"
[ "$(gh pr view "$PR" --repo "$REPO" --json headRefOid --jq .headRefOid)" = "$HEAD_SHA" ] || stop "等待期间 PR 头漂移"
node "$CLI" ask --lead flywheel-test-2 --exec-id "$EXEC" --report "DONE: FLY-3033 restart probe line appended | commits: $(git log --format=%h origin/main..HEAD | tr '\n' ' ') | PR: https://github.com/$REPO/pull/$PR | head: $HEAD_SHA | CI: green" || stop "ask --report 失败，未交卷"
node "$CLI" complete --route needs_review --pr "$PR"
RC=$?
[ "$RC" = 0 ] || stop "complete exit $RC"
```

- `gh pr checks --watch` 在 `statusCheckRollup=[]` 时会立刻 exit 1 不等待，所以先有界轮询到非空再 watch。CI 约 13 分钟（`ci.yml` 的 build-and-test 超时 20 分钟），执行工具超时要设到 ≥ 1500 秒，否则工具超时会杀掉 watch——被杀了就重跑本块（只读，幂等）。
- `complete` exit 3（有未读邮件）：读输出里的邮件、处理、按提示 ack，然后 **只跑 Task 6b**（不重发 report）。
- 实现节点注入的完成命令与此不同时，**以注入命令为准**。
- 本块在 `ask --report` 之前被杀：重跑整块；在 `ask --report` 成功之后、`complete` 之前被杀：重跑整块会再报一次（内容相同，无害），然后交卷。

### Task 6b — 仅重试 complete（不重发 report）

```sh
fh=$(frozen_head) || stop "冻结头校验失败，不能交卷"
PR=${fh#* }
node "$CLI" complete --route needs_review --pr "$PR"
RC=$?
[ "$RC" = 0 ] || stop "complete exit $RC（exit 3 = 仍有未读邮件：处理并 ack 后再跑本块）"
```

## 4. 回滚边界

- 合并前：PR 未合，`main` 不受影响；撤销 = 关闭 PR。本设计节点与实现节点都不合并。
- 合并后：`git revert <README commit>` 单行即可；README 行对任何代码路径无影响。无数据迁移、无服务重启。

## 5. 负向守卫（显式不做）

- 不改 README 前 44 字节，不在别处加目标行，不重复追加。
- 不 `--no-verify`、不改 / 不 unset `core.hooksPath` 与 `extensions.worktreeConfig`、不 force push（非快进 → ask Lead）。
- 不 `pnpm install`、不跑本地测试套件、不改 `packages/`、CI、脚本、`CLAUDE.md`。
- 冻结后不落任何 commit（包括账本），评审批准只绑定冻结头。
- 不依赖窗口 / tmux / 进程存活做任何判断（「丢窗口不判死」由引擎负责）。
- 不向生产 Bridge / 生产仓做任何动作；不派单、不合并、不请求 ship、不部署。

## 6. 验收证据（交给 QA）

| 证据 | 取法 |
|---|---|
| 目标行唯一且在末尾 | `git show <PR头>:README.md \| sed -n 4p`；`grep -cxF` = 1；4 行 / 74 字节 |
| 原内容未动 | `git show <PR头>:README.md \| head -c 44` 与 `origin/main:README.md` 逐字节相同 |
| 恰 1 个 README commit | `git log --format=%s origin/main..<PR头> -- README.md` |
| milestone 为最后 commit | `git log -1 --format=%H <PR头> -- engineering/doc/milestones/FLY-3033.md` = PR 头，且内容含目标行 |
| diff 在白名单内 | §2 |
| 代码复审批准绑定 PR 头 | 注入评审门的落账（reviewed head = PR 头） |
| 精确头 CI 绿 | `gh pr checks <PR>` |
| 执行体生命周期（重启 / 负载下死体换体、同 thread 续干、交卷回 thread） | FLY-2920 driver receipt（不在本 plan 证据范围内；README 成功不能代替它） |

## 7. 设计阶段演练（dry-run）

在临时仓复刻本分支起点（44 字节 README + 本地 bare origin），配 `gh` / `flywheel-comm` 桩，把 §3 的代码块从本文件逐字抽出执行（每块 = §1 + 该块，一次独立 `/bin/sh`）。脚本在 `dry-run/`，结果记录在 `dry-run.md`：15 个场景（完工重放、追加后被杀、暂存后被杀、milestone 暂存后被杀、PR 已开后被杀、push 失败、越界、孤儿锁 / 新鲜锁、TURN not-yours、CI 失败、complete exit 3、冻结后读取失败、无临时目录）全部符合预期。
