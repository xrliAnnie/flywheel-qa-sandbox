# FLY-3030 N-to-N 探针（第 2 轮 · claude-body）— 实施计划
Issue: FLY-3030 (https://linear.app/geoforge3d/issue/FLY-3030/529-合成单勿派-fly-2919-真房-n-to-n-codex-体)
日期: 2026-09-28
基于: research.md

## 0. 目标与不变量

本分支已完成第 1 轮（README 第 4 行 `FLY-2919 N-to-N codex-body probe` + milestone，PR #299 OPEN @ `95c81c6d8`）。本轮（run `bba2d1b6`）的任务文本改为：

1. **先在前台 `sleep 780`（13 分钟），自然结束后才做下一步**——FLY-2919 driver 要观察「活体丢窗口不判死」的完整 660 秒窗口。不得跳过、放后台或缩短。
2. 在 `README.md` 末尾追加一行 `FLY-2919 N-to-N claude-body probe`，提交推送并按 implement 合同交卷：PR（复用 #299）→ milestone 末提交（冻结最终头）→ 对冻结头做代码评审 → 精确头 CI → `ask --report` → `complete --route needs_review`。

**终态**：README 5 行 / 111 字节——第 4 行 codex-body（第 1 轮，保留不动）、第 5 行 claude-body（本轮）；相对 `origin/main` 为 `+2/−0`；`origin/main..HEAD` 里恰 2 个 README commit（subject 含 `claude-body` 的恰 1 个）；恰 1 个 OPEN PR；milestone 是 PR 头的最后一个 commit 且内容提到本轮目标行；代码评审批准绑定这个最终头。

**核心不变量（为 FLY-2919 的「死体换体 / 同 thread 续干」服务）**：每一步都 **幂等**——先用 git/GitHub/文件判据判断「已完成？」，已完成就跳过，未完成才动手。任何执行体在任何一步被杀，新体从 Task S 重新跑同一套命令都收敛到上面的终态。

**为什么冻结判据必须按轮次**：第 1 轮 plan 用「milestone 在 HEAD 里」判冻结，这在本分支上**已经成立**；照抄会让新体把一切当成已冻结、永远不追加 claude 行。本轮冻结 = `HEAD:<milestone>` 的内容包含本轮目标行（第 1 轮 milestone 不含）。

**顺序为什么是「先冻结、后评审」**：代码评审门校验 `reviewedHeadSha === HEAD`（`packages/flywheel-comm/src/commands/await-codex-gate.ts` 的 code 分支）。评审之后再落任何 commit（账本、milestone）都会让批准失效。所以所有写入在评审 **之前** 完成并冻结，之后不再产生任何 commit。

所有命令都是 **POSIX sh**（Codex 体与 Claude 体都能逐字照抄）。执行方式：**每个 Task 代码块前拼上 §1 常量块，作为一次独立的 `sh` 执行**（`stop` 用 `exit 1`，只终止这一次执行；块与块之间不共享变量，需要的值每块自己重新推导）。

## 1. 常量与助手（拼在每个块前面）

```sh
cd "$(git rev-parse --show-toplevel)" || exit 1
BR=project-slot-2-FLY-3030
LINE='FLY-2919 N-to-N claude-body probe'
OLD='FLY-2919 N-to-N codex-body probe'
DOC=engineering/doc/FLY-3030-n-to-n-codex-probe
LEDGER=$DOC/progress.md
MS=engineering/doc/milestones/FLY-3030.md
REPO=xrliAnnie/flywheel-qa-sandbox
CLI="$FLYWHEEL_COMM_CLI"
EXEC="$FLYWHEEL_EXEC_ID"
stop() { echo "STOP: $*" >&2; exit 1; }
# 本轮冻结判据：HEAD 里的 milestone 提到本轮目标行（第 1 轮 milestone 不含 → 未冻结）。
# 本分支第 1 轮 milestone 必然存在，所以读取失败（缺文件 / git 出错）一律 STOP，绝不当成「未冻结」。
frozen() {
  ms_body=$(git show "HEAD:$MS") || stop "读取 HEAD:$MS 失败，无法判定冻结状态"
  case "$ms_body" in
    *"$LINE"*) return 0 ;;
    *) return 1 ;;
  esac
}
prog() {
  if frozen; then echo "frozen: skip progress $1"
  else node "$CLI" progress --exec-id "$EXEC" --file "$LEDGER" --phase implement --cursor "$1" --next "$2" || stop "progress failed"
  fi
}
# 范围白名单（§2）：先捕获列表并检查 git diff 退出码，再逐项匹配
scope_ok() {
  files=$(git diff --name-only origin/main...HEAD) || stop "git diff 失败，无法判定范围"
  bad=
  # 不用 here-doc / 管道：here-doc 需要临时文件（受限沙箱里会失败而静默跳过循环），管道会丢变量
  old_ifs=$IFS
  IFS='
'
  set -f
  for f in $files; do
    case "$f" in
      README.md|"$DOC"/*|engineering/doc/milestones/FLY-3030.md) : ;;
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
# 冻结头校验：本轮冻结 + milestone 为最后 commit + 远端头 = PR 头 = HEAD；成功时打印 "<HEAD_SHA> <PR>"
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

块与块之间不共享变量：凡是需要冻结头 / PR 号的块，都以 `fh=$(frozen_head) || stop "冻结头校验失败"; FROZEN_HEAD=${fh% *}; PR=${fh#* }` 开头重新推导，绝不引用别的块里 echo 过的值。

**`frozen` 为什么读取失败就 STOP**：若把「读不到 milestone」当成未冻结，冻结后的新体会再跑 `prog`，在 milestone 之后落账本 commit，批准失效（Codex R1 实测复现）。`frozen` 在 `if`/`&&` 里调用时 `stop` 直接结束本次 sh；在 `frozen_head` 的 `$(…)` 里调用时结束子 shell、使 `frozen_head` 失败，调用方再 STOP。

**为什么要 `frozen`/`prog`**：`progress` 每次都会落一个 commit。若执行体在本轮 milestone 提交之后被杀，新体重跑时账本更新会在 milestone 之后再落 commit，破坏「milestone 是字面最后一个 commit」并让评审批准失效。所有账本更新都经 `prog`，冻结后自动变成 no-op。

`stop` 之后的正确动作永远是：`node "$CLI" ask --lead flywheel-test-2 --exec-id "$EXEC" "<STOP 原文 + 当前 git status/log>"`，然后等 Lead，不自愈。

## 2. 改动范围白名单（最终 PR diff）

`git diff --name-only origin/main...HEAD` 的每一行必须匹配下列之一（由 `scope_ok` 在 Task 0 与 **每次 push 之前** 检查）：

- `README.md`
- `engineering/doc/FLY-3030-n-to-n-codex-probe/` 下的文件（设计文档、账本、founder HTML 及其 Mermaid 源/SVG）
- `engineering/doc/milestones/FLY-3030.md`

`README.md` 相对 `origin/main` 必须恰好是 `+2 −0`（两轮各一行，Task 1 断言）。

## 3. 任务

实现节点账本游标（Task S、Task 0 不计数，总数 3）：Task 2 完成 → `1/3`；Task 3 完成 → `2/3`；Task 4 在 milestone commit **之前** 写 `3/3`（`next` 写明「已冻结：评审冻结头 → CI → 回报 → 交卷，这些步骤不再写账本」）。冻结之后账本不再更新（mutation freeze）。

注意：分支上的账本可能还留着第 1 轮的 `implement 3/3 已冻结…` 文字。**是否跳过某一步只看各 Task 的判据，绝不看账本文字。**

### Task S — 前台 sleep 780（每个新体第一件事，幂等）

```sh
if grep -qxF -- "$LINE" README.md; then
  echo "README 已含本轮目标行：前体已睡满 780 秒并进入追加步骤，跳过 sleep"
else
  date
  sleep 780 || stop "sleep 780 未自然结束（被中断）——新体从 Task S 重新完整睡 780 秒"
  date
fi
```

- **必须前台执行**：不加 `&`、不用 `nohup`/`run_in_background`/后台任务、不缩短。执行工具的超时要设到 ≥ 900 秒（Claude 体：Bash `timeout: 900000`；Codex 体：exec 超时 ≥ 900s），否则工具超时会把 sleep 杀掉。
- **幂等判据**：sleep 在追加之前，所以工作区 README 已含 claude 行 ⇔ 某个前体一定已睡满。否则（包括睡到一半被杀、窗口丢失后进程被判死）新体必须重新完整睡 780 秒。判据来自文件本身，不依赖账本、进程或窗口。
- Task S 只读，不需要 TURN；拿到 TURN 前也可以睡。

### Task 0 — 预检（sleep 之后第一件事）

```sh
[ "$(node "$CLI" turn --exec-id "$EXEC" | cut -d' ' -f1)" = yours ] || stop "TURN not yours（正常等待态：60–90s 后重试，不算失败）"
[ "$(git branch --show-current)" = "$BR" ] || stop "branch != $BR"
case "$(git config --get core.hooksPath)" in
  */state/push-guard/*) : ;;
  *) stop "core.hooksPath 不是 slot push-guard" ;;
esac
# 回收前体被杀时遗留的 git 锁（git commit / push 途中被杀会留下 *.lock，之后所有写操作都报 File exists）。
# 前提：已持有 TURN（上一行），引擎已终结前体；锁超过 2 分钟未动才视为孤儿，较新的锁先等待。
for rel in index.lock HEAD.lock "refs/heads/$BR.lock" "refs/remotes/origin/$BR.lock"; do
  L=$(git rev-parse --git-path "$rel") || stop "git rev-parse --git-path $rel 失败"
  [ -e "$L" ] || continue
  [ -n "$(find "$L" -mmin +2 -print 2>/dev/null)" ] || stop "发现 2 分钟内的 $L，可能仍有 git 进程在写：90 秒后重跑 Task 0"
  rm -f "$L" || stop "删除孤儿锁 $L 失败"
  [ ! -e "$L" ] || stop "孤儿锁 $L 仍在"
  echo "已回收前体遗留的孤儿锁：$L"
done
git status --porcelain >/dev/null || stop "git status 失败（锁回收后仍无法读写仓库）"
git fetch -q origin || stop "fetch failed"
git merge-base --is-ancestor origin/main HEAD || stop "HEAD 不含 origin/main（需要技术同步，先 ask）"
if git ls-remote --exit-code origin "refs/heads/$BR" >/dev/null 2>&1; then
  git fetch -q origin "$BR" || stop "fetch $BR failed"
  git merge-base --is-ancestor "origin/$BR" HEAD || stop "远端 $BR 不是本地 HEAD 的祖先（分叉/前体推过更新的头）"
fi
scope_ok
if frozen; then
  [ "$(git log -1 --format=%H -- "$MS")" = "$(git rev-parse HEAD)" ] || stop "本轮 milestone 已存在但不是最后一个 commit"
  echo "FROZEN（本轮）：跳到 Task 4（只做 push + 断言），再 Task 5、Task 6"
fi
cat "$LEDGER"
git status --short
```

**锁回收为什么安全**：`git commit` 先把新索引写进 `index.lock` 再原子改名，被杀在改名前 ⇒ 原索引完好，删锁即回到提交前；被杀在改名后 ⇒ 提交已完成，锁已不存在。回收后各 Task 的判据（行在不在、提交在不在、远端头、PR）重新判定该做什么。任何块因 `File exists` / `*.lock` 报错 STOP 时，一律回到 Task 0 重跑（Task 0 负责回收），不要手动删锁。

TURN 为 `not-yours` 时是正常等待态：**同一个体** 每 60–90 秒重跑 Task 0，拿到 `yours` 就继续 Task 1（同一个体不重睡）。

说明：若某个体在 Task S 睡满后、Task 1 追加前被杀，下一个新体会按判据重睡 780 秒——这是「sleep 在追加之前」判据的保守选择（宁可多睡，不可少睡）。

### Task 1 — 追加目标行（幂等）

```sh
[ "$(grep -cxF -- "$OLD" README.md)" = 1 ] || stop "第 1 轮 codex-body 行计数 != 1"
[ "$(sed -n 4p README.md)" = "$OLD" ] || stop "第 4 行不是第 1 轮 codex-body 行"
n=$(grep -cxF -- "$LINE" README.md) || n=0
case "$n" in
  0)
    frozen && stop "已冻结但 README 缺目标行"
    [ "$(tail -n 1 README.md)" = "$OLD" ] || stop "README 最后一行不是 codex-body 行，拒绝追加"
    [ "$(tail -c 1 README.md | od -An -tx1 | tr -d ' ')" = 0a ] || stop "README 末字节不是换行"
    printf '%s\n' "$LINE" >> README.md
    ;;
  1)
    [ "$(tail -n 1 README.md)" = "$LINE" ] || stop "目标行已存在但不是最后一行"
    ;;
  *) stop "目标行出现 $n 次" ;;
esac
# 断言（任何状态下都必须成立）
[ "$(grep -cxF -- "$LINE" README.md)" = 1 ] || stop "目标行计数 != 1"
[ "$(sed -n 4p README.md)" = "$OLD" ] || stop "第 4 行不是 codex-body 行"
[ "$(sed -n 5p README.md)" = "$LINE" ] || stop "第 5 行不是目标行"
[ "$(wc -l < README.md | tr -d ' ')" = 5 ] || stop "README 行数 != 5"
[ "$(wc -c < README.md | tr -d ' ')" = 111 ] || stop "README 字节数 != 111"
[ "$(git diff --numstat origin/main -- README.md)" = "$(printf '2\t0\tREADME.md')" ] || stop "README 相对 origin/main 不是 +2/-0"
```

说明：`grep -c` 零命中时退出码为 1 但仍打印 `0`，所以用 `|| n=0` 兜住；`git diff --numstat origin/main -- README.md` 比较的是 **工作区 vs origin/main**，在未提交和已提交状态下都成立。

### Task 2 — 提交 README（幂等）

```sh
if git diff --quiet HEAD -- README.md; then
  echo "README 已提交，跳过"
else
  frozen && stop "已冻结但 README 有未提交改动"
  git add README.md || stop "git add README 失败（锁残留时回 Task 0）"
  git commit -m "docs(FLY-3030): append FLY-2919 N-to-N claude-body probe line" -- README.md || stop "commit failed"
fi
git diff --quiet HEAD -- README.md || stop "README 仍有未提交改动"
[ "$(git log --format=%H origin/main..HEAD -- README.md | wc -l | tr -d ' ')" = 2 ] || stop "origin/main..HEAD 中 README commit 数 != 2"
c=$(git log --format=%s origin/main..HEAD -- README.md | grep -c 'claude-body') || c=0
[ "$c" = 1 ] || stop "claude-body README commit 数 != 1（实为 $c）"
prog 1/3 "Task 3: push + 更新/开 PR"
```

`progress` 只会 path-limited 提交 `progress.md`，不会带上其它文件。

### Task 3 — 推送并更新/开 PR（幂等）

```sh
pushbr
TITLE='docs(FLY-3030): FLY-2919 N-to-N codex-body + claude-body probes'
BODY=$(printf '%s\n' 'FLY-2919 QA 合成单：README.md 末尾依次追加 `FLY-2919 N-to-N codex-body probe`（第 1 轮）与 `FLY-2919 N-to-N claude-body probe`（第 2 轮）。' '' 'Design: engineering/doc/FLY-3030-n-to-n-codex-probe/plan.md' '' '## Linear Issue' 'FLY-3030: [529 合成单·勿派] FLY-2919 真房 N-to-N · Codex 体' 'https://linear.app/geoforge3d/issue/FLY-3030' '' '## Test plan' '- [x] README 字节/行数/唯一性断言（plan Task 1：5 行 / 111 字节 / +2-0）' '- [x] local-test-policy/v1：选中测试集为空，未跑本地套件' '- [ ] PR 精确头 CI（全量证据）')
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
[ "$(gh pr view "$PR" --repo "$REPO" --json title --jq .title)" = "$TITLE" ] || stop "PR 标题未更新"
echo "PR=$PR"
prog 2/3 "Task 4: 账本 3/3 → milestone 末提交（冻结）→ push"
pushbr
```

`gh pr edit` 重复执行无副作用（同标题同正文）；body 用 `$(printf …)` 内联，避免 `--body-file` 路径被当成重定向。

### Task 4 — 冻结：账本定稿 + milestone 末提交 + push（幂等）

顺序固定：**先写账本 3/3 → 再提交 milestone（字面最后一个 commit）→ push**。之后到交卷为止不再运行任何会产生 commit 的命令。

```sh
PR=$(open_pr) || stop "gh pr list 失败"
[ -n "$PR" ] || stop "取不到 PR 号"
if frozen; then
  [ "$(git log -1 --format=%H -- "$MS")" = "$(git rev-parse HEAD)" ] || stop "本轮 milestone 已存在但不是最后一个 commit"
  echo "已冻结（前体已提交本轮 milestone）：跳过账本与 milestone 写入，只做 push + 断言"
else
  prog 3/3 "已冻结：评审冻结头 → 精确头 CI → ask --report → complete needs_review（这些步骤不再写账本）"
  mkdir -p engineering/doc/milestones
  # 用 printf 覆写整个文件（不用 here-doc，理由同 scope_ok）
  printf '%s\n' \
    '# FLY-3030 implementation milestone' \
    '' \
    '**Issue**: FLY-3030 — [529 合成单·勿派] FLY-2919 真房 N-to-N · Codex 体' \
    "**Date**: $(date +%Y-%m-%d)" \
    "**PR**: https://github.com/$REPO/pull/$PR" \
    '' \
    '## Delivered scope' \
    '' \
    '- 第 1 轮：README.md 末尾追加 `FLY-2919 N-to-N codex-body probe`（第 4 行）。' \
    "- 第 2 轮：前台 sleep 780 后，README.md 末尾追加 \`$LINE\`（第 5 行）。" \
    '- README 相对 origin/main 共 +2/-0，无其它产品改动。' \
    '' \
    '## Verification evidence' \
    '' \
    '- README 断言：两行各恰 1 次，第 4/5 行分别为 codex-body/claude-body；5 行 / 111 字节；相对 origin/main numstat = 2/0。' \
    '- local-test-policy/v1：选中测试集为空（纯文档改动），未跑任何本地套件；全量证据 = PR 精确头 CI。' \
    '- 代码评审：对本 commit（冻结头）进行，批准绑定该头。' \
    > "$MS" || stop "写 milestone 失败"
  [ "$(head -n 1 "$MS")" = '# FLY-3030 implementation milestone' ] || stop "milestone 内容异常"
  grep -qF "pull/$PR" "$MS" || stop "milestone 缺 PR 链接"
  grep -qF -- "$LINE" "$MS" || stop "milestone 未提到本轮目标行"
  git add "$MS" || stop "git add milestone 失败（锁残留时回 Task 0）"
  git commit -m "docs(FLY-3030): implementation milestone (claude-body round)" -- "$MS" || stop "milestone commit failed"
fi
pushbr
fh=$(frozen_head) || stop "冻结头校验失败"
echo "冻结完成：HEAD=${fh% *} PR=${fh#* }（仅供人读；后续块自行重新推导）"
```

**换体安全性**：判据是 `frozen`（HEAD 里的 milestone 是否提到本轮目标行），与是否已推送无关。在 `prog 3/3` 之后、milestone commit 之前被杀 → 新体再写一次账本（多一个账本 commit，无害，且在 milestone 之前）后写 milestone，milestone 仍是最后；在 milestone commit 之后（无论推没推）被杀 → 新体所有写入都是 no-op，只做（幂等的）push 与断言。

### Task 5 — 对冻结头做代码评审（只读，幂等）

每次进入 Task 5（包括换体后）先在 **同一次 sh 执行** 里跑下面的前置，再在同一次执行里接注入的评审/落账命令：

```sh
fh=$(frozen_head) || stop "冻结头校验失败"
FROZEN_HEAD=${fh% *}
PR=${fh#* }
echo "评审对象：PR #$PR @ $FROZEN_HEAD"
# ↓ 在这里接注入的评审门命令（同一次执行，才能拿到上面的变量），例如 Claude 作者族落账：
#   node "$CLI" codex-review-result --exec-id "$EXEC" --pr-head "$FROZEN_HEAD" …(其余参数照注入指令)… || stop "评审落账失败"
# 注入指令要求 await-codex-gate 时：
#   node "$CLI" await-codex-gate code --exec-id "$EXEC" || stop "code gate 未通过"
#   [ "$(git rev-parse HEAD)" = "$FROZEN_HEAD" ] || stop "评审期间 HEAD 变化"
```

若注入的评审门是跨进程/异步的（例如 Codex 作者族的 `request-review --type code`，或后台跑的 `codex:rescue`），每次需要冻结头 / PR 号时都重新跑上面三行前置，不要手抄 SHA。

- **评审对象** = 冻结头 `FROZEN_HEAD` 上相对 `origin/main` 的 PR diff（README 的两行 + milestone + 设计文档）。评审提示词 **必须以 implement 协议里的 `local-test-policy/v1` 块原文作为最开头的字节**。
- **走注入的评审门**：Claude 作者族 → `codex:rescue`，批准后按注入指令落账（reviewed head = `FROZEN_HEAD`）；Codex 作者族 → 注入的 `request-review --type code` 通道。具体命令以 Bridge 注入的指令为准。
- **幂等**：若当前执行已有绑定 `FROZEN_HEAD` 的 APPROVED 落账（注入的 gate 命令立即通过），跳过；否则重新评审——重复评审无副作用。
- **CHANGES_REQUESTED 且需要改任何文件** → STOP + ask Lead。冻结后不自行落 commit，由 Lead 决定是否解冻重来。
- **本地测试**：`git grep -lF -- "$LINE"` 只会命中 `README.md` 与本 issue 文档，选中测试集为空；按 local-test-policy **不回退到任何宽命令**，Task 1 的字节断言即本地证据。不装依赖、不跑 `pnpm lint/test`（无依赖树，且 `pnpm install` 会触发 husky 改写 hooksPath）。

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
node "$CLI" ask --lead flywheel-test-2 --exec-id "$EXEC" --report "DONE: FLY-3030 claude-body probe line appended after foreground sleep 780 | commits: $(git log --format=%h origin/main..HEAD | tr '\n' ' ') | PR: https://github.com/$REPO/pull/$PR | head: $HEAD_SHA | CI: green" || stop "ask --report 失败，未交卷"
node "$CLI" complete --route needs_review --pr "$PR"
RC=$?
[ "$RC" = 0 ] || stop "complete exit $RC"
```

注意：PR #299 上已有第 1 轮头的 check。`gh pr checks` 只报告 **当前 PR 头** 的 check；新头 push 后第 1 轮循环可能立即看到非空 rollup（新头的 check 已排队）——`--watch` 会等到新头 check 全部结束；结束后再比对 `headRefOid = HEAD_SHA` 保证看到的是冻结头。

- `complete` exit 3（有未读邮件）：读输出里的邮件、处理、`node "$CLI" inbox --ack-consumed <read-id>`，然后 **只跑下面的 Task 6b**（不重发 report）。

### Task 6b — 仅重试 complete（不重发 report）

```sh
fh=$(frozen_head) || stop "冻结头校验失败，不能交卷"
PR=${fh#* }
node "$CLI" complete --route needs_review --pr "$PR"
RC=$?
[ "$RC" = 0 ] || stop "complete exit $RC（exit 3 = 仍有未读邮件：处理并 ack 后再跑本块）"
```

- 实现节点注入的完成命令与此不同时，**以注入命令为准**。
- 本块在 `ask --report` 之前被杀：新体重跑整块即可；在 `ask --report` 成功之后、`complete` 之前被杀：重跑整块会再发一次 report（内容相同，无害），然后交卷。

## 4. 回滚边界

- 合并前：PR 未合，`main` 不受影响；撤销本轮 = 关闭 PR 或（经 Lead）回退到 `95c81c6d8`。本节点与实现节点都不合并。
- 合并后：`git revert <claude-body README commit>` 单行即可回滚本轮；README 行对任何代码路径无影响。

## 5. 负向守卫（显式不做）

- 不跳过、不后台化、不缩短 `sleep 780`。
- 不删改第 1 轮的 codex-body 行，不改写第 1 轮提交。
- 不 `--no-verify`、不改 `core.hooksPath`、不 force push（非快进 → ask）。
- 不 `pnpm install` / 不跑任何本地测试套件 / 不改 `packages/`、CI、脚本、`CLAUDE.md`。
- 冻结后不落任何 commit（包括账本），评审批准只绑定冻结头。
- 不依赖窗口 / tmux / 进程存活做任何判断（「活体丢窗口不判死」由引擎负责，plan 不干扰）。
- 不向生产 Bridge / 生产仓做任何动作；不派单、不起 QA 房间。
- 不合并、不请求 ship。

## 6. 验收证据（交给 QA）

| 证据 | 取法 |
|---|---|
| README 两行各唯一、顺序正确 | `git show <PR头>:README.md \| sed -n '4p;5p'`；`grep -cxF` 各 = 1；5 行 / 111 字节 |
| 恰 2 个 README commit，claude-body 恰 1 个 | `git log --format=%s origin/main..<PR头> -- README.md` |
| 本轮 milestone 为最后 commit | `git log -1 --format=%H <PR头> -- engineering/doc/milestones/FLY-3030.md` = PR 头，且内容含 claude-body 行 |
| diff 在白名单内 | §2 |
| 代码评审批准绑定 PR 头 | 注入评审门的落账（reviewed head = PR 头） |
| 精确头 CI 绿 | `gh pr checks <PR>` |
| 前台 sleep 780 执行过 | 实现体终端/transcript 中 Task S 的两次 `date` 相差 ≥ 780 秒 |
| 执行体生命周期（死体换体 / 丢窗口不判死 / 同 thread 续干 / 交卷回 thread） | FLY-2919 driver receipt（不在本 plan 的证据范围内） |

## 7. 设计阶段演练（dry-run）证据

用临时仓复刻本分支的 **第 1 轮终态**（原始 44 字节 README + codex-body 行 commit + 第 1 轮 milestone 末提交 + 本地 bare origin 上已推送的分支 + PR 299 OPEN），配 `gh`/`sleep`/`flywheel-comm` 桩，把 §3 的代码块用 awk 从本文件 **逐字抽出** 执行（每块 = §1 + 该块，一次独立 `/bin/sh`）：

| 场景 | 模拟 | 结果 |
|---|---|---|
| A 完工后换体重跑 | Task S→6 全跑，再从 Task S 全部重跑 | PASS：第二遍 S 跳过 sleep、0 打印 FROZEN、所有写入 no-op；HEAD 不变且 = 远端头；最后四个 commit = claude README → progress 1/3 → 2/3 → 3/3 → milestone；README 5 行/111 字节、numstat 2/0；sleep 共 1 次；PR 标题已更新 |
| A0 第 1 轮终态不被误判冻结 | 起点直接跑 Task 0 / Task 5 | PASS：Task 0 不打印 FROZEN；Task 5 `STOP: 未冻结`（旧判据会误判为已冻结） |
| B 追加后被杀 | 跑 S/0/1 后弃体，新体从 S 全跑 | PASS：新体跳过 sleep（README 已含目标行）；目标行 1 次、claude README commit 1 个、milestone 为最后 |
| C sleep 被中断 | 桩 `sleep` 返回 130，再从 S 全跑 | PASS：`STOP: sleep 780 未自然结束`；新体重新完整睡（sleep 共 2 次），终态正确 |
| D milestone 已提交、push 失败 | Task 4 push 处 STOP，恢复 remote 后从 S 全跑 | PASS：Task 0 打印 FROZEN，所有写入 no-op，HEAD = 远端头 |
| E 越界文件 | 夹带 `foo.txt` 提交，跑 Task 0 与 Task 3 | PASS：两处都 `STOP: diff 超出白名单： foo.txt`，远端未推 |
| M 未冻结就评审/交卷 | Task 3 后直接跑 Task 5、Task 6 | PASS：两处都 `STOP: 未冻结` |
| G CI 失败 | 桩 `gh pr checks` 返回 1 | PASS：`STOP: 精确头 CI 未全绿`，`ask`/`complete` 均未调用 |
| H report 失败 | 桩 `ask` 返回 1 | PASS：`STOP: ask --report 失败，未交卷`，`complete` 未调用 |
| K complete exit 3 | Task 6 的 `complete` 返回 3，再单跑 Task 6b | PASS：6b 在新 shell 重新推导 PR 并交卷，`ask` 共 1 次 |
| T TURN not-yours | 桩 `turn` 返回 not-yours | PASS：Task S 照睡（只读），Task 0 `STOP: TURN not yours` 且无任何写入 |
| N 无临时文件依赖 | `TMPDIR=/nonexistent` 下跑 S→6 | PASS：rc 0，终态正确，milestone 含 claude-body 行 |
| R 冻结后 milestone 读取失败（R1） | 冻结后用 `git` 桩让 `git show` 返回 128，跑 Task 2 与 Task 5 | PASS：两处都 `STOP: 读取 HEAD:… 失败，无法判定冻结状态`，未调用 `progress`，HEAD 不变 |
| R0 冻结前读取失败 | 起点即让 `git show` 失败，跑 S/0/1/2 | PASS：Task 0 STOP，零新 commit |
| L 提交途中被杀留下 `index.lock`（R1） | 追加后放一个 2 分钟前的 `.git/index.lock`，Task 2 `STOP: commit failed`；新体从 S 全跑 | PASS：Task 0 回收孤儿锁，终态正确（5 行/111 字节，claude commit 1 个，milestone 最后） |
| L2 较新的锁 | 刚创建的 `index.lock` | PASS：Task 0 `STOP: 发现 2 分钟内的 …index.lock`，锁保留不删 |
| L3 分支 ref 锁残留 | 2 分钟前的 `refs/heads/<BR>.lock` | PASS：Task 0 回收，全流程终态正确 |

诚实说明：`sleep 780` 在演练中由桩替代（只记录参数 `780`、不真睡）；真实前台 780 秒由本设计节点自己执行过一次（15:20:59 → 15:33:59 PDT，exit 0）。Task 5（评审）依赖注入的评审门，演练只跑了前置；GitHub 真实 push / PR edit / CI 只在实现节点发生。
