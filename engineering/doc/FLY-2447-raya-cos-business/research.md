# FLY-2447 Raya 统管业务 — 调研
Issue: FLY-2447 (https://linear.app/geoforge3d/issue/FLY-2447/rayacos-统管-leads-summaries88-日报-在新地基重排按-prd-fly-1846-的定义作为-raya)
日期: 2026-09-14
基于: exploration.md

## 证据基线

2026-09-14 只读核对 Linear 当前 issue 与依赖、GitHub Raya main/PR、两仓源码。Flywheel 初始 HEAD `579c79ed6`；Raya GitHub main `9d63a2b2e6736bcdd5e699945b3bf8655c06c5e9`（`gh api repos/xrliAnnie/raya/commits/main`）。本机 `~/.flywheel/raya/code` 仍为 `0f77e9772176c973eb1e09548b00c05ae550ef32`，未改动它；这只能证明版本差，不能证明运行进程的状态。

| 继承源 | 精确版本 | 用途 |
|---|---|---|
| Raya 当前 main | `9d63a2b2e6736bcdd5e699945b3bf8655c06c5e9` | 从④的 `packages/cos` 继续 |
| 2380 业务实现 | `41b26fa4e8baaddf076a33e7291772de979ffb8c` | 原 collector/repo-writer/state/格式的回归对照 |
| 2381 业务实现 | `f1905cdaeb5747445e791649741fcdf20069b5c3` | 当前 README 明示提取来源；goal/采样/证据规则 |
| 2379 业务生命周期 | `34c879475dfe05253d2d52b409ccd14f107fe9b2` | 仅旧 question ID/状态迁移对照，不恢复驱动 |
| Flywheel 2380 文档分支 | `8ea892e5d8faf58d5815c4afbeba9eda864cbb64` | `engineering/doc/FLY-2380-raya-daily-report/plan.md`；20:00、文字分片、仓内日报、两日真机判据 |
| ⑤ Raya PR #71 | `d4e6b13a4e1aef4cd602bb80301e2686c2996c58`，OPEN | 当前 main 尚无的 voice port 接线；不能因 FLY-2446 Done 就当作已部署 |

Linear 当前：FLY-2447 In Progress；2445/2446 Done；2380/2437 Canceled。2437 明文说 Raya #27 不再合入、分支保留。2381 的产品效果必须在新地基实现，历史锚 PR 不能替代。

## 现有入口与真实缺口

| 文件（除标注 Raya 外均在 Flywheel） | 已有行为 | 本单设计影响 |
|---|---|---|
| Raya `.lead/raya/identity.md` | PR merge、memory provenance、questions/report ledger 指令；仍称跨 Lead/voice unavailable、空轮静默 | 换为标准工具执行协议，保留 persona 判断义务与 merge 窄例外 |
| Raya `packages/cos/src/cli.ts` | 仅 `daily-report-date` 与调用 `createUnavailablePorts()` 的 `voice-intent` | 增加一次性业务 prepare/record/resume 入口；不加 daemon |
| Raya `ports.ts` | directory 空、request/reply/announce/voice 全 unavailable | 不再把 default factory 当可用端口；业务返回明确工具意图 |
| Raya `summary-absorption.ts` | 非空 Facts/Judgment 就进 mergeCandidates；缺字段调用不可用 request | 非空只能选为 review candidate；理解决定与 head 绑定后才可 merge |
| Raya `daily-report/{collector,repo-writer,storage,controller,generator}.ts` | collector 钉 main/PR head；writer 固定 reports/date；controller 是 recovery-step 纯函数；生成只返回 prompt | 复用解析/纯规则，补完整当前 turn 协议；抽离默认 gh 子进程，不引入模型驱动 |
| Raya `portfolio/{sampler,goal-store,patrol}.ts` | sampler 自带 gh/git/fetch；goal-store 自带 git；patrol 函数返回 prompt，发布只 sanitize | 改为数据输入/工具意图，保留业务文件存储；drift-envelope 校验接上实际出站入口 |
| `lead-directory.ts` | `compileLeadDirectory` 只含有 cosContext 的行；项目完整集合未暴露给 Lead tool | 增加独立只读全项目投影与 tool，不能因为无 cosContext 就丢项目 |
| `lead-actions/lead-actions-main.ts` | `discord_send(target,text,eventId)` 已走 Bridge；只返回自然语言 text | 保留原工具；增加 structuredContent 回执，Raya 不解析“Sent to…”当事实 |
| `discord-send-core.ts`、`alias-allowlist.ts` | chat/roundtable alias、限流、去重、禁 raw channel | 直接复用，失败不能切 direct；exact eventId/target/body 不变重试 |
| `cross-dept-channel-rules.md`、roundtable wiring | 定向对话、已有 thread 路由/订阅、防 bot 循环 | 不复制名单、REST poller 或线程创建；真实双向用当前机制验收 |
| `summary-absorption-rider.ts` | `summary_due` 先冻 producer/period；grace 后 `summary_absorption_round`，携 frozen 对账行 | 原 roundId/period 不变；作为 6h 业务触发，不再加 Raya 6h timer |
| `flag-store-runtime.ts` | `summary_absorption_cadence_ms` 每次读取 | 保留动态 6h 默认；不增加镜像间隔 |
| `summary-pr-merge.ts` | repo 仅 Raya/Raya-memory；核全 diff 后 exact-head merge；写 merge receipt，写失败可辨 mergeOccurred | 唯一 summary merge 路径；崩溃恢复认 GitHub 合并事实 |
| `cos-ports/voice-intent.ts` | start 仅 meetingId；stop 先按 meetingId 查 session；HTTP accepted 不代表 live | 沿用⑤公共端口与 meeting.json 信任解析；不把 accepted 写成已开会 |
| `voice-session-start.ts`、`meeting-notes-config.ts` | Bridge 从可信配置解析当前会议，校验 UUID、状态、registry | 业务 meeting 必须输出该现有 schema，而不是仅自有最小 Meeting 对象 |
| `scripts/lib/updater-raya-deploy.sh`、`bin/raya-migration-*` | updater-owned 标准载体迁移及 v2 receipt | 本单不另做部署工具；两仓 SHA 和同 activation 证据继续硬门 |

## 2380 原方案中保留与取消

保留：默认当地20:00、运行时可配、最多补最近一个到期日；报告含日期、来源 summary、状态/遗漏/截断说明、事实和判断；固定 `reports/YYYY-MM-DD.md`；create-or-adopt 不覆盖既有报告；分片与每片稳定身份；未知发送不可盲发；连续两个真实自然日验收。原计划 §0 记录 reports 运行时直写 main 的业务落法，此设计不把它变成代码/配置写权限。

取消：`runBrain` timer、第二个 Codex 实例、ephemeral generation thread、把日报再 ingest 回旧 text thread、私有 Discord REST 对账、`raya.env` 中新驱动配置。当前标准 turn 已有生成上下文；跨 turn 用仓内报告及 exact source message 恢复，避免第二套收信日志。

## 判据与限制

业务调研未跑旧业务测试、未操作生产 Lead、未读取业务数据库或任何凭据文件；评审等待阶段仅mode=ro查询本review job的非秘密状态列，见validation.md；源码静态存在不能证明业务可用。Bridge `/health` 200 只用于 onboarding。语音、两日报和 founder 纠正必须交给真正端到端验收。

产品参考均为本地 PRD、已注入 issue、GitHub/Linear 当前私有资料；无需外部模型选型研究。不把过期的项目数量、角色显示名、deployment status 写成配置常量。


## 评审后源代码补充（2026-09-14）

主动圆桌原有FLY-676拒绝点在 `packages/teamlead/src/lead-backends/codex/discord-send-core.ts`；FLY-680只是缺失engage seam的归属注释，不是已可用能力。通用接线可沿 `CodexOutboundSender`、`CodexLeadOutboundHandler`、`SqliteOutboundDedupStore`、`codexLeadBridgeWiring`、`CodexLeadInboxSocket` 现有认证/发送路径扩充。两个runtime均已有reply-in-thread wiring与inbox subscription接口。现有 `RestPollDiscordInboundSource.addChannel` 没有cursor会跳到最新消息，`roundtable-thread-budget`在重启后无budget会拒bot，因此主动订阅必须有根消息起始游标/补读、持久有限预算及重复消息准入证据；不能简单移除拒绝条件。

`chat-delivery-envelope.ts` 原replyRoute只表示outbound话题路由。`RestPollDiscordInboundSource`已解析Discord被回复message/author，但 `CodexDiscordMailboxStrategy`和`discord-chat-ingest.ts`未传递；必须添加兼容可选replyTo并贯通真实入站与持久渲染。具体修订以plan §2.3/2.4为准。
