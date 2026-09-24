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

## QA 第二次回退整改

QA 在头 `aec8c8ccb` 的真人路径核验发现五个阻断点，本轮均按 hard-red → 最小修复 → green 闭环：

- RoomIO 首帧 sequence 必须从 0 开始；`CompositeSpeech` 与 `LiveLeadAdapter` 从预增改为后增，两个直接测试分别 4/4、12/12。
- producer 与 consumer 的 handoff 幂等键公式不一致；公式提升为 voice-core 单一 helper，adapter 与 Teamlead route 共用，`delegation.id` 仍只用于 binding，不作幂等键。
- Engine A 虽有推送订阅，legacy voice daemon `/outbound` 与 Teamlead Discord poller 仍会运行；开关选中时现在同时关闭两处轮询，默认 legacy 路径不变。
- `startBridge` 在 catch-all 404 后挂载 headphone/handoff router；改为在 `createBridgeApp` 内预先挂载 late-bound holder，运行时再注入真实 router，未配置时显式 503。
- 529 voice launcher 的封闭 env allowlist 缺三个 Engine A 开关；仅放行 `FLYWHEEL_VOICE_ENGINE`、`FLYWHEEL_VOICE_EDGE_TTS_STREAM_CMD`、`FLYWHEEL_HEADPHONE_BACKGROUND_ENABLED` 并增加精确断言。

最终本地验证：聚焦 voice-core 4/4、voice-codex 71/71、Teamlead 37/37、529 launcher 15/15；changed-TypeScript `vitest related` 为 voice-core 5/5、voice-codex 60/60、Teamlead 自动依赖图 104 文件 1202/1202。`pnpm --filter 'flywheel-voice-core...' --filter 'flywheel-voice-codex...' --filter 'flywheel-teamlead...' build` 覆盖 16 个 owner/dependency package 并通过；`pnpm --filter '...flywheel-voice-core' typecheck` 覆盖 11 个 owner/dependent package 并通过。变更的 15 个源码/测试文件定向 Biome 0 errors（`plugin.ts` 仅保留 2 个本次 diff 外既有 warning）。根 `pnpm lint` 已执行但因本次 diff 外的 FLY-1547/1563 research scripts、FLY-2560 replay tooling 等 3 个既有 error 而退出 1；遵守锁定范围未改这些文件。未请求 full CI。

Consumer discovery 对本轮 9 个非测试源文件逐一执行完整路径、文件名、父目录三组 `git grep -lF`，命中计数（full/file/parent）为：Teamlead `plugin.ts` 256/1063/991、`voice-handoff-routes.ts` 0/2/991、`voice-session-services.ts` 3/13/991；voice-codex `cli.ts` 10/230/24、`daemon.ts` 13/32/24、`live-lead-adapter.ts` 0/3/24；voice-core `CompositeSpeech.ts` 0/0/0、`handoff.ts` 0/1/32；529 launcher `fly2655-voice-room.mjs` 7/11/335。保留所有真实 import/export/composition、精确行为测试，以及 Vitest related 自动解析出的依赖图；因此 Teamlead 的中央 `plugin.ts` 自动扩展到 104 文件，没有人工裁减。

其余匹配逐类排除且没有未说明类别：`engineering/doc/**`、`product/doc/**`、`doc/**` 是历史文字或生成证据；fixture/snapshot/inventory 仅保存路径字符串；同名 `plugin.ts`、`cli.ts`、`daemon.ts` 等是其他 package 的词法碰撞；父目录命中除已保留 import/test 外只共享目录文字；新增文件以无扩展名相对 import 使用，故完整 `.ts` 查询可能为零。唯一直接命中的新 `scripts/__tests__` consumer 是 `fly2655-voice-room.test.mjs`，已完整执行 15/15；没有本轮新增或保留的 `scripts/__tests__/*.test.sh`。本轮没有运行人为选择的全包 suite，Teamlead 104 文件来自强制 `vitest related`，也没有以它替代 QA exact-head full CI。

## R8 精确头代码审查阻断整改

代码审查在头 `8b2c43d91` 提出六个 HIGH，本轮全部按失败回归 → 最小修复 → 绿色闭环：

- Live provider 失效后的 `sendAudio` 异常现在被 adapter 边界收口并只记录一次 unavailable，后续帧直接丢弃，不再逃逸 RoomIO 50 Hz clock；
- 新 RoomIO utterance start 会淘汰因 capture/lease failure 遗留的旧 open window，后续 delegation 可绑定新 utterance；
- FFmpeg decoder 用 `pauseStdout` / `resumeStdout` 对 PCM queue 做真实背压，watchdog 在消费者主动限速期间暂停，不再把正常的长 Lead 播报误判为 96 KB resource exhaustion 或 30 秒 timeout；
- `CompositeSpeech.pending` 与 adapter `speakWork` 只缓存非失败 receipt，且 Lead result 仅在播报 completed 后记 applied，因此 barge-in 后相同 result 可以重试并推进 cursor；
- GPT-Live 官方协议没有 transcript-done / output-audio-done；backend 按 1 秒 idle boundary 聚合 output transcript 并发出一个 `final:true` caption，adapter 忽略 raw partial，且不会伪造 `response-done` 造成后续音频被丢弃；
- HTTP result source verification 现在把 request `text` 与已鉴权 CommDB source message 的 `content` 精确比对，不能复用真实 delivery id 播报伪造文本。

本轮精确验证：

- 直接回归：voice-core 4 文件 28/28、voice-codex 14/14、Teamlead route 7/7；
- changed-TypeScript `vitest related`：voice-core 20 passed files + 2 smoke files skipped，196 passed / 4 skipped；voice-codex 1 文件 14/14；Teamlead 的 `plugin.ts` 组合根自动展开 103 文件、1178/1178；
- `pnpm --filter 'flywheel-voice-core...' --filter 'flywheel-voice-codex...' --filter 'flywheel-teamlead...' build` 覆盖 16 个 owner/dependency package 并通过；`pnpm --filter '...flywheel-voice-core' typecheck` 覆盖 11 个 owner/dependent package 并通过；
- 根 `pnpm lint` 检查 5239 files，0 errors、25 warnings、exit 0；本轮 15 个 TypeScript 文件定向 Biome 为 0 errors，`plugin.ts` 仅有 2 个本次 diff 外既有 warning；`git diff --check` 通过。

Consumer discovery 对本轮 8 个非测试 TypeScript 执行完整路径、文件名、父目录三组 `git grep -lF`，命中计数（full/file/parent）为：Teamlead `plugin.ts` 256/1063/991、`voice-handoff-routes.ts` 0/2/991；voice-codex `live-lead-adapter.ts` 0/3/24；voice-core `FfmpegPcmDecoder.ts` 2/2/4、`CompositeSpeech.ts` 0/1/0、`GptLiveBackend.ts` 0/0/0、`LiveUtteranceAssembler.ts` 0/0/0、`process.ts` 3/13/32。保留真实 import/export/composition、`ProcessHandle` 实现与 fake、直接回归和 `vitest related` 自动选择的全部 consumer；因此 Teamlead 中央组合根扩展出的 103 文件未人工裁减，voice-core 的进程 API consumer 也覆盖了真实 subprocess tests。

其余命中逐类排除且没有未说明类别：`engineering/doc/**`、`product/doc/**`、`doc/**` 是历史文字；child-process census 与 kill-path inventory 只记录受管路径且此前已由 QA 回退修复验证；通用 `plugin.ts` / `process.ts` basename 在其他目录是词法碰撞；父目录命中除上述真实 import/test 外只共享目录字符串；OpenAI Live 新文件使用无扩展名相对 import，故 `.ts` 完整路径或 basename 可能为零。没有本轮新增或保留的 `scripts/__tests__/*.test.sh` consumer。本轮没有请求 full CI；真人 10 次首字延迟、复杂问题落地、真机字幕与 V2/V3 联调仍属于 QA。

## QA 第三次回退整改（claim 1481）

QA 在 `b51a597567bf399120b3908f56c55bd68f933d38` 的真房核验确认，先前 D–H 逻辑与 full CI 已通过，但真人 Engine A 会被一条生产合同缺口终止：headphone list 返回投影后的公开 item，claim 却返回原始 `itemFromRow`，其中 `speechBrief: null` 被客户端严格解析器拒绝。另有三项验证/激活缺口：reply SSE 固定 1 秒无限重连导致审计洪泛；529 launcher 的生产 `voiceEnv()` 与 slot Bridge 环境没有完整透传三个 Engine A 变量；此前缺少 adapter→route 与两个音频 producer→真实 RoomIO 的配对合同测试。

本轮按失败回归 → 最小修复 → green 闭环：

- list 与 claim 共用 `publicHeadphoneItem`，claim 不再泄漏内部字段或 `speechBrief: null`；客户端也把历史/异构 Bridge 的 null 当缺失。初始 route 断言稳定显示原始 record，client 断言稳定复现 `headphone inbox response invalid`；最终增加真实 Express route → 真实 `BridgeVoiceClient.listHeadphoneItems()` / `claimHeadphoneItem()` 配对测试，含数据库形状的 null 行。
- reply subscription 使用 1s 起步、30s 上限的指数退避，并限制为 5 次重连；预算耗尽只写一次 `voice_reply_subscription_exhausted`，不回退轮询，也不会继续制造失败审计。fake-timer 回归先证明旧实现 100ms 内已超过四次调用，修复后固定为初次连接 + 三次测试重连，10 秒后仍无新增调用。
- 官方 529 launcher 用单一 `voiceProcessBaseEnv` 把 `FLYWHEEL_VOICE_ENGINE`、`FLYWHEEL_VOICE_EDGE_TTS_STREAM_CMD`、`FLYWHEEL_HEADPHONE_BACKGROUND_ENABLED` 送入 `buildVoiceProcessEnv`，因此 prepare receipt 的 `environmentNames` 来自包含三项的最终 env。对应测试先因生产 `voiceEnv()` 仍硬编码 `{HOME, PATH}` 而 red。
- `scripts/test-deploy.sh` 的 voice fixture `BRIDGE_EXTRA_ENV` 显式白名单透传同三项；直接结构测试先红于缺失 `FLYWHEEL_VOICE_ENGINE`，随后 15/15 green。生产部署必须把 `FLYWHEEL_VOICE_ENGINE=openai-live` 写入 `~/.flywheel/.env`；Bridge/voice launch wrapper 用 `set -a` source 该文件，测试 slot 则由上述封闭白名单重建环境。
- 新 adapter→route 测试把真实 `LiveLeadAdapter` 产出的 request POST 给真实 handoff router/store，证明 committed record 使用合同字面幂等键，并保留旧 digest key 的 400 negative guard。新 RoomIO 合同测试使用真实 `flywheel-voice-bridge createRoomIO`：先证明 sequence 1 被 `speech_sequence_invalid` 拒绝，再证明 `CompositeSpeech` 与 `LiveLeadAdapter` 均从 sequence 0 流入真实 guard。

最终本地证据：Teamlead 精确 2 文件 5/5、voice-headphone 15/15、voice-codex 2 文件 16/16、529 launcher 15/15；最终新增 Teamlead 配对测试的 `vitest related` 4/4。生产文件整改后完整 changed-file related 为 voice-headphone 15/15、voice-codex 16/16、Teamlead 自动依赖图 104 文件 1175/1175。受影响 dependency build 覆盖 16 个 package；voice-headphone owner/dependent typecheck 覆盖 voice-headphone 与 voice-codex；根 lint 最终检查 5241 files、0 errors、25 warnings；9 个 JS/TS 文件定向 Biome 无改动，`bash -n scripts/test-deploy.sh` 与 `git diff --check` 均通过。未运行人为选择的本地全包 suite，也未请求 full CI。

本轮四个非测试生产文件的完整路径、文件名、父目录 `git grep -lF` 命中计数（full/file/parent）为：voice-headphone `bridge-client.ts` 2/22/6、Teamlead `headphone-routes.ts` 0/0/991、529 launcher `fly2655-voice-room.mjs` 7/12/335、`scripts/test-deploy.sh` 230/329/933。保留的真实 consumer 是 voice-headphone public export/session/daemon、voice-codex Engine A composition/CLI、Teamlead plugin mount、529 launcher/deploy入口，以及本轮精确合同测试；生产 TypeScript 均由对应 exact/related 覆盖，脚本由 launcher 15/15 与 shell syntax 覆盖。

其余命中按类别全部排除：`engineering/doc/**`、`product/doc/**`、`doc/**` 与旧 review/QA evidence 只保存路径文字；kill-path inventory 只登记 launcher 既有进程操作；通用 `bridge-client.ts`、`test-deploy.sh` 与 `scripts` basename/父目录在其他 package 或历史材料中只是词法碰撞；fixture/snapshot/CI 清单只保存命令或路径；其他 `scripts/__tests__` 针对未改的 deploy 子系统，不消费本轮 voice env block。唯一直接读取该 voice env block 的 `fly2655-voice-room.test.mjs` 已完整执行。本轮没有新增或修改 `scripts/__tests__/*.test.sh`，因此没有遗漏该类强制 shell 测试。以上仍不是 QA 真人 10 次延迟、字幕、复杂 handoff、耳机三件事、529 N-to-N 或 exact-head full CI 的替代证据。

## R9 精确头代码审查阻断整改

代码审查在 `ec9384dca` 确认三个 HIGH：公开 GPT-Live 没有 `response-done`，adapter 因而从不关闭前台 RoomIO speech；audible tail 未 drain 时 heartbeat 每次仍按 overdue 计算，形成 1ms 重排；reply subscription 的重连预算只增不减，长期会话累计五次断连后永久失聪。本轮只修这三项阻断，四项 MEDIUM/LOW advisory 原样记入 `follow-ups.md`。

- 前台音频现在用 1 秒可配置 idle boundary 关闭 speech，`endSpeech` 仍排在全部已接收 frame 之后，不伪造 provider `response-done`，也不把字幕聚合当音频完成。idle 后若又到迟音频，adapter 自动开启新 speech；真实 RoomIO 合同测试不再手工 emit `response-done`，并证明首段调用 `endSpeech`、tail duration 被计入、迟到帧进入第二段且再次正常结束。
- heartbeat 观察到未 drain tail 时把这段可听输出记为 activity，再按完整 heartbeat interval 重排。失败测试把旧实现稳定钉在 `[1]`，修复后为 `[1000]`，且没有误播 heartbeat。
- SSE 重连预算在一条连接持续健康达到 backoff cap 后清零；短时 flap 仍共享原预算并最终 exhausted，避免恢复永久失聪与快速 flap 无限审计两种极端。回归先用两次 503 消耗完整预算，再保持 ready 40ms，随后断开并证明新预算可再次发起连接。

最终证据：voice-core related 3 文件 15/15、voice-headphone related 16/16、voice-codex related 2 文件 16/16；受影响 dependency build 覆盖 16 个 package，`...flywheel-voice-core` dependent typecheck 覆盖 11 个 package；根 lint 检查 5241 files、0 errors、25 warnings；定向 Biome、`git diff --check` 均通过。Consumer discovery（full/file/parent）为 `live-lead-adapter.ts` 0/3/24、`HeadphoneMode.ts` 0/0/6，`bridge-client.ts` 沿用本轮 2/22/6；保留真实 composition/export/session 与精确/related 测试，其他命中均为文档、inventory、wrapper 路径文字或父目录碰撞。没有新增或修改 `scripts/__tests__/*.test.sh`，没有请求 full CI。

## R10 barge-in 尾音取消阻断整改

R9 精确头 `f692b6b23` 的第二轮代码审查发现唯一 HIGH：idle boundary 已把 active frontend speech 清空，但真实 WaitingMouth 仍可能排着数秒 PCM；此时 sustained barge-in 找不到 speechId，无法执行 `localPlaybackCancel`。真实 RoomIO 回归先稳定复现 1/2 失败：1 秒 PCM 已调用 `endSpeech` 且 audible tail 未 drain，打断后的取消调用为 0。

最小修复只把当前前台播放的 `speechId + generation` 保留到取消边界；`endSpeech` 只结束生产者写入，不丢掉本地可取消身份。barge-in、provider cancellation、下一段开始与 session close 继续复用同一 `cancelFrontendSpeech`，因此即使 active segment 已结束，仍能取消 WaitingMouth 中尚未播完的同一段。真实 RoomIO 回归现在证明 idle boundary 后 tail 未 drain 时，sustained barge-in 精确调用该 speech 的 `localPlaybackCancel(speechId, 9)`；原 sequence-zero 与迟到帧合同测试未删除。

最终证据：精确真实 RoomIO 文件 3/3，changed-file `vitest related` 2 文件 17/17；`flywheel-voice-codex...` dependency build 覆盖 16 个 package，`...flywheel-voice-codex` typecheck 通过；根 lint 检查 5241 files、0 errors、25 warnings；两文件定向 Biome 与 `git diff --check` 通过。Consumer discovery（full/file/parent）为生产 `live-lead-adapter.ts` 0/2/24、回归 `engine-a-room-io-contract.test.ts` 0/0/5。生产 basename 的两个匹配只是 FLY-2796/2798 方案文档；两组 parent 命中均为历史文档/评审 JSON、child-process inventory、产品文档或 wrapper 路径文字，不是 import。真实 import 使用无扩展名相对 specifier；保留的直接测试和可执行消费者均由 17/17 related 图覆盖。没有新增或修改 `scripts/__tests__/*.test.sh`，也没有请求 full CI。

## R11 stale frontend write 隔离阻断整改

R10 精确头 `0143d079e` 的第三轮代码审查发现唯一 HIGH：旧段 S1 的 `writeSpeech` 在 await 期间被下一段替换后才 reject，原来的无条件 catch 会调用无参 `cancelFrontendSpeech()`，误杀已经 active 的 S2。真实 RoomIO hard-red 用 600,000 bytes 超队列大段制造 pending write，idle 后送入 S2 首帧；旧代码稳定 3/4 通过、1/4 失败，S2 的 sequence 0 从未进入 RoomIO。

最小修复只给 catch 增加所属段 guard：失败仍始终记录 `live_frontend_output_failed`，但仅当 `this.frontendSpeech === speech` 时才取消。绿色回归证明 S1 的 `speech_playback_stopped` 仍有审计，S2 不被 `localPlaybackCancel`，且 sequence 0 真正提交给真实 RoomIO。没有改 idle boundary、WaitingMouth 或共享 RoomIO tail 合同；本轮新增 MEDIUM/LOW 仍只进入 follow-up。

最终证据：精确真实 RoomIO 文件 4/4，changed-file `vitest related` 2 文件 18/18；`flywheel-voice-codex...` dependency build 覆盖 16 个 package，`...flywheel-voice-codex` typecheck 通过；根 lint 检查 5241 files、0 errors、25 warnings；两文件定向 Biome 与 `git diff --check` 通过。Consumer discovery（full/file/parent）仍为生产 `live-lead-adapter.ts` 0/2/24、回归 `engine-a-room-io-contract.test.ts` 0/0/5；保留项、无扩展相对 imports 与文档/inventory/wrapper 排除类别同 R10，18/18 related 覆盖全部真实 executable consumer。没有新增或修改 `scripts/__tests__/*.test.sh`，也没有请求 full CI。

## QA claim 1494 长播报稳定性整改

QA 在精确头 `50208d4c4` 发现三个同一真人会话阻断，本轮只修这三项：

- announcer takeover 期间 RoomIO 仍持续上送 `unknown/no_active_speaker` 帧，旧代码把它们与 founder 语音一起缓冲，约 30 秒后必然触发 `live_lead_input_buffer_overflow`。新增 60 秒连续未知归属帧回归先红，最小修复只缓冲明确归属于当前 founder 的帧；未知帧丢弃，随后 founder 帧仍按原顺序回放。
- headphone claim 固定 60 秒，800 字播报在完成 ACK 前租约已过期。新增真实 `splitSpeechText` 与规范 `speakRequestDigest` receipts 的 150 秒 ACK 回归先红；默认 claim 现在按公开 speech brief 渲染文本（缺失时用正文）的 Unicode code point 数量估算，基线 60 秒、每字符 250ms、上限 15 分钟，显式测试 override 仍受同一上限校验。
- daemon 对外仍保持 `session_runtime_failed` 脱敏，但以前丢失了可诊断根因。回归用真实 QA 错误 `discord_audio:Cannot perform IP discovery - socket closed` 先证明 evidence 缺失；现在只写枚举化 `causeCode=discord_audio_ip_discovery_socket_closed` 到会话 evidence，原始错误、路径和 token 不进入记录或日志。

TDD 与最终本地证据：失败阶段分别稳定复现 unknown frame overflow、60 秒 claim 到期和 runtime cause evidence 缺失；修复后 voice-codex 精确 2 文件 28/28、Teamlead 精确 1 文件 15/15。直接消费者 `headphone-routes` 与 adapter→route 为 2 文件 5/5，Engine A composition 为 1/1。changed-TypeScript `vitest related`：voice-codex 5 文件 67/67；Teamlead 因 `headphone-inbox.ts → StateStore.ts` 的中央依赖自然展开为 572 文件、8010 passed / 4 skipped，命令为强制 related selector，不作为本地 full-suite 或 exact-head CI 证据。受影响 owner/dependency build 覆盖 16 个 package，Teamlead 与 voice-codex typecheck 均通过；7 个改动文件定向 Biome 0 errors，`git diff --check` 通过。根 `pnpm lint` 已执行，但仓库基线中的 FLY-1547/1563 research scripts、FLY-2560 replay tooling 等本 issue diff 外文件仍有 3 errors / 25 warnings，故 exit 1；没有越界修复。

Consumer discovery 对本轮 4 个生产 TypeScript 逐一执行完整路径、文件名、父目录三组 `git grep -lF`，命中计数（full/file/parent）为：`headphone-inbox.ts` 0/1/991、`live-lead-adapter.ts` 0/3/24、`daemon.ts` 13/33/24、`cli.ts` 10/230/24。保留的真实 executable consumers 为 `StateStore.ts`、headphone routes/collector/question authority、voice-codex index/realtime/session/cli、Engine A composition/reply events，以及对应精确测试；跨包 adapter→route、route consumer 与 composition 测试均单独执行，其他源码消费者由上述 related 图覆盖。

其余命中全部按类别排除：完整路径与 basename 命中的 `engineering/doc/**`、`product/doc/**`、review JSON、生成快照和 voice evidence 只保存路径或历史说明；`daemon.ts` / `cli.ts` 在其他 package 的同名文件是词法碰撞；child-process census、kill-path inventory、wrapper 与 package 脚本只引用入口路径而不消费本轮内部 API；父目录的 991/24 项除已列真实 imports/tests 外只共享目录字符串。`scripts/__tests__/flywheel-voice-wrapper.test.sh` 只检查 daemon 入口包装，既不读取本轮新 causeCode/claim/buffer 逻辑，也没有被修改；本轮没有新增或修改任何 `scripts/__tests__/*.test.sh`。实现节点没有请求 full CI，也不宣称 QA 真人 10 次延迟、字幕或耳机三件事已经重测。
