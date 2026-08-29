# FLY-898 Fleet-wide core-room 回复纪律 — 实施计划

Issue: FLY-898 (https://linear.app/geoforge3d/issue/FLY-898/infraruntime-fleet-wide-core-room-回复纪律-无-时只有-cos-回其他-lead-一律)
日期: 2026-07-06
基于: exploration.md, research.md
Status: codex-approved（design review R1 CHANGES→R2 APPROVED, 2026-07-06）

---

## 0. 一句话

对**每个项目的 core room**（`generalChannel`）统一强制：非-CoS lead 只在被真 `<@id>`（+ 显式回复本人
消息）时才收到消息进 session；无-@ 消息只有 CoS 收到、其他 lead 服务端静默。CoS 零改动。两个 backend
（Claude 插件 `requireMention` + Codex `mention-gate`）各自入站 gate，同一 `projects.json` 驱动。

**核心不变量**：core-room「被 addressed」= 真 `<@id>` + 显式回本人消息 only，**不认裸词名字**
（防 `刚 Peter 帮我` 假 mention，Tadashi 指令 / Anna 生产事故）。

> **⚠️ founder-facing 行为变化（ship gate 必须向 Annie 明示，不埋）**：Annie 原话「点了它的名」；本实现
> 把 core 的 addressed 收紧为**真 Discord @**（不是裸文本名字）。即在 core room 打字「Peter 看一下」
> （无 @）**不再**触达 Peter；要触达非-CoS lead 必须真 @ 它。理由：裸名匹配会假触发（`刚 Peter 帮我`），
> 正是 FLY-152 的 pile-on 病根；CoS 是所有无-@ 消息的兜底 responder。Tadashi 已拍 id-only；Annie 在
> ship gate review 时须知晓此收紧。

---

## 1. 数据模型 + 单一判定（共享，零新 config）

- **core room** = `ProjectEntry.generalChannel`（已存在）。
- **CoS** = 该项目 `chatChannel === generalChannel` 的 lead（隐式约定，零新字段，对齐 FLY-173）。
- 新纯函数（单一真相，launcher / fleet 脚本 / 两 Codex runtime 共用，避免三处漂移）
  `packages/teamlead/src/core-room-gate.ts`：

  ```
  resolveCoreRoomGate(project, lead) → { coreChannelId?, projectHasCoS: bool, isCoS: bool, gateNonCoS: bool }
  ```
  **gateNonCoS（Codex R1#3 修正 joycon fail-open）**= 三条同时成立：
  1. `project.generalChannel` 非空（core 存在），且
  2. `project.leads` 里**至少有一个** lead `chatChannel === generalChannel`（**项目真有 CoS**），且
  3. 本 lead `chatChannel !== generalChannel`（本 lead 不是 CoS）。
  → **core-有-但-无-CoS**（joycon：generalChannel 设了但没 lead chat==core）→ 条件 2 不成立 →
    `gateNonCoS=false` → **不 gate**（fail-open 保现状，单 lead 不被静音）。
  → 无 generalChannel / CoS 本身 → `gateNonCoS=false`。
- 表驱动测试先行（TDD）：geoforge3d(多-lead core,CoS+2非CoS) / joycon(core-无-CoS,全 false) /
  sub(单-lead CoS) / growth(codex-CoS mufasa + 2 非CoS) / personal-assistant(无 core) / flywheel。

---

## 2. Surface 1 — Codex lead（本 repo，两个 runtime 都改）

> **风险实况（Codex R1#1 核实后修正）**：当前 fleet **没有非-CoS codex lead 订阅任何 core room**
> —— mufasa 是 growth CoS（chat==core，不 gate）；codex-infra-bot 只订阅它自己的 chat + Alerts 频道
> （`run-codex-infra-bot-tui.sh` 不设 `FLYWHEEL_LEAD_CORE_CHANNEL_ID`），**不在 flywheel core 里**。
> 所以本 surface 对现有 codex lead 是 **dormant**（live 风险低）。仍必须为 fleet-wide 契约 + 未来非-CoS
> codex lead 在**两个** runtime 正确接线 + 测试。

### 2.1 `mention-gate.ts` — id-only core 频道集

`buildMentionGate` 现在对 `sharedChannelIds` 统一用 `isMentioned`（含名字 regex ③）。新增：
- `coreStrictChannelIds?: Iterable<string>`：命中时用 **id-only 判定** —— 真 `<@id>`（①②）+
  **显式回本人消息**（见 2.3），**跳过 ③ 名字 regex**。
- `isMentioned` 增 `opts?: { idOnly?: boolean }`（true 时不跑名字 regex），或抽 `isIdMentioned()`。
- predicate：`if coreStrict.has(ch) return isIdMentioned(msg, botUserId)`；roundtable/crossDept 走原
  name-aware 路径不变。
- byte-compat：`coreStrictChannelIds` 缺省空 → 逐字不变（现有 mention-gate 测试全绿）。

### 2.2 两个 runtime 的接线（headless + **TUI**，Codex R1#1）

**必须两处都改**（FLY-398：生产 Codex 走 windowed TUI）：
- `codex-lead-runtime.ts`（headless，`~:528-547` + `~:1598-1615`）
- `codex-lead-tui-runtime.ts`（**生产**，`~:558` + `~:580-606`）—— 同一 buildMentionGate 装配。

改法（两处一致）：
- 新增 `coreMentionGated` 信号：runtime 用 `resolveCoreRoomGate` 直接算（chatChannel + generalChannel
  都可从 config/env 拿；优先 runtime 算，少 env 少漂移），或 launcher env `FLYWHEEL_LEAD_CORE_MENTION_GATED=1`。
- 开时：`coreChannelId` 保留在 `baseChannels`（仍订阅），**额外**作 `coreStrictChannelIds` 传
  `buildMentionGate`；`shouldHandle` 构建条件从 `crossDept.length>0` 放宽为
  `crossDept.length>0 || coreMentionGated`。**不**把 core 进 `crossDeptChannelIds`（避开 `:555`
  bridge-mode throw + reply-routing；core 本是 Bridge-authorized）。
- dry-run boot 报告加一行 `core mention gate: on/off`（Codex R1#1：operator 可见）。
- CoS codex lead（mufasa）→ off → core 永远处理（现状）。

### 2.3 Codex「回本人消息」reply-to-self（Codex R1#2）

现 `mention-gate.isMentioned` 无 reply-to-self（FLY-267 明确 out-of-scope）；`RestPollDiscordInboundSource`
只映射 `message_reference.message_id`（`:338`），不知被引用消息的作者。**具体设计**：
- 富化入站消息：`RestPoll` 读 Discord message 的 `referenced_message?.author?.id` → 新字段
  `DiscordInboundMessage.referencedAuthorId`（Discord 对 reply 消息默认带 `referenced_message` 全对象）。
- id-only 判定：`isIdMentioned = mentions.has(bot) || content 含 <@bot> || referencedAuthorId === botUserId`。
- **降级 fail-safe**：payload 未带 `referenced_message.author`（被删/无权限）→ `referencedAuthorId`
  undefined → reply-to-self 不触发（退化为 @-only，安全严格，不误放）。**不**引入 sent-id tracker /
  async fetch（过重）。
- 两 runtime 都验：「回本 bot 上一条消息 → pass」「回别人消息 → drop」。

### 2.4 Codex 侧测试

- `mention-gate.test.ts`：core-strict 下 `刚 Peter 帮我`（含名无@）→ drop；真 `<@id>` → handle；
  `referencedAuthorId===bot` → handle；`referencedAuthorId=其他` → drop；roundtable 名字仍 handle（不回归）。
- `codex-lead-runtime.test.ts` + `codex-lead-tui-runtime.test.ts`：coreMentionGated on/off 的
  channelIds / shouldHandle / bridge-mode 不 throw（core 不进 crossDept）；byte-compat（off=现状）。
- RestPoll 映射测试：`referenced_message.author.id → referencedAuthorId`；缺省 undefined。

---

## 3. Surface 2 — Claude lead（access.json，driven from projects.json）

### 3.1 gate 本体 = core group `requireMention: true`（非-CoS）

非-CoS lead 的 core group `requireMention: false → true`（CoS 保 false）。插件
`requireMention && !isMentioned → drop` 即服务端静默无-@ 消息。

### 3.2 id-only 化 = 插件 fork per-group mentionPatterns（A，Tadashi qid ae6d33fd 确认）

插件 `mentionPatterns` 全局无 per-group（`server.ts:460-473`）→ 光 requireMention:true，裸词名字仍假
mention 过（`isMentioned` `:768-790` 用全局 patterns）。**走 (A)**：
- 转发插件 fork `server.ts`：`GroupPolicy`（`:460-463`）加可选 `mentionPatterns?: string[]`；两处
  `isMentioned` 调用（`:736`、`:762`）传 `policy.mentionPatterns ?? access.mentionPatterns`。
- 核心 access.json patch：非-CoS lead 的 **core group 设 `mentionPatterns: []`**（id-only，只留 `<@id>` +
  reply-to-self）；roundtable group 不设 per-group → 用全局 → 名字寻址不回归。
- byte-compat：per-group 字段缺省 → 逐字回退全局。插件 fork 测试补 per-group case + reverse-compat。
- 双 PR（同 FLY-314 flywheel + plugin fork），随 batched Tier-3 重启 reload plugin。

### 3.3 rollout 顺序 + 硬 preflight（Codex R1#4 —— 防旧插件下静默失败）

**旧 `server.ts` 会忽略未知 group 字段** → 若 access.json 先写 `mentionPatterns:[]` 而运行时插件仍旧版，
则全局 patterns 仍生效、裸名仍过 = 主 bug 没修但看似修了。硬顺序：
1. 插件 fork PR 合并 + `update-discord-plugin.sh` 同步到 marketplace runtime。
2. **preflight 校验**：扩 `check-discord-plugin.sh`（现只校 allowBots marker + SHA），加断言运行时
   `server.ts` 含 per-group 支持标记（grep `policy.mentionPatterns ?? access.mentionPatterns` 或版本
   marker）。
3. **共享 patch 助手（§3.4）refuse 写 `mentionPatterns:[]` 除非 preflight 通过**：不支持时仍写
   `requireMention:true`（无-@ 静音 = 部分收益）但**跳过** id-only 字段并 **loud warn**「id-only 未激活,
   等插件同步」。避免静默假成功。
4. 插件同步 + 校验通过 → access mutation → 重启/reload。

### 3.4 共享 patch 助手（Codex R1#5 —— 一个受测助手，非两处内联）

新脚本/函数 `apply-core-room-mention-gate`（bash，镜像 `add-roundtable-allowfrom.sh` 骨架 + 其
**optimistic rebase guard**，因为插件自身 pairing/prune 也写 access.json，每次启动的 read-modify-rename
无 guard 会 clobber）：
- 原子（唯一 temp + rename）、写前备份、JSON 校验、**幂等**（已是目标态 → no-op、diff 空）、
  **optimistic rebase**（写前重读，中途被插件改则重算）、只碰目标 group 的 `requireMention` + (支持时)
  `mentionPatterns`，绝不碰其他 group/字段、绝不 CREATE group。
- **缺 access/缺 core group 策略（统一，消 R1#5 的 §3.3/§3.5 矛盾）**：core group 不存在 = 该 lead 没订阅
  core → **no-op**（launcher 与 fleet 一致）；坏 JSON = fail-closed 非零（不 mutate）；fleet apply 对坏
  文件报确切 lead + 非零退出该 lead 的 apply（不静默）。
- launcher 与 fleet apply **都调这个助手**（同一逻辑，不重造）。

### 3.5 落点 1 — 共享 launcher `claude-lead.sh` 启动幂等 patch（主）

- 扩现有 `LEAD_CORE_CHANNEL` resolver（`:277-284`）：额外解析本 lead 的 chatChannel
  （loadProjects → `project.leads.find(agentId===LEAD_ID).chatChannel`）→ `LEAD_CHAT_CHANNEL`；并解析
  「项目是否有 CoS」（有 lead chat==core）。
- 用 `resolveCoreRoomGate` 逻辑算 `gateNonCoS`（§1；joycon fail-open 内建）。
- `gateNonCoS==true` → 调 §3.4 助手幂等 patch core group（preflight 门控 id-only 字段）。否则不动。

### 3.6 落点 2 — 一次性 fleet apply 脚本（首发立即生效）

`apply-core-room-mention-gate.sh --all`（复用 §3.4 助手）：
- 读 `projects.json` → 每项目算 CoS + 非-CoS Claude leads（`resolveCoreRoomGate`，joycon 天然跳过）。
- 对每个 `gateNonCoS` 的 Claude lead：定位 access.json（`~/.claude/channels/discord-<agentId>/`），
  幂等 patch。`--dry-run`（打印 diff 不写）、`--project <name>`。跳过 codex lead（走 runtime）。
- **§3.3 preflight 前置**：脚本先校运行时插件 per-group 支持，未通过则拒写 id-only + loud warn。
- 幂等验收：连跑两次第二次 diff 空。

### 3.7 Claude 侧测试

- `resolveCoreRoomGate` 表驱动（含 joycon core-无-CoS = 全 false，Codex R1#3）。
- 助手脚本测试（bash，`add-roundtable-allowfrom.test.sh` 模式）：只改目标 group 目标字段、其他字节不变、
  幂等、optimistic rebase、缺 group=no-op、坏 JSON fail-closed、CoS 不被 patch、preflight 未过拒写 id-only。
- 插件 fork `server.ts`：per-group mentionPatterns gate 测试（core `[]`=id-only drop 裸名；roundtable 全局
  名字仍 pass；无 per-group=用全局 byte-compat）。

---

## 4. 提示词（文档 + backstop）+ founder-facing 明示（Codex R1#7）

- `cross-dept-channel-rules.md`（或新增 core-room 短段）补：「core room 现由**服务端**强制 mention 纪律
  —— 非-CoS lead 只在被**真 Discord @**（或回本人消息）时收到；无-@ 只有 CoS 回。**在 core 找某 lead 请真
  @ 它，不能只打名字。**」明确『真 @』而非裸名。范围克制：不重写 FLY-152 既有措辞。
- 此「裸名不再触达、须真 @」的行为变化 → 写进 §7 founder-facing QA checklist + ship-gate 向 Annie 明示
  （§0 已高亮）。

## 5. Core thread 语义（Codex R1#6 —— pin 边界）

**FLY-898 只 gate core PARENT 频道**。子 thread：
- Claude：插件 thread 继承 parent group policy（`server.ts:710-712`）→ core 下的 thread 也按 id-only
  gated。**接受**（core 纪律的自然延伸），非本 issue 目标；若将来要 thread 内放松 → 单独 follow-up。
- Codex：REST poll 只看配置频道 + roundtable topic thread，**不发现 core 下任意 thread** → core thread
  对 Codex 不变。
- 两 backend 在「core 子 thread」上有已知差异 → 明确 out-of-scope for v1，QA 措辞写清「core 子 thread
  行为不在本次验证目标内」。

## 6. 字节兼容矩阵

| 场景 | 期望 |
|---|---|
| 无 generalChannel（personal-assistant/belle） | 不 gate，逐字现状 |
| core-有-但-无-CoS（joycon 单 lead） | fail-open 不 gate（gateNonCoS=false） |
| CoS 本身（Simba/Triton/mufasa/Asha…） | 零改动，永远听 core |
| 非-core 频道（dept chat / issue thread） | 零改动 |
| roundtable | 零改动（(A) per-group 隔离） |
| Codex `coreMentionGated` 缺省/off | 两 runtime 逐字现状 |
| 插件 per-group mentionPatterns 缺省 | 用全局，逐字现状 |
| 运行时插件未支持 per-group | 拒写 id-only 字段 + warn（不静默假修） |

kill-switch：Codex 侧信号 off = 旁路；Claude 侧助手 `--dry-run` + 备份回滚（改回 requireMention:false）。

## 7. Rollout（founder ship-gate hold — 绝不自 ship）

顺序（Codex R1#4）：
1. 本 session（Path A，全 Opus）：design review 过 → TDD implement 两 Codex runtime + mention-gate +
   RestPoll 富化 + 共享助手 + launcher + fleet 脚本 + 插件 fork per-group + preflight → 全仓 lint + test 绿。
2. **双 PR**：插件 fork PR + 本 repo PR（同 FLY-314）。
3. QA 真机验足（§8）。
4. **HOLD 在 founder ship-gate**：fleet-wide 行为改动 + §0 的裸名→真@ 收紧，Annie 早上 review + 点头才上。
   Tadashi 作 executor、verify-approval 过后随 batched Tier-3：**先**同步+校验新插件（preflight）→ **再**
   fleet apply 脚本 patch access.json → 重启 Claude Leads（launcher 复patch 兜底）+ Codex runtime。
   **绝不自 ship**。

## 8. QA（真机 E2E，独立会话验；gate 项）

真 core room（flywheel core 或 QA 529 Room 镜像），Claude-in-Chrome 观察：
- **无-@ 消息** → 只有 CoS 收+回；非-CoS lead session **零注入零回**（查 tmux pane 无该消息）。
- **@ 某非-CoS lead** → 它收+回。
- **裸名（`刚 Peter 帮我` / `Peter 看一下`，无 @）** → Peter **不**收（id-only，不被裸名假 mention 绕过）
  —— 这是 §0/§4 明示的行为变化的正向验证。
- **回本人消息**（回复该 lead 之前发的消息）→ 收（两 backend；Codex 经 referencedAuthorId）。
- **CoS + roundtable 无回归**：CoS 在 core 正常；roundtable 名字寻址仍 work（(A) 隔离）。
- **byte-compat**：joycon（core-无-CoS）单 lead 仍收无-@（未被误静音）。
- core 子 thread：out-of-scope（§5），不作 pass/fail 目标。
- （codex 非-CoS-in-core 当前无 live 实例 → 用 QA 镜像或单测覆盖 Codex 两 runtime 逻辑。）

## 9. Files touched（预估）

- `packages/teamlead/src/core-room-gate.ts`（新，纯函数 + 测试）
- `packages/teamlead/src/lead-backends/codex/mention-gate.ts`（id-only core-strict + reply-to-self）+ 测试
- `packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts`（coreMentionGated）+ 测试
- `packages/teamlead/src/lead-backends/codex/codex-lead-tui-runtime.ts`（coreMentionGated）+ 测试
- `packages/teamlead/src/lead-backends/codex/RestPollDiscordInboundSource.ts`（referencedAuthorId）+ 测试
- `packages/teamlead/scripts/claude-lead.sh`（LEAD_CHAT_CHANNEL + gateNonCoS + 启动 patch）
- `packages/teamlead/scripts/apply-core-room-mention-gate.sh`（新，共享助手 + `--all`/`--dry-run`）+ 测试
- `~/.flywheel/bin/check-discord-plugin.sh`（per-group 支持 preflight marker）—— 若在 repo 则改，否则
  实现阶段确认其源
- `packages/teamlead/lead-rules-base/cross-dept-channel-rules.md`（core-room 服务端强制 + 真@ 一句）
- 转发插件 fork `server.ts`（per-group mentionPatterns）+ 测试（**独立 repo PR**）
- 本 doc 文件夹随分支合入

## 10. Non-Goals / Follow-ups

Non-goals：不建中央 inbound Discord router（保 FLY-152 边界）；不动 CoS 在 core 的行为；不动 issue
thread / dept chat / spawn 纪律；不做 LLM 语气判定；不动 roundtable（(A) 隔离）；core 子 thread 放松
不在 v1。
Follow-ups：① roundtable 自身 bare-word 假 mention 风险（B 本可顺带根除）单独 issue；② 若需 core 子
thread 内放松 @ 要求 → 单独 issue；③ Codex reply-to-self 若要 sent-id tracker 强化 → 单独。

## 11. Decisions（已定）

- **A/B**（Claude id-only 机制）= **(A)** per-group mentionPatterns（Tadashi qid ae6d33fd）。
- Codex reply-to-self = 富化 `referencedAuthorId`（不引 sent-id tracker）。
- joycon/core-无-CoS = fail-open 不 gate（`gateNonCoS` 三条件）。
- 裸名→真@ 收紧 = 已定（Tadashi id-only），ship gate 向 Annie 明示。

## 12. Implementation guardrails（Codex R2 APPROVED 附带的 3 条非阻塞项，implement 必落）

1. **Codex core 订阅的 coreChannelId 来源要具体**：implement 时明确——两 runtime 用
   `resolveCoreRoomGate` 需拿到完整 project roster（不只本 lead chat）来判 gateNonCoS；且加测试证
   dry-run 报告 `core mention gate: on` **只在** core 频道确实在 runtime 订阅集里时才 on。当前无 live
   非-CoS codex-in-core → dormant，但接线要真能 resolve core 频道。
2. **preflight checker 的 source-of-truth**：`check-discord-plugin.sh` 是 ops-side（`~/.flywheel/bin/`），
   本 checkout 无 repo-tracked 源。implement 时确认其托管路径 + 更新机制并写进 progress/rollout；若有
   installer/sync 源则改源，不只改生成副本。避免 fleet rollout 漂移。
3. **降级态 ≠ id-only 完成**：helper 输出 + QA gate 必须区分 `mention-required-only`（仅 requireMention:true,
   裸名仍过）vs `id-only-core`（requireMention:true **且** mentionPatterns:[]）。founder-facing rollout
   到「运行时插件 per-group marker 在 + 非-CoS Claude lead 的 core group 两字段都写上」才算完成，否则只是
   部分收益、不满足 id-only 不变量。
