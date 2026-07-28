# FLY-1508 design 节点 founder HTML 合同补互动格式规范 — 实施计划

Issue: FLY-1508
日期: 2026-07-27
基于: research.md
状态: Codex design review 3 轮 APPROVED(R1: 4 项——禁自写 CSP meta / escape 安全前提 / pathname key + clipboard reject 兜底 / 反锚补全;R2: 3 项——rejection 锚点 / escape 与 DOM sink 拆分防双重编码 / CSP 后果表述收窄;R3: 零 blocker);Implement brainstorm gate 追加 founder 两条同级合同要求(真 Mermaid 图,适合时用 Mermaid 的 UML 风格图类型 + 首次术语白话解释)

## 改动 1:合同文本(唯一代码改点)

`packages/edge-worker/src/Blueprint.ts` → `founderDesignHtmlDeliveryLines()`:在 `"5) honest boundary — what this design does and does not do.",` 之后、`"Commit and push the final HTML..."` 之前,插入以下 11 行(逐字,引号照 TS 字符串转义):

```ts
"INTERACTIVE COMMENT LAYER (MANDATORY — the founder reviews by leaving per-section comments):",
"a) Below EVERY section/card, render a comment input (textarea) that auto-saves to localStorage on input — key it with a prefix that includes location.pathname (all reports share one hosted origin; a bare constant prefix leaks comments across reports), and wrap localStorage access in try/catch.",
"b) At the bottom of the page, add a summary card that live-aggregates every non-empty comment prefixed with its section title, plus a copy-all-comments button — copy via navigator.clipboard.writeText, falling back to document.execCommand('copy') when the clipboard API is unavailable OR its promise rejects.",
'c) ALL JavaScript must be inline in a single <script nonce="__CSP_NONCE__"> block. publish-report replaces this exact placeholder with a real per-report nonce and injects the matching CSP. Do NOT include your own Content-Security-Policy meta — an existing CSP suppresses that injection and can leave the minted nonce unauthorized, blocking the script; a script without the placeholder is blocked outright.',
"d) Bind every event handler inside that nonced script via addEventListener — inline handler attributes (onclick=...) are NOT covered by the script nonce and fail silently under CSP. HTML-escape ALL issue/repo/user/tool-derived text before template/markup interpolation; for runtime DOM writes pass raw strings only through textContent/value, and never pass derived data to innerHTML or splice it into the nonced script.",
"e) Keep the rest of the page on the existing Apple-light html-report-style with zero external dependencies (no CDN scripts, styles, or fonts).",
"DIAGRAMS AND LANGUAGE (MANDATORY - founder feedback 2026-07-27):",
"f) Render EVERY process or architecture diagram as a real diagram authored in Mermaid syntax (use Mermaid UML-style diagram types where appropriate); render it locally with mmdc to a self-contained SVG and inline that SVG in the HTML - no runtime mermaid.js: the diagram must be fully rendered at build time and the hosted artifact must make zero external fetches. Do NOT fake diagrams with CSS boxes and arrows.",
"g) Founder-friendly language with zero unexplained jargon: the first time each technical term appears, follow it immediately with a one-sentence plain-language explanation.",
'h) Render diagrams locally only. If mmdc fails, retry once with standard flags: mmdc -i <source.mmd> -o <output.svg> -w 1000 -b white --svgId <unique-id>. If that retry also fails, ship a clearly labeled "DIAGRAM PENDING LOCAL RENDER" CSS placeholder instead of a fake diagram, keep the Mermaid source beside the HTML, and report the render failure; NEVER use a hosted or remote diagram rendering service.',
"i) For pages with multiple diagrams, pass mmdc --svgId <issue>-d<N> with a distinct stable value unique per diagram; duplicate SVG, marker, gradient, or filter ids can break later diagrams.",
```

要点:
- 条款自包含——不引用托管 URL(7 天过期)、不引用任何 repo 路径(合同注入所有项目);
- issue 四条互动要求 ↔ 条款映射:①逐节 textarea+localStorage = a;②底部汇总+一键复制+兜底 = b;③内联 JS + `__CSP_NONCE__` = c;④Apple-light 零外部依赖 = e;
- Implement brainstorm gate 补入 founder 在 FLY-1501 thread 的两条同级要求,放在独立的 `DIAGRAMS AND LANGUAGE` 必选块:⑤流程/架构图必须用 Mermaid 语法(适合时使用 Mermaid 的 UML 风格图类型)渲染真图、mmdc 转成自包含 SVG 后内联、成品零外部请求、禁 CSS 盒子拼伪图 = f;⑥语言 founder-friendly 零黑话、每个技术术语首次出现立即配一句白话解释 = g;
- Code review MEDIUM advisory 由 Lead 采纳:本地 `mmdc` 首次失败后用标准 flags 重试一次;仍失败则交付显式标注待渲的 CSS 占位、保留 Mermaid 源并报告失败,严禁 hosted/remote renderer = h;同页多图必须各传唯一稳定的 `mmdc --svgId` 防 SVG 内部 id 冲突 = i;
- Tadashi 点名的显式 MUST(addEventListener / 禁 inline onclick)= d 前半;
- Codex R1 补的三个机制硬前提:禁自写 CSP meta(`injectHeadMeta` 遇已有 CSP 跳过 nonce CSP 注入,`report-registry.ts:385-394`)= c;非可信内容必须 HTML-escape / 禁 innerHTML / 禁拼进 nonced script(`report-registry.ts:57-61` 安全契约)= d 后半;localStorage key 含 `location.pathname`(共享 origin 防跨报告串批注)+ clipboard reject 也兜底 = a/b;
- 插入点在内容五项与 commit/push 时序条款之间,不打断发布流程行序,三条 design 路径(generic / mockup-first / generalized workflow)经同一函数自动全覆盖。

## 改动 2:测试(prompt-string 锚点,全部 hermetic)

canonical 正向锚全落在 fly793 design case;其余 design 形态锚标题+nonce 即可(避免重复断言);反锚补全**所有**非 design 形态(Codex R1 #4)。

| 文件 | 改法 |
|---|---|
| `Blueprint.fly793-phase-prompt.test.ts` | design 测试(:102)加正锚:`INTERACTIVE COMMENT LAYER (MANDATORY`、`localStorage`、`location.pathname`、`nonce="__CSP_NONCE__"`、`Do NOT include your own Content-Security-Policy meta`、`addEventListener`、`HTML-escape`、`textContent/value`、`navigator.clipboard.writeText`、`unavailable OR its promise rejects`、`execCommand('copy')`、`DIAGRAMS AND LANGUAGE (MANDATORY`、`mmdc`、`inline that SVG`、`no runtime mermaid.js`、`first time each technical term appears`、`Do NOT fake diagrams with CSS boxes`、`retry once with standard flags`、`DIAGRAM PENDING LOCAL RENDER`、`hosted or remote diagram rendering service`、`mmdc --svgId`、`unique per diagram`、`plain-language explanation`;`INTERACTIVE COMMENT LAYER` 与 `DIAGRAMS AND LANGUAGE` 两个反锚均加进 implement(:144)、QA(:155)、byte-compat 默认单 session(:168)、shareParentBranch-main(:175)四个既有 case |
| `blueprint-designer-phase.test.ts` | mockup-first 路径(:103)与 generic 路径(:130)各加 `INTERACTIVE COMMENT LAYER` + `__CSP_NONCE__` + `DIAGRAMS AND LANGUAGE (MANDATORY` + `plain-language explanation` 正锚;单 session(:161)与 Implement/QA(:171)既有 case 各加两个必选块的反锚 |
| `Blueprint.generalized-workflow.test.ts` | design 节点测试(:130 区)加 `INTERACTIVE COMMENT LAYER` + `DIAGRAMS AND LANGUAGE (MANDATORY` + `plain-language explanation` 正锚;no-design 测试(:186 区)加两个必选块的反锚 |

既有断言零改动、全保绿(只增不改)。

## 改动 3:设计完稿后的 founder 反馈补折

- 新增 `design-correction.md`,记录 2026-07-27 FLY-1501 thread 的两条 founder 反馈及本次合同纠正;
- 本单已交付的 `founder-design-FLY-1508.html` 也必须遵守新合同:删除 CSS box + arrow 拼出的伪流程图;本次本地 `mmdc` 受工作区 macOS sandbox 阻断,按 h 条交付显式待本地渲染的 CSS 占位并保留 Mermaid 源,不再使用服务端 renderer;证据见 `design-correction.md`。
- Lead 负责重发布,本实现节点只提交更新后的自包含 HTML。

## Code review LOW advisories(记录,本单不扩合同)

- `publish-report` 有 512KB 硬上限;后续若图很多,可在独立 follow-up 定义体积预算和超限时的图表舍弃顺序;
- 每节 comment 的 localStorage suffix 后续可从 DOM 顺序升级为稳定 section slug,避免同路径内容重排时错配;
- a 条的 “EVERY section/card” 后续可显式排除底部汇总卡,消除自指歧义;本参考页已用非 `.card` 的 `#cmt-panel` 避免汇总卡自聚合。

## 不做(范围铁律)

不动 publish-report / report-registry;不动 implement / QA / 单 session 节点;零新机制、零 config、零 flag。

## 验收(implement 节点执行)

1. 上述锚点断言全过 + 既有 Blueprint prompt 测试全绿;
2. 全仓 `pnpm lint` + `pnpm -r build` + edge-worker 测试;
3. Codex code review 通过;ship 走 founder gate。

## 风险

极低——纯 prompt 文案。唯一实质风险是条款写错误导 runner(如漏 addEventListener MUST → 复制按钮被 CSP 拦),已由 c/d 两条显式条款 + 逐字锚点测试钉死。
