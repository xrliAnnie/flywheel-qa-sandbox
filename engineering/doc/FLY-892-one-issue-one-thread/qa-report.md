# FLY-892 一 issue = 一 thread — QA 报告

Issue: FLY-892 (https://linear.app/geoforge3d/issue/FLY-892/pipelineux-一-issue-一-thread-收敛三段式-designimplementqa-三-thread-lead-chat)
日期: 2026-07-05
基于: plan.md

## 结论:PASS

Implement 段(commits `4fa3762d`..`68590fe1`)已完整实现 plan.md 的全部 8 个 Step,单测 + lint + 全仓 build + 真机 Discord E2E 均通过,未发现回归。

## 验证内容

### 1. 全量单测

- `pnpm -r build`(16/17 workspace 包)全绿,零 TS 类型错误 —— Step1/2 删 `chatThreadRole` role 参数是约 10 个文件的机械改动,编译期已锁死行为收敛。
- `packages/config`:20 个测试文件、332 测试全绿(含新增 `fly892-phase-tag.test.ts` 9 例)。
- `packages/teamlead`:365 个测试文件、5037 个测试用例,**5013 通过**,24 失败。24 个失败逐一核对后确认与本次改动**无关**、属已知环境性失败:
  - `codex-lead-runtime.test.ts` 22 例:`FLYWHEEL_CODEX_LEAD_WORKSPACE must not overlap ~/.flywheel` —— 本机 `TMPDIR` 落在 `~/.flywheel/runner-state/...` 下触发的路径重叠自检,与本 PR 未触碰的 `codex-lead-runtime.ts` 无关(memory: `reference_qa_codex_lead_runtime_tmpdir_overlap`)。
  - `LeadAlertNotifier.test.ts` 1 例:断言期望 mock token,收到本机 shell env 里的真 bot token —— 环境变量泄漏,非本 PR 文件。
  - `post-merge.test.ts` 1 例:并发跑全仓测试时 5000ms 超时;单独重跑该文件 6/6 秒过(0.46s),确认是系统负载下的计时抖动,非回归。
  - FLY-892 触碰的全部 19 个测试文件(`ChatThreadCreator.test.ts` 63 例、`phase-chat-threads.test.ts`、`StateStore.test.ts` 96 例、4 个新增 `fly892-*.test.ts`、`event-route.attach-pin.test.ts` 等)**全部通过**,含既有的 FLY-91/FLY-560/FLY-755/FLY-793 byte-compat 断言。
- `pnpm lint`:0 error,14 个 warning 全部落在本 PR 未触碰的文件(`runner-idle-watchdog-quiet.test.ts`、`qa-fly-863-codex-hold-signal-e2e.mjs`)。

### 2. 真机 Discord E2E(模块驱动,529 QA Room slot-2)

跑 `scripts/qa-fly892-real-discord-thread-e2e.mjs`(已提交,可重跑复验):直接 import 编译后的生产代码(`StateStore`/`ChatThreadCreator`/`reconcileLegacyPhaseThreads`/`phaseMessageTag`/`phaseThreadBadge`),真 fetch 打真 Discord API(slot-2 `product-lead-test` 频道),不 mock Discord。**34/34 断言 PASS**,覆盖:

| Step | 场景 | 结果 |
|---|---|---|
| 1/2 | design→implement→qa 顺序 ensure 收敛到同一条真实 Discord thread(仅第一次真建 thread,后两次复用) | ✅ |
| 1/2 | design+implement **并发** ensure → in-flight dedup,仅一次真建 thread(StateStore 仅一行) | ✅ |
| 1/2 | Lead `/api/chat-threads/send` 的 `getChatThreadByIssue` 查找与三段 session 共享**同一条**thread(no bifurcation) | ✅ |
| 3 | `phaseMessageTag` 三段+模型标签(`[设计·Fable]`/`[实现·Opus]`/`[QA·Sonnet]`)+ main 空串;真发到同一 thread | ✅ |
| 4 | pipeline header 真 POST + pin(测试 bot 无 MANAGE_MESSAGES → 403,自愈路径按预期记 `pinnedAt=null`);阶段推进**原地编辑同一条**消息;内容不变的重复调用零变化(幂等) | ✅ |
| 5 | boot sweep **有 main thread** 分支:真发指针消息 + 真归档 legacy thread;二次跑幂等(不再处理已归档行) | ✅ |
| 5(Codex R1 #1) | boot sweep **无 main thread 且 issue 仍活跃** → **fail-closed 跳过**,legacy thread 保持 OPEN;issue 转 terminal 后同一 thread 才被真归档 | ✅ **(全 issue 最关键的安全属性,已在真 Discord 上验证两条分支)** |
| 6 | `phaseThreadBadge` 阶段级徽章(🎨设计/🔨实现/🧪QA);真 PATCH 改名,阶段切换后**无残留**(无 🔨 残留在 🧪QA 标题里);main 徽章为空(FLY-560 字节兼容) | ✅ |

真机测试产生的 4 条 Discord thread 已在脚本末尾/手动全部归档,slot-2 测试频道未留脏数据。

### 3. 代码走查(关键集成点)

- `event-route.ts` 的 `pinRunnerAttachForSession`:确认单-runner "Runner terminal" 置顶固定用 Lead bot token(`ctx`),仅三段 pipeline header 用 `headerCtx`(`resolveAnnouncerBotToken` 命中则 announcer,否则回退 Lead bot)—— 与最新 commit `68590fe1`(Codex R1 Med 修复)一致,与 plan Step 7 路由表一致。
- `plugin.ts` 的 boot sweep 挂载:一次性、try/catch 包裹、非阻塞、无新周期 timer —— 与 plan §9(纯 Bridge 侧、单次重启)一致。
- `buildPipelineHeaderContent` 的 "计划模型" 冗余显示(`[QA·Sonnet] ⬜ 未开始（计划模型 Sonnet）`)核对 `mockup.html:70` 逐字一致 —— 非 bug,是 Annie 已批准的 mockup 格式。

## 已知未覆盖(非阻塞)

- **Step 7 announcer bot 身份路由**的"真实换绑定 token"未在真 Discord 上端到端验证(需要为测试 slot 项目额外配置第二个 bot token 才能在 API 层面区分两个身份发帖,超出本次 QA 的合理范围)。该行为已有 81 个单测覆盖(`fly892-announcer-config.test.ts`),且默认关闭(未配置 = 现状 Lead bot,byte-compat)。生产要启用需项目配置 `announcerBotTokenEnv`,建议下次真正启用时补一次针对性真机验证。
- 未跑完整三段真实 Claude Runner(design→implement→QA 三个真实 session)走完整流水线 —— 相当于跑数小时的真实 issue,超出 QA 时间窗;已用模块驱动方式对**同一批生产函数**做真 Discord 验证覆盖等价路径(创建/复用/打标签/置顶/归档/改名),风险已充分覆盖。

## 部署提醒(照抄 plan §9)

纯 Bridge 侧 + edge-worker ctx 清理 → 单次 Bridge 重启即可生效(Runner/Lead 不动)。与在飞的其他 Bridge PR 攒批重启。
