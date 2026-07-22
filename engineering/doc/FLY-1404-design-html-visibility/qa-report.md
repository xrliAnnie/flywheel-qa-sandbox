# FLY-1404 设计期可见性 — QA 报告(三段式 QA 阶段)

Issue: FLY-1404
日期: 2026-07-21
基于: plan.md、research.md、exploration.md + 本分支 implement 提交(PR #666,head `4ce1551f`)

> 三段式 QA 阶段独立验证。**Verdict: FAIL(kickback 给 implement)** —— 一个 HIGH 产品代码缺陷(TOCTOU headSha 绑定)必须先修。其余全部通过。

---

## 1. 验证范围与方法

| 面 | 方法 | 结果 |
|----|------|------|
| 全仓 build | `pnpm -r build` | ✅ exit 0 |
| 全仓 lint | `pnpm lint` | ✅ exit 0 |
| CI(PR #666) | `gh pr checks 666` | ✅ 9/9 pass(Quick Gate / Unit light+heavy / teamlead 1-3 / Script Tests / NPM / CI OK) |
| flywheel-comm 单测 | design-html-evidence / complete / publish-report | ✅ 71 passed |
| edge-worker prompt 测 | fly793-phase-prompt / generalized-workflow / designer-phase / fly1188-codex-prompt | ✅ 33 passed |
| config 注册表 | feature-flags-registry | ✅ 25 passed |
| teamlead sink/dispatch | design-html-admission / event-route / DirectEventSink(+dag-seam) / complete-marker-reconciler / fly1404-rules / run-dispatcher / workflow-run-snapshot / actions-retry-route / fly887-turn-seam | ✅ 262 + 16 passed |
| **真机门突变 E2E** | 真 git 仓 + 真 dist CLI,见 §2 | ✅ 决定性通过(核心「校验真拦」验收) |
| validator 纯逻辑对抗 | 直接跑 `validateDesignHtmlCompletion` 8 例,见 §3 | ✅ 全部行为正确 |
| **Codex xhigh code review** | 见 §4 | ⚠️ **CHANGES REQUESTED(1 HIGH + 1 LOW)** |

注:所有 teamlead 测试跑前显式 `env -u FLYWHEEL_RUNNER_BACKEND`(避免 runner-backend env 污染套件),`env -u FLYWHEEL_DESIGN_HTML_GATE`(避免逃生口残留干扰)。核实了 10 个 teamlead 测试路径逐一存在(vitest 会静默忽略不存在路径 → 已逐个 `-f` 核对,无空过绿)。

---

## 2. 真机门突变验证(founder 第一验收:「缺 HTML 时 design 无法 complete,校验真拦」)

单测 mock 了 git(`execFileSync`),按 QA 铁律 mock 测试需真机集成补位。搭真 git 仓 + 真 `dist/index.js complete --route phase_design_complete --base-ref main`,**同一套 harness 只切换「HTML 是否/在哪提交」这一个变量**,观察门从「拦」翻到「放」——证明断言非空过。

| Case | 提交内容 | 期望 | 实测 |
|------|----------|------|------|
| A | 只有 `doc/FLY-1404-x/plan.md`,无 HTML | 拦(exit 1 + 5 节补救文案) | ✅ 拦,补救文案完整 |
| B | A + 新增 `doc/FLY-1404-x/design.html`(唯一变量翻转) | 放行(越过门打 Bridge) | ✅ 无「required」消息,越门去打 Bridge(不可达如预期) |
| C | 无 HTML + `FLYWHEEL_DESIGN_HTML_GATE=0` | 跳过(大声 DISABLED 日志) | ✅ DISABLED 日志出现,越门 |
| D | HTML 在 doc 外(`site/index.html`) | 拦 | ✅ 拦 |
| E | 前缀碰撞:仅 `doc/FLY-14040-x/a.html` | 拦(FLY-14040 ≠ FLY-1404) | ✅ 拦 |

**A↔B 是关键突变**:两套仓唯一差异是「是否提交 doc 内 HTML」,门就从拦翻到放 → 断言真实、边界正确、逃生口带大声日志。harness 见 `scratchpad/gate-e2e.sh`(会话产物,已把逐 case 输出录入本报告)。

---

## 3. validator 纯逻辑对抗(直接跑 built dist)

直接 import `validateDesignHtmlCompletion`,8 个对抗输入全部行为正确:

```
OK  :: valid → ok
REJ :: headSha mismatch payload.evidence → reject
REJ :: wrong attested identifier FLY-999 → reject
REJ :: mixed-type paths (["…html", 7]) → reject(整体拒,非过滤)
REJ :: path outside doc folder → reject
REJ :: missing authoritative identifier → reject
OK  :: non-design route → pass-through
OK  :: gate disabled → ok disabled
```

结论:admission validator 逻辑 sound;identifier 权威源经核实(makeEvent 默认 `issue_id:"issue-1"` 非 canonical + session `issue_identifier="GEO-95"`)——现有「accepts attested design HTML」HTTP 测试已隐式锁住「authority 取 session row 非 raw event.issue_id」(若回退读 raw 该测试会红)。

---

## 4. Codex xhigh code review 结果(硬门)

`codex:rescue` REVIEW-ONLY,xhigh,head `4ce1551f` → **CHANGES REQUESTED**。

### FINDING-1(HIGH,产品代码,阻断 ship)—— attestation 的 headSha 与 HTML 校验绑定到两个不同 commit(TOCTOU)

- 位置:`packages/flywheel-comm/src/commands/complete.ts:330`(`${baseRef}..HEAD`)、`:340`(`gitObjectExists("HEAD", path)`)、`:357`(`headSha: args.evidence.headSha`)。`evidence.headSha` 来自 `collectEvidence` 内 `:456` 的**另一次独立** `git rev-parse HEAD`。
- 失效场景:`collectEvidence` 在 commit H1(无 HTML)时取 headSha=H1 → 两次调用之间 HEAD 移到 H2(含 HTML)→ `diff …HEAD` 与 `cat-file HEAD:path` 对 **H2** 成功 → attestation 却写 **H1**。Bridge 只交叉校验 `parsed.headSha === payload.evidence.headSha`(都 H1)且**按设计不重放 git**,于是接受一个「声称 H1 有 HTML、实际 H1 没有」的假 attestation,推进生命周期。
- 影响评估:实测运行流(runner 先提交 HTML 再同步调 complete,单线程)下几乎不可触发;但这是安全治理门的**核心不变量**(HEAD-bound)、Bridge 又把 CLI attestation 当唯一可信绑定,属信任链上真实(虽窄)完整性缺口。
- 修法(约 2 行,implement 阶段):把 HEAD 解析一次成不可变 SHA,`diff` range 与 `gitObjectExists` 都用该 SHA、attestation.headSha 用同一个;或在 mint 前断言 HEAD 未移动。补一个确定性回归测试(mock `rev-parse HEAD` 与 diff/cat-file 的 HEAD 解析为不同 SHA,断言拒绝/一致)。

### FINDING-2(LOW,测试覆盖,可与修 FINDING-1 同窗补)—— sink 级对抗子用例缺

- HTTP(`event-route.test.ts`)与 marker(`complete-marker-reconciler.test.ts`)只测了 missing→(409/quarantine) 与 valid→advance 两态;plan §9 R4-1 要求的「HTTP+marker 双面」严格 schema 负测(混型 paths / headSha 不一致 / 错 attested identifier / 缺 canonical authority)、以及「合法 attestation marker 照常 replay」的正测未在 sink 层落。
- 缓解事实:validator 交叉校验分支已在 `design-html-admission.test.ts` 的 `it.each`(missing/malformed/wrong-issue/prefix-collision/head-mismatch)单测覆盖;各 sink 的拒绝分支对 reason 无关(共用 `!admission.ok`),故回归风险低。建议 implement 补齐 plan §9 R4-1 双面负测把「validator reject → sink 正确 409/quarantine」在每个 sink 各锁一例。

---

## 5. 需求符合度核对(founder 原话 4 点)

| # | 要求 | 状态 |
|---|------|------|
| 1 | design 完成硬性交付 founder HTML(图优先 5 节,scratchpad→Lead 投 thread) | ✅ Blueprint prompt(B2/B3/B6)+ complete.ts 门 + 共享 `founderDesignHtmlDeliveryLines` |
| 2 | Lead 基础规则同步一条(投递/机会式核验/TURN/反馈修正) | ✅ department-lead-rules.md 新节 |
| 3 | 非阻塞:HTML 发出后 implement 照常启动,不等 review | ✅ prompt「NON-BLOCKING」+ 规则「does not wait」+ 门不拦 successor(E2E case B 越门) |
| 4 | 5 节模板(①一句话②流程图③数据结构④取舍+否决替代⑤诚实边界) | ✅ prompt + 补救文案均含五节 |

R5 裁定(绑定 design-node completion 语义而非「三段式」拓扑)经 `isDesignNodeCompletion` 抽象 + route-based admission 落实。

---

## 6. 未覆盖 / 移交 ship 后真机

- plan §10 验收 #2「下一张走三段式新 issue,design 完成 HTML 出现在 issue thread,founder 无需追问」= 全链 live E2E(需部署后的 Bridge + 新 Lead bundle + 真三段式 dispatch),属 **ship 后独立真机 QA**;本分支层的执法机制(CLI 门)已真机证到会拦。
- plan §11 rollout 屏障(停 Bridge / Lead 先起 / marker drain)为部署动作,ship 时执行。

## 7. 结论

**FAIL** —— FINDING-1(HIGH TOCTOU)须 implement 阶段在本分支修复并补回归测试;建议同窗补 FINDING-2(LOW 覆盖)。修复后唤醒本 QA 阶段 re-verify(重跑 §1 全表 + §2 突变 E2E + Codex 增量 re-review 新 head)。其余全部通过。
