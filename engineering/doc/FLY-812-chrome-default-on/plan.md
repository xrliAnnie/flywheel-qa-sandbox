# FLY-812 Chrome 默认开 — 实施计划

Issue: FLY-812 (https://linear.app/geoforge3d/issue/FLY-812/infrap1regression-fly-751-一刀切关掉所有非-qa-runner-的-claude-in-chrome-破坏-sub)
日期: 2026-07-03
基于: exploration.md, research.md

## 0. 决策(brainstorm gate 已拍板 = 方案 A)

Lead(flywheel-eng-lead)确认理解无误 + 拍板 **A(surgical P1)**:

- chrome 默认开(`disableChrome` 默认 `false`)。
- opt-out = 新 `no-chrome` issue label(和 `full-mcp` 对称)。
- 插件瘦身(discord/playwright/serena)**不动**;QA **字节不变**;TmuxAdapter 机制**不碰**。
- 并发上限(admission gate / 766 option C)**不拉进本 P1**,留给 766 fast-follow。
- **hold 在 founder ship-gate,不自 ship。**
- 上线后**由 Lead 撤**临时 kill-switch。方向 Lead 同步到 812 thread 给 Annie(inform + 可否决、非阻塞)。

## 0.1 决策更新(founder 复核 2026-07-03,QA·815 后)

Annie 在 founder ship-gate 复核后,**改了插件瘦身范围**(§0 里「插件瘦身不动=关三个」被此条取代):

- **discord 保留**(不关)—— runner 测试时有时需要。
- **playwright 保留**(不关)—— geoforge3d 测试时需要。
- **serena 关掉** —— 0/375 runner session 确认未用,founder 接受这点小 slim(~120-200MB/session)。
- chrome 仍默认开 + `no-chrome` opt-out(§0 核心不变)。

即 `DEFAULT_RUNNER_DISABLED_PLUGINS` 从 `[discord, playwright, serena]` 收窄为 **`[serena]`**。理由:本 P1 的教训就是 FLY-751「看着没用就一刀切」弄坏了真实用户,discord/playwright 有确认的真实用途,不冒重蹈覆辙的险;真要再省单独开 measured issue。此改动**触发重 Codex code review + 重 QA**(旧 815 验的是三-slim 版)。

## 1. 目标 / 非目标

**目标**:非-QA runner 恢复 Claude-in-Chrome;fleet 内存靠已合并的 766 reaper + 保留的插件瘦身兜。

**非目标**:并发上限(766 fast-follow);碰 TmuxAdapter;改插件瘦身列表;改 `full-mcp` / `FLYWHEEL_RUNNER_SLIM_MCP` 语义。

## 2. 改动清单(最小 diff)

唯一生产代码文件:**`packages/config/src/runner-mcp-profile.ts`**

1. 第 90 行策略翻转:
   ```ts
   // 旧:const disableChrome = !isQa;
   // 新:
   const disableChrome = labels.some((l) => l.toLowerCase() === "no-chrome");
   ```
   - `isQa` 保留(仍供 playwright carve-out `disabledPlugins` 用)。
   - `labels` 已在函数内(第 73 行 `const labels = args.issueLabels ?? []`)。
   - degenerate null 检查(第 94 行)**不变**:非-QA + 空插件 + 无 no-chrome → `{[], false}` → return null(字节兼容 spawn),语义正确。

2. 注释更新 —— **覆盖文件内所有过时的 policy 注释**,不只顶段(Codex R1 #3):
   - 模块头段(1-27 行):chrome 语义改为「**默认开**;opt-out = `no-chrome` label」;`no-chrome` label 补进第 25-27 行的 escape-hatch 列表(与 `full-mcp` 并列,说明它只关 chrome、不撤插件瘦身)。
   - 第 27 行「empty override still slims chrome for non-QA」—— 现已不成立(chrome 默认开),改写。
   - 第 53 行 `sessionRole` doc「"qa" keeps the browser」—— 收窄为「"qa" 保留 playwright(browser 自动化)」,chrome 不再是 QA 专属。
   - 「QA exemption below」注释(第 86 行上方)+ 第 92-93 行 degenerate 注释(「QA with an empty list...」)—— 更新为反映 chrome 默认开 + `no-chrome` opt-out。
   - **不扩到 TmuxAdapter**;adapter 行为保持不动。

**不改**:`run-dispatcher.ts`(两处调用入参不变)、`TmuxAdapter.ts`(仍按 `disableChrome` 拼 `--no-chrome`)、`Blueprint.ts`、插件默认列表。

## 3. TDD 步骤(RED → GREEN → REFACTOR)

### RED — 先改/加测试(全红)

`packages/config/src/__tests__/runner-mcp-profile.test.ts`:
- 改「default」用例:`disableChrome` 期望 `true` → `false`(插件列表不变,仍是 3 个)。
- 改「non-qa sessionRole (main)」:`disableChrome` `true` → `false`。
- 改「env 覆盖 split/trim/filter」:`disableChrome` `true` → `false`。
- 改「empty env list + 非-QA」:`{disabledPlugins: [], disableChrome: true}` → 现在 `{[], false}` 命中 degenerate null → 期望 `toBeNull()`(用例语义随之调整)。
- QA 用例(`disableChrome:false`)不变。
- **新增**:`no-chrome` label(大小写不敏感)→ 非-QA 得 `{disabledPlugins:[3 个], disableChrome:true}`;QA + `no-chrome` → chrome 也关(label 优先,`{disabledPlugins:[discord,serena], disableChrome:true}`)。
- **新增**:`no-chrome` + `full-mcp` 同时存在 → `full-mcp` 先短路 return null(维持既有优先级)。
- **新增(Codex R1 #2)**:`no-chrome` + 空插件 env 覆盖 —— `resolveRunnerMcpProfile({ issueLabels:["no-chrome"], env:{ FLYWHEEL_RUNNER_DISABLED_PLUGINS:"" } })` 期望 `{ disabledPlugins:[], disableChrome:true }`(**非** null)。证明 opt-out 穿过 degenerate guard 不被吞掉:`disabledPlugins.length===0` 但 `disableChrome===true` → 不命中 `return null`。

`packages/teamlead/src/__tests__/run-dispatcher.test.ts`:
- `DEFAULT_PROFILE`(第 237 行)`disableChrome: true` → `false`。其余断言不变。

### GREEN — 落第 2 节的 diff,跑到全绿

`pnpm --filter flywheel-config test` + `pnpm --filter flywheel-teamlead test`(至少 run-dispatcher.test)+ `pnpm --filter flywheel-claude-runner test`(包名核实 = `flywheel-claude-runner`,**非** `@flywheel/claude-runner`;Codex R1 #1。TmuxAdapter.test 应仍绿,证明机制未受影响)。

### REFACTOR

无结构性重构需求(单行策略 + 注释)。确认无新死代码。

## 4. 验证 / QA(founder-gate 前)

- **单测**:上述三包全绿。
- **全仓 lint**:`pnpm lint`(biome)—— push 前必跑全仓,防 format/长行(历史两次 CI 头轮挂 biome)。
- **QA(独立 session)目标 = Lead 给的受影响 nightly 作业,确认恢复 chrome**:
  - `com.flywheel.sub-daily-loop`(Sub 夜间 cron)。
  - growth 的 learn / report / improve 作业。
  - 验证要点:非-QA runner 启动 argv **不含** `--no-chrome`(chrome 恢复);带 `no-chrome` label 的 runner argv **含** `--no-chrome`(opt-out 生效);插件瘦身仍在(`--settings` 里 discord/playwright/serena=false)。

## 5. 上线后 ops(非代码;Lead 执行)

正式修 deploy(Bridge 重启拿新 dist)**之后**,撤 `~/.flywheel/.env` 的 `FLYWHEEL_RUNNER_SLIM_MCP=0` → 瘦身以新语义恢复(chrome 开 + 插件瘦)。**顺序不能反**(先 deploy、再撤 env)。

## 6. 风险 / 回滚

- 风险极低:单行策略翻转 + 纯函数,已有测试网密。
- 回滚:revert 单个 commit 即回到 751 语义;或临时重设 `FLYWHEEL_RUNNER_SLIM_MCP=0`(kill-switch 仍在)。
- 内存回归担忧:chrome 常驻 MCP 的内存是「中等」项,真正大头(agent-browser Chrome-for-Testing)由 766 reaper 管、与本改动正交。若 fleet 内存后续吃紧,正解是 766 的并发上限 fast-follow,不是退回关 chrome。
