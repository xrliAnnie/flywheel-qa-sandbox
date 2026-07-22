# FLY-1404 设计期可见性:design 完成必产 founder HTML — 实施计划

Issue: FLY-1404 (https://linear.app/geoforge3d/issue/FLY-1404/流程设计可见性-design-完成-必产-founder-设计-html图优先发-issue-thread-写进三段式-design)
日期: 2026-07-21
基于: research.md

Version: v1.58.0(暂定,ship 取空号)
Status: codex-approved(R5 APPROVED,2026-07-21;R1×6 + R2×7 + R3×4 + R4×5 全采纳 + R5 两条非阻断措辞已折入,见 §13)

## 0. 一句话

三段式 design 完成时,design runner 必须产出并 commit 一份 founder 友好设计 HTML(图优先,5 节模板);`complete --route phase_design_complete` 与 Bridge 各接收面用同一共享谓词 fail-closed 校验(Bridge 侧拒绝 = 非 2xx,绝不 ok:true);runner 用 publish-only 发布拿 URL、经 ask --report 上报,Lead 走 founder-html-delivery 投对应 issue thread;implement 照常启动零等待(非阻塞)。

## 1. Scope

**In**:
- B1 `complete.ts`:phase_design_complete 前置校验(共享谓词 + ACMR diff + HEAD 存在性)+ env 逃生口
- B2 `Blueprint.ts` isDesignPhase prompt:交付物步骤 + 投递协议 + 非阻塞语义
- B3 `Blueprint.ts` isDesignerPhase prompt:最终高保真 HTML 的 publish-only + 上报步骤;修正存量「publish WITHOUT --channel」错误文案
- B4 `department-lead-rules.md`:新节(投递/机会式核验/TURN 纪律/反馈修正流)
- B5 `publish-report.ts`:新增 `--publish-only`(只发布拿 URL,不截图不投递;向后兼容,不改「缺 channel → generalChannel」现语义)
- B6 generalized workflow:**capability invariant** — `completion_route=phase_design_complete` 必须 `shared_branch_writer=true`,违反即 fail-closed(wiring bug);合法 generalized design 节点注入与 B2 同源的交付协议块
- B7 sister-sink 校验对齐:新 CLI 写 versioned attestation(`designHtmlEvidence`,git 强校验通过后才写);event-route(**含 enrolled 早期事务路径**)只认合法 attestation 做 admission(HTTP 拒绝 = 409 + 稳定 error code);**DirectEventSink 对该 route 一律拒绝**(无合法 attestation 载体,见 §8.2);marker-reconciler 只认合法 attestation,缺/坏则隔离(quarantine)
- B8 dispatch admission:phase_design_complete 路由的 session,dispatch 时必须有已解析 Lead,缺失 fail-closed(投递链路不能无人消费)
- 对应测试(见 §9)

**Out**(诚实边界,见各节):
- PhaseOrchestrator handoff 逻辑零改动(非阻塞 = 现状)
- 不做机器级「投递回执」状态(Lead 规则层兜底)
- 非 phase_design_complete route 不受此门
- sink 侧只校验 payload 证据形态(结构化防御,见 §8),不重放 git;深度伪造 payload 属恶意,超出威胁模型

## 2. B1 — complete.ts 校验(fail-closed)

文件:`packages/flywheel-comm/src/commands/complete.ts` + 新共享模块

### 2.1 共享谓词(单一出口,供 CLI + Bridge 复用)

新文件 `packages/flywheel-comm/src/design-html-evidence.ts`。**导出方式:package.json 新增专用 subpath export `"./design-html-evidence"`**(R2-4:包根入口是无条件执行 main() 的 CLI,绝不能从根导入;既有安全共享模式即显式 subpath exports)。teamlead 已依赖 flywheel-comm workspace 包,import 方向成立。

```ts
/**
 * FLY-1404: shared admission predicate — does this path list contain a
 * founder design HTML inside THIS issue's doc folder? Used by the
 * `complete` CLI (against git-derived paths) and by the Bridge sinks
 * (against parsed attestation paths) so all admission surfaces agree.
 * Boundary: `doc/<IDENT>/` or `doc/<IDENT>-<slug>/` — `FLY-14040-x` must
 * NOT match `FLY-1404` (prefix-collision guard).
 * STRICT by contract (R2-4 + R4-1): invalid identifier (must match
 * /^[A-Z]+-\d+$/), non-array paths, or ANY non-string item → NO MATCH
 * (empty result — mixed arrays are rejected wholesale, not filtered),
 * NEVER throws. Malformed payloads happen without malice.
 */
export function findDesignHtmlPaths(
	paths: unknown,
	issueIdentifier: unknown,
): string[] {
	if (typeof issueIdentifier !== "string" || !/^[A-Z]+-\d+$/.test(issueIdentifier))
		return [];
	if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string"))
		return [];
	const re = new RegExp(`(^|/)doc/${issueIdentifier}(?:-[^/]+)?/`);
	return paths.filter((p) => /\.html$/i.test(p) && re.test(p));
}
```

identifier 校验后才内插正则(格式即白名单,无元字符注入面)。

同模块再提供**唯一的 attestation 解析器**(R4-1:各 sink 不得自拼 shape check):

```ts
/** Strict schema parse for the FLY-1404 attestation. Rejected = reason string. */
export function parseDesignHtmlEvidence(
	value: unknown,
): { ok: true; issueIdentifier: string; paths: string[]; headSha: string }
 | { ok: false; reason: string };
```

接受条件(缺一即 rejected,绝不 throw):非数组的 plain object、`version === 1`、`issueIdentifier` 命中 `^[A-Z]+-\d+$`、`paths` 非空数组且 `every(typeof === "string")`、`headSha` 命中 `^[0-9a-f]{40}$`(与 `evidence.headSha` 同契约,`complete.ts:375-378`)。

### 2.2 CLI 校验(挂点:collectEvidence 之后、payload 构造与 marker 写入之前)

仅 `route === "phase_design_complete"`:

1. **逃生口**:`FLYWHEEL_DESIGN_HTML_GATE === "0"` → 跳过 + stderr 一行显式日志(「design-HTML gate DISABLED via FLYWHEEL_DESIGN_HTML_GATE=0 — skipping founder design HTML validation」)。
2. **identifier fail-closed**(R1-2a):`deriveIssueIdentifier()` 不可得 → exit 1,报错指明「分支名须含 issue token(如 proj-FLY-123);逃生口 env」。**不降级**。
3. **强化判据**(R1-2c):不用 payload 的 `changedFilePaths`(含删除项),另跑
   `git diff --name-only --diff-filter=ACMR <baseRef>..HEAD` 取「新增/修改」路径 → `findDesignHtmlPaths()` 过滤 → 候选逐个用**新 helper** `gitObjectExists(ref, path): boolean` 验 HEAD 真实存在(R2-4:基于 `execFileSync` 的成功/异常区分 `git cat-file -e`;**不得复用**现有 `git()` helper — 它把成功空输出与失败压成同一空串)。至少一个存在才过。payload 的 `changedFilePaths` 字段本身**字节不变**。
4. **失败输出**(exit 1)含**完整补救协议**(R2-6:这段文字是版本交错窗口里旧 prompt runner 的唯一指引,必须走得完全程):5 节模板结构 → 落 `doc/<IDENT>-<slug>/` → commit + push → `publish-report --html <path> --project <name> --publish-only` 拿 URL → `ask --lead <lead> --exec-id <id> --report "DESIGN-HTML ready: …"` → 重跑 complete。

## 3. B2 — Blueprint isDesignPhase prompt(`Blueprint.ts:1558-1565`)

现四步改为七步。插值全部用该作用域已有变量,与 line 1807 先例同形:`${commCliPath}`、`${executionId}`、`${ctx.leadId}`(B8 保证非空,见 §7.2)、`${ctx.projectName ?? ctx.teamName}`。prompt 测试断言渲染后**不存在任何**字面占位符(含 `<lead>`,R2-5)。

```
1. Read the codebase and understand the context (CLAUDE.md, relevant files).
2. Do the design: brainstorm → research → plan → design review.
3. Commit the design docs (exploration/research/plan + progress.md) to this branch and push.
4. MANDATORY DELIVERABLE — founder design HTML (FLY-1404): produce a founder-friendly
   design HTML in THIS issue's doc folder (doc/<ISSUE>-<slug>/), commit it to this
   branch and push (`complete` fail-closes without a committed HTML there — the gate
   verifies the commit; pushing keeps the shared branch durable). Diagram-first, five
   sections: ① one-sentence what this design does ② core flow diagram (Mermaid/SVG;
   before/after comparison when changing an existing flow) ③ how the data/structures
   stand ④ key tradeoffs + the rejected alternatives ⑤ honest boundaries (what this
   design does NOT do). Style: the project's html-report-style (Apple-style light theme).
5. Publish it: `node ${commCliPath} publish-report --html <abs-path> --project
   ${ctx.projectName ?? ctx.teamName} --publish-only` (publish-only: hosted URL comes
   back, NOTHING is posted to Discord), then hand it to your Lead:
   `node ${commCliPath} ask --lead ${ctx.leadId} --exec-id ${executionId}
   --report "DESIGN-HTML ready: <hosted-url> | repo: <repo-path> | issue: <ISSUE-ID>"`.
   Your Lead delivers it into the founder's issue thread — a Runner never posts founder
   material to Discord directly. If publish fails, send the ask --report anyway with
   "publish-failed" in place of the URL; the Lead publishes from the repo path.
6. NON-BLOCKING: after that report is sent, proceed immediately — do NOT wait for
   founder review. Founder feedback arrives asynchronously and is handled as an
   incremental design correction (design-correction.md, written by the current TURN
   holder).
7. Then complete the design phase with `flywheel-comm complete --route
   phase_design_complete`. Do NOT implement code, create a PR, or ship — the Implement
   phase does that on this same branch.
```

措辞注意(R2-4):门**只验证 committed**(HEAD),push 是指令不是门的判据 — 文案不声称「fail-closes without pushed」。上报用 `ask --report`(fire-and-forget,排除 founder reply 误绑定)。

## 4. B3 — Blueprint isDesignerPhase prompt(`Blueprint.ts:1543-1557`)

1. **步骤 2 存量错误文案修正**(R1-1):「publish WITHOUT --channel and hand the URL to your Lead」→「publish with --publish-only and hand the URL to your Lead」(现文案实际会 fallback 投到 generalChannel)。
2. **步骤 5 之后新增最终交付步骤**:founder 选定方向、高保真工件 commit 之后 — committed set MUST include at least one .html inside this issue's doc folder;然后对**最终**高保真 HTML 再走一次 publish-only + `ask --report "DESIGN-HTML ready: …"`(概念卡是选方向的中间物,founder thread 里要有最终定稿),之后才 complete。

## 5. B4 — department-lead-rules.md 新节

文件:`packages/teamlead/lead-rules-base/department-lead-rules.md`(装载链零改动,research §3.1)。挂在「Runner Question Handling (FLY-161)」之后:

```markdown
## Three-Stage Design Visibility — Founder Design HTML (FLY-1404, strictly enforced)

When a three-stage pipeline's Design phase completes, the founder MUST see a design
HTML in that issue's thread — without having to ask for it.

1. **Delivery (normal path)**: the design runner reports
   `DESIGN-HTML ready: <hosted-url> | repo: <path> | issue: <ISSUE-ID>` through its
   report channel (it reaches you as a runner report). On receipt, deliver the URL
   into that issue's thread via the founder-html-delivery skill (title + full-page
   image + link; never a local path). This is a DELIVERY, not a review request — do
   not hold it for your own review, and do not wait for the founder before letting
   implement proceed. If the report says "publish-failed", publish from the repo path
   yourself (founder-html-delivery covers publishing), then deliver.
2. **Opportunistic verification**: whenever you learn that an issue's three-stage
   pipeline is at implement or later (its status line, a standup sweep, any
   interaction with the issue) and you never received a DESIGN-HTML report for it,
   the design deliverable was skipped. The CLI gate makes this rare; when it happens,
   instruct the parked design runner (keep-alive: it stays alive as the
   design-context holder) to publish-only + report the ALREADY-COMMITTED design HTML.
   Do NOT block, pause, or roll back the implement phase — this deliverable is
   non-blocking by design.
3. **TURN discipline for a late HTML**: the parked design runner must NOT write the
   worktree (the TURN belongs to implement). Late remediation is read-only for the
   design runner: publish + report what is already committed. If a repo write is
   genuinely needed (nothing committed — e.g. the gate was bypassed via its escape
   env), the current TURN holder (implement) writes and commits it.
4. **Founder feedback flow**: founder feedback on the design HTML is relayed to the
   current TURN holder (usually implement), which records it as `design-correction.md`
   in the issue's doc folder (abolished concepts / retained organs / verbatim founder
   quotes) and the incremental review covers it. The design phase is NOT re-opened and
   the pipeline is NOT rolled back.
```

核验触发是**机会式**(R1-6):design_done 没有推送给 Lead 的 lifecycle 事件面,规则不假装有;主执法面是 CLI+Bridge 门,Lead 层是第二道网。

## 6. B5 — publish-report `--publish-only`(R1-1)

文件:`packages/flywheel-comm/src/commands/publish-report.ts`(+ CLI arg 解析处)

- 新 flag `--publish-only`:publish(拿 unguessable hosted URL)后**直接返回** envelope(带 url),跳过 screenshot 与 `/api/reports/deliver`。
- **不改**现有行为:无该 flag 时缺 `--channel` 仍走 Bridge「fallback 到 generalChannel」现语义(字节兼容)。
- stdout 契约不变:单行 JSON envelope,publish-only 时含 `url` + 显式标记字段(implement 时与现 envelope 形态对齐)。
- 单测:publish-only 不发起 screenshot/deliver(spy 零调用断言)+ url 正常返回;无 flag 路径现测试不动。

## 7. B6/B8 — generalized workflow invariant 与 dispatch admission

### 7.1 capability invariant(R2-1,取代 R2 前的「no-write env 豁免」)

registry 事实:`design` 节点恒为 `completion_route=phase_design_complete` + `shared_branch_writer=true`(`packages/config/src/node-type-registry.ts:59-70`);`generic` 恒为 no-write + `no_code`(`:111-116`)。「no-write + phase_design_complete」是**非法组合**(现测试手工拼出的形态,snapshot materializer 生不出来)— 不豁免,**fail-closed**:

- 在 snapshot materialization / dispatch admission 加 invariant:`completion_route === "phase_design_complete"` ⇒ `shared_branch_writer === true`,违反即拒绝 dispatch(capability wiring bug,fail loud)。
- 运维手工 `FLYWHEEL_DESIGN_HTML_GATE=0` 仍在,但**绝不由普通 dispatch 自动设置**(逃生口是运维动作,不是业务规则豁免)。
- 合法(写能力)generalized design 节点:systemPromptLines 注入与 B2 步骤 4/5/6 同源的交付协议块(共享 builder,三条路径一份文本,防漂移)。
- `Blueprint.generalized-workflow.test.ts:106-126` 的矛盾 capability 用例改为合法组合(或改为断言 invariant 拒绝)。

### 7.2 dispatch admission:Lead 必须已解析(R2-5 + R3-2)

`BlueprintContext.leadId` 可选、PhaseOrchestrator 对 undefined Lead「dispatching anyway」(`phase-orchestrator.ts:2085-2103`)— 但 design HTML 的投递链路以 Lead 为唯一消费者,无 Lead = 上报永远无人消费、founder 永远看不到。修复:**凡 completion route 为 phase_design_complete 的 session(标准 design / designer / generalized design),dispatch 时必须有已解析 Lead**,缺失 → fail-closed 拒绝 dispatch + 配置补救信息(复用既有 failClosed/alert 面)。

**入口收口(R3-2:「一处收口」必须覆盖全部真实入口,不止两条)**:抽 `assertDesignDispatchContract()`,在

1. `RunDispatcher.start()`(fresh + phase successor,`run-dispatcher.ts:1148-1210`)
2. `RetryDispatcher.dispatch()`(retry/resume 独立入口,**不经过** start(),`run-dispatcher.ts:539-600`;真实 `handleRetry()` 会把可 undefined 的 `retryLeadId` 传入,且 phase row 保留 sessionRole=design)

两个入口的**任何 lifecycle/inflight/pre-register/TURN 副作用之前**调用。retry 的 missing-Lead 还要在 `handleRetry()`(`actions.ts:736-751,1088-1124`)**关闭旧 preserved runner 之前**预检 — 只在 dispatch 内拒绝的话,旧设计上下文已经先被关掉了。capability invariant(§7.1)同样在 snapshot build/parse 与 generalized retry 路径生效,不只靠 Blueprint fixture。

prompt 里 `${ctx.leadId}` 因此可去 fallback(测试断言无 `<lead>` 占位符)。

## 8. B7 — sister-sink admission 对齐(R1-4 + R2-2/R2-3 + R3-1)

marker replay 是**存量**旁路(reconciler 不看证据、原样重放;现测试断言无 changed paths 的 marker 可推进 design_done)。对齐方案:

### 8.1 versioned attestation(R3-1:sink 不凭兼容字段推断)

兼容字段 `changedFilePaths` 含删除项 — 「diff 里只删除了既有 `doc/FLY-1404-x/old.html`」的旧 payload/旧 marker 会被路径谓词误认有证据,这是 legacy/版本交错的**非恶意**路径,payload-only 谓词封不住。终形:

- 新 CLI 在 §2.2 git 强校验(ACMR + HEAD 存在性)**全部通过后**,往 payload 写入 attestation 字段:
  `designHtmlEvidence: { version: 1, issueIdentifier, paths: string[], headSha }`(paths = 通过校验的 HTML 路径;headSha = 同一次 `rev-parse HEAD`)。fail-close marker 同 payload 同源,天然携带。
- Bridge 接收面对 phase_design_complete **只认 attestation**,admission 条件全部经 `parseDesignHtmlEvidence()`(R4-1,严格 schema,sink 不自拼 shape check):
  1. parse ok(version/identifier/paths/headSha 形态全过);
  2. `findDesignHtmlPaths(parsed.paths, parsed.issueIdentifier)` 非空;
  3. `parsed.headSha === payload.evidence.headSha`(同 payload 交叉一致);
  4. `parsed.issueIdentifier` 等于**该接收面的 authoritative identifier**(R4-2,见下)。
  **不回看** `changedFilePaths`(兼容字段字节不变,仅不再作证据)。
- **identifier 权威源(R4-2)**:`event.issue_id` 不稳定 — 有的 Lead 传 Linear UUID、有的传 identifier(`Blueprint.ts:2419-2428`,CLI 的 FLYWHEEL_ISSUE_ID 即 raw issueId);而 payload 的 `issueIdentifier` 与 attestation 的同源(都出自 branch regex),互比是自证。逐接收面写死:event-route 与 marker-reconciler 用**已存 session row 的 `issue_identifier`**(仅当其命中 canonical regex 才可用;缺失/不命中 → fail-closed 409/quarantine);raw `event.issue_id` 仅在自身命中 regex 时可作 fallback。生产形态测试:`event.issue_id = <Linear UUID>` + session `issue_identifier = FLY-1404` + attestation `FLY-1404` → 通过;attestation `FLY-999` → 409/quarantine。
- 缺/坏 attestation:HTTP 完成 → 409;marker → quarantine。旧 CLI 无法伪造出 attestation → 版本交错窗口自然收敛到 rollout 屏障(§11)。

### 8.2 各接收面

- **event-route.ts — 挂点必须早于 enrolled 事务**(R2-2):enrolled generalized execution 在 `commitEnrolledCompletion()`(`event-route.ts:617-661` → `StateStore.ts:15446-15581`,写 receipt + design_done edge + successor side effect + 终态)处**提前完成并 return**,legacy `:1293` 分支根本看不到。attestation admission 放在 `commitEnrolledCompletion()` 之前(作为该 canonical commit 的显式前置契约),不过 → **HTTP 409 + 稳定 error code `design_html_evidence_missing` + 补救信息**,零状态突变(无 receipt、无 edge、无 successor dispatch、session 不终结)。legacy(non-enrolled)路径在 `:1293` 分支前同样拒绝。
- **为什么是 409 而不是 ok:true+warning**(R2-3):CLI 只看 `response.ok`,2xx 会打印「delivered」并成功返回 — 旧 runner 自认完成而 Bridge 留 running,恰是要避免的状态撕裂。非 2xx → 旧 CLI 重试 4 次 → exit 1 + 写 fail-close marker → 该无 attestation marker 被 quarantine,闭环 fail-closed。传输层测试直接断言:Bridge 拒绝时 CLI 绝不打印 delivered/exit 0。
- **DirectEventSink.ts:668 — 永远 fail-closed**(R4-4 诚实边界):该 sink 的输入是 `(EventEnvelope, BlueprintResult)`,`BlueprintResult` 没有也**不该有** attestation 字段(没有任何 Bridge-local producer 跑过 §2.2 的 git 强校验,扩类型+测试手造 = 伪造不可达状态)。此 route 的唯一合法 authority 是 CLI 的 HTTP/marker 通道 → DirectEventSink 对 phase_design_complete 一律拒绝推进 + 大声 warn(仅 gate=0 运维逃生口除外);测试只保留 refusal 与 escape parity,**不设正测**。
- **complete-marker-reconciler.ts**:route=phase_design_complete 且缺/坏 attestation 的 marker → **quarantine**(复用 FLY-172 既有隔离机制)+ 大声告警,不重放。被隔离的 marker 对应的 runner 若还活着,可用新 CLI 重跑 complete(新 attestation 走正门),残留 marker 是死证据不是活状态。
- **Bridge 侧逃生口**:Bridge 进程 env `FLYWHEEL_DESIGN_HTML_GATE=0` → 三处跳过 + 一行显式日志(与 CLI 同款措辞);生效需进程重启(见 §11)。
- **防御性输入**(R2-4):attestation 形态不可信但非恶意(旧版本/畸形),共享谓词与 attestation 解析对 unknown 输入返回拒绝、不抛 — 409/quarantine 而非 500。

## 9. 测试计划(TDD,先红后绿)

### 共享谓词单测(flywheel-comm)

正例(doc/IDENT/ 与 doc/IDENT-slug/)、前缀碰撞 FLY-14040、大小写 .HTML、**畸形输入不抛**:identifier=`"["`/非字符串/不合形态、paths 非数组/含非字符串项 → 空结果(R2-4)。

### complete 单测(`packages/flywheel-comm/src/__tests__/complete.test.ts`)

`beforeEach` 显式清理 `FLYWHEEL_DESIGN_HTML_GATE`。

| # | 场景 | 期望 |
|---|------|------|
| 1 | ACMR diff 含 `engineering/doc/FLY-1404-x/design.html` 且 HEAD 存在 | 通过,事件照发 |
| 2 | 无任何 .html | exit 1,报错含 5 节模板 + publish-only + ask --report 完整补救协议(R2-6) |
| 3 | .html 在 doc 外(`site/index.html`) | exit 1 |
| 4 | .html 在别的 issue 文件夹(`doc/FLY-999-x/a.html`) | exit 1 |
| 5 | 前缀碰撞:分支 FLY-1404,仅 `doc/FLY-14040-x/a.html` | exit 1 |
| 6 | 删除绕过:diff 仅删除既有 `doc/FLY-1404-x/old.html` | exit 1 |
| 7 | ident 不可得(分支无 token) | exit 1(fail-closed)+ 分支名要求 |
| 8 | FLYWHEEL_DESIGN_HTML_GATE=0 | 跳过 + stderr「DISABLED」显式行 |
| 9 | 其他 route | 校验不执行,现行为字节不变 |
| 10 | `gitObjectExists`:存在/不存在/git 失败 三态 | boolean 正确,不与空串混淆(R2-4) |
| 11 | **传输**:Bridge 返 409 | 重试后 exit 1 + marker,绝不打印 delivered(R2-3) |

### publish-report 单测

publish-only:零 screenshot/deliver 调用 + envelope 带 url;无 flag 路径不动。

### Blueprint prompt 测试

- `Blueprint.fly793-phase-prompt.test.ts`:isDesignPhase 七步断言;渲染值为真实 leadId/execId/project,**无任何占位符(含 `<lead>`)**
- `blueprint-designer-phase.test.ts`:步骤 2 文案修正 + 最终交付步骤
- `Blueprint.generalized-workflow.test.ts`:合法 design 节点含协议块;**invariant 用例**:no-write + phase_design_complete 组合被拒(R2-1)
- `Blueprint.fly1188-codex-prompt.test.ts`:共用块改动后对齐断言仍绿

### sink/集成测试(teamlead)

- **enrolled generalized 集成负测**(R2-2):缺 attestation 的 enrolled design completion → 断言无 `workflow_node_completion`、无 `node_completed`/`edge_traversed`、无 Implement dispatch side effect、session 不终结、HTTP 409;合法 attestation → 一次性提交(正测)
- legacy event-route:缺/坏 attestation → 409 + 零状态突变;合法 → design_done
- **删除-only 旧证据负测**(R3-1):payload 无 attestation 但 `changedFilePaths` 含(被删除的)`doc/FLY-1404-x/old.html` → HTTP 409;同形 marker → quarantine — 断言兼容字段绝不被当证据
- attestation 严格 schema 负测(R4-1,HTTP + marker 双面):字段缺失 / null / attestation 是数组 / **paths 混型数组**(`["…/design.html", 7]` 必须整体拒绝) / headSha 缺失、数字、空串、非 40-hex → 409/quarantine,不抛 500;headSha 与 `evidence.headSha` 不一致 → 拒绝
- **identifier 权威源生产形态测试**(R4-2):`event.issue_id = <Linear UUID>` + session row `issue_identifier = FLY-1404` + attestation `FLY-1404` → 通过;attestation `FLY-999` → 409/quarantine;session row 无可用 canonical identifier → fail-closed
- DirectEventSink:**refusal-only**(R4-4)— phase_design_complete 一律拒绝推进 + warn 断言;gate=0 escape parity 断言;**无正测**(无合法 attestation 载体,不伪造不可达状态)
- marker-reconciler:缺 attestation marker → quarantine + 告警,不重放;合法 attestation marker → 照常重放(现「无 changed paths 可推进」用例改为携带合法 attestation)
- Bridge env=0:三处跳过(+显式日志断言)
- **dispatch admission 三组**(B8,R3-2):fresh/successor start、legacy phase retry、generalized retry × missing-Lead / 非法 capability → 全部零 launch side effect;retry 组另断言 missing-Lead 预检发生在旧 preserved runner 关闭**之前**

### 全仓门

`pnpm lint` + `pnpm -r build` + 目标包测试单独跑(memory:`pnpm -r test` exit 码不证明目标包跑过)。

## 10. 验收(issue 原文)与真机 QA

1. **校验真拦**:隔离环境 route=phase_design_complete 无 doc HTML → exit 1;补上 → 通过(单测 + 真机各一次)。
2. **端到端**:下一张走三段式的新 issue,design 完成时 HTML 出现在 issue thread,founder 无需追问(独立 QA 真机验)。
3. **逃生口**:env=0 跳过且有显式日志(CLI + Bridge 两侧;Bridge 侧经重启生效)。
4. **marker/enrolled 旁路封堵**:无证据 marker 被 quarantine;enrolled 无证据完成收 409 且零状态突变(集成负测 + 真机注入验证)。

## 11. Rollout(真实完成屏障,R2-6 + R3-3)

没有「选择性暂停 design dispatch」的现成开关(`stopAccepting()` 是进程级停止接单、无同进程 resume)— 屏障用「停 Bridge = completion fail-close 成 marker」实现,不假设不存在的机制:

1. **盘点在飞 design session**(sessions 查询 + cmux 面),记录清单。
2. **停 Bridge**(遵循 bridge-ship-discipline + FLY-239 精准杀;launchd KeepAlive 先改配置再杀)。从此刻起任何 completion 都 fail-close 成 marker — 这就是完成屏障:没有 completion 能从旧门溜过。
3. 生产 checkout `git pull` + `pnpm build`(CLI/prompt/Bridge dist 全部到位)。
4. **重启 dept Leads(在 Bridge 起来之前,R4-3)** → grep 各 Lead materialized bundle 含「Three-Stage Design Visibility」节。顺序理由:Bridge 一起来 `/events`/publish/successor dispatch 即恢复,旧 prompt runner 会立刻被新 CLI 补救文案引导 publish + ask --report — 若 Lead 还跑旧 bundle,上报落进无规则窗口,恰好重现「HTML 已产 founder 没看到」。Lead 启动不硬依赖 Bridge(bundle 本地物化);若实测有硬依赖,必须先写出可验证的 ingestion hold(证明 hold 期间 /events 不推进)再调整顺序,不许拿步骤文字当屏障。
5. **起新 Bridge** → 验证新代码在跑(startup log / 版本戳)+ checklist(操作化精确形,R5-2:receipt 只存 `bundlePath`+`sha`,不含正文):逐 Lead 读 active receipt → 验证其 `bundlePath` 指向在跑的 generation → 对比 receipt `sha` 与该 bundle 的 sentinel SHA → 对该 bundle 文件 grep「Three-Stage Design Visibility」。boot marker drain:停机窗口内旧 CLI 产生的 phase_design_complete marker **无 attestation → quarantine + 告警**(§8);对应 runner 若还活着,用新 CLI 重跑 complete 走正门 — 窗口 marker 是死证据不是丢状态。
6. 恢复正常运转。此后新 runner:新 prompt + 新 CLI + 新 Bridge 门 + 新 Lead 规则,一致生效;步骤 1 清单里的在飞旧 prompt runner 补跑 complete 时被新 CLI 门引导补产+投递(报错文本 = 完整协议,§2.2-4)。
7. 回滚:CLI 侧 runner env `FLYWHEEL_DESIGN_HTML_GATE=0` 即时;**Bridge 侧同名 env 需进程重启生效**(非「即时翻转」);prompt/规则回滚走 revert。

## 12. 里程碑表(implement 阶段 chunk 划分)

| chunk | 内容 | 验证 |
|-------|------|------|
| 1 | 共享谓词(subpath export)+ gitObjectExists + complete.ts 校验 + 单测 | flywheel-comm 测试绿 |
| 2 | publish-report --publish-only + 单测 | flywheel-comm 测试绿 |
| 3 | Blueprint B2/B3 + B6 协议块/invariant + 四个 prompt 测试 | edge-worker/config 测试绿 |
| 4 | B7 三 sink 对齐(含 enrolled 前置挂点 + 409)+ 集成负测 | teamlead 测试绿 |
| 5 | B8 dispatch admission(Lead 必解析)+ 负测 | teamlead 测试绿 |
| 6 | department-lead-rules.md 新节 | rules-bundle 相关测试绿 |
| 7 | 全仓 lint + build + codex code review | CI 绿 + APPROVED |

## 13. Design review 修订记录

- **R1(2026-07-21,Codex,CHANGES REQUESTED,6 项全采纳)**:
  1. publish-report 无 --channel 实为 fallback 投 generalChannel → --publish-only(B5)+ 修 designer 存量文案 + ask --report。
  2. 谓词三绕过(ident 降级/前缀碰撞/删除文件)→ fail-closed ident + 边界正则 + ACMR+HEAD 存在性(B1)。
  3. generalized design 节点无协议覆盖 + designer 最终 HTML 未上报 → B6 + B3;协议块三路径共享。
  4. marker replay 存量旁路 → 推翻「三 sink 零改动」,共享谓词 admission + marker quarantine(B7)。
  5. 插值作用域与 complete 测试路径错误 → line 1807 先例修正;`src/__tests__/complete.test.ts`;beforeEach 清 env。
  6. rollout 窗口 + B4-2 与 TURN 冲突 + push 缺失 → 有序激活 + 机会式核验/只读补救 + commit AND push。
- **R2(2026-07-21,Codex,CHANGES REQUESTED,7 项全采纳)**:
  1. no-write env 豁免不可达且不可注入(registry:design 恒 writer;BlueprintContext 无通用 env 面;Bridge 门照拒)→ 撤销豁免,改 capability invariant fail-closed(§7.1)。
  2. enrolled generalized 在 commitEnrolledCompletion 提前完成事务 → admission 挂点前移至该 canonical commit 之前 + enrolled 集成负测(§8)。
  3. ok:true+warning 被旧 CLI 当成功(只看 response.ok)→ 改 409 + 稳定 error code;传输层断言绝不打印 delivered(§8)。
  4. 包根入口执行 main() / 谓词输入不可信 / git() 空串二义 → subpath export + unknown 防御性输入 + gitObjectExists 三态(§2)。
  5. `<lead>` 占位符 = 上报无人消费的真实路径 → B8 dispatch admission:Lead 必解析,fail-closed(§7.2)。
  6. rollout 漏 Bridge 重启 + 旧 runner 补救协议不完整 → 原子维护窗口五步 + CLI 报错含完整投递协议 + Bridge env 重启生效说明(§11)。
  7. 上游 exploration/research 与 plan 矛盾(publish 事实/零 sink 改动/测试路径/降级判据/ok:true)→ 两文档同步修订并标 superseded。
- **R3(2026-07-21,Codex,CHANGES REQUESTED,4 项全采纳)**:
  1. 删除-only 旧 payload/marker 仍骗过 payload 路径谓词(兼容字段含删除项,非恶意 legacy 路径)→ versioned attestation `designHtmlEvidence`:只有新 CLI git 强校验通过后写入,三接收面只认 attestation 不回看 changedFilePaths;缺/坏 → 409/quarantine(§8.1)。
  2. B8 漏 `RetryDispatcher.dispatch()` 独立入口 + handleRetry 先关旧 runner → `assertDesignDispatchContract()` 两入口副作用前收口 + retry missing-Lead 在关旧 runner 前预检 + invariant 覆盖 snapshot/parse 与 generalized retry;测试三组(§7.2)。
  3. 「暂停 dispatch」无现成开关、在飞 design 可在升级中途溜过旧门 → 屏障改「停 Bridge = completion fail-close 成 marker」真实序列;停机窗口 marker 无 attestation → quarantine,活 runner 用新 CLI 重跑正门(§11)。
  4. 上游文档 Lead「翻段核验 + 补产」旧契约残留 + research §5「零改动」标题与 B5 矛盾 → 标 superseded / 对齐 plan §5 机会式+只读语义;标题改掉。
- **R4(2026-07-21,Codex,CHANGES REQUESTED,5 项全采纳)**:
  1. attestation schema 不严格(混型 paths 被过滤放行、headSha 未纳入 admission)→ 共享 `parseDesignHtmlEvidence()` 唯一解析器,混型整体拒绝,headSha 40-hex + 与 evidence.headSha 交叉一致(§2.1/§8.1)。
  2. identifier「与事件一致」无权威源(event.issue_id 可为 Linear UUID → 误拒;payload 同源互比 = 自证)→ 逐接收面写死 authority = session row `issue_identifier`(命中 regex 才可用,否则 fail-closed),raw issue_id 仅自身命中 regex 时作 fallback;生产形态测试(§8.1)。
  3. rollout 先起 Bridge 后重启 Lead → 投递竞态重开 → Lead 先于 Bridge;若 Lead 启动硬依赖 Bridge 须先证明 ingestion hold(§11)。
  4. DirectEventSink 无合法 attestation 载体 → 永远 fail-closed + warn(gate=0 除外),测试 refusal-only,不伪造不可达正例(§8.2)。
  5. 上游文档仍描述 payload-predicate 方案与「零新机制」→ 追加 attestation 终形注记 + 措辞改「复用现有 transport、新增 admission contract」。
- **R5(2026-07-21,Founder 经 Lead 回流,绑定语义裁定,3 项全采纳)**:
  1. HTML 门禁绑定的是 **design-node completion semantic**,不是「三段式」拓扑本身:legacy `phase_design_complete` 是当前载体,未来 DAG 任意形状只要节点的 completion route 是 `phase_design_complete` 就复用同一 invariant/admission。
  2. 任意非三段式形状(如 Design→QA / Design→Implement)含 design 节点仍强制 HTML;完全不含 design 节点的 workflow 不触发门禁。snapshot build/parse、Blueprint、dispatch、Bridge 三接收面全部按 route/capability 抽象,不用阶段数推断。
  3. 验收新增形状无关测试:非三段式 design 节点的非法 no-writer capability fail-close、合法 generalized design 注入完整协议;no-design generalized node 不含协议且完成不受门禁。
