# FLY-2798 前台快答与后台 Lead — 实现验证
Issue: FLY-2798 (https://linear.app/geoforge3d/issue/FLY-2798/语音v4-引擎-a前台快答-后台-lead-在现有通用管道上让实时模型自己答简单的复杂的交给)
日期: 2026-09-24
基于: plan.md

## 本地验证

- `pnpm --filter "flywheel-voice-codex..." build`：通过；覆盖受影响包及依赖。
- `pnpm --filter <pkg> typecheck`：`voice-core`、`voice-codex`、`teamlead`、`voice-bridge`、`voice-headphone`、`gemini-agent`、`flywheel-comm` 均通过；可信 delivery-context 修补后又重跑 `teamlead` 与 `voice-codex`，通过。
- 聚焦 Vitest：`voice-core` 13 文件 97/97、`voice-codex` 5 文件 57/57、`teamlead` 11 文件 198/198、`flywheel-comm` 3 文件 107/107，通过。
- `voice-codex vitest related`：3 文件 17/17，通过。
- `teamlead vitest related` 首轮扩大到 Bridge 依赖图，143/144 文件、1830/1831 测试通过；唯一红项证明普通 HTTP body 可伪造 `deliveryContext`。保留该 hard-red，修为“鉴权 Bridge 适配层提升到可信 envelope，核心 handler 不信 body”，对应聚焦回归 4 文件 44/44 通过；最终 related 复跑 147 文件、1858/1858 通过。
- 第三轮代码审查指出 Lead result producer 重放时使用墙钟 `createdAt`，会让 MailboxQueue 的同身份投影 hash 冲突。新增“推进墙钟 1 秒后重放”测试先稳定复现 identity conflict，再把结果消息时间固定为权威 source message 的 `created_at`；同时让 composite speech 与 V1 fake 共用规范 `speakRequestDigest`，且 HTTP 适配层只提升与 `leadId` 精确匹配的 canonical voice context。整改后聚焦 27/27（teamlead）与 5/5（voice-core）通过；最终 `teamlead vitest related` 126 文件、1607/1607，`voice-core vitest related` 3 文件、13/13。
- `pnpm --filter "flywheel-teamlead..." build`：scope 内 13 个 package 通过。`pnpm --filter "...flywheel-voice-core" typecheck`：11 个 owner/dependent package 全部通过。
- `pnpm exec biome check`（本轮涉及的 11 个 TypeScript 文件）：零 error。
- 根 `pnpm lint`：首次在同步 main 前失败，5 errors / 25 warnings 均在本 issue diff 外；未扩大范围修改。同步当前 main 后于合并头重跑，5232 files、0 errors、25 warnings、exit 0；第三轮整改后重跑为 5233 files、0 errors、25 warnings、exit 0。本次涉及文件的定向 Biome 检查也无 error。
- `git diff --check`：通过。

## Consumer discovery 与选择

按角色合同，对从续跑基线 `5ff45d138` 到实现头的每个非测试 TypeScript 文件，均执行 `git grep -lF` 三组查询：完整路径、文件名、父目录。查询计数如下（`full/file/parent`）：

- `teamlead/bridge`: `lead-capability-discord.ts` 5/8/984，`plugin.ts` 255/1057/984，`voice-lead-result-producer.ts` 0/0/984。
- `teamlead/codex`: `CodexLeadOutboundHandler.ts` 8/17/123，`CodexOutboundSender.ts` 3/22/123，`LeadInputRouter.ts` 4/30/123，`capability-outbound.ts` 2/3/123，`codex-lead-runtime.ts` 33/139/123，`codex-lead-tui-runtime.ts` 25/106/123，`voice-reply-delivery-context.ts` 0/0/123。
- 其他 `teamlead`: `codexLeadBridgeWiring.ts` 3/12/125，`automatic-outbound.ts` 2/5/23。
- `voice-codex`: `index.ts` 0/401/24，`live-caption-projection.ts` 0/0/24，`live-lead-adapter.ts` 0/2/24，`live-reply-events.ts` 0/1/24。
- `voice-core/openai-live`: 四个新增文件均 0/0/0；`voice-core/index.ts` 1/401/32；第三轮整改新增 `headphone/speak-request.ts` 为 0/0/6，实际消费者由无扩展名相对 import 与 `headphone/index.ts` export 审计覆盖。

保留的消费者是实际 import/export/composition、对应聚焦测试，以及 Vitest `related` 从模块图选出的文件：OpenAI Live backend/controller/assembler/composite 的 13 个 voice-core 测试；live Lead/reply/caption 的 3 个 voice-codex 测试；Bridge producer、outbound handler/sender/router/capability、voice handoff store/routes/session 的 11 个 teamlead 测试；comm 的 inbox nudge、Discord ingest、CLI 的 3 个测试。`plugin.ts` 使 teamlead related 扩为整个 Bridge 图，因此最终复跑不再人工减集。

其余查询命中全部排除，原因逐类穷尽如下：

- `plugin.ts`、`index.ts` 等通用文件名的同名碰撞，不引用本次模块；
- 父目录字符串命中的历史文档、计划、审查 JSON、快照、路径卫生清单与 kill-path inventory，只记载路径而不执行代码；
- 测试/fixture 中未 import 本次模块、仅共享 `bridge`、`codex` 或 `src` 路径字样的碰撞；
- 本次新文件以无扩展名相对 import 使用，故 `.ts` 完整文件名查询为 0；实际消费者由 import/export 审计及 `vitest related` 覆盖。

没有保留或新增 `scripts/__tests__/*.test.sh` 匹配；因此无 shell 测试需要执行。没有运行本地全包测试，也没有请求 full CI。

## 最终头记录

第三轮 blocking HIGH `voice-lead-result-producer-not-replay-safe` 已按上述 hard-red → minimal fix → green 闭环修复。其余审查 advisories 中，V1 digest 与 HTTP delivery-context trust boundary 已一并收紧；reconcile timer guard、unavailable 重试语义和 results route committed-state gate 保留为非阻断 follow-up，并将在有效复审后完整转报 Lead。

待最终 milestone commit 后绑定 SHA、有效代码审查与 PR。真人语音 10 次“说完到听到第一个字”分布、复杂问题落地、字幕实听和 V2/V3 联调属于 QA，本文不宣称完成。

## QA 第一次 full CI 回退整改

QA 在精确头 `fd9cde9f33468cf3cdeb50f11c0d49ce80ec1772` 请求的 full CI run `35988198150` 暴露四类确定性遗漏：config flag-drift 未登记九个 V4 runtime 配置；child-process census 未登记 FFmpeg/Edge TTS 两个受限子进程；kill-path inventory 未登记同两处的四个超时/清理 kill；package-onboard 未携带共享 Silero runtime。失败 lane 为 Unit teamlead shard 4、Unit heavy、Unit light、Script tests 3/6；meta CI 因这些失败而红。这里不把此前普通 scope CI 当 full-CI 证据。

整改遵循 hard-red → 最小修复：

- config drift 本地先稳定复现 2 failed / 12 passed，再把九个端点、模型、voice、key-env、context 上限和 streaming TTS 配置逐项登记为有明确理由的非 flag 配置；
- child census 与 kill inventory 各自先复现单测 hard-red，再分别补两条 `standalone_runtime_bounded` census 和四条 `out-of-scope` kill 清单，没有改变进程生命周期；
- Silero packaging 复用了依赖 PR #1309 已评审的单一提交 `6c3811e20`，本分支 cherry-pick 为 `1fb4ce0a4`：资产仍由既有 `voice-bridge/models` 所有，package-onboard 纳入 `voice-headphone`，没有复制二进制或合入依赖分支的其他改动。

当前头的本地绿色证据：

- 原四个红项：config drift 14/14；child census 1/1；kill inventory 5/5；`package-onboard-smoke.test.sh` 26/26。后者首次只因共享 `~/.npm` 不可写而失败，使用隔离缓存 `/private/tmp/fly2798-npm-cache` 后通过；
- `flywheel-config vitest related src/feature-flags/truth.ts --run`：18 文件、326/326；Silero 两个变更测试的 `vitest related`：2 文件、5/5，真实语音 fixture 为 max `0.99999940`、243/298 positives；
- 直接 consumer：`fly1981-final-ledgers` 12/12、`fly2278-retirement` 1/1、`check-flag-truth.test.sh` 3/3、`fly1674-residue.test.sh` 85/85、`fly2102-flag-freeze.test.sh` 46/46；
- `pnpm --filter "flywheel-voice-codex..." build` 通过；根 `pnpm lint` 为 5235 files、0 errors、25 warnings、exit 0；变更的 TS/JSON/package 文件定向 Biome 6 files 无 error，两个 shell 文件 `bash -n` 通过，`git diff --check` 通过。

本轮对唯一变更的生产 TypeScript `packages/config/src/feature-flags/truth.ts` 重新执行完整路径、文件名、父目录三组 `git grep -lF`，分别命中 35/124/165。实际 import/export 审计保留 `scripts/check-flag-truth.ts`、config public barrels、`ConfigLoader.ts`、flag drift/truth/registry/final-ledger tests；路径读取型 consumer 保留 `fly2278-retirement`、`fly1674-residue`、`fly2102-flag-freeze`，均由上述 related 或精确测试覆盖。所有其余匹配按精确路径组排除：`engineering/doc/**`、`product/doc/**`、`doc/**` 是历史文档/生成物；`packages/teamlead/src/__tests__/fixtures/**` 是文字 fixture；`packages/config/src/feature-flags/registry.ts` 两处仅为注释；`packages/teamlead/src/bridge/{flag-provenance.ts,__tests__/flag-provenance.test.ts}` 和 `scripts/verify-flag-verdicts.mjs` 只引用 registry 路径；`scripts/__tests__/test-deploy-generalized.test.sh` 仅把 truth 文件列为扫描排除项；`scripts/fly1645-receipt-residue-gate.config.json` 只列与本次九项无关的历史 residue 目标。除上述已运行的 consumer 外，没有遗漏可执行依赖；本轮唯一变更的 `scripts/__tests__/*.test.sh` 是 package-onboard smoke，已全量执行。

本整改尚未由 QA 在新精确头重跑 full CI；实现节点不会自行请求 full CI，也不宣称 QA 已通过。下一步是 milestone-last、新精确头代码复审、推送既有 PR #1312，再交回 QA retest。

## QA 回退后的 Engine A 激活与订阅接线

Lead 在旧头 `f65795e62` 复核时确认 A1–A4 之外仍缺生产激活与订阅接线，因此该头的 R5 APPROVED 已作废。本轮按同一已批准设计完成两条闭环：

- 激活：`FLYWHEEL_VOICE_ENGINE` 默认 `legacy-realtime`，只有显式设为 `openai-live` 才使用权威 `sessionId + sessionGeneration` 构造 RoomIO，并接入 `GptLiveBackend → LiveLeadAdapter → HeadphoneSession`；现有 `GenericVoiceSession.speak()` 在该分支转到 V1 `speak()`，legacy 默认路径不变。配置测试与 V1 播报测试均先红后绿。
- 订阅：生产组合注入 Headphone Bridge 的 `subscribeReplies`，通知只作门铃，正文仍从 durable results route 重读；断线记录 `voice_reply_subscription_failed`，不退回 3 秒 Bridge / 4 秒 daemon 轮询；重连对每个已登记 handoff 精确唤醒一次。旧 poller 保留给 legacy。
- 输出：Lead 与前台共享同一 V1 utterance stream，经 `LiveCaptionProjection` 分别投影为 `🤖 前台` 与 `💬 Lead`；确定性播报用 streaming Edge TTS → FFmpeg PCM → RoomIO，边生成边提交。
- 部署要求：Engine A 主机必须把 `FLYWHEEL_VOICE_EDGE_TTS_STREAM_CMD` 指向安装了兼容 `edge-tts` 的 Python 3.10 可执行文件（例如受管 venv 的 `bin/python3.10`）。默认 `python3` 仅在它实际解析到该受支持运行时时可用；否则语音失败会显式记录，不能静默降级。

本轮验证：

- 精确行为测试：voice-codex 5 文件 71/71；teamlead 2 文件 30/30；voice-headphone 2 文件 19/19。
- changed-TypeScript `vitest related`：config 18 文件 326/326；voice-core 2 文件 5/5；teamlead 的依赖图自动展开为 102 文件 1194/1194；voice-codex 14 文件 171/171。
- `pnpm --filter "flywheel-voice-codex..." build`：scope 内 16 个 package 通过；`pnpm --filter "...flywheel-voice-core" typecheck`：11 个 owner/dependent package 通过。
- 根 `pnpm lint`：5237 files、0 errors、25 warnings、exit 0；`git diff --check` 通过。

Consumer discovery 对本轮 13 个非测试 TypeScript 逐一执行完整路径、文件名、父目录三组 `git grep -lF`；命中计数（full/file/parent）为：`truth.ts` 36/125/166、`voice-session-services.ts` 3/12/991、voice-codex 的 `bridge-client.ts` 5/21/24、`cli.ts` 10/229/24、`config.ts` 10/381/24、`discord-room.ts` 7/25/24、`engine-a-composition.ts` 0/0/24、`index.ts` 0/403/24、`live-caption-projection.ts` 0/1/24、`live-reply-events.ts` 0/2/24、`projection.ts` 2/7/24、`session.ts` 3/55/24，voice-core `index.ts` 1/403/32。保留全部真实 import/export、生产组合与直接测试：flag truth/drift consumers、Teamlead voice session service/router、voice-codex daemon/session/RoomIO/Engine A 组合、voice-headphone Bridge/session、voice-core public export/composite speech。它们均由上述精确测试或 related 图覆盖。

其余命中逐类排除且没有未说明类别：`engineering/doc/**`、`product/doc/**`、`doc/**` 只记载历史路径；`dist/**` 与生成清单不作为源码 consumer；`index.ts`、`config.ts`、`cli.ts`、`session.ts` 等通用 basename 在其他 package 的同名文件只是词法碰撞；父目录命中中，Teamlead 991 项与 voice-codex 24 项、voice-core 32 项除已保留 import/test 外均只共享目录字符串；fixture/snapshot/JSON/inventory 仅保存文字；本轮新增文件使用无扩展名相对 import，故完整 `.ts` 查询为零。没有新增或保留的 `scripts/__tests__/*.test.sh` consumer。本地没有运行人为选择的全包 suite；teamlead 的 102 文件由 `vitest related` 自动展开。

以上仍不等于 QA：真人 Raya 10 次首字延迟分布、复杂问题落地、字幕实听、V2/V3 联调和新精确头 full CI 均待 QA 重测，实施节点不自行请求 full CI。

## R6 生产 Lead 回信门铃整改

R6 代码审查发现生产 `VoiceLeadResultProducer` 直接写入 durable result store，绕过了原先只存在于 `POST /:handoffId/results` 闭包内的 SSE subscriber map；Engine A 没有结果轮询兜底，因此该提交路径会让正文已持久化但语音会话收不到门铃。新增 producer-path 接受测试先因共享 notifier 不存在而 hard-red，随后用最小接缝闭环：`startBridge` 构造唯一 `VoiceReplyNotifier`，同一实例同时注入 `createBridgeApp` 的 producer `onCommitted` 与 handoff router；HTTP route 和 producer 都只在新 durable sequence 落地后通知绑定的 `sessionId + generation`。相同 operation 重放仍返回同一 result，但不会重复发门铃；SSE 继续只携带 handoff id，正文仍由语音进程从 durable results route 重读。

整改后的本地证据：

- producer + route 聚焦测试 2 文件、13/13；新增断言覆盖 producer commit → shared notifier → 绑定 session wake，并覆盖同 operation 重放只唤醒一次；
- changed-TypeScript `vitest related` 因 `plugin.ts` 组合根自动展开为 103 文件、1183/1183；未人工缩减依赖图；
- `flywheel-teamlead` typecheck 通过；`pnpm --filter "flywheel-teamlead..." build` 覆盖 13 个 owner/dependency package 并通过；
- 根 `pnpm lint` 检查 5238 files、0 errors、25 个既有 warning、exit 0；定向 Biome 对本轮 6 个 TypeScript 文件 0 errors，`git diff --check` 通过。

Consumer discovery 对本轮 4 个非测试 TypeScript 执行完整路径、文件名、父目录三组 `git grep -lF`，命中计数（full/file/parent）为：`plugin.ts` 256/1063/991、`voice-handoff-routes.ts` 0/1/991、`voice-lead-result-producer.ts` 0/1/991、`voice-reply-notifier.ts` 0/0/991。保留生产组合根、router、producer、共享 notifier 以及两个直接测试；它们全部由上述聚焦测试与 related 图覆盖。其余命中均为 `plugin.ts` 等通用 basename 碰撞、`engineering/doc/**` 等历史文字、fixture/snapshot/inventory 路径文字，或仅共享 `packages/teamlead/src/bridge` 父目录而没有 import 的模块；新增文件使用无扩展名相对 import，故完整 `.ts`/basename 查询为零。没有新增或保留的 `scripts/__tests__/*.test.sh` consumer。本轮没有运行本地全包 suite，也没有请求 full CI。
