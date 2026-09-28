# FLY-3030 N-to-N Codex 体探针 — 实施计划
Issue: FLY-3030 (https://linear.app/geoforge3d/issue/FLY-3030/529-合成单勿派-fly-2919-真房-n-to-n-codex-体)
日期: 2026-09-28
基于: research.md

## 0. 目标与不变量

**唯一产品改动**：`README.md` 末尾追加一行 `FLY-2919 N-to-N codex-body probe`，然后按 implement 合同交卷（PR → 评审门 → milestone 末提交 → `needs_review`）。

**核心不变量（为 FLY-2919 的「死体换体 / 同 thread 续干」服务）**：implement 的每一步都是 **幂等** 的——先用 git/GitHub 判据判断「已完成？」，已完成就跳过，未完成才动手。任何执行体在任何一步被杀，新体从 Task 0 重新跑同一套命令都收敛到同一个终态：README 恰好 1 行目标行、恰好 1 个 README commit、恰好 1 个 PR、milestone 是最后一个 commit。

所有命令都是 **POSIX sh**（Codex 体与 Claude 体都能逐字照抄）。执行方式：**每个 Task 代码块前拼上 §1 常量块，作为一次独立的 `sh` 执行**（`stop` 用 `exit 1`，只终止这一次执行）。

## 1. 常量（每个新 shell 先执行）

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
```

**为什么要 `frozen`/`prog`**：`progress` 每次都会落一个 commit。若执行体在 milestone 提交之后被杀，新体从 Task 0 重跑时，Task 2/3/4 里的账本更新会在 milestone 之后再落 commit，破坏「milestone 是字面最后一个 commit」。所以所有账本更新都经 `prog`，冻结后自动变成 no-op（设计阶段演练实测抓到过这个问题）。

`stop` 之后的正确动作永远是：`node "$CLI" ask --lead flywheel-test-2 --exec-id "$EXEC" "<STOP 原文 + 当前 git status/log>"`，然后等 Lead，不自愈。

## 2. 改动范围白名单（最终 PR diff）

`git diff --name-only origin/main...HEAD` 的每一行必须匹配下列之一，否则 STOP：

- `README.md`
- `engineering/doc/FLY-3030-n-to-n-codex-probe/` 下的文件（设计文档、账本、founder HTML 及其 Mermaid 源/SVG）
- `engineering/doc/milestones/FLY-3030.md`

`README.md` 的 diff 必须恰好是 `+1 −0`。

## 3. 任务

实现节点账本游标映射（Task 0 不计数）：Task 1+2 完成 → `1/4`；Task 3 完成 → `2/4`；Task 4 完成 → `3/4`；Task 5 在 milestone commit 之前写 `4/4`（见 mutation freeze）。所有账本更新一律走 §1 的 `prog`。

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
cat "$LEDGER"
git status --short
```

读账本 `nextStep` 与 `git status` 了解前体进度，但 **是否跳过某一步只看下面各 Task 的判据**，不看账本文字。

TURN 为 `not-yours` 时是正常等待态：每 60–90 秒重跑 `node "$CLI" turn`，拿到 `yours` 再从 Task 0 开始。

### Task 1 — 追加目标行（S0 → S1，幂等）

```sh
n=$(grep -cxF -- "$LINE" README.md) || n=0
case "$n" in
  0)
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
  git add README.md
  git commit -m "docs(FLY-3030): append FLY-2919 N-to-N codex-body probe line" -- README.md || stop "commit failed"
fi
[ "$(git log --format=%H origin/main..HEAD -- README.md | wc -l | tr -d ' ')" = 1 ] || stop "origin/main..HEAD 中 README commit 数 != 1"
git diff --quiet HEAD -- README.md || stop "README 仍有未提交改动"
prog 1/4 "Task 3: push + 开 PR"
```

`progress` 只会 path-limited 提交 `progress.md`，不会带上其它文件。

### Task 3 — 推送并开 PR（S2 → S4，幂等）

```sh
git push -u origin "HEAD:refs/heads/$BR" || stop "push 被拒（非快进需 Lead 确认 FORCE-PUSH ACK，禁止 --no-verify）"
[ "$(git ls-remote origin "refs/heads/$BR" | cut -f1)" = "$(git rev-parse HEAD)" ] || stop "远端头 != 本地 HEAD"
prs=$(gh pr list --repo "$REPO" --head "$BR" --state all --json number,state --jq '.[] | "\(.number) \(.state)"') || stop "gh pr list 失败（无法判定，别盲开 PR）"
case "$(printf '%s\n' "$prs" | grep -c .)" in
  0)
    gh pr create --repo "$REPO" --base main --head "$BR" \
      --title "docs(FLY-3030): FLY-2919 N-to-N codex-body probe" \
      --body "$(printf '%s\n' 'FLY-2919 QA 合成单：README.md 末尾追加一行 `FLY-2919 N-to-N codex-body probe`。' '' 'Design: engineering/doc/FLY-3030-n-to-n-codex-probe/plan.md' '' '## Linear Issue' 'FLY-3030: [529 合成单·勿派] FLY-2919 真房 N-to-N · Codex 体' 'https://linear.app/geoforge3d/issue/FLY-3030' '' '## Test plan' '- [x] README 字节/行数/唯一性断言（plan Task 1）' '- [ ] PR 精确头 CI（全量证据）')" \
      || stop "gh pr create 失败"
    ;;
  1)
    printf '%s\n' "$prs" | grep -q ' OPEN$' || stop "已有 PR 但不是 OPEN：$prs"
    ;;
  *) stop "同分支有多个 PR：$prs" ;;
esac
PR=$(gh pr list --repo "$REPO" --head "$BR" --state open --json number --jq '.[0].number')
[ -n "$PR" ] || stop "取不到 PR 号"
echo "PR=$PR"
prog 2/4 "Task 4: 代码评审门（PR #$PR）"
git push origin "HEAD:refs/heads/$BR" || stop "账本推送失败"
```

`gh pr create` 的 body 用 `$(printf …)` 内联，避免 `--body-file` 路径被当成重定向。

### Task 4 — 代码评审门（幂等）

- 评审对象：PR 上 `README.md` 的 `+1` 行 + 设计文档。评审提示词 **必须以 implement 协议里的 `local-test-policy/v1` 块原文作为最开头的字节**。
- 走注入的评审门：Claude 作者族 → `codex:rescue`；Codex 作者族 → 注入的 `request-review --type code` 通道（以 Bridge 注入指令为准）。
- 已有与当前 PR 头绑定的 APPROVED 裁决（Bridge 已写的 `code-review.json` / `codex-review-result` 落账）→ 视为已完成，跳过。
- 评审若要求改 README 以外的东西：超出范围，STOP + ask。
- 本地测试：`git grep -lF -- "$LINE"` 只会命中 `README.md` 与本 issue 文档，选中测试集为空；按 local-test-policy **不回退到任何宽命令**，Task 1 的字节断言即本地证据。不装依赖、不跑 `pnpm lint/test`（无依赖树，且 `pnpm install` 会触发 husky 改写 hooksPath）；PR 里如实声明「本地 targeted 证据 = README 断言；全量 = PR 精确头 CI」。

完成后：

```sh
prog 3/4 "Task 5: 账本定稿 → milestone 末提交 → push → CI → complete"
```

### Task 5 — 账本定稿 + milestone 末提交 + 交卷（mutation freeze）

顺序固定：**先写账本 4/4 → 再提交 milestone（字面最后一个 commit）→ push → 之后只读**。push 之后不再运行任何会产生 commit 的命令（包括 `progress`）。

```sh
PR=$(gh pr list --repo "$REPO" --head "$BR" --state open --json number --jq '.[0].number')
[ -n "$PR" ] || stop "取不到 PR 号"
if frozen; then
  [ "$(git log -1 --format=%H -- "$MS")" = "$(git rev-parse HEAD)" ] || stop "milestone 已存在但不是最后一个 commit"
  echo "已冻结（前体已提交 milestone）：跳过账本与 milestone 写入，只做 push + 断言"
else
  prog 4/4 "已提交 milestone 并推送；等 PR #$PR 精确头 CI → ask --report → complete --route needs_review"
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
EOF
  git add "$MS"
  git commit -m "docs(FLY-3030): implementation milestone" -- "$MS" || stop "milestone commit failed"
fi
git push origin "HEAD:refs/heads/$BR" || stop "push failed"
HEAD_SHA=$(git rev-parse HEAD)
[ "$(git ls-remote origin "refs/heads/$BR" | cut -f1)" = "$HEAD_SHA" ] || stop "远端头 != 本地 HEAD"
[ "$(git log -1 --format=%H -- "$MS")" = "$HEAD_SHA" ] || stop "milestone 不是最后一个 commit"
git diff --name-only origin/main...HEAD | while IFS= read -r f; do
  case "$f" in
    README.md|engineering/doc/FLY-3030-n-to-n-codex-probe/*|engineering/doc/milestones/FLY-3030.md) : ;;
    *) echo "OUT-OF-SCOPE: $f"; exit 1 ;;
  esac
done || stop "diff 超出白名单"
```

**换体安全性**：判据是 `frozen`（milestone 是否已进入 HEAD），与是否已推送无关。在 `prog 4/4` 之后、milestone commit 之前被杀 → 新体再写一次账本（多一个账本 commit，无害）后写 milestone，milestone 仍是最后；在 milestone commit 之后（无论推没推）被杀 → 新体所有写入都是 no-op，只做（幂等的）push 与断言。push 成功之后不再运行任何会产生 commit 的命令。

### Task 6 — 等精确头 CI、回报、交卷（只读）

```sh
PR=$(gh pr list --repo "$REPO" --head "$BR" --state open --json number --jq '.[0].number')
[ -n "$PR" ] || stop "取不到 PR 号"
HEAD_SHA=$(git rev-parse HEAD)
[ "$(gh pr view "$PR" --repo "$REPO" --json headRefOid --jq .headRefOid)" = "$HEAD_SHA" ] || stop "PR 头 != 本地 HEAD"
i=0
while [ "$(gh pr view "$PR" --repo "$REPO" --json statusCheckRollup --jq '.statusCheckRollup | length')" = 0 ]; do
  i=$((i+1)); [ "$i" -le 20 ] || stop "10 分钟内 CI 未出现"
  sleep 30
done
gh pr checks "$PR" --repo "$REPO" --watch --interval 30; CI_RC=$?
echo "CI_RC=$CI_RC"
[ "$(gh pr view "$PR" --repo "$REPO" --json headRefOid --jq .headRefOid)" = "$HEAD_SHA" ] || stop "等待期间 PR 头漂移"
```

- `CI_RC=0` → 回报 + 交卷：

```sh
node "$CLI" ask --lead flywheel-test-2 --exec-id "$EXEC" --report "DONE: FLY-3030 README probe line appended | commits: $(git log --format=%h origin/main..HEAD | tr '\n' ' ') | PR: https://github.com/$REPO/pull/$PR | CI: green @ $HEAD_SHA"
node "$CLI" complete --route needs_review --pr "$PR"
```

- `CI_RC≠0` → 不修代码、不重推；先对照 `origin/main` 最近一次 CI 判断是否 pre-existing，把证据 `ask` Lead，等指示。
- `complete` 若 exit 3（有未读邮件）：读内容、`inbox --ack-consumed <read-id>`、处理后重跑同一条 `complete`。实现节点注入的完成命令与此不同时，**以注入命令为准**。

## 4. 回滚边界

- 合并前：PR 未合，`main` 不受影响；撤销 = 关闭 PR（需 Lead）。本节点与实现节点都不合并。
- 合并后：`git revert <README commit>` 单行即可回滚；README 行对任何代码路径无影响。

## 5. 负向守卫（显式不做）

- 不 `--no-verify`、不改 `core.hooksPath`、不 force push（非快进 → ask）。
- 不 `pnpm install` / 不跑任何本地测试套件 / 不改 `packages/`、CI、脚本、`CLAUDE.md`。
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
| 精确头 CI 绿 | `gh pr checks <PR>` |
| 执行体生命周期（死体换体 / 丢窗口不判死 / 同 thread 续干 / 交卷回 thread） | FLY-2919 driver receipt（不在本 plan 的证据范围内） |

## 7. 设计阶段演练（dry-run）证据

用临时仓（真 README 字节 + 本地 bare origin + `flywheel-comm`/`gh` 桩）把 §3 的代码块逐字抽出执行（每块 = §1 + 该块，一次独立 `sh`）：

| 场景 | 模拟 | 结果 |
|---|---|---|
| A 完工后换体重跑 | Task 0–5 全跑完，再从 Task 0 全部重跑 | PASS：HEAD 不变，无新 commit |
| B 追加后被杀 | 只跑 Task 0–1，再从 Task 0 全跑 | PASS：目标行 1 次、README commit 1 个 |
| C milestone 已提交、push 失败后被杀 | Task 5 在 push 处失败，恢复 remote 后从 Task 0 全跑 | PASS：HEAD 不变且 = 远端头，milestone 仍是最后 |
| E 目标行重复 | README 里已有 2 行目标行 | 按预期 `STOP: 目标行出现 2 次` |
| F 目标行不在末行 | 目标行后还有一行 | 按预期 `STOP: 目标行已存在但不是最后一行` |

演练首轮抓到并修掉一个真问题：完工后换体重跑，Task 2/3 的账本更新会在 milestone 之后再落 commit → 引入 `frozen`/`prog`。README 追加后实测 77 字节、4 行。
