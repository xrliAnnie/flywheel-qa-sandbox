# FLY-1726 Lead 统一 Identity — 调研(身份表现形式全景图)

Issue: FLY-1726 (https://linear.app/geoforge3d/issue/FLY-1726/设计议题基础层-lead-统一-identity-身份在-n-处以不同形式表现无单一权威今日三重嵌合体活爆雷标本annie-直令立单)
日期: 2026-08-12
基于: exploration.md

## 0. 审计方法与口径

- 5 路并行代码审计(env / registry / DB / 进程面 / Discord+GitHub),全部落到 file:line;另做生产只读实测(projects.json 16 行、comm.db to_agent 实际取值、lead-lease.db 键形态、launchd label 清单)。
- 参考料:FLY-1710 redo-design.md(round-9 过评审)与其 research.md;#815 冻结代码只读。
- 本文所有「现状」以 main `4f246f52` 为准。

## 1. 结论先行

1. **身份的值空间其实是统一的**——几乎所有面最终都源于 `~/.flywheel/projects.json` 的 `leads[].agentId`(+ `projectName`)。爆雷不在「值从哪来」,而在**「值怎么到达每个消费点」:三类到达方式(argv/manifest 新鲜值、`-e`/allowlist 注入、环境继承)有三种寿命,继承路径可以带着别的 Lead 的旧值存活**。
2. **嵌合体在今天的 main 上仍可结构性复现**:共享 cmux tmux server 的 global env 冻结着第一个启动 shell 的变量;Runner 开窗(`TmuxAdapter.ts:503,510`)只用 `-e` 覆写 `FLYWHEEL_*` 前缀名,**不清除裸 `LEAD_ID` / `DISCORD_STATE_DIR`**——于是 `FLYWHEEL_LEAD_ID`(新鲜)× `LEAD_ID`(继承)× `DISCORD_STATE_DIR`(继承)三权分立,pid 59595 就是这么拼出来的。
3. **系统里没有任何一处「login 后断言 bot 身份」**:registry 行今天没有 `botUserId` 字段(0/16);运行时 bot id 是登录后 `/users/@me` 自报再发布(`roundtable-allowbots.ts:292-316`)——只发布、不断言,且属于 FLY-1710 明令禁止的「自证」形态。
4. **存在三条静默错身份 fallback 链**(Lead 拿错 bot 也能继续说话):`ProjectConfig.ts:328-331`(botTokenEnv 解析失败→warn 后回落全局 `DISCORD_BOT_TOKEN`)、`bridge/tools.ts:484,619,832`(`leadCfg?.botToken ?? globalBotToken`)、`bridge/lead-inbox-runtime.ts:607`(`lead.botToken ?? process.env.DISCORD_BOT_TOKEN`)。
5. **DB 面全部是无外键的裸字符串**,且有四个「坏 sentinel」写入形态在野:`"lead"`(flywheel-comm CLI 默认,`index.ts:383`)、`"unknown"`(`plugin.ts:4861` fallback)、`"unassigned"`(`runs-route.ts:1583`)、`"product-lead"`(`config.ts:138` 配置默认)。
6. **好消息:进程面已有一条干净的身份主脊**(projects.json → manifest → launchd label → wrapper-v2 → hash 派生私有 socket → lease bind),多数消费者是「重派生再比对」而非「解析名字反推」;可直接复用的器官不少(§7)。

## 2. 全景总表:一个 Lead 的身份表现形式

「形态」列:**A** = 裸 agentId(如 `flywheel-eng-lead`);**K** = dash 复合键 `<project>-<agentId>`;**S** = slash 键 `<project>/<agentId>`(仅用于 socket hash);**D** = Discord snowflake;**其他**如注。

### 2.1 权威/配置层

| # | 表现形式 | 形态 | 位置 | 取值来源 | 断言现状 |
|---|---|---|---|---|---|
| 1 | registry 行 `leads[].agentId` | A | `~/.flywheel/projects.json`;唯一解析器 `ProjectConfig.ts:286-353`,校验 `parseAndValidateProjects`(:384-945) | 手写/fleet 引擎写入 | 全局 exact-key 唯一(:601-623);grammar `^[A-Za-z0-9][A-Za-z0-9._-]*$` |
| 2 | `FLYWHEEL_PROJECTS` env 整体覆盖 | JSON | `ProjectConfig.ts:289-292` | 调用方 | `flywheel-fleet.sh:83` 见到即硬死;其余进程无防护 |
| 3 | per-Lead manifest | K(文件名)+A(字段) | `~/.flywheel/manifests/<project>-<agentId>.json`(`materialize-lead-manifests.sh:76`) | projects.json 物化 | wrapper 回查 projects.json 恰一行(`flywheel-lead-wrapper-v2.sh:94-101`) |
| 4 | launchd label | K | `com.flywheel.lead.<project>-<agentId>`(`flywheel-daemon.sh:47,106`) | manifest 文件名 | 重启链验 label==manifest==registry(`lead-restart-lifecycle.sh:526-566`) |
| 5 | Agent Team 目录/`--agent-id` | `<name>@<team>`,Lead=`<agentId>@<agentId>`,Runner=`runner-<exec8>@<agentId>` | `~/.claude/teams/<team>/config.json`;唯一派生源 `path-helpers.ts:163-168` | leadId | 无与 registry 的对账;FLY-208 黑洞即此面失和 |
| 6 | 身份规则/persona 文件 | A | `~/.claude/agents/<agentId>.md`、`<projectRoot>/.lead/<agentId>/identity.md`(`claude-lead.sh:749-786`) | 约定 | 无同步机制 |

### 2.2 env 层(进程内身份)

| # | 变量 | 语义 | 设值方 | 消费方(决定什么) | 已知病灶 |
|---|---|---|---|---|---|
| 7 | `FLYWHEEL_LEAD_ID` | Lead 进程=「我是谁」;Runner 进程=「我的 owner 是谁」(**一名两义**,FLY-1571) | `claude-lead.sh:1162,1618`;wrapper-v2 `:205`(server env);Runner 窗 `TmuxAdapter.ts:510`;Codex launcher 硬编码 | terminal-mcp/inbox-mcp 的会话范围;flywheel-comm `ack` 默认身份;lease `claimed_lead_mismatch` 对账(`lead-lease.ts:2586`);Codex runtime 必填 | Bridge 三处 seam 需主动 `delete` 自己继承的值(`write-gate-response.ts:201` 等)——继承污染已被代码承认 |
| 8 | `LEAD_ID`(裸名) | launcher 内部主变量,同时导出进 pane;lead-rules 文档教模型用 `$LEAD_ID` 调 Bridge API | `claude-lead.sh:115`(argv)、`:1617`(pane 覆写) | launcher 全部 per-Lead 派生(state dir/`--agent`/规则束/mailbox teamName) | **裸名在祖先 shell/tmux server env 存活率最高**;Runner 窗不覆写→事故直接成因 |
| 9 | `DISCORD_STATE_DIR` | 指向该 Lead 的 Discord 身份目录 | `claude-lead.sh:183` **`${DISCORD_STATE_DIR:-derive}` 继承优先**;wrapper-v2 `:221` manifest 优先 | Discord plugin(token/access.json/spool 全由它定);roundtable reconcile;mention gate | 三个竞争权威(继承>manifest>派生);继承赢=事故 |
| 10 | `PROJECT_NAME`/`FLYWHEEL_PROJECT_NAME` | 身份的 project 半边 | `claude-lead.sh:1626-1627`;Runner 窗 `TmuxAdapter.ts:503`;Codex 硬编码 | comm.db 分片路径、token/告警定位 | FLY-60 同类继承污染史 |
| 11 | `FLYWHEEL_LEAD_ROLE` / `FLYWHEEL_LEAD_COMPANION` / `FLYWHEEL_LEAD_EXTERNAL` | 角色面 | QA slot manifest;`claude-lead.sh:1679,1686`(由 registry 查得,非 env 派生) | 规则束选择(cos vs dept);enforcer 豁免 | 错值=整套行为合同翻转 |
| 12 | lease/carrier 证明族:`FLYWHEEL_LEAD_LEASE_KEY`/`FLYWHEEL_LEAD_GENERATION`/`FLYWHEEL_LEAD_CARRIER*` | 身份**证明**(非名字) | `claude-lead.sh:1666-1672`;wrapper-v2 `:206-211` | `validateLeadWriteAuthorization`(`lead-lease.ts:2436-2602`) | 已是 fail-closed 设计;`FLYWHEEL_LEAD_LEASE_BYPASS` 为运维逃生口 |
| 13 | `FLYWHEEL_CODEX_LEAD_ID`/`_PROJECT` | Codex 面(**零读者,死面**) | `codex-lead.sh:84-89` | 无 | 导出即忘;`_STATE_DIR` 有读者(thread-id 记忆) |

### 2.3 进程/OS 层

| # | 表现形式 | 形态 | 生成 | 断言现状 |
|---|---|---|---|---|
| 14 | 私有 tmux socket | S→hash:`~/.flywheel/sock/fw-<prefix20>-<sha16>.sock` | `lead-address.sh:6-43` / `lead-address.ts:35-59`(字节一致双胞胎) | 消费者必须重派生比对(`fleet-data.ts:331-336`,`flywheel-cmux-sync.sh:709-717`)——**不可逆 hash 逼出正确姿势** |
| 15 | tmux session/window/pane(Lead) | 刻意去身份:`main`/`main`/`%0` | `flywheel-lead-wrapper-v2.sh:247` | 身份在 socket+manifest,不在名字 ✅ |
| 16 | cmux workspace/tab 标题 | K | `flywheel-cmux-sync.sh:669-724` | ⚠️ `title→launchd label` 反推(`:8054`),有 round-trip 校验但入口是渲染标题 |
| 17 | Runner 窗名 vs 窗身份 | 名=`<LinearId>-<runner>-<title>`;身份=tmux user option `@flywheel_exec_id` | `tmux-naming.ts:36-42`;`TmuxAdapter.ts:1415` | 名是展示、option 是身份 ✅;但仍有标题 regex 分类器(`flywheel-cmux-sync.sh:1442`) |
| 18 | lease 行 | K(`lead_lease.lead_key`)+A(`lead_id`) | `flywheel-comm lead-lease acquire`(FLY-1697 preflight) | key 回读必须 echo-back 一致;generation 单调;**pair(lead_key↔lead_id)本身无一致性约束** |
| 19 | ps 表反查 | argv `--agent <leadId>` | `lead-identity-preflight.sh:304-352`(锚定 claude 可执行名) | 谨慎收敛的反查,存量两处(另:`cmux-mutator-process-census.sh`) |
| 20 | Codex bespoke 载体 | launcher 文件名嵌 Lead 名 + 硬编码 env + `CODEX_HOME=~/.codex-<name>` + `thread-id` 文件 | `run-codex-lead-mufasa-tui-fullaccess.sh:51-66` | 与 registry 行靠人肉一致(companion-lead-ship-discipline) |

### 2.4 消息/状态 DB 层(全部裸字符串、无外键)

| # | 表.列 | 形态 | 写入源 | 关键消费 | 危险点 |
|---|---|---|---|---|---|
| 21 | comm.db `sessions.lead_id` | A(可空) | Runner spawn ctx.leadId;CLI `--lead` ?? env ?? **`"lead"`** | `wake.ts:87-93` 派生 runner 邮箱路径 | **错值=wake 黑洞**(投进不存在的 inbox) |
| 22 | comm.db `mailbox.to_agent`/`from_agent` | A / `runner-<exec8>` / `bridge` / 自由文本 | Bridge 事件生产、chat-ingest `--lead`、CLI `--from` | Bridge `LeadInboxLoop` 按 `to_agent==lead.agentId` 认领 | 无人认领的 to_agent 滞留→dead-letter;`"unknown"` fallback 在野 |
| 23 | comm.db `mailbox.claimed_by` | 投递循环 lease epoch(**非 Lead 名**;生产实测多为 execution UUID/`legacy-push`) | `claimLeadBatch` | lease 复核/ack | 工具侧误读成 Lead 名的风险 |
| 24 | comm.db `mailbox.sender_ref` | JSON 内嵌 K(lease_key)+generation+pid | `validateLeadWriteAuthorization` 产出 | 溯源投影 | leadId↔leadKey 翻译唯一落点 |
| 25 | teamlead.db `lead_events.lead_id`(+ack HMAC 绑定) | A | Bridge 路由(fallback 链:`cos ?? leads[0] ?? "unknown"`) | 去重键+投递 id+ack token 全部内嵌 leadId | **改名=在飞 ack 全作废**;`"unknown"` 行不可投递 |
| 26 | teamlead.db `alert_threads.lead_id`(correlation_key 内嵌) / `chat_threads.lead_id` / `detection_escalations.owner_lead_id` / `workflow_run.selected_by` 等 | A | 各写入方 | `configuredLead`(`plugin.ts:654`)是唯一读侧守卫样板 | owner 错/空=升级页直达 founder;selected_by 有 `"unassigned"` sentinel |
| 27 | claims.db `alert_claims.lead_id` + event_id 派生含 lead | A | TS claimer + `lead-alert.sh --lead`(shell 侧有 projects.json 校验 `:275-301`) | 告警去重 | TS/shell 两个写入方必须同式派生 event_id |
| 28 | audit.db `founder_consent_audit.lead_id` | A(**caller 自报,故意不验**) | HTTP body / CLI `--from` | Track-3 校准语料 | 自由文本漂移只污染校准,不阻断运行 |
| 29 | StateStore(teamlead.db)`sessions` | **无 lead_id 列**(issue 清单勘误);`agent_name`=Runner 角色名 | — | — | Runner→Lead 链只在 comm.db `sessions.lead_id` |
| 30 | Codex 后端 per-Lead DB(outbox/lifecycle_requests) | A | runtime env `FLYWHEEL_LEAD_ID` | 出站归属、lifecycle consent 绑定 | per-Lead 文件路径本身就是 scope |

### 2.5 Discord / GitHub 层

| # | 表现形式 | 形态 | 现状 | 危险点 |
|---|---|---|---|---|
| 31 | bot token | 具名 env(`TADASHI_BOT_TOKEN`…)→泛名 `DISCORD_BOT_TOKEN` 投影 | registry 只存 selector(`botTokenEnv` 16/16);值在共享 `~/.flywheel/.env` | 泛名投影经 tmux 祖先可继承;**三条静默 fallback 链**(§1.4) |
| 32 | bot user id | D | **registry 0/16**;运行时 `/users/@me` 自报→发布进 `~/.flywheel/roundtable-registry/`;Codex 面用 env `FLYWHEEL_LEAD_BOT_USER_ID`(信 env 不验 login);`voice-routes.ts:126` 还有 token 解码派生 | **全系统无 login 断言**;发布≠断言;token 解码=自证 |
| 33 | Discord state dir + access.json | 目录名 `discord-<agentId>`;access.json 内**无 leadId 字段**,纯靠目录名归属 | `claude-lead.sh:183` 派生(继承优先);内含 token .env(legacy)、groups、allowBots、spool | 生产有 20+ 目录含非 registry 名(`discord-peter`/`discord-belle`…),FLY-1710 §9.1 已列退休审计 |
| 34 | 频道归属 | 分散在 `chatChannel`/`alertChannel`/`generalChannel`/fleet 级 env `FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS`/roundtable.json/各 access.json groups | 无单表;CoS 判定靠结构等式 `chatChannel===generalChannel`(`core-room-gate.ts:49`) | 两个 Lead 同 listing 一个频道无任何阻止——FLY-1710 ChannelAuthority 即为此而设 |
| 35 | GitHub | 全舰 2 个身份:host gh login(xrliAnnie, admin)+ CI `SHIP_PAT` | `ship-on-comment.yml:155-161`;无 per-Lead 机器账号 | Lead 面无归属可言;属 founder 级信任决策,本单只记边界 |

## 3. 三种键形态与坏 sentinel

- **裸 A**(`flywheel-eng-lead`):env、DB、Discord dir、Agent Team、persona——绝大多数面。依赖 agentId **跨项目全局唯一**(grammar 校验已有;`discord-<agentId>` 无 project 前缀更是硬依赖)。
- **K**(`flywheel-flywheel-eng-lead`):manifest 文件名、launchd label、lease key、fleet console key、cmux 标题。dash 连接有歧义(`a-b`+`c` ≡ `a`+`b-c`),靠全局 exact-key 唯一校验兜住。
- **S→hash**(socket):不可逆,消费者被迫重派生比对——全景里最健康的形态。
- **坏 sentinel 在野**:`"lead"`、`"unknown"`、`"unassigned"`、`"product-lead"`(config 默认)+ `flywheel-restart-guard.py:337` 兜底 `"flywheel-eng-lead"`。每一个都是「身份缺失时静默编一个」的形态。

## 4. 嵌合体结构性复现机制(事故力学)

```
共享 cmux tmux server 诞生时冻结 global env(含某 Lead 或 Annie shell 的 LEAD_ID / DISCORD_STATE_DIR / DISCORD_BOT_TOKEN)
  → Runner 开窗只 -e 覆写 FLYWHEEL_* 前缀(TmuxAdapter.ts:503,510)
  → 裸名旧值原样进入新进程
  → 进程内:FLYWHEEL_LEAD_ID(新鲜,来自 dispatch)× LEAD_ID(继承)× DISCORD_STATE_DIR(继承)
  → 该进程若加载 Discord adapter:铸章=A、频道声明=B、在场=B 的 token
  → 无任何一处断言三者同 Lead → 嵌合体带病存活、跨代繁殖
```

`claude-lead.sh` 自己的 pane 路径是唯一强制三面同源的地方(`:1570-1579` 注释 + `-e` 全量覆写 + `env -i` 起 child);Runner 窗和非 launcher 进程只对齐 `FLYWHEEL_*` 子集。

## 5. 断言现状盘点(有什么/缺什么)

**已有(可复用的骨架)**:
- lease preflight(FLY-1697):`lead_identity_v2_acquire_bind`,key echo-back + generation 单调 + PID/lstart 绑定,HOLD 分类告警。
- 写边界:`validateLeadWriteAuthorization`(claimed vs env vs lease store,mismatch 拒绝)。
- socket 重派生比对(三处消费者)。
- 重启链 label==manifest==registry 三方对账。
- fleet console 三轴 drift 检测(configured/carrier/observed → ONLINE/DRIFT/CONFLICT/EXTERNAL)。
- Bridge 三处 seam 主动 `delete` 自身继承身份 env。

**缺(gap → design 输入)**:
- G1 **launch 时 env 一致性断言**:无人检查 `LEAD_ID`==`FLYWHEEL_LEAD_ID`==manifest leadId、`DISCORD_STATE_DIR` 是否属于本 Lead。
- G2 **login 后 bot id 断言**:全系统不存在;registry 无 `botUserId` 字段可断言(0/16)。
- G3 **spawn 边界身份卫生**:Runner 窗不清裸名旧值(TmuxAdapter);`~/.flywheel/.env` `set -a` 面无身份键防御(只有 token/carrier 两族被主动防)。
- G4 **静默 fallback**:三条错 token 链 + 五个坏 sentinel,身份缺失全部静默补,不 fail-loud。
- G5 **派生规则单点化**:state dir 派生写了两处(claude-lead.sh / wrapper-v2)且优先级不同;#815 又写了第三处(bash);Codex launcher 全手抄。无「一个 resolver,其余全消费」。
- G6 **manifest launchEnvironment 冻结**:错误身份值一旦进 manifest,永续复制(`flywheel-daemon.sh:339-372`)。
- G7 **Agent Team 面无对账**:`teams/<team>/config.json` 与 registry 无校验(FLY-208 黑洞根因面)。

## 6. FLY-1710 已裁定、本单继承的合同

- `CanonicalLeadIdentity = {leadId, projectName, botUserId, botTokenEnv, discordStateDir}` 接口形状(1710 §3.1);一次 registry compile 同时产出 identity 与 ChannelAuthority 两个只读对象。
- `botUserId` 必须 registry 独立登记;禁止 token 解码 / `/users/@me` 运行时 fallback(自证恒真);缺失 fail-loud。
- 不做长期 dual mode(`registry|legacy` 已裁死);不复制临时实现。
- FLY-1726 owns(1710 §6.1 原文):canonical identity schema;registry 行唯一解析与全局 uniqueness validation;secret selector→token 的父进程解引用边界;launcher 向 adapter 交付 immutable identity 的方式;login 后 bot user id assertion;identity conflict 的 fail-loud 错误合同。
- #815 处分清单「独立保留」器官(1710 §7.1):registry 唯一性校验/同源派生/login 断言/inherited conflict fail-loud/thread parent 传播/parity fixtures/ingest spool 再授权——设计吸收,代码重裁。

## 7. 可复用器官清单(实现时的落点)

| 器官 | 位置 | 在新设计中的角色 |
|---|---|---|
| `parseAndValidateProjects`(唯一校验权威) | `ProjectConfig.ts:384-945` | registry 校验扩展点(botUserId 唯一性等) |
| `resolveCanonicalLead` / `readCanonicalLeadCatalog` | `flywheel-comm/src/canonical-lead.ts:108-174` | leadId→leadKey 唯一映射器,resolver 底座候选 |
| `deriveRunnerMailboxIdentity` | `agent-team-transport/src/path-helpers.ts:163-168` | Runner 邮箱身份唯一派生源(保持) |
| `validateLeadWriteAuthorization` | `lead-lease.ts:2436-2602` | 写边界断言(保持,消费 canonical identity) |
| lease preflight | `lead-identity-preflight.sh` | 启动断言序列的挂载点 |
| `discord_identity_resolve()`(#815,冻结) | `flywheel-FLY-1710:scripts/lib/discord-identity.sh` | 单点派生+断言的形状参考;bash 实现不复用(避免双权威) |
| `validate-projects` CLI 模式 | `bin/validate-projects.ts` | 「TS 单实现 + shell 经 CLI 消费」的先例 |
| fleet console 三轴 drift | `fleet-data.ts:62-100` | 身份失和的观测面(扩展 identity 维度) |

## 8. 勘误(相对 issue 起点清单)

- `teamlead.db sessions.lead_id` 不存在;Runner→Lead 链在 **comm.db** `sessions.lead_id`。
- registry 行今天**没有** `botUserId`/`discordStateDir`/`channels` 字段(它们是 #815 冻结新增);今天 bot id 只活在 roundtable-registry(自报发布)。
- `mailbox.claimed_by` 不是 Lead 名,是投递 lease epoch;`three_stage_turn.holder_exec_id` 是 Runner execution id。
