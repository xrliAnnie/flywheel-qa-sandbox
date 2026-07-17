# FLY-1319 founder 本地时区 — 调研

Issue: FLY-1319 (https://linear.app/geoforge3d/issue/FLY-1319/infra-founder-本地时区-让所有-lead-知道-annie-的-local-time非-utc理想自动跟设备)
日期: 2026-07-16
基于: exploration.md

调研输入 = exploration.md 的 F0-F5 结构 + brainstorm gate 三条裁定(F3 默认保守、部署事实进 plan、F0 技术路线批准)。以下全部锚点均已逐行核实(非转述)。

## 1. 时间到达 agent 的全部面(锚点清单)

### 1.1 Claude Lead(Belle / Tadashi / Cass / HL 等)
| 面 | 位置 | 现状 |
|---|---|---|
| inbound 消息 ts= 属性 | 插件 fork `external_plugins/discord/server.ts:884`(`~/.claude/plugins/marketplaces/claude-plugins-official/`) | `msg.createdAt.toISOString()` 裸 UTC |
| fetch_messages 历史 | 同文件 `:675` | `[UTC ISO] author: text` |
| 插件 instructions(每个 Lead 的 MCP 说明) | 同文件 `:458` 区 instructions 数组 | 提到 ts="..." 但**没说是 UTC** |
| 规则层 | `packages/teamlead/lead-rules-base/`(22 个文件) | 零时区/founder 时间规则(grep 确认) |

### 1.2 Codex Lead(Mufasa)—— 新发现
- inbound 消息结构 `DiscordInboundMessage`(`CodexDiscordGateway.ts:32-56`)**没有任何时间戳字段**;turn input = `payload: msg.content`(`CodexDiscordGateway.ts:179`)裸文本。
- 即:Codex Lead 不是「把 UTC 当 local」,而是**完全无时间信号**,聊作息全凭猜。Mufasa 恰是陪伴型、最常聊作息。
- 规则层(Codex design R2 更正):**只有生产 launcher** `run-codex-lead-mufasa-tui-fullaccess.sh` 经 `assemble_full_access_governance`(source lead-rules-bundle.sh)吃到 bundle 变化;`run-codex-lead-mufasa-tui.sh:129`、`run-codex-lead-mufasa.sh:42`、`run-codex-lead-mufasa-writecapable.sh:70` 三个 launcher 手工拼 `FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES`(identity + companion-safety-contract),**绕过 bundle** —— 新规则文件必须同时追加进这三处默认列表(codex runtime 读显式列表,codex-lead-runtime.ts:625-629/:983-994)。

### 1.3 Runner(经 Bridge 组装的提示词)
- `packages/edge-worker/src/PromptBuilder.ts:768`(new_comment_timestamp)、`:960`(root comment)、`:981`(reply)— 裸 `toLocaleString()`:server locale、无时区标注(host 在 PDT 时值恰好对,但模型不知道这是谁的时区)。

### 1.4 Bridge 渲染的 founder-visible 文本
| 位置 | 现状 |
|---|---|
| `packages/teamlead/src/bridge/approval-signal/deferred-approval.ts:121-135` `founderMsgClock()` | 唯一按 founder 时区渲染的地方,但硬编码 `America/Los_Angeles` |
| `packages/teamlead/src/bridge/standup-service.ts:62-66` `pacificDateString()` | 硬编码 LA |
| `packages/teamlead/src/MetaAlertNotifier.ts:161` | 告警正文 `toISOString()` = UTC |
| `scripts/lead-alert.sh:363` | `date '+%H:%M'` host 本地、无时区标注 |
| `packages/teamlead/src/bridge/plugin.ts:3523` | `FLYWHEEL_DIGEST_TZ ?? "America/Los_Angeles"` |
| `packages/teamlead/src/bridge/plugin.ts:9425` | `TOKEN_USAGE_TIMEZONE ?? "America/Los_Angeles"` |

### 1.5 明确不碰(带理由)
- `packages/token-usage/*`(scanner.ts:8 DEFAULT_TIMEZONE、render-html、cli):token-usage **不依赖 flywheel-config**(package.json 核实);报表里时区有显式标注(诚实、不误导);改日切桶语义有报表连续性风险。v1 不动,env 覆盖已存在。
- launchd 调度(`com.flywheel.daily-standup.plist` 等 StartCalendarInterval):按 host 本地钟 fire,host 跟设备走 → 行为已正确。
- 存储层(StateStore/DB/journal):继续存 UTC/epoch,只改渲染(gate 裁定 ③)。

## 2. F0 resolver 技术验证

### 2.1 Node 时区缓存坑(实测 + 依据)
- Node(ICU)在进程启动时解析系统时区,长跑进程内 `Intl.DateTimeFormat().resolvedOptions().timeZone` **不反映设备切换后的新时区** → 长跑 Bridge 不能依赖它跟随 travel。
- cache-proof 读法:`readlink /etc/localtime`,本机实测返回 `/var/db/timezone/zoneinfo/America/Los_Angeles`(macOS);Linux 为 `/usr/share/zoneinfo/<IANA>`。解析 = 取 `zoneinfo/` 之后的子串。
- 渲染侧不受缓存影响:`Intl.DateTimeFormat(locale, { timeZone: <显式 IANA> })` 传显式参数总是正确。
- 有效性校验:解析出的字符串必须能通过 `Intl.DateTimeFormat(undefined, { timeZone: tz })` 不抛(防 symlink 异常/剪切错误),失败逐级 fallback。

### 2.2 解析顺序(gate 已批)
```
FLYWHEEL_FOUNDER_TZ(显式 IANA,校验失败视为未设并告警日志)
  → readlink /etc/localtime(短 TTL cache,60s)
  → Intl.DateTimeFormat().resolvedOptions().timeZone(进程启动值,兜底)
  → "America/Los_Angeles"(最终兜底)
```
- 配置位置:全局 `~/.flywheel/.env`(founder 唯一、天然全局;不进 per-project config.yaml)。launchd wrapper 会 `source ~/.flywheel/.env`,**但 env 不会自然到达 Lead pane**(Codex design R1 更正):claude-lead.sh 用显式 `tmux new-window -e` allowlist 构造 pane 环境(claude-lead.sh:1407-1448,注释明言 pane 不继承 launcher env)—— `FLYWHEEL_FOUNDER_TZ` 必须显式加进该 allowlist,MCP 子进程(插件 fork)才能经 pane env 继承。且改 .env 不刷新在跑进程:override 生效需要 Bridge + 受影响 Lead 重启(设备时区 auto 路径则无此约束)。
- 新 env 必须登记:`packages/config/src/__tests__/feature-flags-drift.test.ts:153` 同款 "config value" 条目(仿 `FLYWHEEL_DIGEST_TZ`)。

### 2.3 resolver 放置与依赖图(核实)
- 放 `packages/config/src/founder-timezone.ts`,仿 `founder-ux-config.ts` 的「ONE resolution choke point / never-absent」模式(founder-ux-config.ts:21-39),`index.ts` 导出。
- 依赖已就绪:`flywheel-teamlead`、`flywheel-edge-worker`、`flywheel-comm` 的 package.json 均已有 `flywheel-config: workspace:*` → 无需新增依赖。
- shell 消费者(lead-alert.sh、插件 fork)不能 import TS → 各自自含同一解析顺序的实现(shell 十行内 / fork 内 ~15 行函数),plan 里用对照测试钉住三份实现不漂移(fork 侧在 fork repo 测)。

## 3. F1 `flywheel-comm founder-time` 子命令

- 模式核实:`packages/flywheel-comm/src/commands/` 一文件一命令 + `index.ts` switch case(:180-290 区)+ help 文本(:111 区)。新增 `founder-time.ts` 完全同型。
- 输出(人读为主,一行):`2026-07-16 19:23 PDT — America/Los_Angeles (UTC-07:00)`;`--json` 给 `{iso, tz, abbrev, offsetMinutes}`(符号东正西负,LA `-420`)。
- CLI 一次性进程 → 每次调用都是新进程,**无缓存坑**,天然跟随设备时区。

## 4. F2 规则文件装载机制(核实)

装载点全清单(有 parity test 绑定,不可只改一处;完整实施枚举见 plan M5):
1. `packages/teamlead/scripts/lead-rules-bundle.sh` `compute_lead_rule_bundle()` — companion/cos/dept 三个分支(companion 分支现只装 companion-safety-contract.md,:50-57;cos :58-60;dept :61-80+)。**founder-local-time.md 三个角色都装**(Belle/Mufasa 陪伴型最常聊作息)。
2. `packages/teamlead/scripts/claude-lead.sh` inline 装载块(companion 区 :2176-2192、dept 区 :2193+、cos 区 :2346+)。
3. parity test:`packages/teamlead/src/__tests__/lead-rules-bundle.test.ts` — 断言 resolver 输出对齐 claude-lead.sh 引用的文件集,新文件要同步进断言。
4. **三个手工拼列表的 Mufasa launcher**(§1.2 更正):`run-codex-lead-mufasa-tui.sh:129` / `run-codex-lead-mufasa.sh:42` / `run-codex-lead-mufasa-writecapable.sh:70` 的 `FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES` 默认列表各自追加(生产 fullaccess launcher 走 bundle,自动跟);配 Mufasa loading-proof 测试(readBaseInstructions 断言,§8)。

## 5. F3 保守方案细节(gate 裁定 ①)

- `ts=` **保持 UTC 不动**;新增 `founder_local` 属性(meta 对象加一个 key,server.ts:884 处);`fetch_messages`(:675)历史前缀补 founder-local。
- **语义(全系统统一,Codex design R1/R3 钉死)**:founder_local = **消息 instant 按「当前解析到的 founder 时区」渲染**;不声称、也不可能还原她发送当时所在的历史时区(Discord 无此信息)。history 文案 = 「message instant rendered in the currently resolved founder timezone」。
- instructions(:458 区)写明双语义:「ts 是 UTC 机器戳;founder_local 是该消息 instant 在 founder 当前时区下的墙钟 —— 推理她的作息/时间一律以 founder_local 为准」。
- ts 消费者清单(record,为什么保守是对的):founder-consent `prompt.ts:114`(字符串喂 Haiku,无格式假设)、deferred-approval(用 snowflake 不用 ts)、Claude Code harness(把 meta 渲染成属性,不 parse)。虽然未发现硬 parse,additive 方案连「未发现 ≠ 不存在」的残余风险都消掉,且对模型同等有效。
- fork 部署事实:fork 是 `~/.claude/plugins/marketplaces/claude-plugins-official` 的 git checkout,MCP server 进程随 Lead 会话启动 → 改动要 fork repo PR + 该 checkout pull + **Lead 重启**才生效。
- fork 侧 tz 解析:自含实现,**与 F0 完全同序** = env FLYWHEEL_FOUNDER_TZ → readlink /etc/localtime(60s TTL,常驻进程必须)→ **Intl fallback(IANA 校验)** → LA(Codex design R2:少了 Intl 会在 copy 式 localtime 时错回 LA,与 F1/F6 分叉);env 经 pane allowlist 显式传入(§2.2 更正)。可测 seam:server.ts 有模块加载副作用,resolver/formatter 与 buildInboundMeta/formatHistoryRow 抽成无副作用模块 + bun test。

## 6. F6(新增):Codex Lead turn input 补时间行

- 依据 §1.2:Codex Lead 零时间信号。在 `CodexDiscordGateway.ts:179` payload 组装处加前缀行,marker 钉死为 `[sent <时间> <TZ> ...]`(sent-instant 语义,见 §5)。
- **时间取消息发送 instant,非处理时刻**:`DiscordInboundMessage` 加可选 `timestampMs`(RestPoll 从 Discord raw timestamp 填充;缺失回退 snowflake 推导;两者皆缺 → 省略前缀 fail-safe)—— RestPoll 启动 drain 的 downtime backlog(RestPollDiscordInboundSource.ts:132-139)不得被标成「恢复时的现在」。
- 影响面核实:dedup 用 `msg.id`(idempotencyKey),mention-gate / roundtable thread-name 派生用 `msg.content` 原值(mention-gate.ts:86、roundtable-reply-route.ts:93/:106)—— 前缀只进模型输入,不碰路由/去重语义。
- teamlead 进程内常驻 → 用 F0 resolver(带 TTL 的 readlink)。

## 7. 部署矩阵(gate 裁定 ②:merge ≠ live)

| 改动 | 生效条件 |
|---|---|
| F0 resolver + F1 founder-time CLI | merge → 生产 main pull + pnpm build(dist 现读,CLI 每次新进程)。**无需任何重启** |
| F2 规则文件 | Lead 启动时读 → **全部 Lead/companion 重启**(挂批量重启窗口) |
| F3 插件 fork | fork repo PR + marketplace checkout pull + **Lead 重启**(MCP 进程随会话) |
| F4 Bridge 渲染(founderMsgClock/standup/MetaAlert/plugin.ts 默认值) | **Bridge 重启** |
| F5 PromptBuilder | edge-worker 跑在 Bridge 进程内 → **Bridge 重启**(此后新 spawn 的 Runner 即正确) |
| F6 Codex gateway payload | **Codex Lead(Mufasa)重启** |
| lead-alert.sh | 脚本每次调用现读 → main pull 即生效 |

## 8. 测试布点(供 plan 展开)

- resolver 单测:env 优先/env 非法回退/readlink 解析(mac+linux 路径 fixture)/readlink 失败回退 Intl/最终兜底 LA/TTL 行为/`Intl` 校验拒绝坏值。
- founder-time CLI:输出格式 + --json + env 注入对照。
- founder_local 渲染纯函数:DST 边界(3 月/11 月切换)、非整点 offset 时区(Asia/Kolkata +05:30)。
- F4 各面:founderMsgClock 尊重 resolver(env 注入改变输出)、standup 日期头、MetaAlert 前缀含 tz 标注;**反向兼容 sentinel**:不设 FLYWHEEL_FOUNDER_TZ 且 host=LA 时,founderMsgClock/standup 输出与现状逐字节一致。
- F6:payload `[sent ...]` 前缀存在(sent-instant 语义)+ downtime replay 用旧 instant + timestampMs/snowflake 双缺时省略前缀 + mention-gate/dedup/thread-name 不受影响(用现有测试防回归)。
- F2:lead-rules-bundle.test.ts parity 扩展(三角色都含新文件)+ **Mufasa loading-proof**(launcher dry-run / readBaseInstructions 断言,生产 fullaccess + rollback TUI 两路径的 baseInstructions 含规则正文)。
- drift:FLYWHEEL_FOUNDER_TZ 登记 feature-flags-drift.test.ts。
- fork(fork repo 内):founder_local 属性存在性 + ts 保持 UTC 的 byte-compat 断言。
