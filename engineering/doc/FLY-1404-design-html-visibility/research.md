# FLY-1404 设计期可见性:design 完成必产 founder HTML — 调研

Issue: FLY-1404 (https://linear.app/geoforge3d/issue/FLY-1404/流程设计可见性-design-完成-必产-founder-设计-html图优先发-issue-thread-写进三段式-design)
日期: 2026-07-21
基于: exploration.md

逐个落点核查到 file:line,含现有机制的精确形态与本次要挂的位置。

## 1. 落点 A:design 阶段 prompt(Blueprint.ts)

### 1.1 标准 design phase

`packages/edge-worker/src/Blueprint.ts:1558-1565` — `isDesignPhase` 的 systemPromptLines,当前四步:

```
1. Read the codebase and understand the context (CLAUDE.md, relevant files).
2. Do the design: brainstorm → research → plan → design review.
3. Commit the design docs (exploration/research/plan + progress.md) to this branch and push.
4. Then complete the design phase with `flywheel-comm complete --route phase_design_complete`. ...
```

新交付物步骤插在 3 与 4 之间(commit docs 之后、complete 之前),后续步骤顺延重编号。此块 Claude/Codex 共用(isCodexRunner 分叉只发生在 keep-alive epilogue,`Blueprint.ts:1679-1692`),新增文本无 vendor 特定内容,天然共用。

### 1.2 mockup-first designer phase(对照与统一)

`Blueprint.ts:1543-1557`(FLY-1059)已趟通 runner 产 founder 视觉物料的完整先例,步骤 2 原话:

> "Assemble them into ONE founder card with founder-html-delivery / publish-report — publish WITHOUT --channel and hand the URL to your Lead; a Runner never posts founder material to Discord directly."

本次沿用同款**流程形态**(runner 产 → 交 Lead → Lead 发 thread),但**不沿用其机制文案** — 「publish WITHOUT --channel」是存量 bug(实际 fallback 投 generalChannel,见 §5 事实更正),两处 prompt 统一改用新 `--publish-only`。designer phase 步骤 5 要求 commit "the approved high-fidelity artifact + a one-page spec" 到分支 —— 按 brainstorm 裁定 2,designer phase 统一受 complete 校验、无豁免:其高保真工件本就是 HTML(frontend-design skill 输出),在其步骤 5 明确「工件含至少一份 .html,落 issue doc 文件夹」+ 最终稿 publish-only 上报(design review R1-3)。

### 1.3 prompt 可用的报告通道

Design runner 的 baseline 协议(AgentDispatcher 注入)已含 `flywheel-comm ask --lead <lead-id>`(FLY-161:ask → runner_question Bridge 事件 → Lead inbox + Discord 通知,非阻塞)。HTML 就绪的上报走这条现成通道 — **用 `--report` 变体**(design review R1:fire-and-forget 状态上报,排除 founder reply 误绑定;裸 ask 会成为可绑定候选,`ask.ts:9-17,33-47`)。消息格式约定为(供 Lead 规则匹配):

```
DESIGN-HTML ready: <hosted-url> | repo: <path-in-repo> | issue: <FLY-XX>
```

### 1.4 相关既有测试

- `packages/edge-worker/src/__tests__/Blueprint.fly793-phase-prompt.test.ts` — pin 三段式各 phase 的 prompt 文本(新步骤要更新断言)
- `packages/edge-worker/src/__tests__/blueprint-designer-phase.test.ts` — pin designer phase 步骤文本
- `packages/edge-worker/src/__tests__/Blueprint.fly1188-codex-prompt.test.ts` — pin codex variant 与 Claude 的字节对齐边界(1558-1565 共用块改动两边同时生效,需确认该测试断言不被破坏)

## 2. 落点 B:complete.ts 前置校验

### 2.1 现有结构

`packages/flywheel-comm/src/commands/complete.ts`:

- `:31-39` VALID_ROUTES 含 `phase_design_complete`(FLY-793)
- `:115-123` 该 route 现有唯一校验:拒 `--merged`/`--pr`
- `:193-197` `collectEvidence({baseRef, merged, pr})` — 已从 git 收集 `changedFilePaths`(`baseRef..HEAD` 的 `diff --name-only`,`:354-355`)
- `:310-318` `deriveIssueIdentifier()` — 从当前分支名匹配 `/[A-Z]+-\d+/`(实测本分支 `flywheel-FLY-1404` → `FLY-1404`)
- `:320-327` `deriveBaseRef()` — `merge-base HEAD origin/main`,失败 fallback `origin/main`

### 2.2 新校验的挂点与判据

挂点:`collectEvidence` 之后、payload 构造之前(需要 `evidence.changedFilePaths`)。仅当 `route === "phase_design_complete"` 时执行。

判据(brainstorm 裁定 1,限定 issue doc 文件夹,反空过):

```
存在 path ∈ changedFilePaths 使得
  path 匹配 /(^|\/)doc\/<IDENT>[^\/]*\//  且  path 以 .html 结尾(大小写不敏感)
其中 IDENT = deriveIssueIdentifier()
```

- 覆盖本仓 `engineering/doc/FLY-1404-<slug>/x.html`,也覆盖其他项目的 `<dept>/doc/<ISSUE>-<slug>/x.html`(FLY-205 doc-flow 的「部门优先 + 一 issue 一文件夹」约定,如 sub 的 `content/doc/LEARN-20-…/`)— 判据不硬编码部门名。
- ~~IDENT 不可得时降级为任意 doc/ 下 .html~~ **(superseded,design review R1-2)**:降级违反反空过裁定(有任何别的 issue 的 HTML 即可空过)→ 改 **fail-closed**(exit 1 + 分支名要求)。另两处 R1 强化:边界正则 `doc/<IDENT>(?:-[^/]+)?/` 防 FLY-14040 前缀碰撞;判据改用 `--diff-filter=ACMR` + HEAD 存在性验证,封「删除既有 HTML 也算 diff 命中」的绕过。终形见 plan §2。
- 失败输出(exit 1)自带**完整补救协议**(R2-6):模板 5 节 + 落点 + commit/push + publish-only + ask --report + 重跑 complete — 这是版本交错窗口里旧 prompt runner 的唯一指引。

### 2.3 开关(brainstorm 裁定 4)

`FLYWHEEL_DESIGN_HTML_GATE=0` 时跳过校验并在 stderr 打一行显式日志(「design-HTML gate DISABLED via env」)。默认(未设/非 0)校验生效。仅影响 `phase_design_complete` route — 三段式本身是 per-project opt-in(`pipeline.three_stage`),不构成对现有单段 runner 的行为变化;对已在跑三段式的项目属于「新硬门默认开」,与 issue 验收(缺 HTML 时 design 无法 complete)一致。

### 2.4 Bridge 侧接收面(~~零改动~~ **superseded,design review R1-4/R2-2/R2-3**)

`session_completed` 的接收面:

- `packages/teamlead/src/bridge/event-route.ts`:**enrolled generalized 完成在 `commitEnrolledCompletion()`(`:617-661` → `StateStore.ts:15446-15581`)处提前提交事务并 return**(receipt + design_done edge + successor dispatch + 终态),legacy 分支在 `:1293-1298`
- `packages/teamlead/src/DirectEventSink.ts:668`(进程内 sink,同款映射)
- `packages/teamlead/src/bridge/complete-marker-reconciler.ts:268-300`(崩溃恢复 marker 重放 — parseMarker **不看证据**,现测试甚至断言无 changed paths 的 marker 可推进 design_done)

R0 的「三 sink 零改动」结论被 review 推翻:marker replay 是**存量**旁路,enrolled 路径的挂点若放在 `:1293` 前也会被提前事务绕过;而拒绝语义若用 ok:true+warning,旧 CLI(只看 `response.ok`,`complete.ts:251-268`)会当成功 — 恰好制造状态撕裂。**payload 路径谓词方案也被 R3 证伪**(`changedFilePaths` 含删除项,删除-only 的旧 payload/marker 会被误认有证据)。终形(plan §8):新 CLI git 强校验通过后 mint **versioned attestation**(`designHtmlEvidence`),接收面在 enrolled canonical commit **之前** + legacy 分支前只认严格解析(`parseDesignHtmlEvidence`)后的 attestation,identifier 权威源 = session row `issue_identifier`;HTTP 拒绝 = **409 + 稳定 error code**;缺/坏 attestation marker quarantine(FLY-172 机制);DirectEventSink 无合法载体 → 永远 fail-closed。

### 2.5 相关既有测试

`packages/flywheel-comm/src/__tests__/complete.test.ts`(**路径更正**,design review R1-5)— 现有 route 校验/证据收集测试所在文件,新校验单测加在这里(beforeEach 清 `FLYWHEEL_DESIGN_HTML_GATE` 防环境泄漏)。

## 3. 落点 C:Lead 规则(department-lead-rules.md)

### 3.1 装载链(brainstorm 裁定 3:零链改动)

- 文件:`packages/teamlead/lead-rules-base/department-lead-rules.md`(FLY-127;非-cos 部门 Lead 全量装载)
- 选择位点:`packages/teamlead/scripts/claude-lead.sh:2221`(`rules_bundle_add "$BASE_DEPT_RULES" base`)— **不动**
- FLY-1402 单 bundle 装载链(`lead-rules-bundle.sh` materializer + `check-rules-truth.mjs` + parity test `lead-rules-bundle.test.ts`)按内容 hash 打包,改文件内容不改选择集 → **装载链三处全部零改动**
- 现有章节结构:Reply Discipline(FLY-162)/ Action Gate / Runner Question Handling(FLY-161)/ Shared Channel(FLY-152)/ Gate Timeout(FLY-159)/ Order of precedence — 新节挂在 Runner Question Handling 之后语义最近(触发面同为 runner 上报)

### 3.2 Lead 侧触发面(核验时机)**(部分 superseded,design review R1-6/R3-4 — 终形见 plan §5)**

Lead 能观察到 design 完成的两个信号:

1. **runner 的 DESIGN-HTML ready 上报**(§1.3 格式,经 FLY-161 通道进 inbox)— 正常路径:收到即走 founder-html-delivery skill 把 URL 投对应 issue thread(founder-html-delivery.md 底线:绝不贴本地路径)
2. ~~状态行翻到 implement 作为兜底核验点、命令 parked design runner 补产~~ **(superseded)**:design_done 没有推送给 Lead 的 lifecycle 事件,「翻段时核验」不是 Lead 真实会收到的触发 — 终形是**机会式核验**(任何与该 issue 的交互中发现已到 implement 且从未收到上报,才触发),且 parked design runner 的补救是**只读**的(见 3.3 修订)。

### 3.3 打回语义的边界**(superseded,design review R1-6/R3-4 — 终形见 plan §5-2/3)**

~~命令 park 的 design runner 补产 HTML 并上报;补产 HTML 可仅以 hosted URL 形态投递~~ → 终形:CLI 门保证正常路径下 HTML **已 commit**,parked design runner 的迟到补救只做**只读动作**(publish-only + report 已提交的工件),绝不写 worktree(TURN 在 implement 手上 — FLY-921);只有「确实没 commit」(门被逃生 env 绕过)时,才由当前 TURN 持有者(implement)写入并 commit。不阻塞、不回滚 implement 不变。

## 4. 非阻塞语义与反馈修正流(零代码改动,纯协议)

- handoff 链路:`event-route.ts:1293`(design_done)→ `phase-orchestrator.ts:1089-1160` `onPhaseComplete` → `handoff(implement)` — **不看任何 review、零改动**,非阻塞天然成立。
- founder 反馈修正流(brainstorm 裁定 5,FLY-1392 实测路径):founder 在 thread 反馈 → Lead relay 给当前 TURN 持有者(通常 implement runner)→ 它在 issue doc 文件夹写 `design-correction.md`(废除概念/保留器官/founder 原话引用)→ 增量 review 覆盖。写进 Lead 规则新节 + design/implement prompt 不需要额外机制。
- design runner park 存活期间可被咨询(回答设计意图),但不写 worktree(TURN 纪律)。

## 5. 投递与发布面(现成基建为主;publish-report 本单加 --publish-only,见 plan §6)

- `flywheel-comm publish-report`(FLY-203,`packages/flywheel-comm/src/commands/publish-report.ts`):`--html <path> --project <name> [--title] [--channel]`。~~无 --channel = 只发布不发 Discord~~ **(事实更正,design review R1-1)**:publish 后**无条件**继续 screenshot + `/api/reports/deliver`,channel 缺失时 Bridge fallback 投到项目 **generalChannel**(`reports-route.ts:368-383`)— designer phase 先例 prompt 里的「WITHOUT --channel」文案本身是存量 bug。终形(plan §6):新增向后兼容 `--publish-only`(只发布拿 URL,跳过 screenshot/deliver),现无-channel 语义不动。发布失败的降级:runner 把 repo 路径经 ask --report 上报,Lead 侧用 founder-html-delivery skill 自行发布(skill 自含失败处理)。
- `founder-html-delivery` skill(flywheel-skills 库,FLY-214;Lead 侧规则文件 `lead-rules-base/founder-html-delivery.md` 已全 Lead 装载):Lead 投递的唯一合规通道,发「标题 + 整页截图 + 链接」一条消息进 thread。
- HTML 本体 commit 进 issue doc 文件夹随分支 merge 进 main — 同时是 complete 校验的 git 证据与设计的永久档案。

## 6. 波及面清单(implement 阶段的完整触点)

(R1/R2 修订后的终表;明细见 plan §12 里程碑)

| 触点 | 文件 | 改动性质 |
|------|------|---------|
| 共享谓词 | `packages/flywheel-comm/src/design-html-evidence.ts`(新)+ package.json subpath export | 新模块(CLI + Bridge 共用;根入口是执行 main() 的 CLI,必须 subpath) |
| complete 校验 | `packages/flywheel-comm/src/commands/complete.ts` | fail-closed 校验 + gitObjectExists + env 开关 |
| publish-report | `packages/flywheel-comm/src/commands/publish-report.ts` | 新 --publish-only(向后兼容) |
| design phase prompt | `packages/edge-worker/src/Blueprint.ts:1558-1565` | 七步(交付物 + publish-only + ask --report + 非阻塞) |
| designer phase prompt | `packages/edge-worker/src/Blueprint.ts:1543-1557` | 修存量文案 + 最终 HTML 交付步骤 |
| generalized 协议块 + invariant | Blueprint generalized 分支 + snapshot/dispatch admission | 写能力 design 节点注协议块;no-write+design route 组合 fail-closed |
| dispatch admission | design 系 dispatch 位点 | Lead 必解析,缺失 fail-closed |
| Bridge 接收面 | event-route(enrolled 前置 + legacy)/ DirectEventSink / marker-reconciler | attestation-only admission(严格 parse + session-row identifier authority,HTTP 409)/ DirectEventSink 永远 fail-closed / 缺 attestation marker quarantine |
| Lead 规则 | `packages/teamlead/lead-rules-base/department-lead-rules.md` | 新增一节(文本) |
| prompt 测试 | fly793 / designer-phase / generalized-workflow / fly1188 | 更新断言 + invariant 用例 |
| complete 测试 | `packages/flywheel-comm/src/__tests__/complete.test.ts` | 11 类用例(见 plan §9) |
| PhaseOrchestrator handoff | phase-orchestrator.ts | **零改动**(非阻塞 = 现状) |
