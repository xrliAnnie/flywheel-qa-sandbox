# FLY-2276 托管交互报告自动 CSP nonce — 实施计划
Issue: FLY-2276 (https://linear.app/geoforge3d/issue/FLY-2276/publish-report-托管页注入的-csp-默认-default-src-none-无-script-src作者不写-csp)
日期: 2026-09-03
基于: research.md

> 修订 v2：吸收设计评审 R1。明确自动 nonce 的 trusted-HTML 威胁边界；加入引号感知扫描、可执行 script type、CSP/tag nonce 对齐、现有测试非空过与隔离验收合同。

## 1. 目标与锁定范围

本实现只收口 `publish-report` 托管链的两个行为：

1. Bridge 注入默认 CSP 时，自动给无 `src` 的**可执行** inline script 配同一个随机 nonce，并在 CSP 中加入匹配的 `script-src 'nonce-…'`。
2. `verify-report` 看到可执行 inline script、但 head CSP 无 `script-src` 或 CSP/tag nonce 不匹配时 fail loud，并给出重新发布或手工占位符修法。

必须保持：`default-src 'none'`、纯静态页与仅含 data-block script 页的 no-script CSP、现有 `__CSP_NONCE__` inline-script 约定、**自动路径**外链脚本拒绝、无 `<head>` 的 400、registry transaction 和 retention 逻辑。不增加旋钮，不改 FLY-2283 的 7→14 天逻辑，不改 `CLAUDE.md`。

### 1.1 安全合同变化

自动路径只处理 **publish 当刻文档里已经存在**、无 `src`、类型可执行的 inline script。托管页是发布时冻结的静态文档、URL 不可猜、发布后没有注入入口；所以给这些既存 script 加 nonce 等价于作者逐块 opt-in，运行时新建的 script 不会自动获得 nonce。

`publish-report` 输入由此明确成为**受信任 HTML artifact**：所有 issue/PR/网页/用户内容等不可信动态值必须在组装前 HTML-escape。服务端 hardening 负责 CSP/nonce 对齐，不是 sanitizer。同步改写 `report-registry.ts` 的 SECURITY 注释并加 `&lt;script&gt;` 惰性回归，禁止让旧注释继续声称只授权 generator 自己的脚本。

nonce 不覆盖 `onclick=` 等 inline event handler。若发布端准备注入默认 CSP且 HTML 含这类真实属性，`injectHeadMeta` 在 deploy 前抛 `ReportHtmlInvalidError`，HTTP 400 文案提示改用 nonced script 内的 `addEventListener`；不自动改写 handler。作者自带 CSP 的页面保持原行为。

现有 placeholder 路径会全局替换 `__CSP_NONCE__`；因此作者若主动把 placeholder nonce 写到 external script 上，现有行为可能授权它。为满足“现有约定行为不变”，本单不改这条 legacy 边界；“外链拒绝”验收锁的是无 placeholder 自动路径，`verify-report` 仍拒绝无 nonce external tag。

## 2. 改动 1：服务端自动 nonce

文件：

- `packages/teamlead/src/__tests__/report-registry.test.ts`
- `packages/teamlead/src/__tests__/reports-route.test.ts`
- `packages/teamlead/src/bridge/report-registry.ts`

### 2.1 RED

先增加一个主行为测试，输入是一份无 CSP、无 `__CSP_NONCE__` 的完整 HTML，包含：

- 两个 inline script，其中一个无 nonce，一个带旧普通 nonce；
- 一个 `<script data-x="foo>" src="https://example.invalid/external.js"></script>` 外链脚本，用引号内 `>` 验 scanner 不提前截断；
- 一段已转义的动态文本 `&lt;script&gt;injected()&lt;/script&gt;`。

断言：nonce generator 只产一个真值；两个 inline opening tag 都使用该真值；注入 CSP 同值且仍有 `default-src 'none'`；external opening tag 不出现该真值；转义 script 保持文本且没有变成真实元素。先单独运行该测试并保存当前失败输出。

在实现前再加一条 publish fail-loud RED：无自带 CSP 的完整 HTML 带 `<button onclick="go()">`，断言 `ReportHtmlInvalidError` 同时提到 inline handler 与 `addEventListener`，并由既有 route mapping 证明 deploy 前 HTTP 400。

### 2.2 GREEN

在 `injectHeadMeta` 内按以下顺序实现：

1. 先定位真实 `<head>` 并检测其中是否已有 CSP meta。
2. 用一个小型确定性 opening-tag scanner：跳过 `<!-- ... -->`，从 `<tag` 开始逐字扫描并维护单/双引号状态，只把引号外的 `>` 当边界；解析属性名/值的真实边界。遇到 `script` / `style` / `title` / `textarea` 等 raw-text/RCDATA 元素后把 cursor 移到真实 closing tag 之后，避免把内容字符串里的伪 tag/handler 当 markup。
3. scanner 在 head 无 CSP 时先扫所有真实 opening tag；独立属性名匹配 `^on[a-z]+$` 即抛 `ReportHtmlInvalidError`，文案要求 `addEventListener`。script 属性只认独立 `src` / `nonce` / `type`，不能把 `data-src` / `data-nonce` 当目标。`type` 缺失/空、`module` 或 `text/javascript` 为可执行；`application/ld+json`、`application/json`、`text/template` 等 data block 原样保留且不触发 script CSP。
4. 若 HTML 含 `__CSP_NONCE__`，继续生成一次 nonce并保持现有全局替换，legacy placeholder 行为逐字节兼容。
5. 否则，仅当 head 无 CSP 时遍历可执行 script：
   - opening tag 有 `src`：原样保留；
   - opening tag 无 `src`：首次命中时生成一个 nonce，把已有 nonce 替换或新增为同一个真值。
6. 至少命中一个可执行 inline script 时选择 `cspMetaWithScriptNonce(nonce)`；否则继续选择现有 `CSP_META`。
7. 在改写后的 HTML 上重新计算 `<head>` 坐标并执行已有 noindex/CSP 注入，避免新增属性导致 offset 漂移。

### 2.3 REFACTOR / 回归

抽取窄 helper，让 head 提取、script element 遍历和属性识别各自可读。补边界测试：

- 自带 CSP、无 placeholder 的 inline script 不被自动改写；
- external-only 页面保持 strict no-script CSP；
- script body 内的 `<script>` 字符串不被改写；
- `data-src` 不被当作外链属性；引号内 `>` 不截断 opening tag；HTML comment 中的 script 不计入；
- `application/ld+json` / `text/template` 不触发 nonce CSP；
- 转义后的 `&lt;script&gt;` 保持惰性，未产生新 element；
- placeholder inline script 行为不变；placeholder external 的既有全局替换边界只记录、不改动；
- 无 CSP + inline handler 在 deploy 前失败；自带 CSP + handler 保持作者策略；
- 原有 placeholder、静态页、fake body meta、反向属性顺序测试继续通过。

## 3. 改动 2：verify-report 核 CSP

文件：

- `packages/flywheel-comm/src/__tests__/verify-report.test.ts`
- `packages/flywheel-comm/src/commands/verify-report.ts`

### 3.1 RED

先增加第二个主行为测试：响应 HTML 的 inline script 已有 `nonce="abc"`，但 `<head>` CSP 只有 `default-src 'none'`、没有 `script-src`。断言 `exitCode=1`、新 check 为 `fail`，错误同时提到 `script-src` 与可执行修法。先单独运行并保存当前错误地通过的输出。

### 3.2 GREEN

给 `VerifyReportChecks` 增加 `scriptCsp`：

- 无可执行 inline script → `skipped`；
- 有可执行 inline script时，解析真实 `<head>` 中每条 CSP meta 的 directive/token；每条都必须有 `script-src` nonce source，且每个非空 script nonce 都属于每条策略的 nonce 集，才 `pass`；
- 无 CSP、无 `script-src`、只有 `'self'` / `'unsafe-inline'` 等非 nonce source，或 CSP/tag nonce 不匹配 → `fail`。

检查顺序固定为：HTTP → placeholder 残留 → inline-script CSP → script nonce → `--expect`。这样最接近 Belle 根因的错误优先呈现，不再只提示表层 nonce 属性。

错误文案给两条修法：优先用新版 `publish-report` 重新发布以自动补 nonce；若必须手写，则 CSP 使用 `script-src 'nonce-__CSP_NONCE__'`，每个 inline script 使用 `nonce="__CSP_NONCE__"`。

### 3.3 REFACTOR / 回归

补通过与负例，证明匹配 nonce 时 `scriptCsp=pass`，nonce `AAA`/`BBB` 不匹配或 `script-src 'self'` 时 fail，纯静态与 data-block-only 页面 `skipped`，head 之外展示的 CSP meta 不算策略。

同步修正现有 fixtures，防止检查顺序造成空过：

- happy-path inline fixture 补真实 `<head>` 与匹配 nonce CSP；
- “script without nonce”与 mixed-nonces fixtures 补匹配 CSP，让执行确实抵达 `scriptNonce` 分支；
- mixed-nonces 明断言 `checks.scriptNonce === 'fail'`，不能只靠错误文案里恰好含 `nonce` 而假绿。

`scriptNonce` 同时收紧为：任何 external script（无论是否手写 nonce）都 fail；可执行 inline script 缺 nonce 时 fail；非可执行 data block 不参与。这样外链脚本不会因自带 nonce 或 legacy placeholder 而被验证器放行。

## 4. TDD 执行顺序

1. 写上述两个主测试，不改实现。
2. 分别运行 TeamLead 与 flywheel-comm focused tests，确认两个都因目标缺口 RED，而不是 fixture/编译错误。
3. 实现 TeamLead 最小修复，focused test GREEN；再运行整个 `report-registry.test.ts`。
4. 实现 verify-report 最小修复，focused test GREEN；再运行整个 `verify-report.test.ts`。
5. 补安全边界回归并 refactor；每次改动重跑两个 focused suites。
6. 小提交保存 TDD 实现，并更新 `progress.md`。

focused commands：

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/report-registry.test.ts
pnpm --filter flywheel-comm exec vitest run src/__tests__/verify-report.test.ts
```

## 5. 真托管与交互验收

制作一份隔离验收 HTML：无 CSP meta、无 nonce、一个按钮通过 inline `addEventListener` 把明确状态从 `ready` 改成 `clicked`。用分支构建产物和显式注入的临时 `ReportRegistry` 运行最小 reports route；不启动、重启或复用生产 Bridge。test-deploy 在干净环境起进程：先 unset 生产路径值，`FLYWHEEL_STATE_DIR`、`FLYWHEEL_COMM_DB`、`FLYWHEEL_RUNNER_STATE_DIR`、registry、delivery secret 全指向 task 专用临时目录/值；不得指向 `~/.flywheel`。运行器合同禁止复用或改写通用 `HOME` / `CODEX_HOME`，因此最小 router 通过构造器显式注入全部路径、完全不调用 home-based 配置解析；验收前后再证明真实 HOME 下的生产路径未写。

交互报告执行：

1. `publish-report --publish-only` 真发托管 URL，不向 Discord 投递。
2. 拉回托管 HTML，断言 `__CSP_NONCE__` 残留 0、inline tag nonce 与 CSP nonce 逐字一致、`default-src 'none'` 仍在。
3. `verify-report --url <url> --expect <marker>` 返回 0 且 `scriptCsp=pass`。
4. 用独立 `agent-browser` session 打开托管 URL，snapshot 后真实 click 按钮，再读取 DOM 状态为 `clicked`；截图后必须实际查看，并关闭该 session。
5. 对一份“inline 有 nonce但 CSP 无 `script-src`”的本地 HTTP fixture 跑 `verify-report`，证明非零与修法文案。

外链拒绝不混入必须返回 0 的托管 fixture：TeamLead adversarial 单元测试锁自动 hardening 不给 external tag 加 nonce；verify-report 单元测试锁 external tag 无论是否带 nonce都预期非零。placeholder external 的 legacy 发布边界按 §1.1 仅记录，验证器仍 fail loud，不冒充已修。

隔离运行前后回查 task 临时 registry/DB/state dir 与生产 reports/state 路径，确认探针只写临时 roots；首个 publish 成功后立即断环，禁止重试增殖 URL。如果当前节点无法安全取得真托管所需的既有凭据，只把该外部验收作为未完成项报告给 Lead，不读取或新建 secrets，也不重启生产 Bridge；本地 route + browser 验收不能冒充真实托管验收。

## 6. 完整验证与评审

focused suites 通过后，按节点契约运行：

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
```

本单不新增 `scripts/__tests__/*.test.sh`；若实现中新增，则逐个执行。另执行窄消费者 sweep：`rg -n '__CSP_NONCE__|script-src' .claude/skills packages/*/lead-rules-base scripts`。`.claude/skills/diagram-design/SKILL.md` 的旧合同属跨仓同步项，本 PR 不修改；在 PR body/Lead handoff 逐文件列出。其余命中逐条确认是仍有效的显式 placeholder 兼容测试/生成器，不做机械删除。

随后：

1. 通过 `codex:rescue` 对 exact head 做代码评审，不能直接运行 `codex exec`。
2. `stage set code_review` 后，打开 `review_code` gate 并 `request-review --type code`。
3. 对 CHANGES_REQUESTED 修复、重跑相关测试、提交并发起全新 gate/review round；APPROVED 才继续。
4. 立即在不可逆动作前再查 Lead inbox。
5. 推 feature branch，创建 `engineering/doc/milestones/FLY-2276.md` 并作为字面意义上的最后一个 commit；不修改 `CLAUDE.md`。推该 exact head 后再开 PR，保证 PR 创建时 milestone 已是末提交。
6. 通过唯一 report channel 向 Lead 汇报 commit、测试、评审、托管 URL 与 PR，然后 `complete --route needs_review --pr <NUMBER>`。不 dispatch QA、不请求 ship、不 merge/deploy。

## 7. 风险与回滚

| 风险 | 防线 |
| --- | --- |
| 自动 nonce 授权漏转义的动态 `<script>` | 明确 trusted-HTML 边界；同步 SECURITY 注释；转义文本惰性回归；消费者文档强调动态值先 escape |
| scanner 误改 script body / 引号内 `>` 提前截断 | 引号感知 opening-tag scanner + element cursor；字符串与 adversarial 属性回归 |
| 自动 nonce 意外授权 external script | `src` 独立属性先行排除；引号内 `>` adversarial auto-path 负断言；legacy placeholder 边界明确不改 |
| data block 扩大 script 执行面 | 仅可执行 `type` 触发 nonce CSP；JSON-LD/template 回归 |
| 作者自带 CSP 被擅自改写 | auto path 仅在 head 无 CSP 时启用；现有 CSP 回归测试 |
| nonce 与 CSP 不一致 | 每次发布只生成一次 nonce；多 inline script 同值；verify-report 自动逐策略比对；托管回读复核 |
| verify-report 检查前移让旧测试空过 | 三处旧 fixture 补真实 CSP，mixed-nonces 明断言 `scriptNonce=fail` |
| inline event handler 仍被 CSP 拦 | 默认 CSP 发布前 fail-loud，文案要求 `addEventListener`；作者自带 CSP 保持原行为 |
| 隔离验收污染生产状态 | 最小 route + 显式临时 registry/DB/secret/state roots；前后回查；不用生产 Bridge/baseDir |
| 与 FLY-2283 冲突 | 不触碰 retention 常量、prune 代码和对应测试 |

回滚只需还原两个实现文件与对应测试；registry schema、持久数据和 CLI 参数均无迁移，因此无需数据回滚。

## 8. Design correction（2026-09-03，代码评审 R3）

代码评审 R3 的阻断 finding `verify-report-exec-type-false-green` 证明，原裁定①把可执行类型只列为 absent/empty/`module`/`text/javascript` 会让合法的 browser/CSP-governed script 被发布端和验证端同时跳过。Lead 在 question gate `d0f8c3e2-da29-4ba3-85b1-bb591e4ee491` 中以既有裁定 `b22173f0` 明确放宽该项。

本段替代上文仅涉及 script `type` 分类的旧约束，其余范围与安全边界不变：

- publisher 与 verifier 必须共用同一个 quote-aware HTML scanner 和同一个 `isCspGovernedInlineScript` 分类器，禁止再维护两份可能漂移的实现；
- CSP-governed inline 类型包括 absent、empty、`module`、`importmap`、`speculationrules`，以及 WHATWG MIME Sniffing 定义的全部 16 个 JavaScript MIME type essence；
- JavaScript MIME 名称 ASCII case-insensitive，并按 Lead 裁定忽略 `; charset=...` 等 MIME 参数后比较 essence；
- `application/ld+json`、`application/json`、`text/template` 等数据块仍排除；任何带 `src` 属性（包括空值或布尔属性）的 script 仍一律视为 external 并由 verifier 拒绝；
- 参数化 RED/GREEN 测试必须同时覆盖 publisher 自动 nonce 与 verifier 缺 `script-src` 失败，锁住全部 essence、参数化 MIME、`importmap`、`speculationrules`。

标准依据：WHATWG HTML `script` processing model（`module`/`importmap`/`speculationrules`）与 WHATWG MIME Sniffing JavaScript MIME type essence list。

## 9. Design correction（2026-09-03，QA attempt 3）

本段覆盖 §1.1 中关于 external script legacy 边界的旧裁定，其余范围与安全合同不变。

- 原句：“现有 placeholder 路径会全局替换 `__CSP_NONCE__`；因此作者若主动把 placeholder nonce 写到 external script 上，现有行为可能授权它。为满足‘现有约定行为不变’，本单不改这条 legacy 边界；‘外链拒绝’验收锁的是无 placeholder 自动路径，`verify-report` 仍拒绝无 nonce external tag。”
- 改后：`publish-report` 对任何真实 `<script src>` 都在 deploy 前 fail-close，不因作者 CSP、nonce 或 `__CSP_NONCE__` placeholder 而放行；publisher 与 `verify-report` 复用同一个 external-script 分类器与同一句修复文案，要求作者把代码内联后重新发布，或采用 `__CSP_NONCE__` inline-script 约定。`default-src 'none'` 不变，不增加机制或旋钮。
- 原因：QA attempt 3 真机复现 `EXT_DID_NOT_RUN`。旧路径允许 external script 发布成功，但浏览器随后由 `default-src 'none'` 阻止加载，形成“发布成功、运行静默失败”，违背本单“要么执行，要么发布即报错”的产品合同。
