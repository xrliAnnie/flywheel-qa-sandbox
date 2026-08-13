# FLY-1726 Lead 统一 Identity — 探索

Issue: FLY-1726 (https://linear.app/geoforge3d/issue/FLY-1726/设计议题基础层-lead-统一-identity-身份在-n-处以不同形式表现无单一权威今日三重嵌合体活爆雷标本annie-直令立单)
日期: 2026-08-12
基于: 无(外部参考:origin/flywheel-FLY-1710 分支 engineering/doc/FLY-1710-chat-receipt-ownership/redo-design.md 及其 research.md)

## 1. 问题(Annie 原话 + 活标本)

Annie(2026-08-12 晨,FLY-1708 thread):

> 「感觉 Lead 的 ID 好像它的身份被很多地方用不同的形式去表现出来,没有一个统一的 Identity……那这个东西其实很容易爆雷。」

同日活标本:pid 59595 三重嵌合 adapter——一个进程内同时携带

- `FLYWHEEL_LEAD_ID=flywheel-product-lead`(铸章权威:回执归谁名下)
- `LEAD_ID=flywheel-eng-lead`(从祖先 tmux 环境继承)
- `DISCORD_STATE_DIR=discord-flywheel-eng-lead`(频道声明权威:读 eng 的 access.json)
- 手里还拿着 eng 的 bot token(在场权威:收 eng 频道的 gateway 事件)

三个「身份」互相打架:用 product 名义铸件、拿 eng 的 token、读 eng 的频道清单,产出 33 条错账(FLY-1710 案里 pid 59595 生卒窗内 26 条 + 家族账共 87 条)。**成因不是哪一行代码写错,而是三变量不同源**:一个来自 team 名推导,两个从祖先 tmux server 环境静默继承——系统里没有任何一处断言「这三个必须是同一个 Lead」。

FLY-1710 重做设计(round-9 过评审)已把事故定性钉死:健康路径连续十天零错铸;错误只存在于 8/11 污染 tmux server 繁殖的嵌合 adapter 世系。**病根 = 身份可以从多个独立来源拼装,且拼错了也能活。**

## 2. 病灶的结构本质:一个 Lead ≥ 12 张「脸」,张张自立门户

初步盘点(全景表在 research.md,此处按「谁说了算」分层):

| 层 | 表现形式 | 当前取值来源 |
|---|---|---|
| 权威候选 | registry 行(`~/.flywheel/projects.json` `leads[].agentId`) | 手写配置,16 行 |
| env 面 | `FLYWHEEL_LEAD_ID` / `LEAD_ID` / `DISCORD_STATE_DIR` | 各 launcher 各自拼;可被 tmux 祖先环境污染 |
| Discord 面 | bot token(via `botTokenEnv`)/ bot user id / access.json 路径与 groups | token 看 env 名;bot user id **registry 里 0/16**;state dir 靠命名约定 |
| 消息面 | comm.db `mailbox.to_agent` / `claimed_by` / delivery_id 内嵌名(`question:flywheel-eng-lead:…`) | 写入方自报 |
| 状态面 | lead-lease.db `lead_key`(`<project>-<agentId>` 复合串)/ StateStore `sessions.agent_name` | launcher 拼接 |
| 进程面 | launchd label(`com.flywheel.lead.<project>-<agentId>`)/ tmux window 名 / 私有 socket 路径 / `--agent-id` | provision 脚本拼接 |
| Agent Team 面 | `~/.claude/teams/<agentId>/config.json` 目录名 | 约定 = agentId |
| GitHub 面 | `SHIP_PAT` / 机器账号 | fleet 级共享,与 Lead 无绑定 |

每张脸各自从「某个来源」取值,来源之间没有互证。**同一进程内两张脸属于不同 Lead 时,没有任何机关让它死掉。**

## 3. 设计题与目标不变量

设计题(issue 原文):一个 Lead 的 Identity 应有**单一权威源**(候选 = registry 行),其余全部**派生 + 启动断言**。

目标不变量(草案,plan.md 收敛):

1. **单源**:每个 Lead 的身份事实只在 registry 行声明一次;其余所有面都是该行的**派生视图**,不允许第二处手填。
2. **一次解析**:一个 Lead 进程一生只解析一次 registry 行,产出 immutable 的 canonical identity 对象;launcher→adapter→ingest 全链持同一份。
3. **启动断言(fail-loud)**:任何派生面与 canonical identity 冲突(继承 env、state dir、login 后的 bot user id、lease 归属)→ 进程在产生副作用前退出,绝不静默偏向任何一侧。
4. **不自证**:期望值必须来自 registry(如 `botUserId` 独立登记),禁止从被验对象自身派生期望值(如从 token 解出 bot id 再拿它验 token——恒真)。
5. **不外溢**:raw registry、named secrets、身份 env 不向 child 进程扩散;child 只拿显式 allowlist 的投影(与 FLY-1715 共界)。

## 4. 方案方向(研究后收敛)

- **方向 A(基线,#815 器官的推广)**:registry 行为唯一权威;一个共享 resolver/compiler(#815 的 `discord_identity_resolve()` 已是雏形)把行编译成 canonical identity;各 launcher(claude-lead.sh v2 carrier、codex-lead-runtime、QA slot)统一消费;login 后断言 bot user id;冲突 fail-loud。FLY-1710 重做设计 §6.1 已经把这个接口形状(`CanonicalLeadIdentity`)当作 FLY-1726 的交付合同。
- **方向 B(被 1710 研究否决过的路线,不再走)**:各消费点各自读 env / access.json 再互相校验——1710 研究已证明这是「第二个报警器」而非结构修复;dual-mode(registry|legacy)也已被裁定删除,因为「两套身份权威正是污染可存活的条件」。
- **待研究定夺**:① canonical identity 的 transport(env 投影 vs 文件 vs argv)与最小字段集;② `<project>-<agentId>` 复合键(lease/launchd 已在用)要不要升级为 canonical key,还是 agentId 全局唯一即可;③ mailbox/StateStore 等存量账面(to_agent 等)按什么节奏对齐;④ GitHub 面(SHIP_PAT 共享)是否纳入本单或立后续单。

## 5. Scope 边界

**In**:canonical identity schema;registry 唯一解析 + 全局 uniqueness 校验;secret selector→token 的解引用边界;launcher→adapter 的 immutable 交付方式;login 后 bot user id 断言;身份冲突 fail-loud 合同;身份表现形式全景图(Annie 要的聊天材料)。

**Out(接口对齐但不实现)**:频道归属表与铸权 gate(FLY-1710 已下线并入本单参考料,其 ChannelAuthority 编译由同一 compiler 产出,但 ingest/outbound enforcement 是实现批次的事);adapter 增殖普查与 spawn sanitation(FLY-1715);销账游标(FLY-1725,消费「身份+游标」键);生产 ACL / token rotation / 杀进程(运维 follow-up)。

**依赖关系**:本单是 FLY-1710 重做与 FLY-1725 的地基——「归属给谁」先要「谁是谁」有唯一答案;「身份+游标」的销账键前提是身份可靠。

## 6. 接续纪律的落实

- FLY-1710 redo-design 已通读;其 §3.1(CanonicalLeadIdentity 形状 + botUserId 禁 token 派生)、§6.1(FLY-1726 owns 清单)、§7.1(#815 保留器官清单)直接作为本设计的输入合同。
- #815 代码冻结不 ship;本单 design 只回收其器官思想(`discord_identity_resolve()` 的单点派生 + 断言),实现按本单自己的 plan 重新裁。
