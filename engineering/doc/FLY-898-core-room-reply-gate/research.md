# FLY-898 Fleet-wide core-room 回复纪律 — 调研

Issue: FLY-898 (https://linear.app/geoforge3d/issue/FLY-898/infraruntime-fleet-wide-core-room-回复纪律-无-时只有-cos-回其他-lead-一律)
日期: 2026-07-06
基于: exploration.md

---

## 1. 目标机制（brainstorm gate 已批 + Tadashi 细化）

在**每个项目的 core room**（= `ProjectEntry.generalChannel`）里：非-CoS lead 只在**被真 `@`（`<@id>`）
或显式回复本人消息**时才收到消息进 session；无-@ 消息只有 CoS 收到。CoS 零改动（core = CoS 自己的
chat channel）。

**关键细化（Tadashi）**：core-room 的「被 addressed」= 真 `<@id>` + 显式回本人消息 **only**，
**不认裸词名字**（access.json 顶层 `mentionPatterns` 的 `\bName\b` 会把文本里裸出现的 lead 名当成
被 @，Anna 生产中过——`刚 Peter 帮我搞了 X` 会假触发 Peter，正是 FLY-152 的 secondary trigger）。

---

## 2. 三个数据事实（projects.json 实测）

| # | 事实 | 出处 |
|---|---|---|
| 1 | core room = `ProjectEntry.generalChannel`（可选 string，FLY-173 引入） | `ProjectConfig.ts:220`、校验 `:706-717` |
| 2 | CoS = 该项目里 `chatChannel === generalChannel` 的那个 lead（5/7 项目成立；core 就是 CoS 私聊） | `projects.json` 实测；对齐 `reply-guard.ts:29-33`、`tools.ts:1186-1192` |
| 3 | core-有-但-无-CoS 的项目存在（joycon：core=`1511888584670711920`，joycon-lead chat 不等于它，单 lead）→ 兜底 fail-open 不 gate | `projects.json` 实测 |

fleet 覆盖（多-lead core = 纪律真正生效处）：geoforge3d（Simba CoS + Peter/Oliver）、flywheel
（cos + eng/product + **codex-infra-bot** + anna-external）、growth（**mufasa codex CoS** + rafiki/reflection）、
tidal-echo（Triton CoS + Ariel）。混合 backend 存在 → 两把 gate 都要改。

---

## 3. 机制 A：Claude lead 入站 = 转发插件 `server.ts`（access.json）

live 源：`~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/discord/server.ts`
（fork，靠 `update-discord-plugin.sh` 从 fork repo 同步；claude-lead.sh `:675-700` 启动前校验 fork 版本）。

### 3.1 入站 gate 判定（`server.ts:706-790`）

```
channelId = thread ? parentId : channelId
policy = access.groups[channelId]            // GroupPolicy = { requireMention, allowFrom }
if !policy → drop
if policy.allowFrom 非空 且 sender 不在里面 → drop      // :717
if requireMention(默认 true) 且 !isMentioned(msg, access.mentionPatterns) → drop  // :762
→ deliver
```

`isMentioned(msg, extraPatterns)`（`:768-790`）依次认：
1. 真 `<@id>`：`msg.mentions.has(client.user)` → true
2. 显式回本人消息：`msg.reference` 指向本 bot 发过的消息 → true
3. **任一全局 `extraPatterns` 正则命中文本** → true ← **裸词假 mention 来源**

### 3.2 关键限制：`mentionPatterns` 是全局、无 per-group（`server.ts:460-473`）

```ts
type GroupPolicy = { requireMention: boolean; allowFrom: string[] }   // 无 mentionPatterns
type Access = { ...; groups: Record<string, GroupPolicy>; mentionPatterns?: string[]; ... }
```

→ requireMention:true 下对**所有** group 用同一份全局裸词 patterns。**无法**只靠 access.json config 让
core group id-only 而 roundtable 保留名字寻址（除非动插件 fork）。

### 3.3 现状（access.json 实测，= 「问题」）

非-CoS lead（Peter core group / Tadashi core group）= `{requireMention:false, allowFrom:[...]}` → 听并回
core 里所有消息。CoS（Simba）core group 也是 `false`（正确，默认 responder）。全局
`mentionPatterns:["\\bPeter\\b"]` 等已配（roundtable 用）。

### 3.4 修复方向（Claude 侧）

非-CoS lead 的 core group `requireMention: false → true`。id-only 化两条路（A/B，待 Tadashi 拍）：
- **(A) 插件 per-group mentionPatterns**：`GroupPolicy` 加可选 `mentionPatterns?`，`isMentioned` 用
  `policy.mentionPatterns ?? access.mentionPatterns`；core group 设 `[]`=id-only，roundtable 不动。第二个 repo PR。
- **(B) 删全局裸词 patterns**：config-only 单 repo，但 roundtable 名字寻址也失效（全 fleet @-only）。

**落点（两个都要，brainstorm 已批）**：
- 共享 launcher `claude-lead.sh` 启动时幂等 patch（自动覆盖重启 + 新 lead）。它已按 pane 解析本项目
  `generalChannel`=`LEAD_CORE_CHANNEL`（`:269-282`）+ 有 access.json seeding 步（`:2200-2219`
  调 `add-roundtable-allowfrom.sh` 模式）。CoS 判定 = 本 lead chatChannel == LEAD_CORE_CHANNEL。
- 一次性 fleet apply 脚本：首发立即生效、缩小首发重启面（不用等下次重启）。

---

## 4. 机制 B：Codex lead 入站 = `mention-gate.ts` + `codex-lead-runtime.ts`

### 4.1 现状（core 永远处理）

`codex-lead-runtime.ts:528-547`：`coreChannelId` 进 `baseChannels`（永远处理）；`crossDeptChannelIds`
（roundtable）单独。`shouldHandle`（`:1598-1615`）只 gate `crossDeptChannelIds`：

```ts
const shouldHandle = config.crossDeptChannelIds.length > 0
  ? buildMentionGate({ botUserId, sharedChannelIds: config.crossDeptChannelIds, mentionPatterns, ... })
  : undefined;
const resolveReplyChannelId = ... crossDeptSet.has(m.channelId) ? m.channelId : undefined;  // 独立
```

→ Codex lead 在 core 里回所有消息（= 问题）。

### 4.2 关键解耦（已核实）

`shouldHandle`（mention-gate）用 `sharedChannelIds`；`resolveReplyChannelId`（回复路由 + bridge-403）
独立用 `crossDeptSet`。所以可以把 core 放进 mention-gate 的 `sharedChannelIds`（受 gate）而**不**放进
`crossDeptChannelIds`（避开 reply-routing + `:555` 的 bridge-mode throw）。core 本就是 Bridge-authorized
频道，回复无 403。

### 4.3 `isMentioned`（`mention-gate.ts:69-91`）已支持 id-only

```ts
if (msg.mentions?.includes(botUserId)) return true;        // ① 真 <@id>
if (content.includes(`<@${botUserId}>`) || `<@!${botUserId}>`) return true;  // ②
if (!msg.authorBot) for (re of compiled) if (re.test(content)) return true;  // ③ 名字，仅非-bot 作者
```

→ core 的 id-only = 给 core 频道走 ①②但**跳过 ③（名字 regex）**。roundtable 继续用完整 patterns。
需在 `buildMentionGate` 区分「core-strict 频道集（id-only）」vs「crossDept 频道集（name-ok）」。

### 4.4 修复方向（Codex 侧，全在本 repo，我全控）

- `codex-lead-runtime.ts`：新增「core 是否 mention-gated」信号（非-CoS 时开）。开时把 `coreChannelId`
  以 **id-only** 语义交给 `buildMentionGate` 的 shared 集，**不**进 `crossDeptChannelIds`。
- `mention-gate.ts`：`buildMentionGate` 支持一组「id-only shared 频道」（跳过名字 regex），与现有
  name-aware shared 频道并存。CoS 判定信号从 launcher env 传（chatChannel vs generalChannel），或
  runtime 从两者算。
- Codex 侧的 CoS：growth 的 mufasa（chat==core）是 CoS → 不 gate；flywheel 的 codex-infra-bot（非-CoS）
  → gate。

---

## 5. 字节兼容 / 边界

- 无 `generalChannel` 的项目（personal-assistant）→ 不 gate。
- core-有-但-无-CoS（joycon 单 lead）→ **fail-open 不 gate**，保持现状（单 lead 项目不该被静音）。
- CoS 本身（chat==core）→ 零改动，永远听 core。
- 非-core 频道（dept chat、issue thread）→ 零改动。
- roundtable → 方案 (A) 零改动；方案 (B) 变 @-only（scope 外，待 Tadashi 定）。
- companion / external lead：mufasa(CoS,codex) 按 CoS 处理；anna(external) 不在 core roster、
  external-contract 独立，不受影响；belle 无 core。

---

## 6. 复用 / 不重造

- 复用插件现成 `requireMention`（Claude）+ `mention-gate` `isMentioned`（Codex）。
- 复用 `add-roundtable-allowfrom.sh` 的「幂等 patch access.json 不动其他字段」模式。
- 复用 `claude-lead.sh` 已解析的 `LEAD_CORE_CHANNEL`（generalChannel）+ 现有 access.json seeding 位点。
- 不建中央 inbound Discord router（保持 FLY-152 边界）。

---

## 7. 已定

- **A vs B**（Claude 侧 id-only 机制）= **(A)** 插件 fork per-group mentionPatterns（Tadashi qid
  ae6d33fd 确认：scope 隔离、roundtable 零回归）。roundtable 自身 bare-word 风险 → 单独 follow-up。
