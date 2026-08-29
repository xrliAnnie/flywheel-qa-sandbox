# FLY-880 Honey Lemon(Flywheel 产品 Lead)部署物料清单 — 草稿

Issue: FLY-880 (https://linear.app/geoforge3d/issue/FLY-880/pmbuild-建对内-pm-agent-协作式产品思考者互动模型-pm-skills-prd-输出按-fly-679-设计)
日期: 2026-07-05
基于: qa-report.md(role .md 本体 QA PASS,作为 Honey Lemon 的互动模型大脑保留)、Tadashi lead-instruction fba88b2e(880 定位定案:独立产品 Lead)+ 78640649(定名 Honey Lemon)+ 后续 ask 回复(2026-07-05,Tadashi 跟 Annie 定的大框方向,细节等 token 到位 continuation 最终确认)

> **状态:草稿,非实施**。按 Tadashi 指令"今晚若有余力可以把部署物料清单按 Honey Lemon 名字备成草稿 commit 到分支",这是**清单/骨架**,不是可执行的最终产物——前置条件(Annie 建 bot token,可能连 token 池一起)到位后,由 Tadashi 安排 continuation 正式实现。以下所有"建议值"在最终实现前都需要 Tadashi/Annie 确认,不是已拍板的事实。

## 0. 部署顺序总览

沿用现有两个 Flywheel-project Lead(Tadashi=`flywheel-eng-lead`、Aunt Cass=`flywheel-cos-lead`)完全一致的部署路径,Honey Lemon 是这条路径的第三个实例,**不需要新工具/新脚本**:

```
~/.flywheel/projects.json 加 leads[] 第三项
        ↓
{projectRoot}/.lead/{agentId}/identity.md(persona)
        ↓
~/.claude/channels/discord-{agentId}/ (access.json + .env)
        ↓
claude-lead.sh 手动跑一次(生成 manifest)→ flywheel-daemon.sh install(生成 + 装载 plist)
        ↓
第 9 步验证清单(tmux ctx 增长 / 只有自己频道回话 / 无串台)
```

launchd plist、launcher 脚本(`flywheel-lead-wrapper.sh`)、manifest JSON 都是**自动生成/复用现有共享脚本**,不需要手写——下面只列需要人工准备的 4 类物料。

## 1. Persona 骨架 — `.lead/flywheel-product-lead/identity.md`(agentId 待确认)

位置约定:`<projectRoot>/.lead/<agentId>/identity.md`(项目仓库内,随分支/PR 走,不在 `~/.flywheel`)。对 Honey Lemon 即 `/Users/xiaorongli/Dev/flywheel/.lead/{agentId}/identity.md`。

**agentId 建议值**:`flywheel-product-lead`(与 `flywheel-eng-lead` 对称命名);最终名字由 Tadashi/Annie 定。

骨架(照抄 Tadashi `.lead/flywheel-eng-lead/identity.md` 的 frontmatter 形态,`department-lead-rules.md` 等共享行为 `claude-lead.sh` 会自动 append,identity.md 只需写这个 Lead 独有的部分):

```markdown
---
name: flywheel-product-lead   # 建议值,待定
description: Flywheel Product Lead (Honey Lemon) — 对内 PM,协作式产品思考者,跟 Annie 一起把方向磨成 PRD 和 build issue,通过 Discord 沟通
model: opus                    # 沿用 Tadashi/Cass 惯例(claude-opus-4-8[1m]),待 Annie/Tadashi 定
memory: user
disallowedTools: Write, Edit, MultiEdit, Agent, NotebookEdit   # 沿用:Lead 是管理者不是实现者,不碰代码
permissionMode: bypassPermissions
---

# Flywheel Product Lead

**你是 Honey Lemon,Flywheel 的产品 Lead —— 跟 Tadashi(工程 Lead)平级,管的是 Flywheel 项目自身的产品方向(self-hosting,同 Tadashi 一样吃自己的狗粮)。**

## Core Identity
- **Name**: Honey Lemon
- **Role**: 产品 Lead —— 协作式产品思考者(FLY-679 互动模型),不是 spec-taker
- **Project**: `flywheel`
- **Core duties**:
  - 跟 Annie 一路来回磨方向(五条铁律,见 §2 互动模型,直接复用 FLY-880 QA 通过的 role .md 内容)
  - 收敛 PRD → 拆 build issue → 转给 Tadashi 派 Runner 实现
  - **不派 Runner、不写代码**(`disallowedTools` 已禁 Write/Edit/MultiEdit/NotebookEdit/Agent;`canSpawnRunners` 方向定为 `false`,类似 Aunt Cass 的 CoS 角色——见 §2 定位结论 3,Tadashi 留了口子等 Annie 最终拍板,continuation 前需再确认一次)

### Discord Identity
**Your Bot ID**: `{待 Annie 建 bot 后填}`
| Identity | Discord ID | @mention |
|---|---|---|
| Honey Lemon(你自己) | `{待填}` | `<@{待填}>` |
| Annie(founder) | `1138241636057481306` | `<@1138241636057481306>` |
| Tadashi(flywheel-eng-lead) | `{Tadashi 现有 bot id}` | `<@...>` |
| Aunt Cass(flywheel-cos-lead) | `{Cass 现有 bot id}` | `<@...>` |

### Channel Isolation(严格执行,沿用 Tadashi/Cass 的隔离规则原文)
{从 Tadashi identity.md 对应段落照抄,只换頻道 ID}

## §2 互动模型(FLY-880 主体,直接整合进 identity.md,不留在 Runner role .md)
Honey Lemon 的产品共创行为规范 = FLY-880 已 QA-PASS 的
`.flywheel/agents/engineering/product-designer-executor.md` Mode A 全部内容
(五条铁律 / round 协议 / topic 树 / PRD 协议 / 拆 issue 协议)—— **这是本次 QA
verdict 明确保留的部分,不需要重新设计或重新验证**。

**定位已确认(Tadashi 2026-07-05,跟 Annie 定的大框,细节等 token 到位的
continuation 最终敲定)**:Honey Lemon 是**完整 Lead,直接跟 Annie 互动**(不是
"派 PM Runner、自己只做协调"的间接模式)——所以 §2 的内容应该**整段迁移/改写进
identity.md 主体**(她本人就是那个跟 Annie 一路来回磨方向的角色),而不是留在
Runner 的 role .md 里被动等 dispatch。`product-designer-executor.md` 本身继续
保留(Mode A 仍可能用于零散的 doc/设计类 issue 走 Runner 路径,Mode B 完全不变)
——这里只是说 Honey Lemon 的 identity.md 需要吸收 Mode A 的行为规范,不是删掉
Runner 那份。具体是"逐字复制"还是"改写成第一人称 Lead 语态"留给 continuation
的实现细节。
```

**定位问题结论(Tadashi 2026-07-05 回复,方向已定;细节留 continuation 最终确认)**:
1. **✅ 已定**:Honey Lemon = 完整 Lead,直接跟 Annie 互动(不是间接派 Runner 模式)——见上,§2 需整合进 identity.md 主体。
2. **✅ 已定**:项目级记忆 = 要。Annie 明确要"Tadashi 级"记忆,用**同款双桶模型**(GEO-203 dual-bucket:`packages/teamlead/src/bridge/memory-route.ts:44,63-77` —— 私有桶 `user_id == agent_id`,共享桶 `user_id == project_name`;identity.md frontmatter 保持 `memory: user`,同时需要把 `flywheel-product-lead` 加进 `~/.flywheel/projects.json` 顶层的 `memoryAllowedUsers` 数组——见 §4,已从"如果确认"改为"确认要做")。
3. **方向已定,留一个口子**:`canSpawnRunners` 倾向 **false**——产品 Lead 出 PRD → 拆 build issue → 进 Tadashi 队列,由 Tadashi 派 Runner 建,Honey Lemon 自己不派工程 Runner(避免绕开工程流水线)。但 Tadashi 明确这条**留给 Annie 最终拍板**,不是 100% 定案,continuation 实现前需要再确认一次。

## 2. launchd plist —— **不手写,自动生成**

Tadashi/Cass 的 plist(`~/Library/LaunchAgents/com.flywheel.lead.flywheel-flywheel-{eng,cos}-lead.plist`)都是 `flywheel-daemon.sh install` 从 manifest 生成的,ProgramArguments 固定是:

```xml
<key>ProgramArguments</key>
<array>
    <string>/bin/bash</string>
    <string>/Users/xiaorongli/.flywheel/bin/flywheel-lead-wrapper.sh</string>
    <string>/Users/xiaorongli/.flywheel/manifests/flywheel-{agentId}.json</string>
</array>
<key>EnvironmentVariables</key>
<dict><key>FLYWHEEL_LEAD_MODEL</key><string>{model}</string></dict>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>RunAtLoad</key><true/>
```

Label 命名会是 `com.flywheel.lead.flywheel-{agentId}`(即 `com.flywheel.lead.flywheel-flywheel-product-lead`,待 agentId 定案)。**动作项:不需要现在手写这个文件** —— 跑 `claude-lead.sh` 生成 manifest 后,`flywheel-daemon.sh install` 会自动产出。

## 3. Launcher 脚本 —— **复用现有,不新增**

`~/.flywheel/bin/flywheel-lead-wrapper.sh`(所有 `claude-code` backend 的 Lead 共用一份)+ `packages/teamlead/scripts/claude-lead.sh`(真正的 per-Lead supervisor,读 manifest、resolve identity.md、append 共享 base rules、按 `FLYWHEEL_LEAD_MODEL` 传 `--model`)。**Honey Lemon 不需要新脚本**,只要 manifest/plist 指向她的 agentId 即可复用整条链路。

## 4. `~/.flywheel/projects.json` —— `leads[]` 新增第三项

**注意**:不是 `.flywheel/config.yaml`(那个是 Bridge/Runner 侧配置,没有 `leads[]`)。真正的 Lead 注册表是 `~/.flywheel/projects.json`,Tadashi/Cass 已在里面的 `"flywheel"` project entry 下。Honey Lemon 是同一个 project entry 里追加的第三个 lead 对象:

```json
{
  "agentId": "flywheel-product-lead",
  "chatChannel": "{待 Annie 建新频道后填}",
  "match": { "labels": ["Flywheel-Product"] },
  "botTokenEnv": "HONEYLEMON_BOT_TOKEN",
  "department": "product",
  "canSpawnRunners": false,
  "model": "claude-opus-4-8[1m]"
}
```
(`agentId`/`chatChannel`/`match.labels`/`botTokenEnv`/`model` 仍是建议值待 Tadashi/Annie 最终确认。`canSpawnRunners: false` 是 Tadashi 2026-07-05 给出的方向——见 §2 结论 3——但他明确留了口子等 Annie 最终拍板,continuation 实现前需要再确认一次,不能直接当定案抄。`department` 若不填,会从 `match.labels[0]` 小写派生,这里显式写更清楚。)

真实 schema 见 `packages/teamlead/src/ProjectConfig.ts` 的 `LeadConfig`/`ProjectEntry` interface(`agentId` 要过 `SAFE_ID` 正则 + 全局 `${projectName}-${agentId}` 唯一性校验;PM/Triage 类角色若 `canSpawnRunners` 留空默认是 `true`,校验器会强制要求显式写 `false`——这条正对应 Honey Lemon 若最终确认不派 Runner 的情况)。

**同时需要**(§2 结论 2 已确认,不再是"如果"):把 `flywheel-product-lead` 加进项目顶层 `memoryAllowedUsers` 数组(现状 `["annie", "flywheel-cos-lead", "flywheel-eng-lead", "flywheel"]` → 追加 `"flywheel-product-lead"`),这样她的 identity.md `memory: user` 才能实际读写跟 Tadashi/Cass 同款的 GEO-203 双桶记忆(私有桶 `user_id==agent_id` + 共享桶 `user_id==project_name`)。

## 5. Discord 频道 + `access.json` allowlist —— 沿用 `/setup-discord-lead` 8 步流程

跑 `/setup-discord-lead` skill(`.claude/commands/setup-discord-lead.md`),关键坑位(备忘,"血泪教训"来源):

1. 建 Discord Application + bot,勾 `Server Members Intent` + `Message Content Intent`。
2. 邀请进 server —— **绝不用 Administrator 权限**,用 bitmask `277025459264`。
3. 建 `~/.claude/channels/discord-flywheel-product-lead/`:
   - `approved/` 子目录
   - `.env`(`DISCORD_BOT_TOKEN=...`,chmod 600)
   - **`access.json`(chmod 600)—— 这是最容易漏配的一步**,必须包含:
     - 她自己的新频道(`requireMention: false`)
     - `#flywheel-core`(共享入口频道,`requireMention: false`,`allowFrom` 限定 founder + 现有 bot)
     - `#leads-roundtable`(`requireMention: true`)
     - `allowBots`:把 Tadashi/Cass 现有 `access.json` 里的 `allowBots` 数组整个复制过来(现役 fleet 的所有 bot id),否则 Honey Lemon 在共享频道看不到其他 Lead 的消息
     - `mentionPatterns`: `["\\bHoney Lemon\\b", "\\bHoneyLemon\\b"]`(命中"点名字回话"规则)
   - **漏配任何一个 `groups` 频道 = bot 在线但对那个频道完全哑**(不是没启动,是消息被 access 层静默丢弃)——这条已经在 Tadashi/Cass 身上踩过,清单里显式标出来防止 Honey Lemon 重蹈。
4. `{LEAD_NAME_UPPER}_BOT_TOKEN`(即 `HONEYLEMON_BOT_TOKEN`)追加进 `~/.flywheel/.env`。
5. 确认默认 `~/.claude/channels/discord/access.json` 保持空 `groups: {}`,防止串台。
6. 建 `.lead/flywheel-product-lead/identity.md`(§1)。
7. 更新 `~/.flywheel/projects.json`(§4)。
8. 手动跑一次 `claude-lead.sh` 验证(tmux ctx 增长、只有自己频道回话、无串台、无 ghost-bot 回话),再 `flywheel-daemon.sh install` 转正式 launchd 托管。

## 6. 明确不在本清单范围(留给 Tadashi 的 continuation / 定位讨论收尾)

- 13 个 flywheel-skills PM skill 同步 —— 这是 FLY-880 计划本身 Step 1(独立仓 PR),与 Honey Lemon 部署是并行/独立的两件事,不重复列在这里。
- 上岗 QA(roundtable + issue→runner→thread 全链)—— 需要 Lead 真实跑起来才能验,不是本草稿能提前做的。
- `canSpawnRunners` 的最终一锤定音(§2 定位结论 3 留的口子)—— 这是 Annie 的产品/架构决策,不是我(QA 阶段)能替她拍板的,清单里只标注方向 + 留口子,不代入最终答案。
- 项目级记忆的具体接入细节(mem0 双桶的实际调用改造,如果 Honey Lemon 需要 identity.md 之外的额外接线)—— 超出这次"物料清单"的范围,是独立的实现工作量。

---
**下一步**:等 Annie 建好 `HONEYLEMON_BOT_TOKEN`(可能连 token 池一起,FLY-882 runner 正在跟她现场建)→ Tadashi 安排 continuation,把 `canSpawnRunners` 最后一锤定音后正式创建 identity.md + projects.json 条目(含 `memoryAllowedUsers` 追加)+ access.json,再走 §5 第 8-9 步验证上线。
