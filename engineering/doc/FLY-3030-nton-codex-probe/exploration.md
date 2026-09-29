# FLY-3030 N-to-N 活体探针 — 探索

Issue: FLY-3030 (https://linear.app/geoforge3d/issue/FLY-3030/529-合成单勿派-fly-2919-真房-n-to-n-codex-体)
日期: 2026-09-28
基于: 无（上游输入 = issue 正文；Linear MCP 本会话 401，按派单文本处理）

**Depth**: Quick　**Mode**: Technical　**Status**: final

## 1. 问题定义

FLY-3030 是 FLY-2919 QA 的**合成任务**（synthetic task = 为了测试编排层而人为造的工单，本身没有产品价值）。
它不要求任何功能，只要求房内 runner 按顺序做两件事：

1. **前台** `sleep 780`（13 分钟），自然结束后再进入第 2 步。目的是给 FLY-2919 的看门狗
   （watchdog = 判断 runner 是死是活的巡检逻辑）一个完整的 660 秒「活体安静窗口」：runner 活着，
   但屏幕长时间不变、也没有交互。看门狗**不能**把它判成死体。
2. 在沙箱仓 `xrliAnnie/flywheel-qa-sandbox` 的 `README.md` 末尾追加一行
   `FLY-2919 N-to-N claude-body probe`，commit、push、按正常流程交卷。

验收不在本任务内，由 FLY-2919 QA 按 driver receipt（派单脚本的回执）判定四件事：
死体当场终结并换体 / 活体丢窗口不判死 / 同一 thread 续干 / 交卷回 thread。

本设计节点的职责：把这两步写成**实现节点不可能做错**的执行计划，把「能悄悄破坏测试目的」的
坑全部列出并给出硬约束。不做实现。

## 2. 已知事实盘点

| 来源 | 事实 | 意义 |
|------|------|------|
| `git remote -v` | 本 worktree 的 origin 就是 `xrliAnnie/flywheel-qa-sandbox` | 第 2 步的目标仓 = 当前仓，无需 clone 别的仓 |
| `git branch --show-current` | 分支 `project-slot-1-FLY-3030`，基于 origin/main `1855f7a1a` | 直接在此分支提交；不建新分支（git-workflow skill 规则 1） |
| `README.md` | 3 行，末行 `FLY-1375 land E2E marker 20260722T023540Z`，文件以 `\n` 结尾 | 追加一行只需 `>>`，不必补前导换行 |
| Claude Code Bash 工具 | 默认超时 120 秒；`run_in_background` 会把命令脱离前台 | **`sleep 780` 必须显式传 `timeout ≥ 900000` 毫秒，且不能后台跑**，否则要么 2 分钟被杀、要么违反「前台」要求 |
| FLY-92 / FLY-193 看门狗 | 靠 pane（终端窗格）内容哈希 + live-region 识别判活 | sleep 期间**不要**打印进度、不要拆成多段 sleep——那会制造画面变化，让测试观察不到真正的安静窗口 |
| 派单环境 | 本 runner：slot 1、`FLYWHEEL_AGENT_BACKEND=claude-code`；issue 正文写「slot 2 --codex-runner，精确头 68eab069e」 | 与 issue 描述不一致；已作为**非阻塞**疑问报 Lead。两步任务内容与后端无关，设计不受影响 |
| 三阶段流水线 | 本 runner 是 `eng_design` 节点，后续由 implement / qa 节点接力 | sleep + 追加行由 **implement 节点**执行；本节点只产出设计 |

## 3. 影响面

| 文件 / 服务 | 变更 | 说明 |
|-------------|------|------|
| `README.md`（沙箱仓根） | 追加 1 行 | 唯一的产物改动 |
| `engineering/doc/FLY-3030-nton-codex-probe/*` | 新增 | 本节点设计文档 + founder HTML + progress |
| 生产代码 / packages | 无 | 零代码改动，零测试代码改动 |

## 4. 方案比较

### 方案 A：单条前台 `sleep 780` + 幂等追加（推荐）

- **核心**：一个 Bash 调用 `sleep 780`（timeout 900 秒，前台）；结束后
  `grep -qxF` 检查目标行不存在再 `>>` 追加；commit 只 add `README.md`；push；建 PR；交卷。
- **优点**：完全贴合 issue 字面要求；安静窗口纯净；幂等（重跑/续干不会追加第二行）。
- **缺点**：13 分钟内 runner 看起来「什么都没干」——这正是测试要的，不是缺陷。
- **工作量**：极小。

### 方案 B：分段 sleep 并打印心跳（拒绝）

- **核心**：`for i in 1..13; do sleep 60; echo tick; done`。
- **为何拒绝**：issue 明说「不要跳过、不要放后台、不要缩短」；打印心跳会让 pane 哈希持续变化，
  看门狗根本进不到「活体丢窗口」分支，FLY-2919 的验收失去意义。

### 方案 C：后台 sleep，同时先做 README（拒绝）

- **为何拒绝**：违反「先前台 sleep、自然结束后再做下一步」的顺序要求；且若看门狗在窗口内误杀，
  README 已提交会让「换体后续干」的观察被污染。

**推荐：方案 A。** 唯一符合测试目的的路径。

## 5. 澄清问题与处理

| # | 问题 | 处理 |
|---|------|------|
| Q1 | issue 说 slot 2 / codex-runner / 头 68eab069e，本 runner 是 slot 1 / claude-code。是否派错房？ | 非阻塞 `ask` 已报 Lead；不阻塞设计。README 目标行本身写的就是 `claude-body probe`，与本后端一致 |
| Q2 | 「按正常流程交卷」= 哪条 `complete` 路由？ | implement 节点用其注入提示词指定的阶段完成路由（三阶段流水线的正常路径），**不是** `pr_handoff`（那是无 transport 的 agy/kimi 专用） |
| Q3 | DoD 模板要求「写测试」，README 单行改动无可测代码 | 显式豁免：验证 = `tail -1 README.md` 逐字相等 + `git diff --stat` 只含 README.md |
| Q4 | `pnpm lint` 是否要跑？ | README 不在 biome 范围；不跑。局部验证命令见 plan |

## 6. 决策

- 采用方案 A。
- 硬约束（写进 plan 的 negative guards）：单条 sleep / 前台 / timeout ≥ 900 秒 / 不打印 / 不缩短；
  追加幂等；只 add README.md；不建新分支；不 force push；不 merge。

## 7. 下一步

- [x] research.md：核实 Bash 工具超时、看门狗识别逻辑、`complete` 路由。
- [x] plan.md：逐步命令 + 验证 + 回滚边界。
- [ ] design_review → founder HTML → `complete --route phase_design_complete`。
