# FLY-2026 浏览器按需启动 — 调研
Issue: FLY-2026 (https://linear.app/geoforge3d/issue/FLY-2026/宿主资源-浏览器按需启动playwright-常驻实例从-59-降到个位数1944-a3-遗留-w5-段)
日期: 2026-08-24
基于: exploration.md

## 0. 结论

FLY-2026 不需要再造 browser supervisor。FLY-1867 已完成启动侧的两级 lazy：普通会话在 machine policy 层不启动 Playwright MCP，显式 QA / `playwright` / `full-mcp` 会话才启动 MCP server，Chrome 则到第一个 browser tool 才启动；FLY-1867 与 FLY-766 已完成 session teardown 和 orphan 回收。

本段应补齐三个窄缺口：

1. 用现有 `setup-mcp-on-demand.sh` 完成宿主 cutover；
2. 增加一个只读、fail-closed 的 idle census，直接回答受管 Playwright/ProofShot 进程总量是否为个位数；
3. 修复 `visualCapture()` 中 ProofShot 已启动、后续截图失败时没有调用 `proofshot stop` 的回收缺口。

宿主 apply、runner/Terminal 重开与 GUI 验收不属于本 implement runner 的进程控制权；代码交付提供明确命令和证据格式，由有宿主权限的 operator/QA 执行，不把 sandbox 的 `ps=EPERM` 写成“零进程”。

## 1. 当前链路与权威边界

| 路径 | 启动条件 | Chrome 何时启动 | 正常回收 | 后备回收 | 本段结论 |
|---|---|---|---|---|---|
| ordinary runner / Lead | machine `playwright=false` 后不加载 MCP | 不适用 | 不适用 | 存量 session 仍由 teardown/reaper 收敛 | 复用 writer，完成宿主 apply |
| QA / `playwright` / `full-mcp` | `resolveRunnerMcpProfile()` per-launch positive opt-in | 第一个 browser tool | browser close / session teardown | `mcp-descendant-reaper` | 不改 profile 规则，做真实路径回归 |
| ProofShot / `agent-browser` | capture 命令显式 `proofshot start` | start 时 | `proofshot stop` | FLY-766 `chrome-session-reaper` | 修复 post-start error 漏 stop |
| Claude-in-Chrome | founder Chrome extension 已连接 | 复用 founder 已有 Chrome | 不由 Flywheel 杀掉 | 不适用 | 只做能力回归，不计入受管临时树 |

边界规则：

- `scripts/setup-mcp-on-demand.sh` 是 `~/.claude/settings.json` 的唯一 writer；本段不增加第二个配置 writer。
- `packages/config/src/runner-mcp-profile.ts` 是 per-launch opt-in 权威；本段不增加新 feature flag。
- `mcp-descendant-reaper.ts` / `mcp-process-classifier.ts` 是 Playwright MCP 进程识别与回收权威。
- `chrome-session-reaper.ts` 是 ProofShot/agent-browser Chrome 识别与回收权威。
- census 只读、永不 kill；`status=unknown` 必须让验收失败，不能降级成空集合。
- machine policy 只控制 Claude Code 消费的 `~/.claude/settings.json`。Cursor/IDE 自己启动的 Playwright MCP 即使 command shape 相同，也必须进入 `external/unmanaged` 披露桶，不能污染 Flywheel 可控子集的 `< 10` 判据或触发 rollback。

## 2. 启动侧已经 lazy 的源码证据

当前本机安装的 `@playwright/mcp@0.0.79` 在 MCP server 注册 `CallToolRequest` handler 时才执行 `initializeServer()` / `factory.create()`；`factory.create()` 才进入 `createBrowserWithInfo()`。因此：

- plugin 被加载时会有 MCP server 常驻；
- Chrome 不在 server 启动时创建，而在第一次 browser tool 调用时创建；
- 关闭普通会话的 plugin 是把 59/78 个常驻 server 降下来的正确层；
- 对 QA 正向 opt-in 仍保留“server 随会话起、Chrome 随第一条 tool 起”的能力。

这与 FLY-1867 的设计修正一致。为 stdio MCP 新增 idle timer/proxy 会复制退出、信号、升级与 profile 生命周期，收益小于风险。

## 3. 现有测量为什么还不够

`playwright-orphan-census.ts` 只回答“有没有符合 orphan 条件的 Playwright Chrome main”，无法回答以下验收问题：

- 当前有多少个 Playwright MCP wrapper/server 进程；
- 一个受管 Chrome main 的 renderer/GPU/helper 完整树有多少进程；
- ProofShot/agent-browser Chrome 是否仍驻留；
- 三类受管进程的 union 是否 `< 10`。

因此需要一个 read-only `browser-idle-census`：复用现有 process sweep 与 exact classifiers，输出稳定 JSON。design review R1 在 2026-08-24 的宿主只读样本中找到一棵由 `Cursor Helper: mcp-process` 持有、已常驻近两天的 exact `npm exec @playwright/mcp@latest` tree。它证明“进程形状相同”不等于“machine policy 对它有权威”。修正后的口径是：

```text
in-scope process union =
  exact Playwright MCP roots whose ancestor holder is OS-comm `claude`, plus descendants
  ∪ Playwright Chrome trees descended from those managed MCP roots
  ∪ ProofShot agent-browser trees whose exact profile carries a Flywheel runner execId
  ∪ orphanedManaged trees whose active owner evidence is gone but whose exact shape is
    inside an existing Flywheel cleanup authority:
      - exact MCP root with ppid=1
      - exact ms-playwright-mcp Chrome main with ppid=1
      - exact agent-browser profile that has no parseable Flywheel execId

disclosed but excluded from singleDigit =
  exact MCP roots whose complete live ancestor chain positively proves a
  Cursor/IDE/other non-Claude holder, plus descendants

ruled-out but never silently discarded =
  exact Chrome `chrome_crashpad_handler` executable rows whose ppid has
  already become 1
```

关键约束：

- 先用 exact classifier/profile marker 找 roots，再按 `pid/ppid` 扩展 descendants；不要用宽泛 `argv.includes("playwright")`。
- MCP ownership 沿 ancestor chain 判定：完整链上出现 OS `comm` basename 精确等于 `claude` 进入 active managed；完整链正面证明 Cursor/IDE/其它 non-Claude holder 才进 external；exact root 已 reparent 到 `ppid=1` 进入 `orphanedManaged`；其它缺行/循环为 `unknown`。agent-browser 在 `parseChromeProc()` 能解析出 Flywheel `execId` 时进入 active managed，exact agent-browser profile 无 execId 时保守进入 `orphanedManaged`，不能当 external 隐去。
- 同一个 pid 只计一次，避免 MCP descendant tree 与 Chrome tree 重叠时双计数。
- founder 普通 Chrome 不匹配受管 profile，不进入数字，也绝不能被回收。
- 只调用一次现有 `collectChromeSweepSample()`（其内部是已知的三次 `ps` sweep）；不用 `defaultListProcesses()` 再制造第四个时间点。沿用现有 candidate-relevant join 完整性规则。
- 任一 sensor 失败、逐行 classifier 出现 `unknown`（包括 `match + unknown` 混合样本）、或 relevant process join 缺关键字段，输出 `status=unknown`、`singleDigit=null`。
- `singleDigit=true` 只在 `status=ok && inScopeProcessCount < 10` 时成立，其中 in-scope = active managed ∪ orphanedManaged。只有正面证明由 non-Claude holder 持有的 external 才排除。

QA attempt 1 还暴露了 denominator 边界：`ppid=1` crashpad helper 不是能承载页面/窗口的 Chrome main，也无法从 reparent 后的单行反推原 browser owner，因此不应混入受管 browser tree 的 `<10` 分母；但静默丢弃同样不可接受。最终 census 把 exact handler identity 放进 `ruledOut.unattributedPpid1CrashpadHandlers`。R4 reviewer 的 live host 样本进一步证伪了首版 argv 假设：8 个 `chrome_crashpad_handler` 全部为 PPID 1，0/8 含 exact `--type=crashpad-handler`；真实 orphan 形状使用 `--monitor-self` / `--monitor-self-annotation=ptype=crashpad-handler`。因此最终判定以 exact `chrome_crashpad_handler` executable + PPID 1 为准，fixture 直接使用该真实 argv 形状。QA 的宿主观察只支持“每个仍存活 browser 大约有 1–2 个、总量随 live browser 有界”的经验上界；若零 live browser 时仍持续存在或数量无界增长，必须按泄漏重新调查，不能借 ruled-out 字段宣告通过。受管 Codex sandbox 对直接 `ps` 采样返回权限拒绝（`EPERM`），所以该经验边界的 live host 相关性直测和零可见窗在本 implement node 仍是 **unverified**；独立 QA/operator 必须在 founder 桌面会话补齐同窗 census 与窗口证据。

R2 的宿主只读样本验证了为什么需要第三态：一个系统 TMPDIR 的 `agent-browser-chrome-*` main 已运行约 15 小时，完整树 47 个进程；它没有 Flywheel execId，但 shape 落在现有 `chrome-session-reaper` 的 unattributed cleanup 权威内。如果把“归属证据已丢”误当成“不是我们的”，这台宿主会在 47 个残留进程存在时仍得到 `singleDigit=true`。

R3 进一步核清这棵样本由一个 reparent 到 `ppid=1` 的 `agent-browser-darwin-arm64` daemon 持有；Chrome main 自身不是 `ppid=1`，因此默认 reaper 与 one-shot unattributed migrate seam 都覆盖不到它。census 必须计数，但本 implement node 不因此新造 kill authority：runbook 将它升级为 founder-gated 一次性运维，明确区分 main + descendant tree 与 holder daemon，未处置前稳态验收保持未通过。

为防止 CLI 偷用旧构建，沿用 `fly-1867-playwright-orphan-census.mjs` 的 fresh-dist guard：source 比 `dist` 新或 package dirty 时拒绝执行，并提示先 build。

## 4. 发现的真实回收缺口

`publish-report.ts:captureReportScreenshot()` 已用 `started` + `finally` 保证 `proofshot stop`。但 `visual-capture.ts:visualCapture()` 当前顺序为：

```text
proofshot start → screenshot → proofshot stop
```

`stop` 位于成功路径的 `try` 内。如果 start 成功后 `open` / `screenshot` / artifact discovery 抛错，函数只释放 visual lock，不调用 stop。这会让浏览器依赖 session teardown 或 periodic reaper 才回收，违背“用完即收”的主路径合同。

公共 seam 的最小修复：

- RED：`visualCapture()` 在 start 成功、screenshot 失败时仍尝试一次 stop；原始错误仍可见；visual lock 仍释放。
- GREEN：记录 `proofShotStarted` 与 `proofShotStopAttempted`；正常 stop 前先标 attempted；`finally` 只补尚未尝试的 stop。
- stop 自身失败时不重试；若主错误与 finally cleanup stop 同时失败，沿用 `publish-report` 已评审过的取舍：warning 明确打印 cleanup 错误，但继续抛原始 screenshot 错误，不能让 cleanup 覆盖根因。正常成功路径上的 stop 失败仍照旧抛错。

这条测试走导出的 `visualCapture()`，不是私有 helper mock，符合使用方真正依赖的生命周期 seam。

## 5. 方案比较

| 方案 | 完成 W5 | 风险 | 结论 |
|---|---:|---:|---|
| 只写操作文档 | 部分 | 不能机器证明个位数，也不修 post-start leak | 不选 |
| 新建 MCP proxy/supervisor + idle timer | 是 | 重复生命周期与升级权威，扩大 blast radius | 不选 |
| 复用现有 writer/reaper + read-only census + 修 ProofShot failure cleanup | 是 | 改动窄，可用 public-seam TDD 锁定 | 选用 |
| 全面关闭所有 Chrome/CiC | 否 | 破坏 QA 与 founder 能力 | 不选 |

## 6. TDD public seams

### Slice A — ProofShot cleanup

- 公共 seam：`visualCapture()`。
- RED：start 成功，screenshot 失败，断言 stop 一次、lock release 一次、原始错误保留。
- GREEN：最小 cleanup state machine。
- REFACTOR：对齐 `publish-report` 的 warn-not-mask 语义；不提前抽象。

### Slice B — idle census

- 公共 seam：导出的纯函数 `classifyBrowserIdleCensus(sample)` 与 CLI JSON contract。
- RED cases：ordinary zero；Claude-held MCP tree；Cursor-held MCP external 分桶；`ppid=1` MCP/Playwright Chrome orphan；Flywheel-owned 与系统 TMPDIR agent-browser；founder Chrome 排除；sensor unknown；`match + unknown` 混合；in-scope union 达到 10 时 false。
- GREEN：用注入的一份 `ChromeSweepSample` 和现有 exact helpers 计算 ancestor ownership、roots/descendants/union。
- REFACTOR：collection adapter 只负责调用现有 sweep，分类逻辑保持纯函数。

### Slice C — operator contract

- 公共 seam：现有 `setup-mcp-on-demand.sh apply/check/rollback` + 新 census CLI。
- 不增加 writer。文档给出 preflight → apply → 用 census 的 epoch 字段披露 apply 前存量 backlog/orphanedManaged → 等班车/长跑 Runner 自然结束 → 两个 idle census → QA browser/ProofShot/CiC → window census → receipt 的精确顺序。
- implement runner 不运行生产 apply/restart；host evidence 由具备权限的 QA/operator 补入评审记录。

design review 通过即作为以上 seam 的确认；若 reviewer 改变口径，先改 plan 再写 RED。

## 7. 验收证据矩阵

| 验收 | 机器证据 | 权威执行者 |
|---|---|---|
| 空闲态个位数 | policy `check` 成功；apply 前 active/orphan backlog 已收敛；间隔 60 秒的两份 census 均 `status=ok` 且 `singleDigit=true`；positive non-Claude external 单独披露 | host operator / QA |
| QA browser 按需起/收 | opt-in settings；tool 前后 census；真实 browser tool 成功；close 后有界回落 | QA session |
| ProofShot 按需起/收 | failure-cleanup test；真实 capture；stop 后 census 回落 | package test + QA |
| CiC 可用 | extension connected；真实 tab/query 能力成功；不出现新受管 Playwright profile | founder-path QA |
| 不盖 founder 桌面 | 受管 target Chrome main 的 CoreGraphics on-screen layer-0 窗口数为 0；founder 普通 Chrome 阳性对照 `>0` | GUI-capable QA |

`ps`/CoreGraphics 不可用时结论只能是 `unknown`，不能通过。

## 8. Authority、风险与回滚

- 本 runner 可以改仓库、跑测试、开 PR；不能安全读取宿主进程表，也不应重开 founder Terminal/运行中 Lead。
- 宿主 apply 使用现有 writer receipt 和 backup；回滚使用其 `rollback`，不手改 JSON。
- apply 前 active/orphan backlog 尚未自然结束与 Cursor/IDE external tree 不构成 rollback，但都要如实披露；post-apply 新生的 orphanedManaged 是 hard failure，按来源处置：ordinary Playwright policy/teardown 失败则 rollback，ProofShot cleanup 失败则停止验收并修 cleanup（writer rollback 不能修 agent-browser）。
- census 误分类的主要风险是把 shape 当 ownership；用 exact command shapes + ancestor holder + runner profile ownership，以及 Cursor/founder 负例压住。
- census 漏报的主要风险是 process table 不完整；任一 sensor 异常 fail-closed 为 `unknown`。

## 9. 会过期的结论

| 结论 | 截止/触发器 | 当前依据 | 重查命令/位置 |
|---|---|---|---|
| 宿主仍 policy drift | settings 发生任何 apply/rollback 后 | 2026-08-24 `check` 返回 drift | `scripts/setup-mcp-on-demand.sh check /Users/xiaorongli/.claude/settings.json` |
| Playwright MCP Chrome 为 first-tool lazy | `@playwright/mcp` 版本变化后 | 本机 `0.0.79` core bundle | 检查实际安装包 `CallToolRequest` → `factory.create()` |
| orphan census / Chrome reaper 在线 | Bridge 重启或版本部署后 | 2026-08-24 ledger/log | `~/.flywheel/state/fly1867/orphan-census.jsonl`、`/tmp/flywheel-bridge.log` |
| QA positive opt-in 规则不变 | `runner-mcp-profile.ts` 变化后 | 当前 source/tests | package tests + source audit |
| 空闲进程个位数 | 每次验收只对带时间戳样本有效 | 当前尚无权威全量样本 | 新 census，间隔 60 秒执行两次 |

## 10. 调研结论

实现应保持为两个代码 tracer bullets（ProofShot cleanup、read-only census）和一个复用既有 writer 的 operational cutover。这样既完成 FLY-1944 W5 的启动侧切换，也把“个位数”从观察性描述变成 fail-closed 的机器合同，同时不增加第二套浏览器生命周期权威。
