# FLY-1018 /gemini-advanced 正式建造 — QA 报告(三段式 QA 阶段)

Issue: FLY-1018 (URL 不可得,只写 issue 号)
日期: 2026-07-10
基于: plan.md / research.md / exploration.md / harness-evidence.md + 本分支已提交实现

**判定:PASS(限代码/护栏/集成层)** — 代码正确、完整对齐 plan 的 implement-phase 验收标准,测试充分,三层护栏结构上 + 端到端都成立。真机 Discord E2E(真人 `/gemini-advanced` 斜杠交互,即 QA-6)**未在本阶段跑,且未豁免** —— 它按 plan §7 归「真启用前的独立 QA」,改挂到下方的 **Enablement 硬门**。本次是 feature-flag **default-off** 代码 ship,不对 Annie 真启用、Annie 面前不会出现任何东西,故本 ship 合规。

---

## 0. ⚠️ ENABLEMENT CHECKLIST(真启用硬门 — 启用/请 Annie 前不可跳)

> **本 ship 只落 default-off 代码,不启用。** 真正对 Annie 打开 `/gemini-advanced`(设 `FLYWHEEL_GEMINI_AGENT` 等 env + 起 daemon + 让她真用)**必须**先过下面这道门。这不是可选步骤,也没有在本 ship 里被豁免 —— 它是 plan §7「独立 QA session」的落点,本次因被测 daemon 从未起过(无 daemon 进程 / 无 bindings 配置 / 无 `GEMINI_API_KEY` / 无 bot)而无法在此阶段执行,故显式挂到 enablement 步:

- [ ] **staged venue 起实例**:FLY-882 池 claim 一个测试 bot(Tadashi 手续,bot 只进测试 guild、不进 #core)+ 配 `~/.flywheel/gemini-agent.json` binding(channelId / projectName / **leadId 必填** / identityPath / contextNote)+ 设 `FLYWHEEL_GEMINI_AGENT=1` + `GEMINI_API_KEY` + `FLYWHEEL_BRIDGE_URL` + scoped `FLYWHEEL_GEMINI_AGENT_BRIDGE_TOKEN` → 起 `flywheel-gemini-agent daemon`。
- [ ] **QA-6 真机走全程**:用 Claude-in-Chrome 以 Annie 名义在测试 guild 走 `/gemini-advanced` 全链 —— 派活(create_issue→dispatch_runner)/ 查状态(query_status)/ 记 memory(save_memory)/ ship 意愿呈报(request_ship_approval 出现在 Lead/founder 面),截图留证。
- [ ] **M4 服务端 scoped-token 真机 403 取证**:拿 scoped token 手打一条 reserved `/api/actions/*` → 403 + Bridge log(plan §7.2)。
- [ ] **审计完整性**:抽一条 session JSONL 逐事件核(先写后调顺序、脱敏)。
- [ ] **绿了才许**:以上全绿,才允许对 Annie 真启用 / 才允许请她上手。任一未过,不 enable、不请她。

**责任人**:Tadashi(bot 手续 + venue)+ 独立 QA session(执行 QA-6)。本条同步进 PR #518 描述的「Enablement checklist」段。

---

## 1. 验证范围与方法

QA 对象:PR #518(`packages/gemini-agent` 新包 M1-M4 + Bridge ship-request route + M4 scoped token),head `8510cc71`,base main。本分支落后 main 125 commit → diff 用 `main...HEAD`(merge-base..HEAD)比对,mergeable=**MERGEABLE** / mergeStateStatus=**CLEAN**(无冲突)。

方法:① 跑全测试套件 + typecheck + build + lint;② 跑 CI 静态守卫;③ 逐文件审查三层护栏 + M4 中间件 + config fail-closed 的**结构正确性**(不只看"测试过了");④ 补一个真实缺口的全栈集成测试并跑通。

**边界(如实)**:本 QA 环境**无 GEMINI_API_KEY**,无法驱动真模型。plan §7 的真 Bridge(529 Room)矩阵 + 真 Discord bot E2E 是**独立 QA session** 的事,以**真启用**为前提;本次 default-off ship 不启用,真启用对 Annie 的硬前提 = M4 merge + 独立 §7 QA PASS + founder 批准(后续独立一步)。implement 阶段已跑过两次真 API delegate replay(harness-evidence.md),我核对了它抓到的 wire bug(abortSignal 误进 body)已在 client.ts 修复。

## 2. 测试与门禁结果

| 项 | 结果 |
|----|------|
| gemini-agent vitest | **170 passed**(165 既有 + 5 本次新增集成) |
| teamlead 相关 vitest(ship-approval-route / gemini-scoped-token / ship-approval-render / runner-status-endpoint / create-issue) | **78 passed** |
| gemini-agent typecheck (`tsc --noEmit`) | 干净,exit 0 |
| gemini-agent build (`tsc`) | 干净,exit 0 |
| biome lint(新测试文件) | 干净 |
| CI 静态守卫 `scripts/gemini-agent-guard.sh` | **ALL GATES GREEN**(reserved endpoints / imports / credentials / 6-tool registry) |

## 3. 三层护栏 — 结构性核查(独立 code review)

**Layer 1 · 注册表封闭(无 merge/ship 工具)**:`tools/schemas.ts` 恰 6 个工具声明,**无任何 merge/ship/deploy 工具**;唯一 ship 相关的 `request_ship_approval` 是 **request 型**(description 明确"You cannot merge, ship, or deploy anything yourself … Never claim a PR is merged")。守卫脚本对 `name: "` 计数 == 6,工具集变更必须显式改守卫(评审可见)。

**Layer 2 · ship 意图 → 纯"呈报"(零权威)**:`bridge/ship-approval-route.ts` 只写一条 `ship_approval_request` lead event,经 `StateStore.recordShipApprovalRequest` 的**事务外发对**落盘(lead_event + request 行同一 better-sqlite3 `transaction()` 成对提交,异常整体回滚 → 零孤儿事件、零半写行,已用真 PK 冲突驱动的回滚测试验证)。**零 CommDB 写、零 approve_to_ship gate/binding、零 verify-approval 触碰**(zero-CommDB sentinel:`FLYWHEEL_COMM_DIR` 全程空)。目标 Lead **显式来自 leadId**,校验 `leadId ∈ ProjectEntry(projectName).leads`,未知 project / 非成员 leadId → 400,**绝不 fallback leads[0]、绝不伪造 session/issue 身份**(execution_id/issue_id 留空)。tokenless 部署在**解析 body 之前** 503(真 plugin.js 全栈测过 malformed/oversized body 仍 503)。

**Layer 3 · 出站白名单 + 服务端 scoped token**:
- 客户端:`tools/bridge-client.ts` 的 `WHITELIST` 恰 6 条 route,`request()` 对白名单外路径(含 `/actions/approve`、`/api/actions/approve`)在 **fetch 之前 throw** `EndpointNotAllowedError`;Bearer 仅 scoped token。
- 服务端(M4):`plugin.ts` `tokenAuthMiddleware` 三分支——主 token 全通(字节不变)/ scoped token 且 (method,path) ∈ 可达集 → next / scoped 越界 → 403 + 日志(路径+时间,**不含 token**)/ 都不匹配 → 401。真中间件 + 真 HTTP 测过 scoped 打 `/api/actions/retry` → 403。
- config fail-closed:`config.ts` scoped == 主 token(trim 比对)→ loadConfig **throw**(Bridge 拒启);scoped 配了但主 token 没配 → ERROR log + 忽略;不配 = `geminiAgentToken` undefined(字节兼容 sentinel 测过)。

**Dispatch 三段闸**(`loop.ts`):顺序固定 audit-first → 白名单 → schema 校验;幻觉工具名**永不执行**,合成 isError 回喂含可用工具清单,`hallucinatedToolCalls++`;abort 中途悬空 call 必回合成 isError(配对不变量);四个熔断(abort/maxSteps/token 预算/context overflow)**全走 Terminal 退出,绝不 throw**;工具 HTTP ≥400 作 isError 回喂,循环继续。

**Binding server-attach(FLY-1060 kickback 修复)**:`create_issue` 合入 binding `deptLabel`(F2,大小写去重)、`save_memory` 合入身份三元组 messages[]/project_name/agent_id/user_id(F4)、`request_ship_approval` 合入 projectName/leadId——全部从 session binding 附带,**在模型的幻觉面之外**(模型 schema 只见 prUrl/summary/requesterContext)。

## 4. 本次新增覆盖(填补真实缺口)

`packages/gemini-agent/src/__tests__/full-stack-integration.test.ts`(+5 测)。

**缺口**:包内每个既有测试都只让 wire 一侧为真——loop.test.ts 用 **stub registry**(execute 返回罐装 ToolResult),bridge-client.test.ts 用 **fake fetch**。**没有任何单测同时接真 loop + 真 registry + 真 BridgeClient + 真 HTTP**(mock-需集成补位)。本次补齐:脚本化 ModelSurface → 真 `runLoop` → 真 dispatch 三段闸 → 真 `createToolRegistry` → 真 `BridgeClient`(白名单 + Bearer + 真 fetch)→ 进程内真 HTTP Bridge(说 6 工具合同、记录 wire)。

证到 seam 级测试证不到的三点:
1. **N1 短链真 HTTP 端到端**:create_issue → dispatch_runner → query_status → save_memory 恰 4 次命中 socket、顺序对、全 Bearer scoped-token。
2. **binding 字段真的上了 wire**:create_issue body 带 `labels:["backend"]`(F2);save_memory body 带完整身份三元组(F4);request_ship_approval body 带 projectName/leadId(模型没供)。
3. **护栏端到端有真牙**:幻觉 `merge_pr` + `deploy` 被 dispatch 闸拦、**从未到达 Bridge socket**,合法 create_issue 照常;`BridgeClient` 对 `/api/actions/approve` 在任何 socket 流量前 throw。**额外发现**:模型即使在 args 里夹带 `projectName`/`leadId` 想改 ship 目标 Lead,也被 schema 闸当**未知参数拒绝**(request_ship_approval 只 advertise 3 个字段)→ 目标 Lead 无法被模型篡改。

## 5. 其他核查

- `@google/genai` **精确 pin `2.10.0`**(无 caret,plan §2.1 要求)。
- model id pin:flash=`gemini-3.5-flash` / pro=`gemini-3.1-pro-preview`(plan §2.7,风险登记里"model id 漂移"的 config 常量表)。
- PR mergeable=MERGEABLE / CLEAN(落后 125 commit 但无冲突);feature default-off(不配任何新 env = 字节兼容,sentinel 测过)。

## 6. 判定与后续

**PASS(限代码/护栏/集成层)**。implement-phase 验收(§9 前四项 + 守卫进 CI + route 测绿 + 字节兼容 sentinel)满足;三层护栏结构上 + 端到端成立;红线(founder-merge-gate 零改动、agent 零 comm.db / 零 reserved endpoint / 进程无 merge 凭证)全部守住。**本次 ship = default-off 代码,Annie 面前不出现任何东西。**

**真机 Discord E2E(QA-6)未跑、未豁免 —— 改挂到 §0 Enablement 硬门**:真人 `/gemini-advanced` 斜杠交互按 plan §7 属「真启用前的独立 QA session」;本阶段无法执行的**事实原因** = 被测 daemon 从没起过(核查四项全空:无 daemon 进程 / 无 `~/.flywheel/gemini-agent.json` bindings / 无 launchd job / 无 `GEMINI_API_KEY`),而起 venue 需 FLY-882 bot 手续(Tadashi)+ API key + guild,不在本 default-off 代码 ship 的范围内。故它**不是被跳过,是被正确地重新挂到 enablement 步**(见 §0 checklist);真启用对 Annie 的路径 = 本 PR merge → §0 Enablement 硬门(含 QA-6)全绿 → 才 enable / 才请她。

**其他(非缺陷)**:ship 时若 rebase over main 才可能触发冲突(当前 CLEAN);ship executor 在 merge 时应复核。
