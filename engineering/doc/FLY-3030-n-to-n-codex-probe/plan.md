# FLY-3030 N-to-N Codex 体探针 — 实施计划
Issue: FLY-3030 (https://linear.app/geoforge3d/issue/FLY-3030/529-合成单勿派-fly-2919-真房-n-to-n-codex-体)
日期: 2026-09-28
基于: research.md

## 0. 目标与不变量

**唯一产品改动**：`README.md` 末尾追加一行 `FLY-2919 N-to-N codex-body probe`，然后按 implement 合同交卷：PR → milestone 末提交（冻结最终头）→ 对冻结头做代码评审 → 精确头 CI → `ask --report` → `complete --route needs_review`。

**核心不变量（为 FLY-2919 的「死体换体 / 同 thread 续干」服务）**：implement 的每一步都是 **幂等** 的——先用 git/GitHub 判据判断「已完成？」，已完成就跳过，未完成才动手。任何执行体在任何一步被杀，新体从 Task 0 重新跑同一套命令都收敛到同一个终态：README 恰好 1 行目标行、恰好 1 个 README commit、恰好 1 个 PR、milestone 是 PR 头的最后一个 commit，且代码评审批准绑定的就是这个最终头。

**顺序为什么是「先冻结、后评审」**：代码评审门校验 `reviewedHeadSha === HEAD`（`packages/flywheel-comm/src/commands/await-codex-gate.ts` 的 code 分支）。评审之后再落任何 commit（账本、milestone）都会让批准失效。所以所有写入（README、账本、milestone）在评审 **之前** 完成并冻结，评审对象就是最终头，之后不再产生任何 commit。

所有命令都是 **POSIX sh**（Codex 体与 Claude 体都能逐字照抄）。执行方式：**每个 Task 代码块前拼上 §1 常量块，作为一次独立的 `sh` 执行**（`stop` 用 `exit 1`，只终止这一次执行；块与块之间不共享变量，需要的值每块自己重新推导）。

## 1. 常量与助手（拼在每个块前面）

```sh
cd "$(git rev-parse --show-toplevel)" || exit 1
BR=project-slot-2-FLY-3030
LINE='FLY-2919 N-to-N codex-body probe'
DOC=engineering/doc/FLY-3030-n-to-n-codex-probe
LEDGER=$DOC/progress.md
MS=engineering/doc/milestones/FLY-3030.md
REPO=xrliAnnie/flywheel-qa-sandbox
CLI="$FLYWHEEL_COMM_CLI"
EXEC="$FLYWHEEL_EXEC_ID"
stop() { echo "STOP: $*" >&2; exit 1; }
# 冻结判据：milestone 一旦进入 HEAD，分支即冻结，之后任何写账本/写文件的动作都跳过
frozen() { git cat-file -e "HEAD:$MS" 2>/dev/null; }
prog() {
  if frozen; then echo "frozen: skip progress $1"
  else node "$CLI" progress --exec-id "$EXEC" --file "$LEDGER" --phase implement --cursor "$1" --next "$2" || stop "progress failed"
  fi
}
# 范围白名单（§2）：先捕获列表并检查 git diff 退出码，再逐项匹配
scope_ok() {
  files=$(git diff --name-only origin/main...HEAD) || stop "git diff 失败，无法判定范围"
  bad=$(printf '%s\n' "$files" | grep -v -e '^$' -e '^README\.md$' -e "^$DOC/" -e '^engineering/doc/milestones/FLY-3030\.md$')
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
```

**为什么要 `frozen`/`prog`**：`progress` 每次都会落一个 commit。若执行体在 milestone 提交之后被杀，新体从 Task 0 重跑时，Task 2/3 里的账本更新会在 milestone 之后再落 commit，破坏「milestone 是字面最后一个 commit」并让评审批准失效。所有账本更新都经 `prog`，冻结后自动变成 no-op（设计阶段演练实测抓到过这个问题）。

`stop` 之后的正确动作永远是：`node "$CLI" ask --lead flywheel-test-2 --exec-id "$EXEC" "<STOP 原文 + 当前 git status/log>"`，然后等 Lead，不自愈。

## 2. 改动范围白名单（最终 PR diff）

`git diff --name-only origin/main...HEAD` 的每一行必须匹配下列之一（由 `scope_ok` 在 Task 0 与 **每次 push 之前** 检查）：

- `README.md`
- `engineering/doc/FLY-3030-n-to-n-codex-probe/` 下的文件（设计文档、账本、founder HTML 及其 Mermaid 源/SVG）
- `engineering/doc/milestones/FLY-3030.md`

`README.md` 的 diff 必须恰好是 `+1 −0`（Task 1 断言）。

## 3. 任务

实现节点账本游标（Task 0 不计数，总数 3）：Task 2 完成 → `1/3`；Task 3 完成 → `2/3`；Task 4 在 milestone commit **之前** 写 `3/3`（`next` 写明「已冻结：评审冻结头 → CI → 回报 → 交卷，这些步骤不再写账本」）。冻结之后账本不再更新——这是 mutation freeze，账本的最后一条如实描述了冻结后剩余的只读步骤。

### Task 0 — 预检（每个新体第一件事）

```sh
[ "$(node "$CLI" turn --exec-id "$EXEC" | cut -d' ' -f1)" = yours ] || stop "TURN not yours（正常等待态：60–90s 后重试，不算失败）"
[ "$(git branch --show-current)" = "$BR" ] || stop "branch != $BR"
case "$(git config --get core.hooksPath)" in
  */state/push-guard/*) : ;;
  *) stop "core.hooksPath 不是 slot push-guard" ;;
esac
git fetch -q origin || stop "fetch failed"
git merge-base --is-ancestor origin/main HEAD || stop "HEAD 不含 origin/main（需要技术同步，先 ask）"
if git ls-remote --exit-code origin "refs/heads/$BR" >/dev/null 2>&1; then
  git fetch -q origin "$BR" || stop "fetch $BR failed"
  git merge-base --is-ancestor "origin/$BR" HEAD || stop "远端 $BR 不是本地 HEAD 的祖先（分叉/前体推过更新的头）"
fi
scope_ok
if frozen; then
  [ "$(git log -1 --format=%H -- "$MS")" = "$(git rev-parse HEAD)" ] || stop "milestone 已存在但不是最后一个 commit"
  echo "FROZEN：跳到 Task 4（只做 push + 断言），再 Task 5、Task 6"
fi
cat "$LEDGER"
git status --short
```

读账本 `nextStep` 与 `git status` 了解前体进度，但 **是否跳过某一步只看各 Task 的判据**，不看账本文字。Task 0 打印 `FROZEN` 时 Task 1–3 仍可照跑（全部判据命中、无写入），也可直接从 Task 4 开始。

TURN 为 `not-yours` 时是正常等待态：每 60–90 秒重跑 `node "$CLI" turn`，拿到 `yours` 再从 Task 0 开始。

### Task 1 — 追加目标行（S0 → S1，幂等）

```sh
n=$(grep -cxF -- "$LINE" README.md) || n=0
case "$n" in
  0)
    frozen && stop "已冻结但 README 缺目标行"
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
[ "$(tail -n 1 README.md)" = "$LINE" ] || stop "最后一行不是目标行"
[ "$(wc -l < README.md | tr -d ' ')" = 4 ] || stop "README 行数 != 4"
[ "$(wc -c < README.md | tr -d ' ')" = 77 ] || stop "README 字节数 != 77"
[ "$(git diff --numstat origin/main -- README.md)" = "$(printf '1\t0\tREADME.md')" ] || stop "README 相对 origin/main 不是 +1/-0"
```

说明：`grep -c` 零命中时退出码为 1 但仍打印 `0`，所以用 `|| n=0` 兜住；`git diff --numstat origin/main -- README.md` 比较的是 **工作区 vs origin/main**，因此在 S1（未提交）和 S2+（已提交）下都成立。

### Task 2 — 提交 README（S1 → S2，幂等）

```sh
if git diff --quiet HEAD -- README.md; then
  echo "README 已提交，跳过"
else
  frozen && stop "已冻结但 README 有未提交改动"
  git add README.md
  git commit -m "docs(FLY-3030): append FLY-2919 N-to-N codex-body probe line" -- README.md || stop "commit failed"
fi
[ "$(git log --format=%H origin/main..HEAD -- README.md | wc -l | tr -d ' ')" = 1 ] || stop "origin/main..HEAD 中 README commit 数 != 1"
git diff --quiet HEAD -- README.md || stop "README 仍有未提交改动"
prog 1/3 "Task 3: push + 开 PR"
```

`progress` 只会 path-limited 提交 `progress.md`，不会带上其它文件。

### Task 3 — 推送并开 PR（S2 → S4，幂等）

```sh
pushbr
prs=$(gh pr list --repo "$REPO" --head "$BR" --state all --json number,state --jq '.[] | "\(.number) \(.state)"') || stop "gh pr list 失败（无法判定，别盲开 PR）"
case "$(printf '%s\n' "$prs" | grep -c .)" in
  0)
    gh pr create --repo "$REPO" --base main --head "$BR" \
      --title "docs(FLY-3030): FLY-2919 N-to-N codex-body probe" \
      --body "$(printf '%s\n' 'FLY-2919 QA 合成单：README.md 末尾追加一行 `FLY-2919 N-to-N codex-body probe`。' '' 'Design: engineering/doc/FLY-3030-n-to-n-codex-probe/plan.md' '' '## Linear Issue' 'FLY-3030: [529 合成单·勿派] FLY-2919 真房 N-to-N · Codex 体' 'https://linear.app/geoforge3d/issue/FLY-3030' '' '## Test plan' '- [x] README 字节/行数/唯一性断言（plan Task 1）' '- [x] local-test-policy/v1：选中测试集为空，未跑本地套件' '- [ ] PR 精确头 CI（全量证据）')" \
      || stop "gh pr create 失败"
    ;;
  1)
    printf '%s\n' "$prs" | grep -q ' OPEN$' || stop "已有 PR 但不是 OPEN：$prs"
    ;;
  *) stop "同分支有多个 PR：$prs" ;;
esac
PR=$(open_pr) || stop "gh pr list 失败"
[ -n "$PR" ] || stop "取不到 PR 号"
echo "PR=$PR"
prog 2/3 "Task 4: 账本 3/3 → milestone 末提交（冻结）→ push"
pushbr
```

`gh pr create` 的 body 用 `$(printf …)` 内联，避免 `--body-file` 路径被当成重定向。

### Task 4 — 冻结：账本定稿 + milestone 末提交 + push（幂等）

顺序固定：**先写账本 3/3 → 再提交 milestone（字面最后一个 commit）→ push**。之后到交卷为止不再运行任何会产生 commit 的命令。

```sh
PR=$(open_pr) || stop "gh pr list 失败"
[ -n "$PR" ] || stop "取不到 PR 号"
if frozen; then
  [ "$(git log -1 --format=%H -- "$MS")" = "$(git rev-parse HEAD)" ] || stop "milestone 已存在但不是最后一个 commit"
  echo "已冻结（前体已提交 milestone）：跳过账本与 milestone 写入，只做 push + 断言"
else
  prog 3/3 "已冻结：评审冻结头 → 精确头 CI → ask --report → complete needs_review（这些步骤不再写账本）"
  mkdir -p engineering/doc/milestones
  cat > "$MS" <<EOF
# FLY-3030 implementation milestone

**Issue**: FLY-3030 — [529 合成单·勿派] FLY-2919 真房 N-to-N · Codex 体
**Date**: $(date +%Y-%m-%d)
**PR**: https://github.com/$REPO/pull/$PR

## Delivered scope

- README.md 末尾追加一行 \`FLY-2919 N-to-N codex-body probe\`（+1/-0），无其它产品改动。

## Verification evidence

- README 断言：目标行恰 1 次且为最后一行；4 行 / 77 字节；相对 origin/main numstat = 1/0。
- local-test-policy/v1：选中测试集为空（纯文档改动），未跑任何本地套件；全量证据 = PR 精确头 CI。
- 代码评审：对本 commit（冻结头）进行，批准绑定该头。
EOF
  git add "$MS"
  git commit -m "docs(FLY-3030): implementation milestone" -- "$MS" || stop "milestone commit failed"
fi
pushbr
HEAD_SHA=$(git rev-parse HEAD)
[ "$(git log -1 --format=%H -- "$MS")" = "$HEAD_SHA" ] || stop "milestone 不是最后一个 commit"
[ "$(gh pr view "$PR" --repo "$REPO" --json headRefOid --jq .headRefOid)" = "$HEAD_SHA" ] || stop "PR 头 != 冻结头"
echo "FROZEN_HEAD=$HEAD_SHA PR=$PR"
```

**换体安全性**：判据是 `frozen`（milestone 是否已进入 HEAD），与是否已推送无关。在 `prog 3/3` 之后、milestone commit 之前被杀 → 新体再写一次账本（多一个账本 commit，无害，且在 milestone 之前）后写 milestone，milestone 仍是最后；在 milestone commit 之后（无论推没推）被杀 → 新体所有写入都是 no-op，只做（幂等的）push 与断言。

### Task 5 — 对冻结头做代码评审（只读，幂等）

前置：Task 4 的断言全过（`frozen`、HEAD = 远端头 = PR 头）。

- **评审对象** = 冻结头 `FROZEN_HEAD` 上相对 `origin/main` 的 PR diff（README 的 `+1` 行 + milestone + 设计文档）。评审提示词 **必须以 implement 协议里的 `local-test-policy/v1` 块原文作为最开头的字节**。
- **走注入的评审门**：Claude 作者族 → `codex:rescue`，批准后按注入指令落账（例如 `codex-review-result --exec-id "$EXEC" --pr-head "$FROZEN_HEAD"`）；Codex 作者族 → 注入的 `request-review --type code` 通道。具体命令以 Bridge 注入的指令为准；落账的 reviewed head 必须等于 `FROZEN_HEAD`。
- **幂等**：若当前执行已有绑定 `FROZEN_HEAD` 的 APPROVED 落账（注入的 gate 命令，例如 `await-codex-gate code --exec-id "$EXEC"`，立即通过），跳过；否则重新评审——重复评审无副作用。
- **收口**：若注入指令要求 `await-codex-gate code`，在 HEAD 仍为 `FROZEN_HEAD` 时运行并必须通过。
- **CHANGES_REQUESTED 且需要改任何文件** → STOP + ask Lead。冻结后不自行落 commit（任何修改都会使 milestone 不再是最后一个、批准失效），由 Lead 决定是否解冻重来。
- **本地测试**：`git grep -lF -- "$LINE"` 只会命中 `README.md` 与本 issue 文档，选中测试集为空；按 local-test-policy **不回退到任何宽命令**，Task 1 的字节断言即本地证据。不装依赖、不跑 `pnpm lint/test`（无依赖树，且 `pnpm install` 会触发 husky 改写 hooksPath）。

本 Task 不写账本（已冻结）。

### Task 6 — 精确头 CI + 回报 + 交卷（单块，只读直到 complete）

```sh
frozen || stop "未冻结，不能交卷"
PR=$(open_pr) || stop "gh pr list 失败"
[ -n "$PR" ] || stop "取不到 PR 号"
HEAD_SHA=$(git rev-parse HEAD)
[ "$(git log -1 --format=%H -- "$MS")" = "$HEAD_SHA" ] || stop "milestone 不是最后一个 commit"
[ "$(git ls-remote origin "refs/heads/$BR" | cut -f1)" = "$HEAD_SHA" ] || stop "远端头 != 本地 HEAD"
[ "$(gh pr view "$PR" --repo "$REPO" --json headRefOid --jq .headRefOid)" = "$HEAD_SHA" ] || stop "PR 头 != 本地 HEAD"
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
node "$CLI" ask --lead flywheel-test-2 --exec-id "$EXEC" --report "DONE: FLY-3030 README probe line appended | commits: $(git log --format=%h origin/main..HEAD | tr '\n' ' ') | PR: https://github.com/$REPO/pull/$PR | head: $HEAD_SHA | CI: green" || stop "ask --report 失败，未交卷"
node "$CLI" complete --route needs_review --pr "$PR"
RC=$?
[ "$RC" = 0 ] || stop "complete exit $RC"
```

- `complete` exit 3（有未读邮件）：读输出里的邮件、处理、`node "$CLI" inbox --ack-consumed <read-id>`，然后 **只重跑** `node "$CLI" complete --route needs_review --pr "$PR"`（不重发 report）。
- 实现节点注入的完成命令与此不同时，**以注入命令为准**。
- 本块在 `ask --report` 之前被杀：新体重跑整块即可；在 `ask --report` 成功之后、`complete` 之前被杀：重跑整块会再发一次 report（内容相同，无害），然后交卷。

## 4. 回滚边界

- 合并前：PR 未合，`main` 不受影响；撤销 = 关闭 PR（需 Lead）。本节点与实现节点都不合并。
- 合并后：`git revert <README commit>` 单行即可回滚；README 行对任何代码路径无影响。

## 5. 负向守卫（显式不做）

- 不 `--no-verify`、不改 `core.hooksPath`、不 force push（非快进 → ask）。
- 不 `pnpm install` / 不跑任何本地测试套件 / 不改 `packages/`、CI、脚本、`CLAUDE.md`。
- 冻结后不落任何 commit（包括账本），评审批准只绑定冻结头。
- 不依赖窗口 / tmux / 进程存活做任何判断（「活体丢窗口不判死」由引擎负责，plan 不干扰）。
- 不向生产 Bridge / 生产仓做任何动作；不派单、不起 QA 房间。
- 不合并、不请求 ship。

## 6. 验收证据（交给 QA）

| 证据 | 取法 |
|---|---|
| README 目标行唯一且在末行 | `git show <PR头>:README.md \| tail -n 1` 与 `grep -cxF` = 1 |
| 恰 1 个 README commit | `git log --format=%H origin/main..<PR头> -- README.md \| wc -l` = 1 |
| milestone 为最后 commit | `git log -1 --format=%H <PR头> -- engineering/doc/milestones/FLY-3030.md` = PR 头 |
| diff 在白名单内 | §2 |
| 代码评审批准绑定 PR 头 | 注入评审门的落账（reviewed head = PR 头） |
| 精确头 CI 绿 | `gh pr checks <PR>` |
| 执行体生命周期（死体换体 / 丢窗口不判死 / 同 thread 续干 / 交卷回 thread） | FLY-2919 driver receipt（不在本 plan 的证据范围内） |

## 7. 设计阶段演练（dry-run）证据

用临时仓（真 README 字节 + 本地 bare origin + `flywheel-comm`/`gh` 桩）把 §3 的代码块逐字抽出执行（每块 = §1 + 该块，一次独立 `sh`）。R1 评审后按新顺序重跑：

| 场景 | 模拟 | 结果 |
|---|---|---|
| A 完工后换体重跑 | Task 0–4 + Task 6 全跑完，再从 Task 0 全部重跑 | PASS：HEAD 不变且 = 远端头；最后三个 commit 为 progress 2/3 → progress 3/3 → milestone |
| B 追加后被杀 | 只跑 Task 0–1，再从 Task 0 全跑 | PASS：目标行 1 次、README commit 1 个、milestone 为最后 |
| C milestone 已提交、push 失败后被杀 | Task 4 在 push 处 STOP，恢复 remote 后从 Task 0 全跑 | PASS：HEAD 不变且 = 远端头，milestone 仍是最后 |
| D 越界文件 | S2 后夹带 `foo.txt` 提交，跑 Task 0 | PASS：`STOP: diff 超出白名单：foo.txt`，远端未推 |
| D2 越界文件 | 同上，直接跑 Task 3 | PASS：push 前 STOP，远端未推 |
| E 目标行重复 | README 里已有 2 行目标行 | PASS：`STOP: 目标行出现 2 次` |
| F 目标行不在末行 | 目标行后还有一行 | PASS：`STOP: 目标行已存在但不是最后一行` |
| G CI 失败 | 桩 `gh pr checks` 返回 1 | PASS：`STOP: 精确头 CI 未全绿`，`ask`/`complete` 均未调用 |
| H report 失败 | 桩 `ask` 返回 1 | PASS：`STOP: ask --report 失败，未交卷`，`complete` 未调用 |
| I 范围扫描失败 | 删掉 `origin/main` 引用后调 `scope_ok` | PASS：`STOP: git diff 失败，无法判定范围` |

Task 5（评审）依赖注入的评审门，演练未覆盖；GitHub 真实 push / PR / CI 也只在实现节点发生。

演练首轮（R1 前）抓到并修掉一个真问题：完工后换体重跑，Task 2/3 的账本更新会在 milestone 之后再落 commit → 引入 `frozen`/`prog`。README 追加后实测 77 字节、4 行。
