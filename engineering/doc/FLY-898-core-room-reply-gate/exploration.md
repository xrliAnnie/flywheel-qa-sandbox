# FLY-898 Fleet-wide core-room 回复纪律 — 探索

Issue: FLY-898 (https://linear.app/geoforge3d/issue/FLY-898/infraruntime-fleet-wide-core-room-回复纪律-无-时只有-cos-回其他-lead-一律)
日期: 2026-07-06
基于: 无

---

## 1. Problem（Annie 的原话意图）

Annie（2026-07-06 睡前直接指令）：

> 「类似的改动可以 apply 到所有的 core room 中去吗？就是不管是 geoforge3d 还是 Flywheel，所有的
> core room 那里如果没有 at 任何人的话，就只有 COS 会回复，其他人只有在被 at 的情况下才会回复。」

目标行为（对**每个项目**的 core room 统一强制）：

| core room 里的消息 | 期望的 responder |
|---|---|
| 无 `@`、也没点任何 lead 的名 | **只有该项目 CoS** |
| `@` 了某个 lead / 点了它的名 | **那个 lead**（正常回） |
| `@` 了 CoS | CoS（本来就是它的地盘） |

范围：geoforge3d、flywheel 以及所有现有 + 未来项目的 core room；**一处改、全项目生效**，不是每个
lead 各写各的。非-core room（部门自己的 chat channel、issue thread、roundtable）行为不变。

---

## 2. 现状审计（codebase 事实，已逐条核对）

### 2.1 「core room」= `ProjectEntry.generalChannel`

`~/.flywheel/projects.json` 每个项目一个可选 `generalChannel`（FLY-173 引入，`ProjectConfig.ts:220`
定义 + `:706` 校验）。这就是「这是 core room」的现成数据标记。当前 fleet 快照：

| 项目 | generalChannel(core) | CoS(= chat==core) | core 里的其他 lead | backend 混合 |
|---|---|---|---|---|
| geoforge3d | `1487340532610109520` | cos-lead(Simba) | product-lead(Peter)、ops-lead(Oliver) | 全 Claude |
| flywheel | `1516209289406971965` | flywheel-cos-lead | eng(Tadashi)、product、**codex-infra-bot(codex full-access)**、anna(external) | 混合 |
| growth | `1500600400238084307` | **mufasa-lead(codex companion)** | rafiki、reflection(Claude) | 混合 |
| tidal-echo | `1517041708855197908` | tidal-echo-cos-lead(Triton) | content-lead(Ariel) | 全 Claude |
| sub | `1511267947551653918` | sub-lead(Asha,单 lead) | —— | Claude |
| joycon-typeless | `1511888584670711920` | **无**(joycon-lead chat≠core) | joycon-lead | Claude |
| personal-assistant | 无 core | —— | belle | Claude |

### 2.2 CoS 识别 = `chatChannel === generalChannel`

**关键结构性事实**：CoS 的 `chatChannel` 就等于项目的 `generalChannel`（5/7 项目成立）。core room
就是 CoS 自己的 chat channel。这与 FLY-173 的 reply-guard 注释一致（`reply-guard.ts:29-33`、
`tools.ts:1186-1192`：「for the cos-lead (Simba) the core channel IS its chatChannel」）。

推论：**CoS 天然是 core 的默认 responder**（core 就是它的私聊，永远都听得见），**不需要为 CoS 做任何
改动**——只需对**非-CoS** lead 上 gate。

### 2.3 两条独立入站机制（backend 分叉）

Flywheel 没有中央 inbound Discord router（FLY-152 plan §3 明确非目标：入站没有 Bridge 路由，
「不改频道订阅——都订阅 core 是有意的，改的是**是否回复**不是**是否听见**」）。入站过滤按 backend 分两套：

- **Claude lead** → 转发 Discord 插件读 `access.json` 的 `groups[channelId].requireMention`。
  插件里 `requireMention` **默认 true**（只有显式 `false` 才「听所有」，见 `roundtable-allowbots.ts:154`）。
  现状核对（access.json 实测）：非-CoS 的 Peter / Tadashi 的 **core group `requireMention: false`**
  → 听并回 core 里所有消息；CoS(Simba) 的 core group 也是 `false`（正确）。每个 lead 都配了
  `mentionPatterns`（如 `["\\bTadashi\\b"]`）→ 名字匹配已就绪。
- **Codex lead** → `mention-gate.ts` 的 `buildMentionGate`（FLY-267）。core(`coreChannelId`) 现在进
  `baseChannels`（**永远处理**，`codex-lead-runtime.ts:528-532`），mention-gate 只 gate
  `crossDeptChannelIds`（`:1598-1615`）。所以 Codex lead 在 core 里也**回所有消息**。

### 2.4 FLY-152 是 prompt-only，正是 Annie 现在抱怨的东西

FLY-152（`cross-dept-channel-rules.md` + 每个 lead 的 identity.md）只用**系统提示词软约定**做「CoS 默认
回、其他 lead 只在被点名时回」。FLY-152 plan §1 原话：「prompt 规则太软——LLM 生产环境不可靠遵守」。
FLY-898 就是把它**升级成服务端强制**：让非-CoS lead **根本听不见**无-@ 消息（Annie 原话「该消息不进它
的 session，跟 requireMention 一样，看不见就不会回」）。

---

## 3. 核心洞察

1. **不需要造新机制、不需要中央 inbound router。** 复用现成的两把 gate：Claude 的
   `requireMention` + Codex 的 `mention-gate`。两者都已支持「@ 或点名才过」（mentionPatterns），
   正好对上 spec 的「被 @ / 被点名」。
2. **只需对非-CoS lead 上 gate。** CoS 天然听 core（core = 它的 chat channel），零改动。
3. **单一真相 = projects.json**：core room = `generalChannel`；CoS = `chatChannel === generalChannel`。
   两个 backend 的 gate 都从这**同一份数据**驱动 → 满足「一处改、全项目生效」。
4. **Claude 侧只是 config，不动插件代码。** 把非-CoS lead 的 core group `requireMention` 翻成 `true`。
   插件默认就支持；名字/@ 仍能过。不需要改转发插件 fork。
5. **共享入口 = launcher/runtime，不是每个 lead 手写。** Claude 的 gate 由**共享 launcher**
   `claude-lead.sh` 在启动时自动打（它已按 pane 解析本项目 `generalChannel`=`LEAD_CORE_CHANNEL`，
   `:269-282`；已有 access.json seeding 步 `:2210-2219`）；Codex 的 gate 在**共享 runtime**
   `codex-lead-runtime.ts` 计算。都从 projects.json 派生，无每-lead 手写。

---

## 4. 方案选项

### 方案 A（推荐）：两 backend 各自入站 gate，同一 projects.json 驱动

- **Claude**：`claude-lead.sh` 启动时判断「本 lead 是否 CoS」(`本 lead chatChannel == LEAD_CORE_CHANNEL`)。
  非-CoS → 幂等 patch 它 access.json 里 core group 的 `requireMention: true`（保留 allowFrom/其他字段
  不动，参照 `add-roundtable-allowfrom.sh` 的幂等 patch 模式）。CoS 或无 core → 不动（字节兼容）。
- **Codex**：`codex-lead-runtime.ts` 新增「core 是否 mention-gated」信号（非-CoS 时开）。开时把
  `coreChannelId` 放进 `buildMentionGate` 的 `sharedChannelIds`（受 mention-gate），但**不**放进
  `crossDeptChannelIds`（避开 reply-routing + bridge-403 throw；core 本就是 Bridge-authorized，回复无 403）。
- **提示词**：`cross-dept-channel-rules.md`（或新 core-room 段）补一句「core room 现由服务端强制 mention
  纪律」，作为文档 + belt-and-suspenders，真正强制在 gate。

优点：boring、复用现成机制、零插件改动、字节兼容默认、一处数据驱动全 fleet。
缺点：Claude 侧本质是「集中生成的 config」而非纯 runtime gate（架构现实：Claude 入站无 Bridge hook）。
两个 backend 两段代码（但同一策略、同一数据源）。

### 方案 B：给转发插件加 inbound-guard，中央 Bridge 判定（真·统一 runtime gate）

插件每条 inbound 先 `POST /api/discord/inbound-guard`，Bridge 用 projects.json 判「非-CoS + core +
无-@ → 不投递」。Claude/Codex 都走同一个 Bridge 判定。

优点：真正单一 runtime gate、自动覆盖新 lead。
缺点：**推翻 FLY-152 明确定的 scope 边界**（「入站不做 Bridge router，是另一个 epic」）；要改插件 fork +
新 Bridge 端点 + 每条 inbound 加一次网络往返（延迟/复杂度）；插件 fail-closed 路径要重新设计。**过重**，
不符合 CLAUDE.md「enforce simplicity, boring obvious solution」。

### 方案 C：纯提示词加强（FLY-152 的延续）

只改 `cross-dept-channel-rules.md` 措辞更狠。**直接被否**——Annie 抱怨的就是「prompt 太软不可靠」，
FLY-898 的存在本身就是要服务端强制。

---

## 5. 推荐

**方案 A**。理由：Annie 要的「服务端强制 + 一处改全项目 + 复用 requireMention/mention-gate」三点全中；
方案 A 的两把 gate 都是现成的、CoS 零改动、字节兼容默认、由共享 launcher/runtime 从 projects.json 驱动。
方案 B 的「统一 runtime gate」诱人但推翻已定 scope 边界且过重，留作未来 follow-up。

---

## 6. 待 Lead 确认的决策点（brainstorm gate）

1. **CoS 识别用隐式约定 `chatChannel===generalChannel`**（零新 config、对齐 FLY-173），还是加显式
   `LeadConfig` 标记？推荐隐式 + 定义「core 有但无 CoS」的兜底（**fail-open：谁都不 gate = 保持现状**，
   字节兼容；joycon 就是这种，单 lead 项目本就不该被静音）。
2. **Claude 侧 gate 落点**：共享 launcher `claude-lead.sh` 启动时幂等 patch access.json（推荐，自动覆盖
   每次重启 + 新 lead），还是独立一次性 fleet 脚本？
3. **founder-UX gate**：本改动影响 Annie 在 Discord 看到「哪些 bot 回话」= founder-facing UX，但 UX 已由
   Annie 原话精确定义，dispatch 也把 founder 批准放在 **ship gate**（早上 review + 点头才上线）。确认
   「implement 前无需单独 founder-UX 签字，ship gate 即 founder 关卡」是否 OK。
4. **范围边界**：本 PR 只做 core room 的无-@ mention 纪律；不碰 roundtable(已 gated)、issue thread、
   dept chat channel、spawn 纪律。确认无遗漏。

---

## 7. 明确 Non-Goals

- 不建中央 inbound Discord router（保持 FLY-152 边界）。
- 不改转发插件 fork 代码（Claude 侧纯 access.json config）。
- 不动 CoS 自己在 core 的行为（core = CoS chat channel，零改动）。
- 不动 roundtable / issue thread / dept chat channel / spawn 纪律。
- 不做 LLM 语气/时态判定（沿用 FLY-152 的 substring 名字匹配）。
