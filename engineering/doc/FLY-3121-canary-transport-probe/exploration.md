# FLY-3121 canary 传输探针 — 探索
Issue: FLY-3121 (https://linear.app/geoforge3d/issue/FLY-3121/529-canary-fly2127-canary-eeb549be-1af1-44c6-93d3-a0cb7f40022c-phase)
日期: 2026-10-01
基于: 无

## 1. 这张单要什么

Issue 原文（唯一需求来源）：

> A bounded transport exercise: append requested marker lines to probe.txt, commit locally, and acknowledge native mail or TURN. No product implementation, shipping or deployment. Owner: FLY2127-CANARY-eeb549be-1af1-44c6-93d3-a0cb7f40022c.

拆成四件事：

1. **追加**：把「被要求的 marker 行」追加到 `probe.txt`。
2. **本地提交**：只做本地 commit。
3. **回执**：对 native mail（Lead 经 mailbox 下发的指令）或 TURN（共享工作树的轮次归属）做确认。
4. **边界**：不做产品实现、不发版、不部署。

这是一次**传输演练**：被验证的是「指令能送达 Runner → Runner 能安全落一笔可核对的本地改动 → 回执能送回 Lead」这条链路，而不是 `probe.txt` 的内容本身有什么产品价值。

## 2. 仓库现状审计（2026-10-01，HEAD `31998a85d`）

| 审计项 | 结果 | 取证命令 |
|---|---|---|
| 仓库 | `xrliAnnie/flywheel-qa-sandbox`（QA 沙箱，非生产仓） | `git remote -v` |
| 分支 | `project-slot-2-FLY-3121`，与 `origin/main` 齐平（0 领先 / 0 落后），远端尚无同名分支 | `git rev-list --count origin/main..HEAD`、`git ls-remote --heads origin project-slot-2-FLY-3121` |
| 仓库根 `probe.txt` | **不存在**，也未被 `.gitignore` 忽略 | `ls probe.txt`、`git check-ignore -v probe.txt`（exit 1） |
| `probe.txt` 的消费方 | **零**：仓库内没有任何代码/脚本/CI 读取仓库根 `probe.txt` | `git grep -n "probe\.txt" -- ':!engineering/doc'`（无输出） |
| 提交钩子 | `core.hooksPath` 指向 push-guard 目录，只有 `pre-push`；没有 `pre-commit` / `commit-msg` | `ls "$(git config --get core.hooksPath)"` |
| CI 触发 | `ci.yml` 只在 `pull_request → main` 与 `push → main` 触发 | `grep -n branches .github/workflows/ci.yml` |
| TURN | `yours phase=design epoch=1 … node=eng_design attempt=1` | `flywheel-comm turn --exec-id $FLYWHEEL_EXEC_ID` |
| 收件箱 | 目前**没有**下发任何 marker 指令 | `flywheel-comm inbox`、直查 `mailbox` 表 |
| Bridge | 沙箱 Bridge `:19872` 健康 | `curl $FLYWHEEL_BRIDGE_URL/health` |

结论：这是一个**纯新增**文件，没有持久化合同、没有迁移、没有既有消费方需要改。

## 3. 歧义与假设（显式列出）

| # | 歧义 | 处理 |
|---|---|---|
| A1 | marker 行的**具体内容**没写在 issue 里 | 假设由 Lead / canary 驱动在运行期经 mailbox 指令逐条下发。已用 `flywheel-comm ask` 非阻塞询问 Lead（question `7bd23282-305a-4cb4-8dff-2b9ad0a312a1`），设计不依赖具体内容。 |
| A2 | `probe.txt` 的路径 | 假设为**仓库根** `probe.txt`（issue 只写了裸文件名）。路径在设计里写死，绝不从指令文本里取。 |
| A3 | 「commit locally」是否意味着禁止 push | 假设含义是「演练的通过条件只要求本地 commit」。本设计既不要求也不禁止把**功能分支** push 到远端（由各节点注入的交接协议决定）；明确禁止的是 push main、merge、发版、部署。 |
| A4 | 没有任何 marker 指令到达时怎么办 | 假设「acknowledge native mail **or** TURN」中的 or 就是为此准备的：没有邮件时，以 TURN 自检结果作为回执。 |
| A5 | 同一条 marker 被重复下发（传输层重投） | 假设重投不应产生重复行 —— 追加必须幂等。 |

以上假设若被 Lead 否定，只影响 plan.md 的 Task 3（取 marker 行的来源）与回执措辞，不影响追加/校验/提交机制。

## 4. 方案选项

### 选项 A：手敲 `echo "<marker>" >> probe.txt`

- 优点：零新增文件。
- 缺点：marker 是**外部输入**，直接拼进 shell 命令行有引号/转义/命令注入风险；没有校验；重投会产生重复行；QA 无法复跑验证。

### 选项 B（推荐）：一个不到 50 行的 bash 辅助脚本 + 配套测试，放在本 issue 的文档夹内

- marker 行先用写文件工具**原样**落到临时文件，再由脚本整批校验 → 幂等追加。
- 校验失败整批拒绝、一个字节都不写。
- 脚本和测试都放在 `engineering/doc/FLY-3121-canary-transport-probe/`，不进 `packages/`、不进 `scripts/`，零产品代码改动。
- QA 可以复跑脚本验证幂等（第二次运行 `appended=0`、工作树无 diff）。

### 选项 C：在 `flywheel-comm` 里加一个 `probe append` 子命令

- 优点：可复用。
- 缺点：这是产品实现，直接违反 issue 的「No product implementation」；还要重新构建 dist、影响所有 Runner。

### 选择

**选项 B**。它是唯一同时满足「外部输入在边界校验」「幂等」「可复验」「零产品代码」的方案；比 A 多出的成本只是两个文档夹内的小文件。

## 5. 需要设计阶段定死的东西

- **稳定标识**：文件路径固定 `<repo-root>/probe.txt`；一行 marker 的身份 = 该行的**完整字节内容**（整行精确匹配）。
- **显示标签**：无（`probe.txt` 不被任何界面渲染）。
- **迁移**：无（新文件，无既有数据）。
- **回滚边界**：单笔 `git revert`，不 reset、不 force-push。
- **负向守卫**：diff 只允许出现 `probe.txt` 与本文档夹；不 push main、不 merge、不发版、不部署。
- **测试证据**：脚本自带测试（RED→GREEN）+ 提交后的 numstat / name-only 断言 + QA 复跑幂等。

这些在 research.md 给出事实依据，在 plan.md 落成可照抄的步骤。
