# FLY-1508 design 节点 founder HTML 合同补互动格式规范 — 设计修正
Issue: FLY-1508
日期: 2026-07-27
基于: plan.md

## 修正来源

设计完稿后,Lead 转达 Annie 在 2026-07-27 FLY-1501 thread 的两条 founder 反馈:

1. 流程图和架构图必须是真正渲染出的 Mermaid 图,适合时可用 Mermaid 自带的 UML 风格图类型;不能再用 CSS 盒子和箭头拼成伪流程图——后者不可读;
2. founder-facing 语言必须零黑话:每个技术术语第一次出现时,紧跟一句白话解释。

## 对永久合同的修正

在 `INTERACTIVE COMMENT LAYER` 之后加入同级的 `DIAGRAMS AND LANGUAGE (MANDATORY - founder feedback 2026-07-27)` 必选块:

- 每张流程/架构图用 Mermaid 语法编写,适合时使用 Mermaid 的 UML 风格图类型;本地以 `mmdc`(Mermaid 命令行渲染器)转为自包含 SVG,再把 SVG 标记内联进 HTML。图必须在构建时完全渲染,托管成品零外部请求,不在页面运行 `mermaid.js`,也不使用 CSS boxes/arrows 冒充图;
- 每个技术术语第一次出现后必须立刻补一整句白话说明。
- `mmdc` 首次失败时用标准 flags 重试一次;仍失败则交付显式标注 `DIAGRAM PENDING LOCAL RENDER` 的 CSS 占位、保留 Mermaid 源并报告失败,严禁把设计内容发给 hosted/remote diagram renderer;
- 同页多图时,每次 `mmdc` 调用都必须传唯一稳定的 `--svgId <issue>-d<N>`,避免 SVG 的 marker/gradient/filter id 互相冲突。

prompt-string 测试会正向钉住标题、`mmdc`、内联 SVG、禁 CSS 伪图和白话解释,并在 implement、QA、默认单 session 等非 design 路径加反向断言。

## 对本单设计成品的修正

`founder-design-FLY-1508.html` 原核心流程正是 CSS boxes/arrows,与新反馈冲突。本修正保留 Mermaid 源;页面继续零外部依赖,互动 comment 层不变。

本机已实际调用已安装的 `mmdc 11.12.0`;即使 Mermaid 源和 SVG 输出都移到 `/private/tmp`,工作区 macOS sandbox 仍在 Chromium 启动前拒绝其 Mach-port 注册(此前的 no-sandbox/headless-shell 尝试也相同)。首次实现曾临时使用服务端 Mermaid SVG,但首轮 code review 指出这会把设计内容送出本机;Lead 采纳后已删除该 SVG,改成交付显式标注待本地渲染的 CSS 占位并保留 `.mmd` 源。这里不把失败的本地调用写成成功证据,也不再使用远程渲染服务。
