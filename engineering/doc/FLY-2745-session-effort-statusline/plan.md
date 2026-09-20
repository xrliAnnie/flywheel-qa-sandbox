# FLY-2745 会话 effort 状态栏 — 实施计划
Issue: FLY-2745 (https://linear.app/geoforge3d/issue/FLY-2745/状态栏可信-cmux-里-leadrunner-的状态栏显示的-effort-不是本会话真实-effortstatusline)
日期: 2026-09-18
基于: research.md

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 让 cmux 状态栏只显示当前 Claude 会话的真实 effort；没有会话证据时明确显示 `?`。

**架构：** `statusline-command.sh` 用一个小型 allowlist 规范化函数统一验证来源，按 stdin `effort.level`、`CLAUDE_EFFORT`、有界 Claude 祖先进程 argv 的顺序选择。显示层不再读取全局 `settings.json`，也不按模型猜测。

**技术栈：** Bash 3.2、jq、macOS/BSD `ps`、现有 hermetic shell harness。

---

## 文件边界

| 文件 | 责任 |
| --- | --- |
| `scripts/statusline-command.sh` | 解析、验证并显示当前会话 effort |
| `scripts/__tests__/fixtures/fly1678/session.json` | 给既有 statusline suite 提供官方 stdin effort 形状，维持既有 golden 的 `high` |
| `scripts/__tests__/fly1678-statusline-fable.test.sh` | 在既有 CI 登记 suite 内覆盖三来源、优先级、全局阴性对照、未知状态 |
| `scripts/install-statusline.sh` | source/target smoke 改用会话 stdin，并拒绝全局值偷渡 |
| `engineering/doc/FLY-2745-session-effort-statusline/progress.md` | restart-resilient implement cursor |
| `engineering/doc/milestones/FLY-2745.md` | PR literal-last milestone commit |

不新增 test 文件，因此 `.github/workflows/ci.yml` 与 Ubicloud fixture 的既有精确登记保持不变。

## Task 1：先建立会话来源行为尺子

**Files:**

- Modify: `scripts/__tests__/fixtures/fly1678/session.json`
- Modify: `scripts/__tests__/fly1678-statusline-fable.test.sh`

- [ ] **Step 1：把既有默认 session fixture 改成官方形状**

```json
{
  "model": { "display_name": "Opus 5", "id": "claude-opus-5" },
  "workspace": { "current_dir": "/repo/flywheel" },
  "context_window": { "used_percentage": 42 },
  "effort": { "level": "high" }
}
```

这让既有 line 1 golden 继续代表会话 `high`，不再依赖 fake global settings。

- [ ] **Step 2：在已登记 suite 加四个 FLY-2745 用例**

测试 helper 用 fake HOME 写 `{"effortLevel":"xhigh"}`，用 `CLAUDE_EFFORT` 注入环境，
并在临时 PATH 中放一个受控 `ps` 替身返回 Claude argv。断言去 ANSI 后 line 1：

```text
stdin medium + env high + argv low -> Opus 5/medium
stdin missing + env high + argv low -> Opus 5/high
stdin/env missing + argv low       -> Opus 5/low
all three missing                  -> Opus 5/?
```

每条都断言 `xhigh` 不出现。第一条还同时断言低优先级的 `high`、`low` 不出现。

- [ ] **Step 3：运行 focused suite，确认 RED 原因正确**

Run:

```bash
bash scripts/__tests__/fly1678-statusline-fable.test.sh
```

Expected: FLY-2745 的 stdin/unknown 断言失败；实际实现仍显示 fake global `xhigh`。既有
FLY-1678 断言不应因测试语法或 fixture 破坏而报错。

- [ ] **Step 4：提交测试红侧与文档**

```bash
git add engineering/doc/FLY-2745-session-effort-statusline \
  scripts/__tests__/fixtures/fly1678/session.json \
  scripts/__tests__/fly1678-statusline-fable.test.sh
git commit -m "test(FLY-2745): expose global effort statusline lie"
```

## Task 2：最小实现会话 effort 选择器

**Files:**

- Modify: `scripts/statusline-command.sh`
- Test: `scripts/__tests__/fly1678-statusline-fable.test.sh`

- [ ] **Step 1：增加单一规范化函数**

函数把候选值转为小写，只接受：

```text
low medium high xhigh max auto
```

空值或其他文本返回失败，不把任意外部字符串送到终端。

- [ ] **Step 2：增加 stdin 与环境来源**

用 jq 从 `.effort.level` 读取；若 `.effort` 本身是字符串也接受。有效 stdin 值优先；
否则验证 `CLAUDE_EFFORT`。

- [ ] **Step 3：增加有界 argv 兜底**

从 `$PPID` 起最多检查四层。每层一次：

```bash
ps -p "$pid" -o ppid= -o command=
```

只从含 Claude executable 的命令读取 `--effort VALUE` 或 `--effort=VALUE`；候选继续走
同一 allowlist。PID 无效、`ps` 失败或到达 PID 1 都正常降级，不写 stderr。

- [ ] **Step 4：删除伪来源并显式显示未知**

完整删除：

```bash
jq -r '.effortLevel // empty' "$HOME/.claude/settings.json"
```

以及 Opus 4.6 → `medium` 的型号推断。没有有效来源时设 `effort="?"`，沿用现有
`model/effort` 槽与 DIM 颜色。

- [ ] **Step 5：运行 focused suite，确认 GREEN**

Run:

```bash
bash scripts/__tests__/fly1678-statusline-fable.test.sh
```

Expected: 所有既有和新增 checks 通过，0 failures，无 stderr。

- [ ] **Step 6：提交最小实现**

```bash
git add scripts/statusline-command.sh
git commit -m "fix(FLY-2745): show session effort in statusline"
```

## Task 3：修正 installer smoke 的权威来源

**Files:**

- Modify: `scripts/install-statusline.sh`
- Test: `scripts/__tests__/fly1678-install-statusline.test.sh`

- [ ] **Step 1：先改 smoke 夹具与断言**

- fake settings 写 `{"effortLevel":"xhigh"}`，作为阴性对照；
- stdin 增加 `"effort":{"level":"medium"}`；
- anchor 增加 `medium`；
- 显式拒绝输出中出现 `xhigh`。

- [ ] **Step 2：针对旧实现验证 smoke 会红**

在临时 scratch 中把候选 effort block 变异回读取 global settings，然后运行 installer
suite；预期 source smoke 或 FLY-2745 行为断言失败。变异体不进入 git。

- [ ] **Step 3：运行 installer focused suite**

Run:

```bash
bash scripts/__tests__/fly1678-install-statusline.test.sh
```

Expected: 全部 installer transaction checks 通过，0 failures。

- [ ] **Step 4：提交 smoke 修复**

```bash
git add scripts/install-statusline.sh
git commit -m "test(FLY-2745): bind statusline smoke to session effort"
```

## Task 4：静态、聚焦、聚合验证与 merge-tree

**Files:**

- Verify only

- [ ] **Step 1：shell 语法与 shellcheck**

```bash
/bin/bash -n scripts/statusline-command.sh scripts/install-statusline.sh \
  scripts/__tests__/fly1678-statusline-fable.test.sh
shellcheck scripts/install-statusline.sh scripts/__tests__/fly1678-statusline-fable.test.sh
```

`statusline-command.sh` 若仍只有仓库既有 SC2059，单独记录，不把历史告警写成新增失败。

- [ ] **Step 2：重复运行两个 focused suites**

```bash
bash scripts/__tests__/fly1678-statusline-fable.test.sh
bash scripts/__tests__/fly1678-install-statusline.test.sh
```

- [ ] **Step 3：按节点合同跑允许的仓库检查**

```bash
pnpm lint
pnpm -r build
```

⛔ 不运行本地 `pnpm test:packages:run`。

- [ ] **Step 4：记录与 origin/main 的 merge-tree**

```bash
git fetch origin main
git merge-tree "$(git merge-base HEAD origin/main)" HEAD origin/main
```

保存是否存在冲突及 merge-base/head/main 三个 SHA 到 PR body/报告。

## Task 5：literal-last milestone、代码审查与 PR

**Files:**

- Create last: `engineering/doc/milestones/FLY-2745.md`

- [ ] **Step 1：创建 literal-last milestone commit**

创建 `engineering/doc/milestones/FLY-2745.md` 后提交。它必须是准备送审 head 的最后一笔
commit。

- [ ] **Step 2：打开并登记 effective code review gate**

```bash
review_gate_json=$(node "$FLYWHEEL_COMM_CLI" gate review_code --lead flywheel-eng-lead \
  --exec-id ed07bf5a-047d-4cf8-86dd-230d8b4f6f54 --no-block \
  "Code review requested for FLY-2745")
review_question_id=$(printf '%s' "$review_gate_json" | jq -er '.questionId')
node "$FLYWHEEL_COMM_CLI" request-review --type code --question-id "$review_question_id"
```

轮询至 `reviewVerdict=APPROVED`；CHANGES_REQUESTED 只修 blocking finding。若发生修订，先提交
修订，再更新 milestone 并把它作为新的 literal-last commit，然后用新 gate 重审。

- [ ] **Step 3：push feature branch 并开 PR**

PR body 分开列 focused tests、lint/build、未跑本地 package aggregate、merge-tree、真机截图
尚待 QA/激活权限。

- [ ] **Step 4：复核 exact PR head 与 CI 状态**

本 implement 节点不运行 `ci-full ensure`；QA 才能冻结 current head 并请求 full CI。只如实
记录当前 PR checks，不把普通绿灯写成 QA 或 ship 权限。

- [ ] **Step 5：报告并走注入完成路由**

```bash
node "$FLYWHEEL_COMM_CLI" ask --lead flywheel-eng-lead \
  --exec-id ed07bf5a-047d-4cf8-86dd-230d8b4f6f54 --report \
  "DONE: FLY-2745 implementation and PR ready ..."
pr_number=$(gh pr view --json number --jq '.number')
node "$FLYWHEEL_COMM_CLI" complete --route needs_review --pr "$pr_number"
```

不派 QA、不请求 ship approval、不 merge、不安装到生产全局路径。

## 自审

- 覆盖 stdin、环境、argv、未知四格；全局 `xhigh` 是每格阴性对照。
- 覆盖 installer smoke、旧实现变异、既有 statusline 回归。
- effort 决策链、settings 值、部署与真机重启均不在修改集。
- 没有未决设计项；运行时 gate/PR id 均由命令回执捕获，命令、文件、预期结果明确。
