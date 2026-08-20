# FLY-1867 playwright-mcp Chrome 泄漏 — 实施计划

Issue: FLY-1867 (https://linear.app/geoforge3d/issue/FLY-1867/playwright-mcp-chrome-泄漏实例从不回收且有可见窗口盖住-founder-桌面-点击落空)
日期: 2026-08-20
基于: research.md

---

## 0. 方案总述

> **Founder 方向修正(2026-08-20,批准版 R18 之后到达)。** Founder 原话:「思考的不是说开了之后怎么关,而是我们为什么需要开它?如果不需要开的话,一开始就不应该打开呀。」随后校准为:**不是禁 Playwright MCP,目标是零白起浏览器**。Chrome 上游已 first-tool lazy;P0 修「用过一次后不回收」,P-1 让普通会话默认不带 MCP、额外消掉 19 个空挂 server。QA / `playwright` / `full-mcp` 等明确会话 positive opt-in;当前 Lead allowlist 为空,日常 browser 继续走 Claude-in-Chrome。完整重审计、cutover 与 rollback 合同见 `design-correction.md`。
>
> 该修正已通过增量 design review(`f71d0836-e7c0-4d16-b6b7-e1a3f2ee0bc0`,APPROVED);advisories 的实施收口见 `design-review-r19.md`。

> **R15 收窄(2026-08-20,Tadashi 裁决)。** R1–R14 把 P2「自动回收孤儿 Chrome」从「扩一下现有 reaper」一路推成了 supervisor + Chrome 启动 shim + 用受管插件替换官方 playwright 插件 + 六相 activation 事务 + 对整个 Chrome.app 做内容哈希 —— §10 十个交付物里六个只服务这一条兜底腿,而它要兜的「P0 之后的孤儿残量」**从来没有量过**。这与 Annie 2026-08-05 三连定案(**修结构别加报警器 · 所有繁复埋雷的东西全删 · 验收 = 删的比加的多**)正面冲突。本版把 P2 收成**只审计、不发信号**,P3 收成**一次性复核脚本**,砍掉的六项与理由见 §11。

**R1 评审改写了这份计划的骨架。** 初稿是「两个环境变量 + 两个回收器」;评审证明其中若干前提是错的,最重要的一条是:

> **泄漏的主要成因很可能是我们自己造成的** —— Flywheel 在拆 runner 时给 playwright-mcp 的优雅退出只留了 **3 秒**,而上游关浏览器的预算是 **15 秒**。我们在它关完之前就 SIGKILL 了它。

这把方案的重心从「加回收器」挪到了「别自己制造孤儿」。R15 把这个重心贯彻到底:**根因修掉之后,残量该由数据说话,不该先为它盖一座回收厂。**

| 腿 | 治什么 | 手段 | 性质 |
|---|---|---|---|
| **P-1 源头消除** | 不需要 browser 的会话为什么还起 playwright-mcp | machine default-off + QA / `playwright` / `full-mcp` positive opt-in;Chrome 沿用 upstream first-tool lazy | **第一道防线** |
| **P0 根因** | 我们自己切断了优雅关闭 | TERM → 轮询至消失 → 封顶 KILL;顺带让 reaper 认出真正持有 Chrome 的 inner 进程 | 改 reaper 的等待契约(**修结构**) |
| **P1 止血** | 可见窗口抢焦点 | `PLAYWRIGHT_MCP_HEADLESS=true` 落在 Claude 配置的 `env` 块 | 配置 + ops writer |
| **P2 量残量** | P0 之后是否仍有孤儿 | **audit-only census**:只写账本/日志,**零信号、零告警**;存量孤儿由 operator 一次性人工复核后手动 drain | 测量,不是机制 |
| **P3 清存量** | 存量 ~631 MB | **一次性**脚本:committed 复核清单 → quiet gate → `lsof` → rename 到 quarantine;删除 quarantine 是另一条显式人工命令 | 一次性操作 |
| **P4 押后** | 磁盘从源头不产生 | `--isolated` | **撤出本期**,见 §6 |

**依赖关系**(见 §7):

1. **P-1 先建立默认不开的边界**;P0 / P1 只服务明确 opt-in 后真正启动过 browser 的会话。
2. **P0 与 P1 之间没有依赖**(R2 纠正),可以并行实现;cutover 验收先证 P-1,再验 opt-in 场景的 P1 / P0。
3. **P0 → P2 census 读数有意义**:census 在 P0 部署前也能跑(它只是量),但用来决定「要不要开自动回收 follow-up」的读数,必须是 P-1 + P0 上线之后的。
4. **存量孤儿 drain → P3**:活着的孤儿 Chrome 打开着自己的 profile,`lsof +D` 会命中,P3 按契约必须保留 —— 所以 P3 要在 operator drain 之后、且在一个没有活 MCP 进程的窗口里跑。

**本期不做自动回收。** 重开的条件写在 §3 末尾:census 账本在 P-1 + P0 上线后持续出现孤儿,再拿着数据单开一单。

---

## P-1 — 不需要 browser 的会话,一开始就不启动 playwright-mcp

### 审计结果

- 当前上游 `@playwright/mcp@0.0.79` 是两级启动:MCP server 随 enabled plugin eager 启动;Chrome 只在第一次 `CallToolRequest` 时进入 `factory.create()` → `createBrowserWithInfo()`,已经是 first-tool lazy。
- Flywheel 已有 machine default-off writer、host provisioning wiring、以及 QA / `playwright` / `full-mcp` positive opt-in。
- 当前 host 的 machine setting 仍为 `true`,且旧 writer backup 为 0,说明 prevention cutover 从未执行;ordinary Runner 因此仍继承 Playwright。
- host census:23 个 server(15 Lead + 6 Runner + reviewer + founder Terminal),21 / 23 没有 Chrome。Chrome 已 first-tool lazy,所以这是 19 个空挂 server 的浪费,不是 21 个白起 browser。
- 重审计按事件 timestamp 与精确 tool family 分流:14 天全部会话 Playwright 98 次 / 66 sessions,Claude-in-Chrome 2335 次 / 93 sessions;常驻 Lead 的 Playwright 只有 `flywheel-eng-lead` 与 `flywheel-product-lead` 共 32 次 / 4 个短 QA sessions,而 Claude-in-Chrome 320 次。此前「四个 Lead」把旧事件/另一套 browser 混入,结论废弃。
- `@playwright/mcp@0.0.79` 没有 idle-close。可信 close 边界仍是显式 tool 与 session teardown,本期不自造 inactivity supervisor。

### 改什么

扩现有 `scripts/setup-mcp-on-demand.sh`,不再新增第二个 settings writer。一次 `apply` 同时拥有两个 path:

1. `enabledPlugins["playwright@claude-plugins-official"] = false` — 普通 Runner / Lead / founder Terminal 不启动 playwright-mcp server;
2. `env.PLAYWRIGHT_MCP_HEADLESS = "true"` — QA / 显式 opt-in 的会话真正启动 Chrome 时不画窗口。

writer 保留拒 symlink、拒坏 JSON、保 mode、same-dir atomic replace,并升级成 `apply` + receipt-aware `rollback`;receipt 对两个 owned path 分别记录 absent / 原值,whole-file preimage / postimage SHA 与 backup。SHA 分叉后逐 path 三方比较:仍是 apply 值→只恢复该 path;已是 preimage→no-op;第三值 / 类型不符→`rollback_conflict`,零写入非零退出。重复 apply 不覆盖第一次 receipt。

在 `ProjectConfig.LeadConfig` 增加 `playwrightMcp?: boolean`,由 `projects.json` 的精确 project + Lead 身份声明未来的显式能力。`parseAndValidateProjects()` 拒绝非布尔值;缺失 / false 默认关。`claude-lead.sh` 对 true 身份给最终 Claude argv 合并一次 per-launch `--settings` Playwright true,沿用 runner 的「machine false + launch true」优先级模型。**本次 production 与 example allowlist 都为空**;四个短 QA sessions 改走 QA / labeled Runner 或一次性会话,不让 resident Lead 因低频需求永久持有插件。

### 能力边界

- ordinary Runner:machine false 生效,没有 positive opt-in → MCP server 不启动;
- QA / `playwright` / `full-mcp`:现有 per-launch `enabledPluginsExtra=true` 覆盖 machine false → MCP server 启动;Chrome 等第一次 tool call;
- 上一条有一个明确的既有 kill-switch:`FLYWHEEL_RUNNER_SLIM_MCP=0` 时 runner launcher 返回 legacy null profile,不会生成任何 per-launch `--settings`,所以 machine false 会继续胜出。当前 host 的 `~/.flywheel/.env` 与 LaunchAgents 都未设置它;cutover preflight 必须重验「未设置/不为 0」。若未来真要把它设为 0,要同时承认 QA / labeled Runner 的 Playwright opt-in 被全局关闭;
- 所有当前 Lead:machine false + identity absent → MCP server 不启动;Claude-in-Chrome 继续作为日常 browser 路径;未来只有明确需求成立才写 `playwrightMcp:true`;
- founder Terminal:machine false → MCP server 不启动;cutover 前在现有 thread 告知 Annie。确实需要时运行 `claude --settings '{"enabledPlugins":{"playwright@claude-plugins-official":true}}'`,只恢复这一次 launch;
- Claude-in-Chrome 是另一套能力,本期不改 `--no-chrome` / `no-chrome` 合同。

### TDD / 真机验收

1. writer apply / idempotence / rollback 三路 / symlink / bad JSON / mode / stale receipt;
2. ordinary runner profile不含 positive opt-in;QA / `playwright` / `full-mcp` 保持 opt-in;
3. `playwrightMcp` 类型验证 + real launcher dry-run:absent/false 无 opt-in,true 有且只命中精确身份;
4. fresh ordinary session:playwright-mcp server=0;
5. fresh opt-in session:tool call 前 Chrome=0;第一次 tool call 后目标 Chrome 出现且 on-screen window=0;
6. founder Terminal 默认关 + 一次性显式命令正向验证;advance notice 留痕;
7. 存量 Runner / Lead / founder Terminal 必须受控重开后再 census,不能把 settings 落盘冒充进程已收敛。

更完整的修正记录与会过期结论见 `design-correction.md`。

---

## 1. P0 — 把优雅关闭的时间还回去

### 实测证据

```ts
// mcp-descendant-reaper.ts:178
const graceMs = deps.graceMs ?? 3_000;          // SIGTERM 后只等 3 秒就 SIGKILL
```

两个生产调用点(`runner-teardown.ts:77` 的 `reapMcpDescendants`、`plugin.ts:6765` 的 `reapMcpOrphans`)**都没有覆盖这个默认值**。

而上游 playwright-mcp 收到 SIGTERM 后:

```js
// coreBundle.js  setupExitWatchdog
setTimeout(() => process.exit(0), 15e3);        // 自己给 gracefullyCloseAll 留 15 秒
await gracefullyCloseAll();                     // ← 关浏览器发生在这里
```

**我们在第 3 秒 SIGKILL，它的关浏览器动作最多需要 15 秒。** Chrome 是 `detached` 启动的独立进程组，父进程被 KILL 不会连坐，于是它活下来变成 `ppid==1` 的孤儿 —— 正是 issue 观察到的现象。

同一个上游 watchdog 不只监听 SIGINT / SIGTERM,也监听 `process.stdin.on("close")`:stdio MCP 的 Claude 父进程消失、pipe 关闭时,也会进入同一个 `gracefullyCloseAll()` + 15 秒封顶路径。因此「3 秒 reaper 抢跑」只是已证实的一条来源,不是唯一来源;pane 被直接杀掉时,未被 reaper TERM 的候选仍可能靠 stdin-close 触发。§5 的真实场景对照要分两组:① reaper 明确 TERM 的 exact identity;② 故意不由 reaper TERM、只关闭 stdin 的 fixture。两组都记录触发源,不能拿「最终都消失」反推是 SIGTERM 假说单独成立。

### 改什么 —— 唯一方案是轮询版,不是「改一个常量」

R2 指出初稿在这里留了歧义(一处说「改一个默认值」,另一处说「建议先做轮询版」)。**确定为轮询版,固定 16s 常量方案作废。**

```
TERM → 每 500ms 用一份批量快照更新 survivors → 直到全部消失或到 deadline → 仍在者 KILL
```

16s 是 deadline 上限,来源是**上游 watchdog 的 15s 强制退出 + 1s 调度余量**。它**不是**「实测 Chrome 需要 15 秒」的结论 —— 这个区分要写在代码注释里,免得后人以为有实测支撑。

### 契约(R2 HIGH-1 逐条闭合)

| 要素 | 契约 |
|---|---|
| **deadline 归属** | 所有 TERM 成功的候选**共享一个单调时钟 deadline**。不是 per-PID 串行等待 —— 否则周期 sweep 最坏退化成 N×16s |
| **身份绑定** | 至少 `pid + lstart + command`。现有 `ProcessRow` **没有 `lstart` 字段**,必须加 —— 轮询把 PID 复用窗口从 3s 拉到 16s,只比 `pid + command` 会误杀同 argv 的复用 PID |
| **探针三态** | `ok` / `gone` / `unknown`。现有 `defaultListProcesses()` 把任何 `ps` 错误或超时**折叠成空数组**,在轮询语义下等于「误判为已退出」。`unknown` 既不算退出,也不授权 KILL |
| **单次探针预算** | 受**剩余 deadline** 约束。现有单次 `ps` timeout 是 15s,所以不加这条,「最多 16s」在当前依赖下不是真实墙钟上限 |
| **TERM 前与 KILL 前**(每个信号) | 三项合取:① fresh exact snapshot 重新证明 exact identity(`pid + lstart + command`);② §3 的 classifier 仍判定它是 MCP 进程;③ **现有的 caller-provided sticky lifecycle `authorityCheck`**(FLY-1185,`mcp-descendant-reaper.ts` 的 `McpReapDeps.authorityCheck`,`close-runner.ts:681` 用它做 Linear reopen fence)仍返回 true。③ 是**既有机制**,throw 或 false 都 sticky fail-closed。authority 是可能走网络的独立 I/O,每个 signal stage 共享自己的 5 秒预算,不偷吃 process-dispatch 的 5 秒;它与 R15 砍掉的 P2 activation authority **无关** |
| **KILL 之后**(R3 MEDIUM-3) | 见下 —— 「发出了 SIGKILL」≠「回收成功」 |

#### 终态语义:成功的定义是进程没了,不是 `kill(2)` 返回 true

现有代码在 `kill(..., SIGKILL)` 返回 true 时立刻 `result.killed++`。那个值只证明**信号发出去了**,不证明目标消失 —— 权限异常、不可杀进程、sensor unknown 都会被记成成功,掩盖真实故障。(R3 指出:旧版 P2 的 TDD 里有「KILL 后仍在 → 不计成功」,P0 没有,两者契约不一致;P2 收窄后这条成为 P0 自己的契约。)

统一为:

- SIGKILL 之后做一次 **bounded fresh exact-identity 确认**
- `alive` 或 `unknown` **都不计入 reclaimed**,并审计 survivor / unknown
- 结果字段拆开:`killSent`(信号发出)与 `confirmedGone`(确认消失),**只有后者算成功**

**最终确认的具体预算**(R4 LOW-5 指出上一版只说「bounded」没给数;而现有单次 `ps` 默认可等 15 秒,朴素实现会在 16 秒之后再挂将近 15 秒):

| 项 | 值 |
|---|---|
| final-confirmation deadline | **2 秒** |
| probe cadence | 250ms |
| 每次 probe 的 timeout | `min(剩余 deadline, 1s)` |

#### 三个阶段各自计时(R5 MEDIUM-5:上一版的「18 秒总墙钟」不成立)

上一版把 16s + 2s 说成整个 reaper 的 18 秒上限。R5 指出这漏了**前面还有一段**:取 fresh snapshot、逐个候选做 authority check、逐个发 SIGTERM。于是 shared deadline 的起点有二义性,而且两种选法都有害:

- 起点定在**第一步之前** → N 个候选时,**排在后面的候选拿不到上游 watchdog 需要的完整 15 秒**优雅窗
- 起点定在**最后一个 TERM 之后** → 真实总时长 = dispatch 时间 + 18 秒,那条「18 秒」断言是假的

而且 N 个候选时,这个二义性**不是测试断言能自动消掉的** —— 实施者为了让 18 秒断言过,很可能无意中砍掉后发候选的优雅预算。

明确拆成三段各自封顶:

| 阶段 | 预算 | 说明 |
|---|---|---|
| process dispatch | **5 秒**(整批一个单调时钟预算,**从初始枚举那一步就起表**,不是从 `reapCandidates()` 内部才起) | 初始枚举 · fresh snapshot · classifier · 全部 TERM;超时仍未 TERM 的候选**安全跳过**(不发信号) |
| authority / signal stage | **TERM 前整批共享 5 秒;KILL 前整批再共享 5 秒** | 网络 authority I/O 不计入 process-dispatch 时钟,否则慢探针会把后面的安全候选静默挤掉;timeout / false / throw 都 sticky fail-closed |
| graceful | **最后一次成功 TERM + 16 秒** | 保证每个候选都拿到完整的上游窗口 |
| confirmation | **整批共享一个 2 秒 deadline** | 不是每个 PID 各 2 秒 |
| **总逻辑预算上限** | **5 + 5 + 16 + 1 + 5 + 2 = 34 秒** | process dispatch + pre-TERM authority + graceful + pre-KILL probe + pre-KILL authority + confirmation;不是 N×。OS 调度开销不计入逻辑预算 |

R6 指出上一版说 dispatch「有一个具体 deadline」却没给数,总上限只写成 `dispatch budget + 18s` —— 那样墙钟仍然不可测,而且实现者可能为了让某个假想总数通过而砍掉后发候选的优雅窗。增量 review 又指出网络 authority 不应静默消耗 process dispatch。实现后复核补回了原表漏掉的 pre-KILL fresh probe 1 秒:现在六段逻辑预算都定死,断言写成 **N 个候选 + 慢探针下逻辑时钟 ≤ 34 秒**,同时单独证明 authority 延迟不会挤掉仍在 process budget 内的 TERM。真实墙钟还会有 OS 调度开销,不伪称精确硬上限。

新增测试:KILL 返回 true 但进程仍存活 · 最终确认返回 unknown · **慢 authority check** · 多候选的 TERM 跨越 dispatch 边界 · dispatch 阶段 sensor timeout · **最后一个候选仍拿到完整 graceful window**。

### 为什么这条是本期唯一的「机制」腿

1. 它是**唯一一条减少孤儿产生**的措施。R15 之前 P2 是事后收拾,现在 P2 只量不收 —— 所以孤儿是否还在产生,**全看这一条修得对不对**。
2. 先做回收器而不做 P0,等于用一个回收器去追一个自己每次拆 runner 都在制造的问题 —— 正是「加报警器而不修结构」。R15 把这句话贯彻到底:回收器也不做了,先看 P0 之后的读数(§3)。

**但它不是 P1 的前置**(见 §7)。

### 代价

典型情况(进程 1 秒内退出)**比现在的固定 3s 更快**。最坏情况(顽固进程)多等 13 秒。P0 位于六条 destructive teardown 路径 + 周期维护路径的公共 chokepoint，所以「一个卡住的 `ps` 把 HTTP teardown 挂住」是真实风险 —— 由上表的探针预算约束兜底。

### TDD

1. RED:构造「3 秒内不退出、5 秒后退出」的假 MCP 进程 → 现行代码 SIGKILL 它;改后不 KILL
2. 轮询提前退出:进程 1 秒消失 → 不等满 16s
3. 顽固进程:到 deadline 仍在 → 照常 SIGKILL(不能变成永不 KILL)
4. **同 argv 的 PID 复用** → 不 KILL(`lstart` 不同)
5. **`ps` error / timeout** → `unknown`，不计退出、不授权 KILL
6. **多个候选共享一个 16s 窗**(不是 N×16s)
7. **`authorityCheck` 在轮询中途 / 多 PID 中途返回 false 或 throw → 后续零信号,outer teardown 记 blocked**(恢复 FLY-1185 的既有用例,R15 初稿误删)
7b. 轮询中途 exact identity 对不上(PID 复用)或 classifier 改判 → 停止对该候选的后续信号(与 7 独立测)
8. 15s 边界竞态
9. 现有 mcp-descendant-reaper 全部用例保持绿

### 验收(R2 要求的精确身份形式)

close 之前记录目标 MCP server 与 Chrome 的 `pid` + `lstart` + profile 路径;close-runner 之后用 **fresh census** 证明**这一组精确身份**及其 Chrome 主进程都已消失。不接受「扫不到 `ppid==1` 的 Chrome」这种存在性判据 —— 那是 allowlist 思维,扫不到可能只说明这次没漏。

---

## 2. P1 — 让浏览器不再画窗口

### 改什么

```
PLAYWRIGHT_MCP_HEADLESS=true
```

**只此一个。** 初稿的 `PLAYWRIGHT_MCP_ISOLATED` 已撤出本期，理由见 §6。

### 落点(R1 改正:初稿的落点是错的)

初稿写「TmuxAdapter 的 spawn env + `~/.flywheel/.env`」。评审证明这**到不了 Lead**:

```bash
# claude-lead.sh:1834+  Lead 的 claude 子进程走 env -i + 显式白名单
local env_args=(
  -e "DISCORD_BOT_TOKEN=..."  -e "LEAD_ID=..."  -e "FLYWHEEL_COMM_DB=..."
  # …约 20 个显式条目，没有任何 PLAYWRIGHT_MCP_*
)
```

`env -i` 意味着**不继承任何未列出的变量** —— 改 `.env` 对 Lead 的 claude 子进程无效。

**新落点:Claude 配置的 `env` 块**(本机是 `~/.claude/settings.json`)。这个块已经存在(现有 4 个变量)。

**我实测到了什么 —— 以及它证明不了什么**(R2 MEDIUM-3 纠正了我在这里的过度声称):

| 变量(取自 settings.json 的 env 块) | 在我这个 **shell** 子进程的环境里? |
|---|---|
| `MAX_THINKING_TOKENS` | ✅ `128000` |
| `ENABLE_TOOL_SEARCH` | ✅ `true` |
| `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` | ✅ `1` |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | ✅ `1` |

我的 shell(pid 94560)与 playwright-mcp server(pid 67910)同为 claude 65113 的子进程。

**但这只证明「Claude 把这个 env 块注入给 shell 子进程」,没有直接证明「MCP server 的 spawn 用同一份 env」。** 这两件事很可能相同,但「很可能」不是证据 —— MCP spawn 走的是另一条代码路径,可能有自己的 env 组装。macOS 上 `ps eww` 读不到别的进程的环境,所以只能用行为探针验(§5-2)。

覆盖面因此是**待验收**,不是已确认:

| 进程类别 | `.env` + TmuxAdapter | Claude `env` 块 |
|---|---|---|
| Runner | ✅ | ⏳ 待直接验收 |
| Lead | ❌ 被 `env -i` 挡住 | ⏳ 待直接验收(且需确认它读的是同一个 config root) |
| **founder 自己开的 Terminal 会话** | ❌ | ⏳ 待直接验收 |

第三行是交叉评审抓到的 —— 现场就有一个:`Terminal.app → login → zsh → claude`,挂着一个 2 小时前的 playwright-mcp 子进程。前一个落点覆盖不到它，而它同样在 founder 桌面上开窗口。

### 配置怎么改 —— 需要一个 ops writer,不能手改

`settings.json` 同时承载 hooks、plugins、permissions 和其它全局 env,手工编辑风险大。仓库里现成的 `scripts/setup-mcp-on-demand.sh` 已经把这个文件该有的防线做完了:**拒绝 symlink · 拒绝坏 JSON(绝不 clobber)· 保留文件 mode · 仅在有变化时备份 · 同目录原子替换 · 幂等**。

P-1 / P1 不再另造第二个 writer:扩现有 `setup-mcp-on-demand.sh`,在同一次安全事务里写 machine default-off 与 `HEADLESS=true`,复用同一套防线与 receipt。它已经接入 host provisioning;本期补的是当前 host cutover、rollback 与可执行验收。

### 存量进程怎么收敛

环境变量只影响**新起**的进程。§5-4 原来写成一道待答题(「等自然轮换还是主动重启」),R2 要求它是可执行步骤:

1. 装新配置(经上述 writer)
2. runner / Lead 受控重启
3. **founder 自己的 Terminal 会话需要她本人配合关掉重开** —— 这一条只能协调,不能代劳
4. 用安全判据(`comm` + 解析后的 argv,**不做 argv 子串匹配**)做一次 fresh census

不再引用会漂移的「现存 19 个」当执行清单 —— 到时候重新普查。

### 删掉初稿的一条假声称

初稿写「上游留了反向 flag `--headed` 作为显式 opt-in 出口」。**这是错的**，我实测了:

```
playwright-mcp --help | grep -c -- --headed      → 0
playwright-mcp --help | grep -c -- --headless    → 1
```

我 grep 到的 `option("--headed", ...)` 属于**另一个命令**(Playwright CLI-daemon)，不是 MCP 命令。这和我调查开头踩的是同一个坑:grep 到字符串就当它在我要的那个上下文里。

**诚实的表述**:在当前 `@playwright/mcp@0.0.79` 的 merge 顺序里,config file < env < CLI;`PLAYWRIGHT_MCP_CONFIG` / `--config` 不能覆盖 machine env 的 `HEADLESS=true`,而 MCP command 只注册正向 `--headless`,没有 `--no-headless`。因此这是一条**舰队级策略**,当前没有 per-launch 的 headed 出口。回滚 = 用同一 writer 恢复 `settings.json` 并重启受影响进程。若确实需要「让人旁观浏览器」的能力,那是一个独立 seam,不在本期;上游版本变化后要重验该优先级,不能永远沿用 0.0.79 的结论。

### 验收

| 判据 | 怎么量 |
|---|---|
| 新起的 Chrome 无窗口 | **能力式判据,不读 argv**(R15 纠正,见下)。触发一次 `browser_navigate` 后:① 用 CoreGraphics 窗口普查(`CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly)`,按 `kCGWindowOwnerPID` 过滤 layer 0)证明**目标 Chrome 主进程 PID 名下的 on-screen 窗口数 = 0**;② **阳性对照**:同一把尺子对 founder 自己的 Chrome 主进程必须量到 > 0(证明尺子能看见窗口,不是普查失败);③ 二次信号:经该 MCP 会话自己的 `browser_evaluate` 读 `navigator.userAgent`,上游 headless 自报为 `HeadlessChrome/…`。①②缺一不可,③ 只做佐证 |
| **当前可执行覆盖** | ordinary Runner / 全部 Lead / founder Terminal 各起一个 fresh session,先证明三类均为 playwright-mcp server=0;再由 QA / labeled Runner 与 founder 一次性 `--settings` opt-in 各触发一次 browser,目标 Chrome 满足上一行 ①②。当前 production Lead allowlist 为空,所以 Lead browser 行明确**不执行、也不冒充已通过**;未来任何 `playwrightMcp:true` 身份落 roster 前,必须用 real launcher 的该 exact identity 跑同一能力式验收 |
| 功能不回归 | 见 §5 —— 必须包含 **GPU 合成截图**，不只是量高度 |

> **R15(Tadashi 提出):上一版这里写「Chrome 主进程 argv 含 `--headless`」。** 那是 argv 子串判据,与 §3 明确否掉的 `grep ms-playwright-mcp` 反模式同族:它量的是「命令行里有这个词」,不是「它没画窗口」。上游 flag 形态一变(`--headless=new` / 改名)就假红,而一个 argv 带 `--headless` 却仍开了窗的 Chrome(例如上游把 headless 交给别的开关)会假绿。issue 的症状是**桌面上有窗口**,判据就直接量窗口。窗口普查在本机实测可用(能按 PID 分辨 Terminal / Discord / Chrome 各自的窗口数),核心就这几行:
>
> ```js
> // osascript -l JavaScript window-census.js  → {"<pid>:<owner>": <layer-0 on-screen 窗口数>}
> ObjC.import('CoreGraphics');
> const arr = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID);
> for (let i = 0; i < $.CFArrayGetCount(arr); i++) {
>   const d = ObjC.castRefToObject($.CFArrayGetValueAtIndex(arr, i));
>   if (ObjC.unwrap(d.objectForKey('kCGWindowLayer')) !== 0) continue;      // 只数普通窗口层
>   count[ObjC.unwrap(d.objectForKey('kCGWindowOwnerPID'))]++;            // 按 owner PID 计数
> }
> ```
>
> 目标 Chrome 主进程的 PID 从**同一次** fresh exact census 取(`comm` ∈ Chrome 家族、无 `--type=`、`--user-data-dir` 在该会话的 profile 根下),不靠 argv 子串找 PID。

---

## 3. P2 — 孤儿残量:本期只量,不收(R15 收窄)

### 为什么从「自动回收」退到「只审计」

R1–R14 证明了一件事:**要让一个回收器安全地对孤儿 Chrome 发 SIGKILL,需要的权威链非常长**。每一轮评审都在这条链上抓出真洞(`ppid==1` 只对当前上游版本成立 → 要钉版本 → 钉版本要受管启动面 → 受管启动面要替换官方插件 → 旧孤儿证明不了版本 → 要 activation cutoff → cutoff 要 launch barrier → barrier 要六相持久状态机 → 创建时证据要 Chrome 启动 shim → shim 要进权威链 → 真 Chrome 要内容哈希……)。每一个推论都对,**但它们加起来是为一个没量过的残量建一座工厂**。

R15 的判断:P0 已经把**已知的**孤儿来源(我们自己的 3 秒 KILL)堵掉。P0 之后还剩多少孤儿、来自哪条路径 —— **不知道,也没量过**。在不知道的时候上自动回收,等于「修了结构还要再装一个报警器」。所以本期 P2 = **把尺子立起来**,数据说需要再做。

### 评审里仍然成立、本期继续遵守的结论

这些不因收窄而作废,P0 / census / P3 都要遵守:

| 结论 | 出处 | 本期怎么用 |
|---|---|---|
| **argv 子串匹配是反模式**(误杀过 FLY-766 runner;交叉评审复现了假阳性) | R1 | census 与 P3 quiet gate 一律按 `comm` 分类 + 解析后的 `--user-data-dir` 字段,**不 grep 命令行** |
| `ppid==1` 作为「生它的 MCP 已死」的判据**只对当前上游版本成立**(playwright 直接 spawn、`detached` 不 reparent) | R2 | census 的 orphan 定义依赖它,所以账本里**记下 `@playwright/mcp` 当时的 cache 版本**;版本变了,读数要重新解释 |
| 现有 reaper **认不出 inner MCP 进程**(argv0 是 `node`,路径是 `.bin/playwright-mcp`) | R5 | P0 与 P3 quiet gate 用下面的结构化 classifier(census 数的是 Chrome 主进程,不需要它) |
| 「读活 server 的 OS cwd 算 profile token」是伪权威(token 来自 MCP `roots/list`,不是 OS cwd) | R3 | P3 不做运行时反推,只用 committed 复核清单 |
| `--isolated` 会让基于 `ms-playwright-mcp` 根的判据失明 | R1 | §6,继续押后 |

### audit-only census 的契约

| 项 | 契约 |
|---|---|
| **在哪跑** | 挂在现有 `chrome-session-reaper` 的周期 sweep 上(复用同一个 timer 与**同一次 sweep 的采样**,**不新起 timer**)。注意现有 sweep 是 comm / command+ppid / etime+lstart **三次 `ps` 按 PID 拼接**,不是一份原子 OS 快照 —— 文档与代码都叫它 **sweep sample**,不叫 snapshot |
| **住在哪** | **独立模块** `packages/teamlead/src/bridge/playwright-orphan-census.ts`,**不**写进 `chrome-session-reaper.ts`。入口只接收:只读 sweep sample · clock · `@playwright/mcp` cache 版本 reader · append-only ledger writer。**不接收** `store` / registry / notifier / `signalProc` / `killProc`。周期调用只返回一行 summary(给 log),**不返回可复用的候选列表**;`--once --print` 是另一个只读的 presentation 入口(Codex R15 MEDIUM-4:红线靠最小可审 API 保证,不靠实现者记得「别喂给 kill loop」) |
| **候选定义** | `comm` ∈ Chrome 家族 · argv 无 `--type=`(主进程)· 解析出的 `--user-data-dir` 是 `~/Library/Caches/ms-playwright-mcp/` 的**直接子目录**且 basename 精确满足 `mcp-<browser>-<7hex>` · `ppid == 1` · 存活 ≥ **effective grace** |
| **effective grace** | `max(30, FLYWHEEL_CHROME_REAPER_ORPHAN_GRACE_MIN)` 分钟 —— 现有 mount(`plugin.ts:7018-7025`)接受任何 > 0 的值,census **单独**取下限 30,**不改变** legacy agent-browser 路径读到的值;**不新增 env**。把计划自己承认的正常 churn(进程数几分钟内 75 → 48)数成孤儿,读数就废了 |
| **动作** | **只记录**。不 TERM、不 KILL、不进任何 reaper 的候选集(见「住在哪」:它拿不到 kill capability) |
| **账本 schema** | `~/.flywheel/state/fly1867/orphan-census.jsonl`,每行:`{observed_at, status: "ok"\|"unknown", effective_grace_min, mcp_cache_versions: [..], profile_roots_in_scope:[persistent], known_profile_roots_out_of_scope:[daemon, isolated-glob], sensor_errors: [..], candidates: [{pid, lstart, profile_token, age_min}]}`。scope 字段阻止把 persistent=0 误读成全机所有 Playwright 形态=0 |
| **`unknown` 的定义**(Codex R15 HIGH-2,R16 MEDIUM-3 收窄 join 规则) | 整行 `status: "unknown"` 的条件:① comm / command / age 三次 `ps` **任一整批失败**;② **candidate-relevant join 缺字段**:任何 Chrome-family 行、或解析出的 `--user-data-dir` 落在目标根下的 plausible candidate,在另外两张 map 里缺 comm / cmd / age / `lstart`;③ `mcp_cache_versions` reader 失败(版本是解释 `ppid==1` 读数的必要证据,缺了就不算 ok)。**无关 PID 在三次 pass 之间出现 / 消失不算 unknown** —— 三次 `ps` 是全系统独立采样,正常 churn 必然让 PID 集合不一致,按全局 set mismatch 判 unknown 会让尺子长期 unknown、毒化 coverage。unknown 行 `candidates` 留空但**绝不写成 clean empty**。现有 reaper 对 primary `ps` 失败是直接返回空 result(`chrome-session-reaper.ts:492-502`)—— census **不能**继承这个语义 |
| **追加时机** | ① 候选集合(按 `pid+lstart` 集合)变化 · ② `status` 翻转(ok↔unknown)· ③ Bridge boot 后第一次 sweep · ④ **每天一行 coverage heartbeat**(无论有无变化)。④ 是为了让「连续两周零残量」能被证明是**尺子一直在量**而不是 Bridge 停了两周。上限可算:每天 1 行 + 变化行,每行几百字节 |
| **`mcp_cache_versions[]`** | 读的是**当前 `_npx` cache 里的版本**(可能多个 root)。字段名故意写成 cache versions —— 它**不证明**某个孤儿是哪版创建的(R4 结论:孤儿的 argv / profile 里都不含版本),只用于日后解释 `ppid==1` 判据是否仍成立 |
| **为什么用 JSONL 而不是 StateStore events 表** | 不是因为 events 表会自动 relay —— Codex R15 核过,`StateStore.insertEvent()` 只 INSERT,现有 reaper 写 `chrome_session_reaped` 也不触发 Discord relay。选 JSONL 是因为它是一个**与 session / event / Discord 域完全分开、没有任何消费者的度量账本**:红线的边界清楚可审,不需要解释「哪些消费者恰好不读这个 event_type」 |
| **零告警** | **不接 `LeadAlertNotifier`、不接 `publish-report`、不发 Discord**。这是 founder 红线(Tadashi 裁决 ①)。TDD 里的**静态守卫**钉三处:模块 imports(无 notifier / Discord / alert / StateStore 符号)· 入口函数的参数与返回类型(拿不到 kill capability、不返回候选列表)· `plugin.ts` 的 call site(只传只读采样与 ledger writer) |
| **读法** | 一条 `jq` 即可:最近 14 天 `status=ok` 的行数(coverage)、非空候选集出现的次数、每次的 `age_min` 分布。这就是「要不要开自动回收」的依据 |

### 存量孤儿:operator 一次性人工 drain,不写工具

现场观测时活孤儿数是 0(§9 第 7 条),但它们在生灭,部署那天可能有。处理方式是**人工步骤**,不是代码:

1. census 跑一次 `--once --print`(同一个 Chrome census parser / sweep-health 入口,只读,打印 `pid + lstart + profile_token + age` 与 `status`)
2. operator 逐条核:profile token 反推的 worktree 是否已删、`lstart` 是否早于最近一次 runner teardown
3. 对每条:**发 TERM 之前**先 `--once --print` 重读一次,exact `pid + lstart + comm + 解析后的 profile` 与复核时一致才 `kill -TERM <pid>`;等 ≤ 16 秒;**发 KILL 之前**再 `--once --print` 重读,**同一个 exact 身份仍在**才 `kill -KILL`。任何一次重读 mismatch 或 `unknown` → 不发信号
4. 最后一次 `--once --print` 为空且 `status=ok` = drain 完成;把每次输出贴进 issue 作为证据

不写 drain 工具的理由:它只跑一次、由人盯着、作用对象有限(个位数进程),而 R1–R14 已经证明**一旦把这件事做成自动化,授权问题会无限膨胀**。

### 共享的结构化 classifier(P0 与 P3 同一份;census 不需要它)

这是 R5–R9 留下的、**收窄后仍然需要**的部分,但**去掉了 bundle / installer / SHA receipt** 那层 —— 那层是为了让 janitor 的 apply receipt 绑住分类权威;P3 现在是一次性脚本,不存在「改分类逻辑绕过已批准 receipt」这个问题。Codex R15 还指出:**census 数的是 Chrome 主进程,不需要识别 MCP server**,它复用的是 Chrome parser + sweep health;classifier 的调用方只有 **P0 与 P3**。

现场每个 MCP server 是**两层**进程:

```
npm exec @playwright/mcp@latest                                   ← wrapper
  └─ node /Users/…/_npx/…/node_modules/.bin/playwright-mcp        ← inner,真正持有 Chrome
```

拿现有的 `matchesMcpFamily` 判定:wrapper 命中(argv 含 `@playwright/mcp`),**inner 完全不命中**(argv0 是 `node`;路径是 `.bin/playwright-mcp`,不含 `@playwright/mcp`)。**wrapper 先死的话,真正持有 Chrome 的 inner 现有 reaper 一个判据都认不出来。**

**不能**靠「family 表再加一行 `argvIncludes`」修(R5 HIGH-3):那是整条命令行的子串匹配,会命中任何命令行里恰好含这段文本的 Claude / runner / 工具进程 —— 正是误杀过 FLY-766 runner 的反模式。

改为**结构化判定**(R6 纠正了 R5 的一条事实错误:`.bin/playwright-mcp` 本身是 symlink,realpath 必然解析成 `cli.js`,所以「realpath 等于 `.bin/...`」永远为假;正确形式是 **lexical 路径分辨调用形态、canonical 路径证明目标同一**):

| 形状 | 判定(**不做子串匹配**) |
|---|---|
| npm / npx wrapper | exact command + token 位置 |
| inner via `.bin` | argv[1] 的 **lexical** 路径精确等于 `…/node_modules/.bin/playwright-mcp` → `lstat` 确认是 package-local link → **canonical realpath 等于同一 package 的 `@playwright/mcp/cli.js`** |
| inner via cli.js | argv[1] 的 lexical 形态是 `…/node_modules/@playwright/mcp/cli.js`,canonical 目标同上 |

(R15 删掉了「直接可执行:exact argv0 basename + realpath」这一形:本机没有任何生产 launch surface 会这样起它,而 bare basename 该按哪个进程的 PATH / cwd 做 canonical 解析也没定义 —— 留着只增加歧义与测试面。若将来真实出现,拿现场 `argv/comm/canonical` 证据再加。)

| 项 | 契约 |
|---|---|
| 源文件 | `packages/teamlead/src/bridge/mcp-process-classifier.ts`,**单一实现**,普通 TS 模块 |
| 调用方 | P0(`mcp-descendant-reaper`)**直接 import**;P3 一次性脚本是 `.mjs`,从 teamlead 的 built `dist` 动态 import 同一个模块(与 `scripts/fly-1648-hot-loop-closeout.mjs:379-390` 同一种做法) |
| **dist 新鲜度**(Codex R15 MEDIUM-5) | 那个 pattern 只拒绝 dist 缺失,不拒绝 **stale dist**。P3 与 `--once --print` 在 import 之前校验 `packages/teamlead/dist/build-identity.json` 的 `artifactBuildSha == git rev-parse HEAD`(teamlead 的 `build` 脚本已经生成这个文件),并拒绝各自会 import 的 relevant TS source 有 tracked diff 或 untracked file;缺失、不符或 relevant tree 不干净 → 提示 commit + build,**fail closed**。它证明的是这几份 imported authority source,不是全仓库任意文件;不需要恢复 bundle installer / SHA receipt |
| 接口 | 输入一份进程快照(`pid, ppid, lstart, comm, argv`),输出逐行 `{verdict: "match"\|"no_match"\|"unknown", shape, reason}` + 顶层 `overall: "clean"\|"has_match"\|"unknown"` |
| 三态 | 解析歧义 / realpath 失败 / `ps` error 或 timeout → `unknown`。**`unknown` 永远不等于 `clean`** —— 现有 `defaultListProcesses()` 把任何 `ps` 错误折叠成空数组,在 P0 的轮询语义与 P3 的 quiet gate 下都等于「把传感器坏了读成很安静」,要改 |
| 形状 | **四种**:npm wrapper · npx wrapper · inner via `.bin` · inner via canonical `cli.js`。官方插件在本机只产生前三种的组合,第四种是同一 symlink 的 canonical 形态 |

测试:`.bin/playwright-mcp` 只出现在无关进程的 argv 文本里 · `playwright-mcp-extra` 这类近似名 · 相邻 package · symlink 与 realpath 不符 · wrapper 先死只剩 inner · wrapper 与 inner 都在时各自的 exact identity。**必须包含一个真实文件系统的 symlink fixture**,不能只用 mock 字符串 —— R5 那条错误规则正是只看字符串推出来的。

### 验收命令要改 —— 初稿那条是反模式

初稿写的验收是:

```bash
ps ... | grep "ms-playwright-mcp" | awk '$2==1'     # ❌ argv 子串匹配
```

这正是 `chrome-session-reaper.ts` 注释里记载的、当初**误杀过 FLY-766 自己那个 runner** 的反模式。交叉评审直接复现了假阳性:一个活着的 claude runner(pid 65113)因为**命令行里含有这个字符串**而被匹配 —— 我自己在调查第一步也踩了同一个坑(当时匹配到的是我自己 argv 里的 issue 正文)。

正确判据:按 `comm` 分类 + 解析出的 `user-data-dir` 字段,**不做 argv 子串匹配**。census 的 `--once --print` 就是这条判据的可执行形式。

### 回滚

census 是只读的,回滚 = 不挂它(revert + 重启 Bridge)。**不为了让文档成立复活 `FLYWHEEL_WORKTREE_AUTOCLEAN`** —— 它已被 FLY-1806 退役并焊死为 `true`(R1 抓到初稿复用它是错的)。

### 什么时候重开「自动回收」

满足**全部**三条才开 follow-up,并把 census 账本作为那一单的第一份输入:

1. P-1 已完成 default-off cutover,且 P0 已部署并通过 §5-3 的前后对照
2. 此后 census 账本**连续 14 天每天至少一行 `status=ok`**(coverage 成立,尺子一直在量),且每行的 `profile_roots_in_scope` 都精确包含 persistent 根、`known_profile_roots_out_of_scope` 没被误当 coverage;其中出现非空候选集、且不是同一批残留(`pid+lstart` 不同)。这个 reopen 规则只回答 official MCP persistent 路径;若 daemon / skillMode / isolated 在这期间成为生产入口,先扩尺子再读「零」
3. 数字规则:**≥ 3 个不同 `pid+lstart` 的候选,`age_min ≥ 60`,分布在 ≥ 3 个不同日期的 `status=ok` 行里** —— 这排除了正常生灭(issue 观测到进程数几分钟内 75 → 48)。达不到数字规则但 operator 仍认为该开,需在 issue 里写明理由(显式 sign-off),不走机械门

到那时再设计的起点是 R1–R14 留下的结论(见上表),不是从零开始;但**砍掉的六项不自动复活**,每一项都要在有数据的前提下重新论证必要性。

### TDD

1. census 候选命中孤儿 playwright Chrome(`ppid==1`、`ms-playwright-mcp` 根、≥ 30 分钟)
2. **MCP server 活着 → 绝不进候选**(`ppid ≠ 1`)
3. renderer(`--type=`)绝不进候选
4. **argv 含该字符串的活 runner 绝不进候选**(把交叉评审复现的那个假阳性钉成回归用例)
5. **census 拿不到 kill capability**:入口签名里没有 `signalProc` / `killProc` / `store`,周期调用的返回值不含候选列表(类型级断言 + call site 断言)
6. 候选集合不变且当天已有 heartbeat → 不追加;集合变化 / status 翻转 / boot / 当天首行 → 追加,且含 `effective_grace_min`、`mcp_cache_versions` 与明确的 in-scope / out-of-scope profile roots
6b. 任一 `ps` 整批失败 / 目标 Chrome 的任一必需字段(comm / cmd / age / `lstart`)缺失 / cache-version reader 失败 → 整行 `status: "unknown"`,绝不写 clean empty
6c. **无关 PID 在 pass 之间消失 / 出现** → 仍 `status: "ok"`(非空测试:fixture 里放一个只在 comm pass 出现的短命 PID)
6d. `FLYWHEEL_CHROME_REAPER_ORPHAN_GRACE_MIN=5` 时 census 的 effective grace 仍为 30,legacy 路径仍读 5
6e. malformed basename / nested descendant 即使仍在 cache root 内也不算 profile;只接受 direct `mcp-<browser>-<7hex>`
7. **静态守卫**:census 模块无 notifier / Discord / alert / StateStore import;`plugin.ts` call site 只传只读采样与 ledger writer
8. classifier 三态:`ps` error / timeout → `unknown`,且 P0 与 P3 对 `unknown` 的处理都是 fail-closed
9. agent-browser 路径 **行为逐字不变**
10. `--once --print` 在 dist `artifactBuildSha ≠ HEAD` 时拒绝运行

---

## 4. P3 — 清扫存量:一次性复核脚本(R15 收窄)

### 为什么不挂 FLY-1330 janitor

R1 逐行核过 janitor:**通用删除路径是文件级 `rm -f`**,批量 `lsof` 探针不递归;allowed roots 不含 `ms-playwright-mcp`;module 解析器 / 保留期 / 报告 / receipt scope 都不认识新模块;而且**改脚本 = 改 SHA → 已安装的 launchd `--apply` 会 fail-closed,直到补做一次全量 dry-run** —— 「加个 module 就自动继承」会静默打断一个正在生产运行的清理任务。

R2–R6 为了让它挂得上,堆出了 manifest 契约 + one-shot completion marker + dormant MCP fence + quarantine 状态机(`prepared → quarantined → deleted | preserved`,绑 device/inode)。**这些都是在解「一个常驻周期任务反复对同一批固定路径生效」带来的问题。** 一个只跑一次、由人盯着跑的脚本,没有这些问题:

| janitor 版要解的 | 一次性脚本为什么不需要 |
|---|---|
| 下一个 tick 把重建出来的同名目录再删一遍 | 脚本不跑第二个 tick;**只移动根目录 mtime 早于复核时间戳的目录**。这只是一道**窄门**:它认得「真的被删掉再 `mkdir`」的新目录(新根 inode,mtime 必然更晚),**认不得**「原目录被原地再次使用」—— 上游 `createUserDataDir()` 对精确原名做 recursive `mkdir`,已存在时不换 inode,子目录里写文件也不保证更新根 mtime(Codex R15 只读实测:至少 5 个现存 profile 的最新嵌套项比根 mtime 晚 3 秒到 3 小时)。原地再用的情形由 `lsof` 和 rename 后复核兜(见下),不由 mtime 兜 |
| apply receipt 绑 manifest / classifier SHA | 没有 launchd apply;operator 当场跑、当场看输出 |
| completion marker 防重跑 | 重跑是安全的:源路径已不在 → 跳过;源路径在但 mtime 晚于复核时间戳 → 跳过并记录 |
| crash 落在 rename 与 receipt 之间 | 不删任何东西,只 rename 到同根 quarantine;crash 后最坏情况是目录在 quarantine 里而账本没记 —— 目录**一个字节没少**,operator 看 quarantine 目录即可 |

### 归因方法(R1 结论保留)

初稿用「枚举 `FLY-<n>` / `GEO-<n>` 名字正向哈希比对」。评审指出:哈希只取 **7 位十六进制**,枚举任意不存在的名字有**假归因**风险。所以归因**不在运行时做**:一次性生成一份候选清单,**人工逐条审**,审过的才提交。

### 复核清单(committed,随脚本一起 review)

| 项 | 定义 |
|---|---|
| 路径 | `scripts/lib/fly1867-legacy-profiles.manifest.json` |
| schema | `{version: 1, issue: "FLY-1867", reviewed_at: <ISO-8601>, entries: [{profile_path, profile_token, inferred_root, provenance}]}` |
| 每条 entry | canonical 绝对 profile 路径 + 7-hex token + 推断出的 worktree 路径 + 怎么归因出来的 |
| 生成 | 一次性生成脚本输出候选,**人工逐条核**(token → 推断路径 → 该路径确实不存在)→ 连同脚本一起提交 PR |
| **`reviewed_at`** | 人工复核完成的时刻。脚本只处理根目录 mtime 早于它的目录 —— 这挡的是「同名目录被删后重建」,**不是** inode 状态机的等价替代(见上表最后一行) |
| 拒收 | symlink · 重复 entry · token 与 path 不自洽 · 路径不在 canonical cache root 下 → **整份清单拒用**,不是跳过单条 |

现场数据(调查时 73 目录 / 631 MB):57 个 token 对应已删除的 worktree → 进清单;9 个 worktree 还在 → 不进;7 个对不上 → **不进,保留**。实施前按 §5-5 重新普查,数字会漂。

实施前复核(2026-08-20T16:41:24.488Z)已经按这条窄门重跑:75 个 profile / 648 MB;68 个 token 可映射,其中 6 个 worktree 仍存在所以排除,62 个已删除 worktree 进入 committed manifest,7 个无法归因继续排除。提交前再次逐条重算 SHA-256 前 7 位并检查路径:62/62 hash 自洽、62/62 profile 仍存在、0 个 inferred root 复活、0 个根 mtime 晚于 `reviewed_at`。这些数字只描述复核时刻;脚本 apply 前仍会重跑动态谓词。

### 脚本契约:`scripts/fly-1867-legacy-profiles-quarantine.mjs`

```
0. 读清单 → 拒收规则 → 任一不过整份拒用
1. quiet gate:一次 bounded tri-state census(§3 的 classifier,整批 5 秒)
      任何活着的 playwright-mcp 进程(四种形状任一) → 整个脚本 fail closed,不动任何目录
      census unknown → 同样 fail closed(「传感器坏了」≠「很安静」)
2. 对每条 entry,在 rename 之前重跑全部谓词:
      路径仍在 canonical cache root 下 · 不是 symlink · owner 是当前用户
      · 根 mtime < reviewed_at · inferred_root 此刻仍不存在
      · 递归 lsof +D 为「空」
      任一不成立 → 跳过,账本记 preserved + 原因
3. 原子 rename 到同一 cache root 下的 quarantine 目录:
      ~/Library/Caches/ms-playwright-mcp/.fly1867-quarantine-<reviewed_at>/<原目录名>
      (同文件系统 → rename 原子;真跨 device 则 rename 以 EXDEV 失败,源目录不丢。
       上游只 join 精确的 mcp-<browser>-<token> 名,不枚举 cache root,所以不会主动选中 quarantine)
4. ★ rename 成功后立刻对 quarantine 路径再跑一次递归 lsof +D(Codex R15 HIGH-3):
      「空」→ 记 moved
      命中或 sensor error → 不做任何自动补救:quarantine 原样保留,记 operator_required,
         打印 exact recovery context(entry、quarantine 路径、lsof 输出、原路径此刻是否存在),
         停止处理后续 entries,非零退出(Codex R16 HIGH-1)
5. 账本:quarantine 目录内的 ledger.jsonl,每条
      {entry, action: moved|preserved|skipped_missing|operator_required, reason, at}
6. 结束打印汇总:moved / preserved / missing / operator_required 各 N,以及 quarantine 的总大小
```

**`lsof +D` 的「空」怎么判**(Codex R15 核过本机行为):无匹配时 `lsof` 正常返回 **exit 1 + 空 stdout**;`rc=0`、或 `rc=1` 但有 `n` 开头的输出、或其它 rc → 都当「在用 / 不可判」,**保留**。仓库里 `flywheel-log-janitor.sh:795-829` 的 `release_tree_is_open()` 就是这套判法,新脚本照抄语义。

**默认模式不删任何东西。** 删除是同一脚本的显式 `--delete-quarantine <exact path>` 模式,在观察期之后由 operator 执行,而且**删除前重跑前置检查**:

```
观察期 ≥ 7 天(覆盖一个完整工作周的 runner 起落)
期间若任何会话报「profile 丢了」→ operator 先关掉相关进程,核对 quarantine 与原路径的 exact 身份,
                                  再决定是否人工 rename 回去(目录内容一个字节没动);脚本不代劳
观察期满 → --delete-quarantine <exact path>:
      路径精确等于 ledger 记录的 quarantine 目录 · 不是 symlink · owner 是当前用户
      · 在 canonical cache root 下 · ledger 存在且可解析 · 递归 lsof +D 为「空」
      任一不成立 → 不删,退出非零
```

### 诚实边界:rename 后复核才是承重的那一环,quiet gate 不是租约

一次「此刻没有进程」的 census **不是租约**(R4)—— 它挡不住一个在最后一次 `lsof` 与 rename 之间刚好打开旧目录的新 MCP server;Unix `rename` 对被打开的目录照样成功。所以 R15 初稿写的「rename 之后结构上不可能再被进程打开」**过强**(Codex R15 HIGH-3)。

真正成立的是两条:

1. **rename 之后**新起的 server 只会去创建**原始路径**(它算出来的 token 指向原名),不会碰 quarantine —— 这条是结构性的
2. **rename 之前**已经打开了该目录的进程,会被**rename 后那次 `lsof +D` 复核**抓到(Chrome 对 profile 里的 lock / 数据库文件持续持有 fd)→ 停下来转人工

剩下的窗口只有「rename 与复核之间启动、且尚未打开任何文件」—— 这样的进程启动后打开的是**原始路径**(新建),与 quarantine 无关。

**为什么复核命中后不自动 rename 回去**(Codex R16 HIGH-1):R15 稿写的是「原路径仍不存在 → rename 回去」。但「查 absent」与「rename」之间又是一个 TOCTOU —— 新 MCP 可以在这两步之间创建原路径;macOS `rename()` 对已存在的空目录会先移除它(干扰正在启动的 Chrome),对非空目录以 `ENOTEMPTY` 失败而计划没定义终态。自动补救分支自己成了新的 mutation。最 fail-closed 的做法就是**不补救**:两边内容都原样保留,停、报、退出非零,由人在关掉相关进程之后处理。

建议在 runner 零活跃的时段(例如凌晨)跑,并提前协调 founder 不在脚本运行的那几分钟里起新的 Claude 会话 —— 但**承重的是第 4 步的复核 + 停手**,不是时段;时段只减少 `operator_required` 出现的概率。

### 验收

- 清单里的每一条,operator 都能从 token 反推出那个已删除的 worktree 路径并确认它不存在
- 脚本 dry-run(`--dry-run`,只打印不 rename)的输出逐条可核
- 跑完:清单内的目录要么在 quarantine 里,要么被记为 preserved / operator_required 并给出原因;**现存 worktree 的目录一个不少;无法归因的一个不动**
- `ms-playwright-mcp/` 之外的路径做 file-set 快照对照,证明零误伤
- 观察期结束、`--delete-quarantine` 之后,`du` 对照前后;删除前置检查失败的用例至少真跑过一次(例如故意留一个打开的文件)

### TDD

1. 清单拒收:symlink / 重复 / token-path 不自洽 / 越界路径 → 整份拒用
2. quiet gate:注入一个活着的 inner MCP(`.bin` 形状)→ 整个脚本不动任何目录;census `unknown` → 同样
3. mtime 晚于 `reviewed_at` 的目录 → preserved(模拟「同名目录被重建」)
4. `lsof +D` 非空 / error → preserved
5. inferred_root 重新出现 → preserved
6. 正常路径 → rename 到 quarantine,rename 后复核为「空」,账本记 moved,源路径不在
6b. **rename 后复核命中**(fixture:rename 前由测试进程打开目录内一个文件并保持持有)→ 记 operator_required、**零后续 mutation**(后面的 entries 一个不动)、quarantine 与原路径(若已被新建)两边内容逐字节保留、退出非零
6c. rename 后复核 sensor error(lsof 不可用 / 其它 rc)→ 同 6b
6d. `lsof` 返回 rc=0 / rc=1 带 `n` 输出 / 其它 rc → 都按「在用 / 不可判」处理;只有 rc=1 + 空 stdout 算「空」
7. 重跑:已 moved 的 entry → skipped_missing,不报错
8. `--dry-run` 零文件系统变更(file-set 快照前后相等)
9. `--delete-quarantine`:路径不精确 / symlink / owner 不符 / ledger 缺失 / `lsof` 非空 → 不删、退出非零;全部通过 → 删且 `du` 归零
10. dist `artifactBuildSha ≠ HEAD` → 拒绝运行

---

## 5. 上线前必须验的(硬前置)

| # | 要验什么 | 判据(R2 要求可判定,不接受「等价」这种未定义词) |
|---|---|---|
| 1 | **headless 下 GPU 合成截图** | 见下方 §5.1 —— R3 指出「像素差在允许范围内」仍然不可机械判定,必须给死阈值 |
| 2 | **直接证明 MCP 子进程拿到了这个变量** | 我实测的是「Claude 注入 env 给 shell 子进程」,不是「MCP spawn 用同一份 env」(§2)。当前可执行判据:QA / labeled Runner 与 founder one-shot opt-in 各触发一次浏览器 → 按 §2 的**能力式判据**(目标 Chrome 主进程 PID 名下 on-screen 窗口数 = 0 + founder 自己的 Chrome 作阳性对照 + UA 自报 `HeadlessChrome` 佐证)证明,**不读 argv**。所有真实 config root 都先验 ordinary session 的 server=0;Lead allowlist 为空时不伪造 Lead browser 结果,未来 opt-in 身份进入 roster 前再补该 exact launcher/config-root 行 |
| 3 | **P0 的真实场景对照** | close 前记录目标 MCP + Chrome 的 `pid`+`lstart`+profile;分开执行 reaper TERM 路径与 stdin-only close fixture,记录各自触发源;close 后 fresh census 证明**这组精确身份**消失(不是「扫不到孤儿」),也不拿两个触发源的共同终态互相冒充因果证据 |
| 4 | **已在运行的进程收敛** | PR/构建阶段不重启生产。获批 ship 后只走 `scripts/self-ship-restart.sh` 的 detached handoff,由 ship workflow 做一次受控 fleet wave;绝不在 resident session inline 跑 `restart-services.sh`。restart-storm gate 被 hold 或部分 Lead 未回到新 SHA → rollout 未收敛、fail-close 报具体身份,不得发成功 completion;之后再协调 founder 关掉重开她自己的 Terminal 会话并做安全 census |
| 5 | **重新做一次磁盘普查** | 基线一直在漂:issue 记录 57 目录/495MB → 调查时 73/631MB → 实施复核 75/648MB。实施前同时普查 persistent `ms-playwright-mcp/mcp-*`、isolated `playwright_*_profile-*` 与 CLI daemon `ms-playwright/daemon/**/ud-*` 三种已知根,再关联活 Chrome 主进程(`comm` + 解析后的 `--user-data-dir` + exact `lstart`,不做 raw argv 推断),不能只 `ls | wc -l`。本次复核 daemon 根 absent、isolated 0;P2 账本仍把这两类明确标成 out-of-scope,所以 persistent 候选=0 只能解读为该根为 0 |

### §5.1 WebGL 硬门的可判定判据(R3 MEDIUM-4)

「像素差在允许范围内」还是不能机械判 pass/fail。上线前在计划里固定下列各项,任何一项波动 → **fail closed 转人工裁决**,不许实施时临时选一个宽松阈值把它糊绿:

| 参数 | 取值 |
|---|---|
| 语料 | 同一台机器、同一组 WebGL 页面,headed 与 headless **各跑一遍** |
| viewport / device scale | 固定(例如 1280×720 @1x),两侧完全一致 |
| scene-ready 信号 | 页面显式暴露的就绪事件;**不用固定 sleep** |
| 比较 metric | 逐像素差异占比;**逐通道容差**与 **scene mask** 一并写死 |
| 附加断言 | 非空帧(不是纯色/全黑)· 场景元素可见 · 输出尺寸与 viewport 相符 |

#### 阈值怎么定 —— 不能用同一组数据既定阈值又验收(R4 MEDIUM-3)

上一版我写「阈值随首轮基线一起定死」。R4 指出这有**循环通过**问题:首轮里已经包含 headed↔headless 的跨模式差值,实施者看完这个差值再把阈值设在它之上,**同一组截图必然通过** —— 测试只是记录了已观察到的结果,证明不了下一次仍在边界内。

改为**看数据前预注册规则、看数据后不许调参**:

| 阶段 | 做什么 | 关键约束 |
|---|---|---|
| 0 · 预注册 | 写死**推导公式**、产品可接受上限、数据切分方式 | 在跑任何数据之前提交 |
| 1 · calibration | 只测**同模式内部抖动**(headed↔headed、headless↔headless) | **不看跨模式差值** |
| 2 · 定阈值 | 按预注册公式 + 上限算出阈值 → 人工 sign-off → 冻结 corpus/metric/threshold | 算出来是多少就是多少 |
| 3 · validation | **浏览器冷启动重跑**,用**独立的 validation shots**(最好含一个 holdout WebGL 页面)执行真正的 gate | 与 calibration 不共用截图 |

跨模式配对方式(3×3 全比 / 配对比 / 仅同模式噪声)在第 0 步就写死,不留解释空间。

**任何放宽阈值都必须显式改测试 + 重新人工 review**,不允许在同一条上线命令里自动调参。

### §5.2 P1 的 rollback 也要走同一个安全 writer

上一版说 P1 的 rollback 是「改回 settings.json 并重启」—— 手改就把刚刚排除掉的 clobber 风险又请回来了。

R4 当时纠正得对:原 R18 scope 的 P1 只设 `PLAYWRIGHT_MCP_HEADLESS`,绝不能顺手写已撤出的 `PLAYWRIGHT_MCP_ISOLATED`。Founder correction 新增的第二个 owned path 是 **P-1 的** `enabledPlugins["playwright@claude-plugins-official"]`,不是把 `ISOLATED` 复活。writer 现在精确拥有这两个 path,不碰其它 `PLAYWRIGHT_MCP_*`。

#### 两个入口:`apply` 与 receipt-aware `rollback`(R15 收口,原为三种模式)

R4 指出「rollback 后 JSON 逐字一致」这条验收本身有问题:如果靠恢复整份 apply 前备份来满足它,就会**覆盖掉 apply 之后别人新增的 hooks / plugins / permissions** —— 安全回滚变成另一种 clobber。而如果只解析删 key,重新序列化又保证不了 whole-file 逐字相等。

R14 版把这写成 `apply / remove / restore-exact` 三个同级公开模式。Codex R15 指出 `remove` 只有在 preimage 里该 key **本来 absent** 时才是正确的回滚 —— 若它原本有值,`remove` 会把它删成 absent,那不是回滚。所以收成两个入口,由 receipt 决定路径:

| 入口 | 语义 |
|---|---|
| `apply` | 写入两个 owned path;receipt 对每个 path 记录原本的 **absent / 原值**,并记录 **preimage SHA** · **postimage SHA** · backup 路径 |
| `rollback` | 读 receipt。当前文件 SHA == postimage → **fast path**:恢复整份 preimage(期间无人改过)。当前 SHA ≠ postimage → **逐个 owned path** 三方比较:① 当前值 == apply 写入值 → 只恢复该 path 的 preimage(原本 absent 则删,原本有值则写回);② 当前值 == preimage → **no-op**;③ 任一路径是第三值或类型不符 → **`rollback_conflict`,整次零写入,退出非零**。receipt 缺失或不可解析 → **fail closed** |
| 重复 `apply` | 已是目标态 → no-op,**且不得覆盖第一次 apply 的 receipt**(否则 preimage 会被改写成 apply 后的值,rollback 就回不去了) |

这条路径的验收是「**其它 JSON 语义 / 字节片段保持不变**」,而**不是** whole-file 逐字相等。

两条路径复用同一套防线(拒 symlink · 拒坏 JSON · 保 mode · 变化才备份 · 同目录原子替换),测试钉四种终态:SHA 相符 → 整份 preimage;SHA 分叉 + owned path 仍是 apply 值 → 只恢复该 path;SHA 分叉 + owned path 已是 preimage → no-op;任一 owned path 是第三值 → `rollback_conflict` 整次零写入非零退出。另补:坏 JSON 拒绝 · **中途有人加了 hook/plugin**(其它字段保留)· stale backup · 重复 apply 不覆盖 receipt。

---

## 6. `--isolated` 为什么撤出本期

初稿把它当作「磁盘那一半的预防腿」。评审证明这个理解不完整，而且**顺序上有害**:

**它不消除磁盘 profile，只是换了个形状。** `browserType.launch()` 会用 `mkdtemp(os.tmpdir())` 建一个 `playwright_chromiumdev_profile-*` 目录并作为 `--user-data-dir` 传给 Chrome。正常退出时 Node 侧清理代码会删它 —— 但在我们关心的那条路径(MCP server 被 SIGKILL)上，**清理代码根本跑不了**,目录和 Chrome 都留下。

**更糟的是它会让 census 失明。** census 的候选定义认 `ms-playwright-mcp` 这个根。一旦启用 isolated，新孤儿的 profile 变成 `os.tmpdir()` 下的另一个前缀 —— census 一个都数不到，账本会给出一个假的「零残量」,而基于目录计数的验收还会**假绿**。在「先量再决定」的方案里,这条恰好会把尺子弄坏。

这正是我在 §3 批评 `mcp-descendant-reaper`「判据对不上、永久空转」的同一个毛病。我差点自己复制一遍。

**另有一个未评估的副作用**:`isolated` 在 `createBrowserWithInfo` 里的判定**排在 `extension` 之前**，会静默抢占 `--extension` 路径;persistent 模式还独有 `ignoreDefaultArgs:["--disable-extensions"]`。所以「唯一代价是丢掉持久 profile」是不完整的。

**后续条件**:先拿到 P0 之后的 census 读数;若日后要评估 `--isolated`,census 必须先扩到能同时覆盖两种 profile 形态。Runner 可以借用现成的 per-exec `TMPDIR` + owner marker;Lead 需要另立一个明确的归属根，**不能**用「host 范围内匹配通用 Playwright 临时前缀」这种判据。

---

## 7. 交付顺序

```
第一腿 ── P-1 machine default-off
             ordinary Runner / ordinary Lead / founder Terminal 不启动 playwright-mcp
             QA / playwright / full-mcp + projects.json Lead allowlist positive opt-in
             │
             └── P1 HEADLESS=true(同一个 policy writer)
                    只保护明确 opt-in 后真正启动 Chrome 的场景

前腿 B ── P0  TERM → 轮询 → 封顶 KILL + classifier 认出 inner
             │  唯一的代码腿;build + 重启 Bridge
             └── P2 census(与 P0 同一个 PR、同一次重启;只读)
                      │
                      └── 读数持续两周 → 才决定要不要开自动回收 follow-up

一次性 ── operator drain(人工,按 §3 步骤)→ P3 quarantine 脚本 → 观察 ≥ 7 天 → 手动删 quarantine
             ⚠️ P3 必须在 drain 之后、且 quiet gate 通过的窗口里跑
```

**真实的依赖有三条**:

1. **P-1 → 残余治理**:先证普通会话不启动 server;P0 / P1 才是 opt-in 残余场景的防线
2. **drain → P3**:活着的孤儿 Chrome 打开着自己的 profile,`lsof +D` 会命中,P3 必须保留 → 先 drain
3. **P-1 + P0 → census 读数有解释力**:census 之前也能跑,但「要不要做自动回收」只看两者上线之后的数据

P0 与 P1 **没有依赖**(R2 纠正:`HEADLESS` 与 `graceMs` 之间既无数据依赖也无安全依赖)。issue 同时包含资源泄漏和**即时的桌面干扰**,后者是 founder 每天在感受的那一半 —— 让它去等一个需要改代码、build、重启 Bridge 的 P0,没有道理。

---

## 8. 明确不做的事

| 不做 | 为什么 |
|---|---|
| **自动回收孤儿 Chrome**(R15 收窄) | 残量没量过;为它建的权威链(§11 六项)是教科书式过度设计。先量,数据说需要再开单 |
| **替换 / fork / 禁用官方 playwright 插件**(R15 恢复初稿这一行) | 那是 P2 版本 fence 的前置;P2 不发信号就不需要版本 fence。**不动全机 playwright 插件身份**(Tadashi 裁决 ②) |
| 给 census 接任何告警通道 | founder 红线(Tadashi 裁决 ①)。census 是尺子,不是报警器 |
| 查 Typeless / DiskImageMounter 挂起 | 与本 issue 无已证实因果。issue 自己记了反证:内存压力已缓解到 51% 空闲时它仍卡着。根因未知,不写进本 issue 验收 |
| 给 ordinary session 保留 playwright-mcp | Founder correction 已明确否掉。真实用途通过 QA / `playwright` / `full-mcp` opt-in 保留,不是全机常开 |
| 复活 `FLYWHEEL_WORKTREE_AUTOCLEAN` 让文档成立 | 它已被 FLY-1806 退役并焊死。宁可如实写「回滚 = revert + 重启」 |
| 依赖 `PWMCP_PROFILES_DIR_FOR_TEST` | 上游测试钩子,名字里写着 FOR_TEST |
| 挂 FLY-1330 janitor module | 见 §4:会让生产 janitor 停摆到补全量 dry-run;一次性脚本不需要它那套状态机 |

---

## 9. 风险与诚实边界

| 风险 | 处置 |
|---|---|
| P0 让 teardown 变慢 | 轮询版:进程一消失就继续,典型情况比现在的固定 3s 更快;process probe 与网络 authority 分开封顶,防止坏 `ps` 挂住 teardown、也防止 authority 偷吃 dispatch;三候选最坏逻辑预算 34 秒由测试钉住(另有不可精确预言的 OS 调度开销) |
| **P0 把「发出 SIGKILL」记成成功** | 终态语义拆成 `killSent` 与 `confirmedGone`;alive/unknown 都不算回收,并审计(§1) |
| P0 轮询把 PID 复用窗口从 3s 拉到 16s | 身份绑定加 `lstart`;探针三态,`unknown` 不授权 KILL |
| headless 下 WebGL 截图退化 | §5-1 硬前置,判据写死,阈值按 §5.1 预注册流程产出 |
| P1 到不了 MCP 子进程 | §5-2 行为探针:量**目标 Chrome 主进程名下的 on-screen 窗口数**(+ 阳性对照),不靠 shell env 推断,也**不读 argv**(R15) |
| 手改 `settings.json` 弄坏 hooks/plugins/permissions | 幂等 ops writer(`apply` + receipt-aware `rollback`:SHA 相符走整份 preimage;SHA 分叉后按该 key 三方比较 —— 仍是 apply 值→只恢复该 key、已是 preimage→no-op、第三值→`rollback_conflict` 零写入;receipt 缺失 fail closed),照搬 `setup-mcp-on-demand.sh` 的防线 |
| **P0 之外还有孤儿来源**(例如 pane 被 SIGHUP/KILL 掉、Bridge 崩溃期间的 teardown) | **本期不治,只量**。census 账本就是为了回答这个问题;若读数说有,follow-up 拿数据开单(§3 末尾的三条件) |
| 上游没有 idle-close | 不伪造 inactivity timeout。普通会话靠 P-1 根本不启 server;opt-in 会话只依赖显式 `browser_close` / session teardown,P0 保证后者拿到完整 graceful budget |
| census 账本增长 | 每天 1 行 heartbeat + 变化行;每行几百字节 → 一年 ≤ (365 + 变化次数) × ~0.5 KB,可算上限 |
| census 变成告警 | 独立模块、入口拿不到 store / notifier / kill capability、周期调用不返回候选列表;JSONL 是无消费者的独立账本;静态守卫钉 imports + 签名 + call site |
| **`ppid==1` 判据随上游版本失效** → census 读数失真 | 账本每行带 `mcp_cache_versions`;版本变了读数重新解释。census 只读,失真的代价是数错,不是误杀 |
| **census 把传感器故障 / Bridge 停跑读成零残量** | `status: unknown` 行 + 每天 heartbeat:坏尺子、停跑两周、真实零残量三者在账本里可区分;reopen 条件要求 14 天 coverage 成立 |
| operator drain 杀错进程 | 人工逐条核 `pid+lstart+profile_token`,**TERM 前与 KILL 前各** `--once --print` 重读同一 exact 身份,mismatch / unknown 不发信号;作用对象个位数 |
| P3 误删仍被依赖的目录 | 默认模式**不删**:只 rename 到同根 quarantine;committed 人工复核清单 + 根 mtime < `reviewed_at`(窄门)+ 变异前重跑全部谓词(含递归 `lsof +D`,按 rc=1+空 stdout 才算空)+ quiet gate tri-state + 无法归因一律不进清单;观察 ≥ 7 天后 `--delete-quarantine` 且删除前重跑前置检查 |
| P3 最后一次 `lsof` 与 rename 之间有进程打开了旧目录 | **quiet gate 不是租约**(§4 诚实边界):rename 后立刻复核 `lsof +D`,命中或不可判 → 两边内容原样保留、记 operator_required、停止后续 entries、非零退出;**不自动 rename 回去**(那又是一个 TOCTOU);rename 之后启动的进程只会建原路径 |

### 仍未验证的(如实记)

1. **headless↔headed 行为等价性**没实测(§5-1 硬前置)。没做的原因:在 founder 机器上起有窗口的浏览器会打扰她。
2. **MCP spawn 是否用与 shell 相同的 env** 未实测 —— 我只证明了 Claude 把 env 块注入给 shell 子进程(§2)。这是 P1 整条覆盖论证的支点,列为 §5-2 硬门(能力式判据)。
3. **各 Lead 是否读同一个 config root**(是否有独立 `CLAUDE_CONFIG_DIR`)未实测。
4. **`--isolated` 的真实 argv / profile 形态**未实测 —— 这也是押后的理由之一。
5. **WebGL 阈值尚未定值,推导规则也还没预注册** —— §5.1 要求 stage-0 先写死推导公式与数据切分,再用只测同模式抖动的 calibration 导出阈值。计划里没有数字,是因为它必须由那条流程产出,不是由我拍。
6. **无法归因的 profile 目录**归属未知,按保留处理。
7. **「MCP server 活着但 Chrome 该关没关」这种形态没抓到现场**(观测时活实例为 0)。`ppid==1` 判据抓不到这类 —— census 也不数它们。有意的保守取舍。
8. **issue 记录的「45 进程 / 1.5 GB」复现不出来**,不作为验收基线;也**不把「此刻扫不到孤儿」当成生命周期已修好的证据** —— 这正是 census 存在的理由。
9. **现有 reaper 认不出 inner MCP 进程**(实测:wrapper 命中、inner 返回 null)—— 独立于本 issue 的既有缺陷,P0 顺带修。
10. **P0 是否真是主要成因** —— 高可信假说,不是已完成的对照实验。因果链(3s 宽限 < 15s 上游预算 + detached 不连坐)是逐行读源码得到的,两位评审都确认链条成立;但 16s 是**上游 watchdog 的上限**,不是「实测 Chrome 需要 15 秒」。§5-3 的前后对照 + census 的持续读数一起补这个实验。

---

## 10. 交付物清单

| # | 交付物 | 归属 | 形态 |
|---|---|---|---|
| 1 | `mcp-descendant-reaper` 的轮询 + 三态 + 终态语义改造 | P0 | TS,改既有模块 |
| 2 | `mcp-process-classifier.ts`(结构化**四形状** + 三态,普通模块,**无 bundle / installer**) | P0 / P3 共用(census 不用) | TS,新模块 |
| 3 | 扩 `setup-mcp-on-demand.sh`:machine default-off + headless 的单一 policy writer(`apply` + receipt-aware `rollback`) | P-1 / P1 | 改既有脚本 |
| 4 | `LeadConfig.playwrightMcp` + validator + `claude-lead.sh` 单一 `--settings` opt-in + production roster cutover receipt | P-1 | TS config + shell launcher |
| 5 | audit-only census:**新独立模块** `playwright-orphan-census.ts`(窄 API,见 §3)+ 既有 mount / sampling seam 的**最小 wiring** + 只读 `.mjs` presentation 入口(`--once --print`,带 dist 新鲜度门) | P2 | TS 新模块 + 最小改既有 mount + 一个 `.mjs` |
| 6 | `fly-1867-legacy-profiles-quarantine.mjs` + committed 复核清单 + `--dry-run` + `--delete-quarantine` | P3 | 一次性脚本 |
| 7 | §5.1 WebGL 硬门的 stage-0 物料:corpus · scene-ready 信号 · metric · 固定的产品可接受上限 · calibration / validation 切分(**P1 writer 部署前**的 QA 交付物,不是生产模块) | P1 | QA 物料 |

**与 R14 版对照**:10 项生产交付物 → 5 项(第 6 项是 QA 物料,R14 版漏列)。Founder correction 没恢复任何被砍机制;P-1 合并进原第 3 项的同一个 settings writer。砍掉的 6 项见 §11;第 2 项从「bundle + installer + SHA receipt」退成普通模块。

---

## 11. R15 收窄记录 —— 砍掉了什么、为什么、哪些结论还有效

**依据**:Annie 2026-08-05 三连定案(修结构别加报警器 · 所有繁复埋雷的东西全删 · 验收 = 删的比加的多);Tadashi 2026-08-20 裁决(question `5d7910f4`):「为一个没量过的孤儿残量上 supervisor + 全机插件身份替换 + 六相状态机,是教科书式的过度设计;P0 修根因后残量该由数据说话。」

### 砍掉的六项

| R14 §10 编号 | 交付物 | 它当初为什么出现 | 为什么现在不需要 |
|---|---|---|---|
| 3 | `flywheel-playwright-mcp-supervisor`(barrier 拒启 · stdio 代理 · 信号转发) | R9:让 launch barrier 有一个读标记的组件 | 没有自动回收就没有 activation,没有 activation 就没有 barrier |
| 4 | Chrome 创建接缝的 ownership shim(经 `PLAYWRIGHT_MCP_EXECUTABLE_PATH`) | R10:让「先有授权,后有 Chrome」成为结构性保证 | 不发信号就不需要授权证据 |
| 5 | 受管 marketplace / plugin 源 + cutover 事务(替换官方 playwright 插件) | R4–R5:`ppid==1` 只对已审版本成立 → 钉版本 → 要受管启动面 | 只审计不发信号,`ppid==1` 失效的代价是**数错**,不是误杀;账本带版本号即可解释 |
| 6 | activation 事务(锁 · 六相持久状态机 · barrier marker · receipt · `release_wait`) | R6–R8、R14:让 cutoff 建立在干净基线上、崩溃可恢复 | 同上 |
| 7 | legacy drain 的 immutable 清单 + receipt + 工具 | R5:旧孤儿无法自证版本,需要独立一次性授权 | 存量孤儿个位数,operator 人工按 §3 步骤 drain,不写工具 |
| 8 | `chrome-session-reaper` 的新候选来源 + 合取式判据(定义 A / 定义 B) | R1:泛化 FLY-1828 exact-snapshot 分支去发信号 | 换成只读 census;候选定义沿用,但**返回值不喂任何 kill 循环** |

以及第 2 项的一半:classifier 的 **bundle + installer + 安装后 SHA 校验 + 运行时 hash 相等校验** —— 它们是为了让 janitor 的 apply receipt 绑住分类权威(R7–R9)。P3 不再是 janitor module,这层没有对象。

连带删除的章节:R14 版 §3 的「定义 A / 定义 B / 唯一权威合取式 / 受管版本 pin / activation cutoff / launch barrier / 崩溃恢复 / producer 契约 / 保留期规则 / cutover 步骤 / receipt 绑什么」、§11「真 Chrome 身份内容绑定」、§12「cutoff 的时间表示 + `release_wait`」。**这些段落的 git 历史保留**(`git log -- plan.md` R1–R14 各轮 commit),将来若 census 数据要求重开自动回收,从那里起步,但每一项都要在有数据的前提下重新论证。

### 没有被砍、继续约束本期的评审结论

见 §3「评审里仍然成立、本期继续遵守的结论」表 —— argv 子串反模式 · `ppid==1` 版本绑定 · inner 进程识别 · OS cwd 不是 profile 权威 · `--isolated` 让判据失明。加上 R2–R6 对 P0 契约的全部收紧(三态、`lstart`、三段封顶、`confirmedGone`)与 R4 对 P1 writer 的 receipt 要求 —— **P0 与 P1 的契约没有放松**,并且 P0 明确保留**既有的 lifecycle `authorityCheck`**(FLY-1185 的 reopen fence;R15 初稿把它和已删的 P2 activation authority 混在一起误删,Codex R15 HIGH-1 抓回 —— 两者无关)。Founder correction 只把 P-1 default-off 合进同一个 `apply` + `rollback` writer,没有恢复 P2 activation authority或任何自动 kill 机制。

### 这次收窄本身的风险

如果 P0 之外还有一条**稳定的**孤儿来源,本期不会治它,会晚一单。我们接受这个代价,因为:(a) 它到底存不存在现在就是不知道;(b) census 会在两周内给出答案;(c) 对桌面的即时干扰(P1)与已知的主因(P0)都已在本期覆盖。

---
