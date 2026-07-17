# FLY-1319 founder 本地时区 — 探索

Issue: FLY-1319 (https://linear.app/geoforge3d/issue/FLY-1319/infra-founder-本地时区-让所有-lead-知道-annie-的-local-time非-utc理想自动跟设备)
日期: 2026-07-16
基于: 无

## 1. 问题

Lead 们反复把 **UTC 时间戳误当成 Annie 的 local time**(她在 PDT,UTC-7),导致「以为她半夜、劝她睡觉 / 推到明天」这类误判(HL 一天犯 3 次)。Annie 要求:所有 Lead 可靠知道她的 local time,**包括 travel 时时区变化**。

> 现场证据:本 issue 的来源标注写着「Annie 2026-07-17 (#flywheel-product)」,而她发言那一刻本机时间是 **2026-07-16 晚间 PDT** —— UTC 日期已经翻页、她的 local 日期还没有。连 issue 元数据本身都在犯这个错。

## 2. 代码审计:时间怎么到达 Lead 的(现状)

全仓 + 插件 fork 审计结论:**目前不存在任何 founder-timezone 配置**;`America/Los_Angeles` 硬编码约 6 处;Lead 看到的时间戳三类来源全部有病:

### 2.1 传输层(误判的直接源头)
- Discord 插件 fork(`~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/discord/server.ts`,repo 外):
  - `server.ts:884` — inbound 消息的 `ts=` 属性 = `msg.createdAt.toISOString()`,**裸 UTC ISO**。每条 Annie 的 Discord 消息进 Lead 上下文都带这个。
  - `server.ts:675` — `fetch_messages` 历史同样 `[UTC ISO]` 前缀。
  - `server.ts:458` 区 — 给 Lead 的 instructions 文本只说有 `ts="..."`,**没说它是 UTC 还是谁的时间** → 模型自然当 local 读。
- Annie 晚上 19:00 PDT 发消息 → ts 显示 `T02:00:00Z`(次日) → Lead 读成「凌晨 2 点」→「劝她睡觉」。机制完全对上事故。

### 2.2 行为层(Lead 没有可靠的「她现在几点」primitive)
- `packages/teamlead/lead-rules-base/` 22 个规则文件,**零个提到时区/founder 时间**(已 grep 确认)。
- Lead 启动注入(claude-lead.sh)不带当前时间;模型对「现在几点」的信息只有消息 ts(UTC)和 harness 的 currentDate(只有日期)。
- HL 钉进 memory 的 never-assume-founder-local-time 是自觉层兜底,不可靠 —— 本 issue 就是要结构解。

### 2.3 渲染层(Bridge 侧 founder-visible 文本各自为政)
- `deferred-approval.ts:121` `founderMsgClock()` — 唯一按「founder 时区」渲染的地方,但**硬编码** `America/Los_Angeles`。
- `standup-service.ts:62` `pacificDateString()` — 硬编码 LA。
- `MetaAlertNotifier.ts:161` — 告警正文前缀 `toISOString()` = UTC。
- `scripts/lead-alert.sh:363` — `date '+%H:%M'` 机器本地但无时区标注。
- `PromptBuilder.ts:768/960/981`(Runner 提示词)— 裸 `toLocaleString()`,server locale、无时区标注。
- 环境变量 `FLYWHEEL_DIGEST_TZ` / `TOKEN_USAGE_TIMEZONE` 各自默认 LA(digest/token 报表用),互不相通。

## 3. 关键洞察:「自动版」在当前部署下几乎免费

**Bridge、全部 Lead、全部 Runner 都跑在 Annie 的 Mac 上 —— host 设备 = founder 设备。**

- macOS「根据位置自动设置时区」开着时,她 travel → 系统时区变 → host 时区就是她的当前时区。
- 所以 issue 里的「自动版(设备报 TZ → 系统)」在单机部署下不需要任何上报通道:**读 host 时区就是读她设备的时区**。
- issue 的「简单版(手动配置)」反而定位成**逃生口**:显式 env 覆盖,用于 host 时区不可信的场景(例如她带手机 travel 但 Mac 留在家、或未来 Bridge 跑在服务器上)。

### 3.1 一个必须绕开的坑:Node 时区缓存
Node(ICU/libuv)在**进程启动时缓存系统时区**,长跑的 Bridge 用 `Intl.DateTimeFormat().resolvedOptions().timeZone` 拿不到设备切换后的新时区。cache-proof 的读法是每次(带短 TTL)`readlink /etc/localtime`:
```
$ readlink /etc/localtime
/var/db/timezone/zoneinfo/America/Los_Angeles   ← macOS,IANA 名可直接截取
```
Linux 同样是指向 zoneinfo 的 symlink,同一招通吃。渲染时用 `Intl.DateTimeFormat(..., { timeZone: <解析出的 IANA 名> })` —— 传显式 timeZone 参数不受进程缓存影响。

## 4. 方案:一个解析器 + 三层修

### F0 单一真相 `resolveFounderTimezone()`
放 `packages/config`(仿 `founder-ux-config.ts` 的「单一解析收口 + 永不缺省」模式)。解析顺序:
1. env `FLYWHEEL_FOUNDER_TZ` 设了显式 IANA 时区 → 用它(travel 逃生口 / 未来远程部署);
2. 否则(默认 `auto`)→ host 设备时区:`readlink /etc/localtime`(短 TTL cache)→ fallback `Intl.resolvedOptions().timeZone` → 最终兜底 `America/Los_Angeles`。

配置放**全局** `~/.flywheel/.env`(founder 只有一个,时区天然全局,不进 per-project config.yaml)。

### F1 primitive:`flywheel-comm founder-time`
一条命令输出 founder 当前 local time(含时区名 + UTC offset),Lead / Runner / 脚本共用,封装 F0 的解析顺序。这是 Lead「推理她现在几点」的唯一权威动作。

### F2 行为规则:`lead-rules-base/founder-local-time.md`
**所有角色**加载(companion + cos + dept —— Belle/Mufasa 恰恰最常聊作息):
- Discord 消息 ts= 属性**始终是 UTC**(F3 只新增 founder_local 属性,ts= 永不改),绝不凭 ts 直觉推断她的作息;有 founder_local 时以它为准;
- 推理「她现在几点 / 该不该推明天」之前,先跑 founder-time;
- 全部 founder-facing 时间显示用 founder local + 明确时区标注。
装载同步(完整清单以 plan A3 为准):claude-lead.sh inline block、lead-rules-bundle.sh(companion/cos/dept 三分支)、parity test,**加上三个手工拼 FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES 的 Mufasa launcher**(tui / headless rollback / writecapable —— 它们绕过 bundle,Codex design R2 抓出)+ Mufasa loading-proof 测试。

### F3 传输层修(插件 fork,独立 PR)
**Tadashi 裁定(brainstorm gate 2026-07-16):默认走保守方案** —— `ts=` 保持 UTC 不动,**新增 `founder_local="..."` 属性**(founder-local 墙钟 + 时区标注),instructions 文本写明两者语义。additive 零破坏且对模型同等有效。只有 research 证明下游**零**硬 parse 依赖时才允许 mutate ts=,举证责任在 mutate 一侧。
(精确语义后在设计审中钉死:founder_local = **消息 instant 按当前解析到的 founder 时区渲染**,不声称历史 send-time zone —— 以 plan.md A6/B1 为准。)
- `fetch_messages` 历史前缀同步补 founder-local 标注;
- fork 进程独立,tz 解析在 fork 内自含实现,与 F0 完全同序:env → readlink /etc/localtime(60s TTL)→ Intl fallback(IANA 校验)→ LA。
repo 内已知 ts 消费者:founder-consent prompt(喂 Haiku,无格式假设)、deferred-approval(用 snowflake,不用 ts)。

### F4 Bridge 渲染收敛
founderMsgClock / pacificDateString / MetaAlertNotifier / lead-alert.sh 全部改走 F0 resolver;completion digest(`FLYWHEEL_DIGEST_TZ`)默认值改 resolver(provider 化,显式 env 仍赢)。**`TOKEN_USAGE_TIMEZONE`(plugin.ts:9425 token digest-expect)保持 `?? LA` 不改** —— 它与 token-usage CLI 有 civil-day MUST-match 硬契约(notify-digest-expect.ts:63),而 token 链本单不碰(Codex design R1 裁定);token 链整体迁移 = follow-up。

### F5 Runner 提示词
PromptBuilder 三处 `toLocaleString()` → founder tz + 时区标注(Runner 写的 founder-facing 素材经 Lead relay,一样要对)。

## 5. 明确不做(scope 边界)

- **launchd 调度时刻**(standup 3AM 等):`StartCalendarInterval` 本来就按 host 本地钟 fire,host 跟设备走 → 行为已正确,不动。
- **多机部署的设备上报通道**:FLY-1005 multi-machine 落地后 host ≠ founder 设备,那时需要「设备 agent 上报 TZ → Bridge」;单独 follow-up issue,不在本单。
- **存量时间戳迁移**:存储层(StateStore/DB/日志)继续存 UTC/epoch,只有渲染层变。不碰存储。
- **product PRD**:Annie 明确纯 infra,直接做。

## 6. 验收对照

| Annie 的要求 | 方案落点 |
|---|---|
| 所有 Lead 显示 + 推理时间用她的 local | F2 规则(全角色)+ F3 传输层 + F4 渲染收敛 |
| travel 换时区不用等人改代码 | F0 auto 模式跟 host 设备;真不行还有 env 逃生口 |
| 理想:自动跟设备 | 单机部署下 auto = 设备时区,免费达成;多机 follow-up |
| 「劝睡觉/推明天」类错误消失 | 传输层直接给墙钟时间 + 行为规则禁止凭 UTC 直觉 |

## 7. Brainstorm gate 裁定记录(Tadashi,2026-07-16)

设计确认:三层归因 + 「host 设备=founder 设备」洞察 + F0-F5 结构批准。三条裁定:

1. **F3 姿态反转**:默认保守方案(ts= 保持 UTC + 新增 founder_local 属性 + instructions 写明两者语义);mutate ts= 需 research 举证下游零硬 parse 依赖,举证责任在 mutate 侧。已回写 §4 F3。
2. **部署事实进 plan**:F2 规则 + F3 插件 fork 都要 Lead/companion **重启**才吃到(FLY-576/589 教训:merge ≠ live)。落地挂批量重启窗口;plan 必须写明哪些 F 即时生效、哪些等重启。
3. **F0 技术路线批准**:readlink /etc/localtime + 短 TTL 对(Node Intl 缓存坑);解析顺序 env → host → LA 批准;存储层继续 UTC 只改渲染批准。(最终顺序在设计审中补 Intl 一级:env → host readlink → **Intl fallback** → LA —— 以 plan A1 为准。)

不做清单批准;多机上报归 FLY-1005 后 follow-up。下一步:research → plan → 跨家族设计审。
