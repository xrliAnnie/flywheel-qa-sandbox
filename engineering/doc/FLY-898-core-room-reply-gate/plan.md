# FLY-898 Fleet-wide core-room 回复纪律 — 实施计划

Issue: FLY-898 (https://linear.app/geoforge3d/issue/FLY-898/infraruntime-fleet-wide-core-room-回复纪律-无-时只有-cos-回其他-lead-一律)
日期: 2026-07-06
基于: exploration.md, research.md
Status: draft（待 Codex design review）

---

## 0. 一句话

对**每个项目的 core room**（`generalChannel`）统一强制：非-CoS lead 只在被真 `<@id>` 或显式回复本人
消息时才收到消息进 session；无-@ 消息只有 CoS 收到、其他 lead 服务端静默。CoS 零改动。两个 backend
（Claude 插件 `requireMention` + Codex `mention-gate`）各自入站 gate，同一 `projects.json` 驱动。

**核心不变量**：core-room「被 addressed」= 真 `<@id>` + 显式回本人消息 only，**不认裸词名字**
（防 `刚 Peter 帮我` 假 mention，Tadashi 指令 / Anna 生产事故）。

---

## 1. 数据模型（共享，零新 config）

- **core room** = `ProjectEntry.generalChannel`（已存在）。
- **CoS** = 该项目 `chatChannel === generalChannel` 的 lead（隐式约定，零新字段，对齐 FLY-173）。
- **兜底**：项目无 `generalChannel`，或有 core 但无 lead chat==core（joycon 单 lead）→ **fail-open
  不 gate**，字节兼容保持现状。
- 新增一个纯函数（单一真相，两 surface 共用）：
  `resolveCoreRoomGate(project, lead) → { isCoreRoom: bool, isCoS: bool, gateNonCoS: bool }`
  放 `packages/teamlead/src/`（如 `core-room-gate.ts`），Codex runtime + fleet 脚本 + launcher 校验都
  能引用同一判定（避免三处各写各的漂移）。TDD：先写这个纯函数的表驱动测试。

---

## 2. Surface 1 — Codex lead（本 repo，我全控）

### 2.1 `mention-gate.ts` — id-only core 频道集

`buildMentionGate` 现在对 `sharedChannelIds` 统一用 `isMentioned`（含名字 regex ③）。改为区分两类
shared：
- **name-aware shared**（roundtable / crossDept）：不变，`isMentioned` 含名字 regex。
- **id-only shared**（core-room gate）：新增 `coreStrictChannelIds?: Iterable<string>`，命中时用
  **id-only 判定**（真 `<@id>` + 显式回本人；**跳过** ③ 名字 regex）。

实现：`isMentioned` 增可选 `opts.idOnly`（true 时不跑名字 regex，只留 ①②），或抽 `isIdMentioned()`。
`buildMentionGate` 的 predicate 里：`if coreStrict.has(ch) return isIdMentioned(msg)`。byte-compat：
`coreStrictChannelIds` 缺省空 → 行为逐字不变（全 79/现有 mention-gate 测试须绿）。

### 2.2 `codex-lead-runtime.ts` — 非-CoS 时把 core 送进 id-only 集

- 新增信号 `coreMentionGated`（非-CoS codex lead = true）。来源：launcher env
  `FLYWHEEL_LEAD_CORE_MENTION_GATED=1`（codex launcher 从 chatChannel vs generalChannel 算），或
  runtime 用 `resolveCoreRoomGate` 直接算（若 chatChannel+generalChannel 都在 env）。**优先 runtime 算**
  （少一个 env、少漂移）。
- 开时：`coreChannelId` 保留在 `baseChannels`（仍订阅、`channelIds` 含它），但**额外**作为
  `coreStrictChannelIds` 传给 `buildMentionGate`；`shouldHandle` 的构建条件从
  `crossDept.length>0` 放宽为 `crossDept.length>0 || coreMentionGated`。**不**把 core 放进
  `crossDeptChannelIds`（避开 `:555` bridge-mode throw + reply-routing；core 本是 Bridge-authorized）。
- CoS codex lead（mufasa，chat==core）→ `coreMentionGated=false` → core 永远处理（现状）。
- 非-CoS codex lead（codex-infra-bot in flywheel）→ gate。

### 2.3 Codex 侧测试

- `mention-gate.test.ts`：core-strict 频道下 `刚 Peter 帮我`（含名字，无 @）→ **drop**；真 `<@id>` →
  handle；回本人消息 → handle；roundtable 频道名字仍 handle（不回归）。
- `codex-lead-runtime.test.ts`：coreMentionGated on/off 的 channelIds / shouldHandle / bridge-mode
  不 throw（core 不进 crossDept）；byte-compat（off = 现状）。

---

## 3. Surface 2 — Claude lead（access.json，driven from projects.json）

### 3.1 gate 本体 = core group `requireMention: true`（非-CoS）

非-CoS lead 的 core group `requireMention: false → true`（CoS 保 false）。插件
`requireMention && !isMentioned → drop` 即服务端静默无-@ 消息。

### 3.2 id-only 化 — 【A/B 已决 = (A)，Tadashi qid ae6d33fd 确认】

插件 `mentionPatterns` 全局无 per-group（`server.ts:460-473`）→ 光 requireMention:true，裸词名字仍假
mention 过。**决定走 (A) 插件 fork per-group mentionPatterns**（Tadashi 拍：scope 忠实、roundtable 零
回归、不 over-reach、插件改动小走 FLY-314 双 PR）：

- 转发插件 fork `server.ts`：`GroupPolicy` 加可选 `mentionPatterns?: string[]`；`isMentioned` 调用处
  （`:736`、`:762`）传 `policy.mentionPatterns ?? access.mentionPatterns`。
- 核心 access.json patch：非-CoS lead 的 **core group 设 `mentionPatterns: []`**（id-only）；roundtable
  group 不设 per-group → 用全局 → 名字寻址不回归。
- byte-compat：per-group 字段缺省 → 逐字回退全局（无 per-group 的 access.json 行为不变）。
- 代价：转发插件 fork 第二个 PR（同 FLY-314 flywheel #411 + plugin fork #12 模式），随 batched Tier-3
  重启 reload plugin，不额外加重启面。插件 fork 测试补 per-group 覆盖 case。

> 否掉 (B)（删全局 patterns → 全 fleet @-only）：会把 roundtable 也 @-only，是 Annie 没要求的行为改动，
> 超 898 scope。roundtable 自身的 bare-word 假 mention 风险 → **单独 follow-up**，不塞进 898（保 scope）。

### 3.3 落点 1 — 共享 launcher `claude-lead.sh` 启动幂等 patch（主）

- 扩现有 `LEAD_CORE_CHANNEL` resolver：额外解析**本 lead 的 chatChannel**（loadProjects 里
  `project.leads.find(agentId===LEAD_ID).chatChannel`）→ 得 `LEAD_CHAT_CHANNEL`。
- CoS 判定：`isCoS = (LEAD_CORE_CHANNEL 非空 && LEAD_CHAT_CHANNEL == LEAD_CORE_CHANNEL)`。
- 非-CoS 且 `LEAD_CORE_CHANNEL` 在本 lead access.json groups 里 → 幂等 patch 该 core group
  `requireMention:true`（+ (A) `mentionPatterns:[]`）。CoS / 无 core / core 不在 groups → 不动。
- 复用 access.json seeding 位点（`:2200-2219` 附近），新增调用一个**新脚本**（见 3.4）或内联 node patch。
  必须：原子（temp+rename）、备份、幂等（已是目标态则 no-op、diff 空）、fail-closed、只碰目标字段。

### 3.4 落点 2 — 一次性 fleet apply 脚本（首发立即生效）

新脚本 `packages/teamlead/scripts/apply-core-room-mention-gate.sh`（镜像
`add-roundtable-allowfrom.sh` 的幂等/原子/备份/fail-closed 骨架）：
- 读 `projects.json` → 每个有 `generalChannel` 的项目，算出 CoS + 非-CoS leads。
- 对每个非-CoS Claude lead：定位其 access.json（launcher 约定 `~/.claude/channels/discord-<agentId>/`），
  幂等 patch core group `requireMention:true`（+ (A) `mentionPatterns:[]`）。
- `--dry-run`（打印 diff 不写）、`--project <name>`（限定范围）。跳过 codex lead（其 gate 走 runtime）。
- 幂等验收：连跑两次第二次 diff 为空。

### 3.5 Claude 侧测试

- 新纯函数 `resolveCoreRoomGate` 表驱动测试（各项目形态：多-lead core / 单-lead core-无-CoS / 无 core /
  CoS / codex-CoS）。
- 脚本测试（bash，`add-roundtable-allowfrom.test.sh` 模式）：patch 只改目标 group 的目标字段、其他
  group/字段字节不变、幂等、fail-closed（缺文件/缺 group/坏 JSON）、CoS 不被 patch。
- launcher patch 的单元化（若内联 node，抽成可测函数）。
- 【A】插件 fork：`server.ts` per-group mentionPatterns 的 gate 测试（core `[]`=id-only drop 裸名；
  roundtable 全局名字仍 pass；byte-compat 无 per-group=用全局）。

---

## 4. 提示词（文档 + backstop，非强制主力）

`cross-dept-channel-rules.md`（或新增短段 / 各 identity.md 引用的 core-room 段）补一句：
「core room 现由**服务端**强制 mention 纪律 —— 非-CoS lead 只在被真 @/回本人消息时收到消息；无-@
只有 CoS 回。」明确『真 @』而非裸名。作为文档一致性 + belt-and-suspenders，真正强制在 gate。范围克制：
不重写 FLY-152 既有措辞，只加 core-room 服务端强制这一句。

---

## 5. 字节兼容矩阵（reverse-compat sentinel 思路）

| 场景 | 期望 |
|---|---|
| 项目无 generalChannel（personal-assistant/belle） | 不 gate，逐字现状 |
| core 有但无 CoS（joycon 单 lead） | fail-open 不 gate |
| CoS 本身（Simba/Triton/mufasa/Asha…） | 零改动，永远听 core |
| 非-core 频道（dept chat / issue thread） | 零改动 |
| roundtable | (A) 零改动；(B) 变 @-only |
| Codex `coreMentionGated` 缺省/off | mention-gate/runtime 逐字现状（79 测绿） |
| 插件 per-group mentionPatterns 缺省 | 用全局，逐字现状 |

kill-switch：Codex 侧信号 off = 旁路；Claude 侧脚本可 `--dry-run` + 备份回滚（改回 requireMention:false）。

---

## 6. Rollout（founder ship-gate hold — 绝不自 ship）

1. 本 session（Path A，全 Opus）：design review 过 → TDD implement 两 surface + 脚本 + [插件 PR] →
   全仓 lint + test 绿。
2. 【A】插件 fork PR + 本 repo PR（双 PR，同 FLY-314）。【B】单 repo PR。
3. QA 真机验足（§7）。
4. **HOLD 在 founder ship-gate**：fleet-wide 行为改动，Annie 早上 review + 点头才上。Tadashi 作 Annie
   executor、verify-approval 通过后随 batched Tier-3 merge + 重启（fleet Claude Lead 重启让 launcher
   patch 生效 + Codex runtime 重启；首发用 fleet apply 脚本立即生效缩小重启依赖）。**绝不自 ship**。

## 7. QA（真机 E2E，独立会话验；gate 项）

在一个真 core room（建议 flywheel core 或 QA 529 Room 镜像），Claude-in-Chrome 观察：
- **无-@ 消息** → 只有 CoS 收+回；其他 lead session **零注入零回**（查 tmux pane：非-CoS lead 根本没
  收到该消息）。
- **@ 某非-CoS lead** → 它收+回。
- **裸名（`刚 Peter 帮我`，无 @）** → Peter **不**收（id-only 生效，不被裸词假 mention 绕过）。
- **回本人消息** → 收。
- **CoS + roundtable 无回归**：CoS 在 core 正常；roundtable (A) 名字寻址仍 work / (B) 需 @。
- 混合 backend：验一个 Codex 非-CoS lead（codex-infra-bot / 测试镜像）同样静默无-@。

## 8. Files touched（预估）

- `packages/teamlead/src/core-room-gate.ts`（新，纯函数 + 测试）
- `packages/teamlead/src/lead-backends/codex/mention-gate.ts`（id-only core-strict）+ 测试
- `packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts`（coreMentionGated 接线）+ 测试
- `packages/teamlead/scripts/claude-lead.sh`（LEAD_CHAT_CHANNEL + 启动 patch）
- `packages/teamlead/scripts/apply-core-room-mention-gate.sh`（新）+ 测试
- `packages/teamlead/lead-rules-base/cross-dept-channel-rules.md`（core-room 服务端强制一句）
- 【A】转发插件 fork `server.ts`（per-group mentionPatterns）+ 测试（**独立 repo PR**）
- 本 doc 文件夹（exploration/research/plan/progress）随分支合入

## 9. Non-Goals

不建中央 inbound Discord router（保 FLY-152 边界）；不动 CoS 在 core 的行为；不动 issue thread / dept
chat / spawn 纪律；不做 LLM 语气判定；(A) 下不动 roundtable。

## 10. Decisions（已定）+ Follow-ups

- **A/B**（Claude id-only 机制）= **(A)**，Tadashi qid ae6d33fd 确认。
- Follow-up（不入 898）：roundtable 自身的 bare-word 假 mention 风险（B 本可顺带根除）→ 单独 issue。
