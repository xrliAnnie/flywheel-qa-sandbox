# FLY-944 shared 频道 lead-to-lead @-mention 不触发 — 调研

Issue: FLY-944 (https://linear.app/geoforge3d/issue/FLY-944/bugrouting-shared-频道-reply-gating-漏掉-lead-to-lead-mention-只有-founder)
日期: 2026-07-06
基于: exploration.md

---

## 1. 入站门链事实(代码位点,逐条已核)

插件 fork 运行时源:~/.flywheel/repos/claude-plugins-official/external_plugins/discord/server.ts
(claude-lead.sh 启动 preflight 保证 marketplace/cache 与 fork 同步)。

| 门 | 位点 | 语义 | 对本案 |
|---|---|---|---|
| 0 self-skip | server.ts:1442 | 自己的消息忽略 | 通过 |
| 1 intake bot 过滤 | server.ts:1443-1446 | bot 作者必须在顶层 allowBots | 通过(FLY-282 mesh 健康,HL/Tadashi 互在) |
| 2 group 存在 | server.ts:718-721(thread 归父频道) | groups 没有该频道 → drop | 通过 |
| 3 **allowFrom** | server.ts:722-726 | **group.allowFrom 非空且 sender 不在 → drop,先于 mention 判定** | ★ 真根因,HL/Tadashi/anna 被丢 |
| 4a roundtable topic-thread | server.ts:732-771 → roundtable-thread-policy.ts decideTopicThreadHandling | member 走 budget;非-member bot 显式 @ → handle | 健康(bot 真 @ 放行) |
| 4b requireMention | server.ts:781-790 → isMentioned(:793) | 真 <@id> mention 对任何作者生效;名字 regex 走 per-group/global patterns | 健康 |

**热生效关键事实**:gate() 每条消息 fresh `loadAccess()`(server.ts:674、1444)→
**access.json 的修改即时生效,无需重启任何 Lead**。requireMention/mentionPatterns/allowFrom
同理。(Lead 重启只影响"启动位点自愈是否跑过",不影响已 patch 的文件。)

## 2. 现有可复用机制(本修复全部搭现成积木)

### 2.1 FLY-898 apply 位点(承载本修复的宿主)

- `packages/teamlead/scripts/apply-core-room-mention-gate.sh`(264 行):幂等 patch 单个
  access.json 的 core group(requireMention:true;preflight 通过时 + mentionPatterns:[])。
  已具备:原子写(temp+rename)、备份、乐观并发 rebase(cksum 变化检测 5 次重试,因插件
  也写此文件)、坏 JSON fail-closed、缺 group no-op、--dry-run、fleet 模式。
- fleet 模式经 `core-room-gate-cli.js --all`(`src/core-room-gate-cli.ts`,126 行)吐
  JSONL:每行 {projectName, leadId, coreChannelId, backend, gateNonCoS…},由
  `resolveCoreRoomGate`(`src/core-room-gate.ts`,纯函数,FLY-898)从 projects.json 判定。
  当前 --all **只枚举 gated 非-CoS lead**;CoS 与 roundtable 不在其输出里(扩展点,见 §4)。
- 启动位点:`claude-lead.sh:2266-2290` —— FLY-282 access.json seeding 之后、supervisor
  循环之前,best-effort(`|| true`,provisioning 失败不 abort Lead 启动)。

### 2.2 FLY-282 roundtable-allowbots(同模式先例)

`claude-lead.sh:2241-2262` 调 `roundtable-allowbots-cli`,registry 目录
~/.flywheel/roundtable-registry/(16 个 lead 的 botUserId 已注册)。证明"启动自愈 +
幂等 union/patch"模式在生产已稳定运行。**其 2026-06 的修复注释已明确指出 allowFrom 仍会
gate reply —— 本 issue 正是那颗当时没拆的雷。**

### 2.3 数据源

- core channel per project:~/.flywheel/projects.json 的 `generalChannel`(FLY-173),
  claude-lead.sh 启动时已解析(LEAD_CORE_CHANNEL);core-room-gate-cli 同源。
- roundtable channel:~/.flywheel/roundtable.json(`{"channelId":"1512578695468941333"}`,
  FLY-569 共享非密默认)+ env FLYWHEEL_ROUNDTABLE_CHANNEL_ID(env 优先)。
- 每 lead access.json:~/.claude/channels/discord-<leadId>/access.json
  (DISCORD_STATE_DIR,GEO-246)。

## 3. Codex 侧核验(预期零改动 → 已证实)

- `CodexDiscordGateway.ts` / `codex-lead-tui-runtime.ts` 入站**没有 allowFrom/allowBots
  概念**(grep 零命中)——sender 过滤不存在,不可能复现本 bug。
- `mention-gate.ts`:`hasExactMentionToken`(mentions 数组 / <@id> token)对 bot 作者
  生效;`isIdMentioned`(FLY-898 core 严格版:真 @ 或 reply-to-self)同样作者无关。
  FLY-220 的 bot 限制只作用于**裸名字 regex**(③),不影响真 @。
- 结论:Codex lead 收 bot 真 @ 本来就通。本修复 **Codex 侧零代码改动**。
- 备注:`~/.claude/channels/discord-mufasa-lead/access.json` 是 Mufasa companion-Claude
  时代遗留文件,现 runtime(Codex full-access,FLY-350)不读它;normalize 顺手覆盖无害。

## 4. 修复的精确落点(方案 A 的工程分解)

### 4.1 要 normalize 的目标态

| 目标 group | requireMention | mentionPatterns | allowFrom |
|---|---|---|---|
| 非-CoS lead 的 core group | true(FLY-898,已有) | [](id-only,preflight-gated,已有) | **[](本 fix 新增)** |
| CoS 的 core group | false 不动(CoS 听全,FLY-898 语义) | 不动 | **[](本 fix 新增 —— Cass 听不见 HL 就是它)** |
| 每个 lead 的 roundtable group | true 不动 | 不动(global 名字 patterns 保留) | **[](本 fix 新增 —— Belle/Mufasa 遗留病)** |
| 其他一切 group(lead 自己的 chatChannel、issue thread 等) | 不动 | 不动 | **不动** |
| 顶层 allowFrom(DM 配对)/ dmPolicy / allowBots | —— | —— | **不动** |

### 4.2 实现形态(两个候选,plan 里择一)

**候选 ①(推荐):扩展 apply-core-room-mention-gate.sh 本体**
- apply_one() 的 jq transform 追加 `.groups[$ch].allowFrom = []`;
- 新增 `--allowfrom-only` 模式(只清 allowFrom、不动 requireMention)服务 CoS-core 与
  roundtable 两类目标;
- fleet 模式:core-room-gate-cli 增一个 `--all-shared` 输出(每 lead 一行:coreChannelId、
  isCoS、含 roundtable id),脚本据此对三类目标分别 apply;
- claude-lead.sh 启动位点在现有调用旁补两行(CoS-core / roundtable 的 --allowfrom-only)。
- 优点:并发 rebase/备份/幂等/preflight 全复用同一份实现,单文件单真相;
- 缺点:脚本名义从"mention gate"扩为"shared-channel 纪律 normalize"(改 header 注释即可)。

**候选 ②:新 sibling 脚本 normalize-shared-channel-allowfrom.sh**
- 职责单一,但要复制一整套原子写/乐观 rebase/幂等骨架(~120 行重复),两个脚本并发写同
  一文件(rebase 能扛但无谓);且 claude-lead.sh 要多一个调用块。
- **否**:重复代码 > 语义洁癖收益,违背 enforce-simplicity。

### 4.3 存量清扫与生效方式

- 一次性:`apply-core-room-mention-gate.sh --all`(扩展后)清全 fleet 存量 —— 因 §1 的
  热生效事实,**跑完即生效,零 Lead/Bridge 重启**(Tadashi 的 requireMention flip 同时补上)。
- 防漂移:每次 Lead 启动的现有位点自愈(新 lead 上岗、文件回退、手工误改都会被拉回目标态)。
- 回滚:脚本自带时间戳 .bak;`--dry-run` 先演练。

## 5. 风险与边界

| 风险 | 判定 |
|---|---|
| 清 allowFrom 是否放宽安全边界 | 否:bot 仍被 intake allowBots(自愈白名单)挡;人 = Annie 私有 server 的 guild 成员。allowFrom 在 shared 频道从未是安全边界,只是(错误的)纪律工具 |
| Tadashi flip 到 requireMention:true 后行为收紧 | founder 在 core 无 @ 消息将只有 CoS 回 —— FLY-898 Annie 自定语义;需在 ship 通报里向 Annie 显式点名这个变化(brainstorm gate 已确认) |
| pile-on(清 allowFrom 后 bot 消息互刷) | 否:非-CoS core = id-only mention 纪律;roundtable = requireMention + FLY-314 budget(≤12/thread,人类消息才重置);FLY-220 名字-regex bot 限制在 Codex 侧、插件侧真 @ 才过 id-only 门 |
| 并发写 access.json(插件 saveAccess vs 脚本) | 已有乐观 rebase 5 重试(FLY-898 实现,沿用) |
| Belle 等 token-isolated companion lead 不走 claude-lead.sh | fleet --all 模式按 channels 目录/CLI 枚举覆盖存量;启动自愈对其不生效 → 依赖 fleet sweep + 文档记录(Belle launcher 后续统一是既有 follow-up) |
| anna(external-locked)变得可被 lead @ 触发 | 她的 core group allowFrom 本来就是 [] —— 本 fix 不改变其现状,非本 issue 范围 |

## 6. 验收口径(QA 阶段执行)

1. **真机 N-to-N(核心)**:HL ↔ Tadashi 在 #flywheel-core 与 #leads-roundtable 双向真 @,
   双方 session 都收到并回复(复刻当晚 FSM 场景);
2. 纪律保留:core 无 @ 消息只有 CoS 反应;roundtable 无 @ 消息不触发无关 lead;
3. 回归:founder @ / founder 无 @(核对 FLY-898 语义)、Cass 在 core 听见 HL、
   Belle 在 roundtable 被新 lead @ 能触发;
4. 幂等:normalize 重跑 diff 为空;非目标 group 字节不变(reverse-compat 断言)。
