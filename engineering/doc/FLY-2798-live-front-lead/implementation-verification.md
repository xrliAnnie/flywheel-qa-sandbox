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
