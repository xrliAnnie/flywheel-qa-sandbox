# FLY-914 竞品研究 — Codex Artifact / Claude Artifacts / ChatGPT Canvas — 竞品对标

Issue: FLY-914 (https://linear.app/geoforge3d/issue/FLY-914/interactive-html-review-artifact-google-doc-style-inline-comments)
日期: 2026-07-06
基于: prd.md

Honey 要求:做 Codex Artifact research。本 issue 自述「类比 Codex App 的 Artifact 功能」。以下对标,只抽对 FLY-914 决策有用的点。

## 对标表(按对我们重要的轴)

| 轴 | Codex / ChatGPT Canvas | Claude Artifacts | **FLY-914(我们)** |
|---|---|---|---|
| 载体 | 桌面 App / Web 内嵌面板 | claude.ai 内嵌面板 | **独立托管 HTML,手机浏览器打开** |
| JS 运行时 | 有(沙箱 iframe,允许脚本) | 有(沙箱 iframe,允许脚本) | 现有 fw-reports **无**(CSP 杀 JS)→ 头号前提 |
| 就地评论 | Canvas 支持选中文本留 comment / suggest edit | 无原生行内评论(整块重生成) | **段落级留评论(A)** |
| 反馈回流 | 评论回到**同一个 App 会话**里的 agent | 回到 claude.ai 会话 | **回到 Discord thread**(Discord 当 hub);**v1 机制 = 剪贴板复制**(段落原文+评论 配对,Annie 粘进 thread),自动 relay 回流 = FLY-931 backlog |
| 平台绑定 | 绑桌面/web App | 绑 claude.ai | **不绑 App:Discord + 手机 + 可批注 artifact** |

## 三条对 FLY-914 的结论

1. **「artifact 有 JS 运行时」是行业标配,不是奢求。** Codex/Claude/Canvas 的 artifact 都跑在允许脚本的沙箱 iframe 里。我们 fw-reports 的 `default-src none` 是**为静态报告收的紧**,不适配交互 artifact。→ 直接支持 PRD §4 的 **H1(放开 JS,nonce script-src)**:这只是把我们的托管拉到行业常规线,不是过度设计。

2. **我们的差异化 = 去 App 化。** 对手的 artifact 都活在自家 App/web 里,评论也回自家会话。**Annie 的场景是手机 + Discord,没有那个桌面 App。** FLY-914 的独特价值 = 「Discord + 手机 + 可批注 artifact,评论回 Discord thread」—— 竞品都做不到(它们绑 App)。这也解释了为什么回流的落点是 Discord(见 PRD §2:v1 = 剪贴板复制粘进 thread;自动 relay = FLY-931 backlog)而不是另建 dashboard(Cass 同判)。

3. **就地评论的粒度:段落级够用、且更省。** Canvas 支持选中任意文本 comment(接近词级),但那是桌面鼠标场景;**Annie 真机验证词级划词在手机别扭 → A 段落级**。竞品的词级能力在手机不构成压力,段落级反而锚点更稳、渲染更省(§1/§3 已采纳)。

## 没做的（诚实边界）
- 未逐一实测各竞品最新 CSP / iframe sandbox 具体值(不阻塞决策:H1 只需我们自己托管放开 nonce,与竞品实现无耦合)。若要,后续可 deep-research 补。
