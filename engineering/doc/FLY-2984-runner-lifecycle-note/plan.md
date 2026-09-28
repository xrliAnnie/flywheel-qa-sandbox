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

When a runner is restarted, it does not start over. The new session re-checks that it still holds the TURN, reads the progress ledger committed on the branch, and inspects the files themselves to see which steps are already done; finished work that was committed and pushed stays in place, and the runner continues from the first unfinished step instead of redoing or rolling back earlier ones.

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
git status --porcelain                  # 只允许为空，或仅含 qa-sandbox/fly2925-n2n.md
```

若 `git status` 出现 `qa-sandbox/fly2925-n2n.md` 以外的改动：停下，`ask` Lead，不自行清理。

### 3.1 定义（粘贴到当前 shell，不写入仓库）

```zsh
F=qa-sandbox/fly2925-n2n.md
BR=project-slot-2-FLY-2984
H='# FLY-2925 N-to-N runner lifecycle note'
P1='A runner is a single worker session that Flywheel starts for one node of a workflow. It receives a bounded task, writes to the shared git worktree only while it holds the TURN, reports its stage and progress to the Bridge, and asks its Lead through flywheel-comm whenever it needs a decision it cannot make alone.'
P2='When a runner is restarted, it does not start over. The new session re-checks that it still holds the TURN, reads the progress ledger committed on the branch, and inspects the files themselves to see which steps are already done; finished work that was committed and pushed stays in place, and the runner continues from the first unfinished step instead of redoing or rolling back earlier ones.'
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
# 账本里 implement 阶段已记到第几步（phase 不是 implement 或无账本 → 0）
LEDGER=engineering/doc/FLY-2984-runner-lifecycle-note/progress.md
ledger_k() {
  local n=0
  if [[ -f $LEDGER ]] && grep -qx 'phase: implement' $LEDGER; then
    n=$(sed -n 's#^phaseCursor: \([0-3]\)/3$#\1#p' $LEDGER | head -1); [[ -n $n ]] || n=0
  fi; print $n
}
```

说明：`$(cat; printf x)` 保留结尾换行，避免命令替换吞掉 `\n` 造成误判。工作区状态（`state`）决定要不要写，已提交状态（`hstate`）决定要不要提交，账本（`ledger_k`）只前进不回退——三者分开判断，重跑任一更早的步骤都不会误提交或把游标拉回。

### 3.2 单步过程 `run_step k`（k = 1, 2, 3 依次执行）

```zsh
run_step() {
  local k=$1 s h; s=$(state); h=$(hstate)
  [[ $s == X || $h == X ]] && { print "STOP: $F 内容不匹配任何已知前缀"; return 2; }
  [[ -z $(git status --porcelain --untracked-files=all -- . ":(exclude)$F") ]] || { print "STOP: 工作树有 $F 以外的改动，ask Lead，不自行清理"; return 2; }
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
    [[ $(git diff --cached --name-only) == "$F" ]] || { print "STOP: 暂存区含其他文件"; return 2; }
    local m; eval "m=\$MSG$k"
    git commit -q -m "$m" -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' || return 2
  fi
  # (c) 记账：账本未到 k 才记（progress 会自行路径限定提交 progress.md）
  if (( $(ledger_k) < k )); then
    node "$FLYWHEEL_COMM_CLI" progress --exec-id "$FLYWHEEL_EXEC_ID" \
      --file "$LEDGER" --phase implement --cursor $k/3 --next "step $((k+1))/3" || return 2
  fi
  # (d) 推送：本地头与远端头不同才推；只允许 fast-forward
  local remote; remote=$(git ls-remote --exit-code origin "refs/heads/$BR" | cut -f1) || { print "STOP: 远端分支不可读"; return 2; }
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
[[ $(git ls-remote origin "refs/heads/$BR" | cut -f1) == $(git rev-parse HEAD) ]] && print V4 PASS || print V4 FAIL
# V5 三个 commit message 与合同一致、顺序正确
[[ $(git log --reverse --format=%s -- "$F") == "$MSG1"$'\n'"$MSG2"$'\n'"$MSG3" ]] && print V5 PASS || print V5 FAIL
```

V1–V5 全 PASS 才能进入交卷；任一 FAIL 按 3.2 的 STOP 规则处理。

### 3.4 交卷

按 implement 节点注入的收尾合同执行（账本已在 3.2(c) 写到 3/3 且已随最后一次 push 上远端 → `ask --report` 带 V1–V5 结果与三个 commit sha → 该节点规定的 `complete --route`）。本计划不硬编码 implement 的 route，不开 PR 到 main，不 merge。

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
| A 第 2 步写完未提交即被杀，重跑 1→2→3 | 第 1 步不误提交；第 2 步提交正确内容；最终 3 个交付 commit |
| B 第 3 步已提交、远端落后两个 commit，重跑 | 零新 commit，只 fast-forward 推齐 |
| 全部完成后重跑 1→2→3 | 零新 commit，零 push |
| 全部完成后单独重跑第 1 步 | 账本仍为 `phaseCursor: 3/3`（不回退） |
| V1–V5 | 全 PASS |
| C 文件被追加未知内容 | `STOP: … 不匹配任何已知前缀`，rc=2，不覆盖 |
| D 暂存了其他文件 | `STOP: 工作树有 … 以外的改动`，rc=2 |

第一版脚本在场景 A 中把「已写到第 2 步」的工作区内容误提交成 step 1——干跑发现后改为 `state`/`hstate`/`ledger_k` 三分判断，即现行版本。

`dryrun.zsh` 是设计证据，不是交付物；implement 不需要运行或修改它。
