# FLY-2984 runner 生命周期说明文件 — 实施计划
Issue: FLY-2984 (https://linear.app/geoforge3d/issue/FLY-2984/qa-sbx-fly-2925-n-to-n-synthetic-runner-lifecycle-task)
日期: 2026-09-27
基于: research.md

状态：设计稿，待 Codex 设计评审。本节点只设计，不写 `qa-sandbox/fly2925-n2n.md`。

## 1. 一句话

implement 节点把 `qa-sandbox/fly2925-n2n.md` 分三步写成「标题 + 三段英文」，每步独立 commit + push；
每步开头先按文件实际内容判断已完成到哪一步，所以被重启后从断点续跑，不重复、不回滚、不碰其他文件。

## 2. 最终文件内容（逐字，权威）

路径：`qa-sandbox/fly2925-n2n.md`。UTF-8、LF、以单个换行结尾；标题与段落、段落与段落之间各一个空行；每段一行。

```markdown
# FLY-2925 N-to-N runner lifecycle note

A runner is a single worker session that Flywheel starts for one node of a workflow. It receives a bounded task, writes to the shared git worktree only while it holds the TURN, reports its stage and progress to the Bridge, and asks its Lead through flywheel-comm whenever it needs a decision it cannot make alone.

When a runner is restarted, it does not start over. It resumes as the same execution rather than a fresh one: it re-checks that it still holds the TURN, reads the progress ledger committed on the branch, and inspects the files themselves to see which steps are already done; finished work that was committed and pushed stays in place, and the runner continues from the first unfinished step instead of redoing or rolling back earlier ones.

Work is handed in through the normal flow: the runner commits and pushes its changes to the issue branch, reports the result to its Lead with a structured flywheel-comm receipt, and then runs flywheel-comm complete with its node's route. It never merges, deploys, or dispatches the next node; the workflow orchestrator decides what happens next.
```

步骤与内容的对应：

| 步 | 本步追加的内容 | 完成后文件的正文段落数 |
|---|---|---|
| 1 | 标题行 + 空行 + 第 1 段 | 1 |
| 2 | 空行 + 第 2 段 | 2 |
| 3 | 空行 + 第 3 段 | 3 |

「正文段落数」= 非空且不以 `#` 开头的行数。

## 3. 执行合同（implement 节点照抄）

### 3.0 前置（每次会话启动、含重启后都跑）

```zsh
cd /private/tmp/flywheel-test-slot-2/project-slot-2-FLY-2984
node "$FLYWHEEL_COMM_CLI" turn          # 必须输出以 "yours" 开头；not-yours 按 TURN WAIT LAW 每 60–90s 轮询，不碰工作树
L=engineering/doc/FLY-2984-runner-lifecycle-note/progress.md
git status --porcelain --untracked-files=all -- . ':(exclude)qa-sandbox/fly2925-n2n.md' \
  ":(exclude)$L" ":(exclude)$L.lock" ":(exclude,glob)$L.tmp-*"                        # 必须无输出
```

第二条命令有任何输出（即存在交付文件与本任务账本残留以外的改动）：停下，`ask` Lead，不自行清理。
被排除的只有两类：交付文件本身；`flywheel-comm progress` 写本任务账本时被杀可能留下的残留——未提交的 `progress.md`（CLI 先 temp+rename 写盘、再 `git add` + `git commit --only`，两者之间不是原子的）、`progress.md.lock`（CLI 自己会回收 >30s 的陈旧锁）、`progress.md.tmp-<pid>`（CLI 的临时文件名）。
用 `--untracked-files=all` + pathspec 排除，是因为首次写入后未跟踪目录会显示为 `?? qa-sandbox/`，普通 `git status --porcelain` 会把它误判为「其他改动」。`run_step` 开头内置同一检查（`precheck`）。

### 3.1 定义（粘贴到当前 shell，不写入仓库）

```zsh
F=qa-sandbox/fly2925-n2n.md
BR=project-slot-2-FLY-2984
H='# FLY-2925 N-to-N runner lifecycle note'
P1='A runner is a single worker session that Flywheel starts for one node of a workflow. It receives a bounded task, writes to the shared git worktree only while it holds the TURN, reports its stage and progress to the Bridge, and asks its Lead through flywheel-comm whenever it needs a decision it cannot make alone.'
P2='When a runner is restarted, it does not start over. It resumes as the same execution rather than a fresh one: it re-checks that it still holds the TURN, reads the progress ledger committed on the branch, and inspects the files themselves to see which steps are already done; finished work that was committed and pushed stays in place, and the runner continues from the first unfinished step instead of redoing or rolling back earlier ones.'
P3='Work is handed in through the normal flow: the runner commits and pushes its changes to the issue branch, reports the result to its Lead with a structured flywheel-comm receipt, and then runs flywheel-comm complete with its node'"'"'s route. It never merges, deploys, or dispatches the next node; the workflow orchestrator decides what happens next.'
MSG1='docs(FLY-2984): add runner lifecycle note (step 1/3)'
MSG2='docs(FLY-2984): describe runner restart (step 2/3)'
MSG3='docs(FLY-2984): describe hand-in (step 3/3)'
# 期望的「完成 k 步」文件全文
expect() { case $1 in
  0) printf '' ;;
  1) printf '%s\n\n%s\n' "$H" "$P1" ;;
  2) printf '%s\n\n%s\n\n%s\n' "$H" "$P1" "$P2" ;;
  3) printf '%s\n\n%s\n\n%s\n\n%s\n' "$H" "$P1" "$P2" "$P3" ;;
esac; }
# 给定「内容+x」判定第几步；不匹配任何前缀则输出 X
st() {
  local k; for k in 3 2 1 0; do
    [[ $1 == "$(expect $k; printf x)" ]] && { print $k; return; }
  done; print X
}
state()  { if [[ -f $F ]]; then st "$(cat -- "$F"; printf x)"; else print 0; fi; }            # 工作区
hstate() { if git cat-file -e "HEAD:$F" 2>/dev/null; then st "$(git show "HEAD:$F"; printf x)"; else print 0; fi; }  # 已提交
# 已提交（HEAD）账本里 implement 阶段记到第几步；只信已提交版本，工作区里未提交的游标不算
LEDGER=engineering/doc/FLY-2984-runner-lifecycle-note/progress.md
ledger_k() {
  local c n=0
  if c=$(git show "HEAD:$LEDGER" 2>/dev/null) && print -r -- "$c" | grep -qx 'phase: implement'; then
    n=$(print -r -- "$c" | sed -n 's#^phaseCursor: \([0-3]\)/3$#\1#p' | head -1); [[ -n $n ]] || n=0
  fi; print $n
}
# 工作树里除交付文件与本任务账本残留外不得有任何改动
precheck() {
  [[ -z $(git status --porcelain --untracked-files=all -- . ":(exclude)$F" \
      ":(exclude)$LEDGER" ":(exclude)$LEDGER.lock" ":(exclude,glob)$LEDGER.tmp-*") ]]
}
```

说明：`$(cat; printf x)` 保留结尾换行，避免命令替换吞掉 `\n` 造成误判。工作区状态（`state`）决定要不要写，已提交状态（`hstate`）决定要不要提交，账本（`ledger_k`）只前进不回退——三者分开判断，重跑任一更早的步骤都不会误提交或把游标拉回。账本只认 HEAD 里已提交的版本：若上次在 `progress` 内部（已写盘、未提交）被杀，`run_step` 开头先把本任务账本的残留（未提交改动、`.lock`、`.tmp-<pid>`）还原到 HEAD，`ledger_k` 仍返回旧值，(c) 随后重新记账。持有 TURN 的只有本 runner，且 `progress` 是同步调用，所以 `run_step` 开头不可能有活着的账本写入者，删锁是安全的。

### 3.2 单步过程 `run_step k`（k = 1, 2, 3 依次执行）

```zsh
run_step() {
  local k=$1 s h; s=$(state); h=$(hstate)
  [[ $s == X || $h == X ]] && { print "STOP: $F 内容不匹配任何已知前缀"; return 2; }
  precheck || { print "STOP: 工作树有 $F 与本任务账本残留以外的改动，ask Lead，不自行清理"; return 2; }
  # 账本残留一律还原到 HEAD：未提交的游标不可信，需要的话 (c) 会重新记账
  if [[ -n $(git status --porcelain --untracked-files=all -- "$LEDGER" "$LEDGER.lock" ":(glob)$LEDGER.tmp-*") ]]; then
    git restore --staged --worktree -- "$LEDGER" || return 2
    rm -f -- "$LEDGER.lock" $LEDGER.tmp-*(N)
  fi
  # (a) 写：工作区还没到第 k 步时，只有恰好停在 k-1 才写
  if (( s < k )); then
    (( s == k - 1 )) || { print "STOP: 需先完成第 $((k-1)) 步"; return 2; }
    mkdir -p qa-sandbox
    expect $k > "$F"
  fi
  # (b) 提交：HEAD 还没到第 k 步时，只有 HEAD 恰好在 k-1 且工作区恰好在 k 才提交
  if (( h < k )); then
    (( h == k - 1 )) || { print "STOP: HEAD 停在第 $h 步"; return 2; }
    [[ $(state) == $k ]] || { print "STOP: 工作区不在第 $k 步（可能越步未提交），ask Lead"; return 2; }
    git add -- "$F"
    [[ -z $(git diff --cached --name-only -- . ":(exclude)$F" ":(exclude)$LEDGER") ]] || { print "STOP: 暂存区含其他文件"; return 2; }
    local m; eval "m=\$MSG$k"
    # --only：即使账本残留已被暂存，也只提交交付文件
    git commit -q --only -m "$m" -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' -- "$F" || return 2
  fi
  # (c) 记账：账本未到 k 才记（progress 会自行路径限定提交 progress.md）
  if (( $(ledger_k) < k )); then
    node "$FLYWHEEL_COMM_CLI" progress --exec-id "$FLYWHEEL_EXEC_ID" \
      --file "$LEDGER" --phase implement --cursor $k/3 --next "step $((k+1))/3" || return 2
  fi
  # (d) 推送：本地头与远端头不同才推；只允许 fast-forward
  local out remote
  out=$(git ls-remote --exit-code origin "refs/heads/$BR") || { print "STOP: 远端分支不可读"; return 2; }
  remote=${out%%$'\t'*}
  [[ ${#remote} == 40 && $remote != *[^0-9a-f]* ]] || { print "STOP: 远端头格式异常"; return 2; }
  if [[ $(git rev-parse HEAD) != $remote ]]; then
    git push origin "$BR" || { print "STOP: push 失败（可能非 fast-forward），ask Lead，不 force"; return 2; }
  fi
  print "STEP $k OK head=$(git rev-parse --short HEAD)"
}
run_step 1 && run_step 2 && run_step 3
```

续跑语义（重启后重新执行 3.0–3.2 即可，无需记住上次跑到哪）：

| 被杀时刻 | 重启后 `run_step` 的行为 |
|---|---|
| 写文件前 | 正常写 → 提交 → 记账 → 推 |
| 写完未提交 | 更早步骤全部跳过；本步 (a) 跳过（工作区已为 k）→ (b) 提交 |
| 提交后未记账 | (a)(b) 跳过 → (c) 记账 → (d) 推 |
| 在 `progress` 内部被杀（账本已写盘/已暂存未提交，可能残留 `.lock` / `.tmp-<pid>`） | precheck 放行这些残留 → 还原到 HEAD → (a)(b) 跳过 → `ledger_k` 读 HEAD 仍为 k-1 → (c) 重新记账 → (d) 推；结束时工作树干净 |
| 记账后未推 | (a)(b)(c) 跳过 → (d) 推 |
| 已推 | 全部跳过，零新 commit |

任一 `STOP` / 非零返回：不重试循环、不改其他文件，用 `ask --lead flywheel-test-2` 报告原因后等待。

### 3.3 最终验收（step 3 之后）

```zsh
# V1 内容逐字一致
[[ $(state) == 3 ]] && print V1 PASS || print V1 FAIL
# V2 恰好 3 个交付 commit，且每个只改这一个文件
C=( ${(f)"$(git log --reverse --format=%H -- "$F")"} )
(( ${#C} == 3 )) && print V2a PASS || print "V2a FAIL (${#C})"
ok=1; for c in $C; do [[ $(git show --name-only --format= $c) == "$F" ]] || { ok=0; print "V2b FAIL $c"; }; done; (( ok )) && print V2b PASS
# V3 从第一个交付 commit 的父提交起，除 progress.md 外只改了这一个文件
B=${C[1]}^
[[ $(git diff --name-only $B..HEAD | grep -v -x 'engineering/doc/FLY-2984-runner-lifecycle-note/progress.md') == "$F" ]] && print V3 PASS || print V3 FAIL
# V4 远端头 == 本地头
out=$(git ls-remote --exit-code origin "refs/heads/$BR") && [[ ${out%%$'\t'*} == $(git rev-parse HEAD) ]] && print V4 PASS || print V4 FAIL
# V5 三个 commit message 与合同一致、顺序正确
[[ $(git log --reverse --format=%s -- "$F") == "$MSG1"$'\n'"$MSG2"$'\n'"$MSG3" ]] && print V5 PASS || print V5 FAIL
```

V1–V5 全 PASS 才能进入交卷；任一 FAIL 按 3.2 的 STOP 规则处理。

### 3.4 交卷

按 implement 节点注入的收尾合同执行：账本已在 3.2(c) 写到 3/3 且随最后一次 push 上远端 → 按注入合同做代码评审 / PR / `ask --report`（带 V1–V5 结果与三个交付 commit sha）→ 注入合同规定的 `complete --route`。本计划不硬编码 implement 的 route，不 merge、不部署。

与 implement 角色通用合同的两处冲突，按下述默认处理并在报告中写明：

| 冲突 | 默认 | 理由 |
|---|---|---|
| 角色合同要求 `engineering/doc/milestones/<ID>.md` 作为 PR 最后一个 commit | **不加**；先 `ask` Lead，只有 Lead 明确要求才加（加了则 V3 需把该路径加入排除表并在报告中说明） | issue 明文「Do not change any other file」，比通用角色合同更具体 |
| 开 PR 的 base | 开 PR 不改文件，不违反 issue；base 由 Lead 决定——本分支领先 `origin/main` 2686 个 commit，对 main 开 PR 会带入 FLY-2925 全部历史。设计节点已发非阻塞问题 `cc147074-ac51-4b79-a8a1-857f36bce612`；implement 开 PR 前 `check` 该问题，无答复则 `ask` Lead 并按其回复执行 | 避免把无关历史推到 main 的 PR 上 |

## 4. 回滚边界

交付只是一个新文件。若需撤销：新增一个删除该文件的 commit（普通 fast-forward push），不改写历史、不 force push。设计节点提交的 `engineering/doc/FLY-2984-runner-lifecycle-note/` 不随之撤销。

## 5. 负向守卫

- 不改 `qa-sandbox/fly2925-n2n.md` 以外的任何文件（progress.md 由 CLI 管，除外）。
- 不写第四段、不改标题、不改已提交的段落。
- 不 `--no-verify`、不改 `core.hooksPath`、不 force push、不 merge/rebase origin/main。
- 文件内容不匹配任何已知前缀（`state` = X）时绝不覆盖，只报告。

## 6. 测试证据

本任务无代码，不跑单元测试。证据 = 3.3 的 V1–V5 输出 + 远端分支上三个交付 commit 的 sha。
设计阶段已在 scratch 目录对 3.1/3.2 做干跑（用本地 bare 仓充当 origin，含「写完未提交被杀」「提交后未推被杀」两种续跑），结果记在 §7。

## 7. 设计阶段干跑记录

脚本：同目录 `dryrun.zsh`（用 awk 从本文件 §3.1/§3.2/§3.3 抽出 zsh 块原样执行，防止文档与测试漂移；`node` 用桩替换，桩按真实账本格式写 `phase: implement` / `phaseCursor: k/3` 并路径限定提交；origin 为 scratch 下的本地 bare 仓）。运行：`zsh -f engineering/doc/FLY-2984-runner-lifecycle-note/dryrun.zsh`。

| 场景 | 结果 |
|---|---|
| A 第 3 步写完未提交即被杀，重跑 1→2→3 | 第 1、2 步不误提交；第 3 步提交正确内容；最终 3 个交付 commit |
| B 第 3 步已提交、远端落后两个 commit，重跑 | 零新 commit，只 fast-forward 推齐 |
| 全部完成后重跑 1→2→3 | 零新 commit，零 push |
| 全部完成后单独重跑第 1 步 | 账本仍为 `phaseCursor: 3/3`（不回退） |
| V1–V5 | 全 PASS |
| C 文件被追加未知内容 | `STOP: … 不匹配任何已知前缀`，rc=2，不覆盖 |
| D 暂存了其他文件 | `STOP: 工作树有 … 以外的改动`，rc=2 |
| E 远端不可读（origin 指向不存在的仓） | `STOP: 远端分支不可读`，rc=2，不打印 OK |
| F 第 1 步写完即被杀（`qa-sandbox/` 未跟踪） | 裸 `git status --porcelain` 为 `?? qa-sandbox/`；§3.0 的排除式检查为空，续跑正常 |
| G 第 2 步在 `progress` 内部被杀（账本已写盘并暂存、未提交，残留 `.lock` 与 `.tmp-999`） | precheck 放行、`ledger_k`=1；重跑后账本 HEAD 为 `2/3`，工作树零残留 |

Codex R1 第一次调用（额度中断前）指出三处：§3.0 首写后误判、`ls-remote | cut` 吞掉失败退出码、第 2 段「new session」与 FLY-2925「重启按原会话续接」不符——均已修正，E/F 两个场景即为回归证据。

Codex R1 第二次调用（额度恢复后）指出第四处（MEDIUM）：`flywheel-comm progress` 先 temp+rename 写盘、再 `git add` + `git commit --only`，两者之间被杀会留下未提交账本，旧 precheck 会永久拦住续跑。已改为 precheck 放行本任务账本残留、`run_step` 开头还原到 HEAD、`ledger_k` 只读 HEAD、交付提交用 `commit --only`；场景 G 即为回归证据。dry-run 的 `node` 桩也改为与真实 CLI 同序（temp+rename → add → commit --only）。

第一版脚本在场景 A 中把「已写到第 2 步」的工作区内容误提交成 step 1——干跑发现后改为 `state`/`hstate`/`ledger_k` 三分判断，即现行版本。

`dryrun.zsh` 是设计证据，不是交付物；implement 不需要运行或修改它。
