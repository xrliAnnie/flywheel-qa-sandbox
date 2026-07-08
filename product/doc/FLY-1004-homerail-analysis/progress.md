---
issue: FLY-1004
phase: implement
phaseCursor: 5/5
updated: 2026-07-08
nextStep: commit + PR → approve gate(founder-gated,停这)→ 报 Lead surface Annie
---

# FLY-1004 progress — homerail 竞品分析 + 扒开源代码

## 完成清单
- [done] 溯源:XHS 笔记 6a4de258(小天fotos)→ repo = xiaotianfotos/homerail(TS, 191★, active)
- [done] firsthand 扒 18 个源文件(manager prompt / adapter factory / DAG engine / voice.ts / codex-appserver / manager-agent-tools / audit / scorecard / skills / provider-catalog / Dockerfile / dag-tools 等)
- [done] BRAINSTORM GATE 过(Lead 确认方向 + 轻改 909 指令 + 两战略点写透)
- [done] exploration.md / research.md / plan.md(doc-flow full)
- [done] eng-idea-for-tadashi.md(主交付物,每条 它怎么做(出处)→我们能怎么用→值不值,voice 单独 A 节 + 优先级)
- [done] FLY-909 fold(轻改):homerail-deepdive.md + competitor-scan 表 A 一行 + 一句观察,不动收敛叙事
- [todo] commit + push + PR + CI 绿
- [todo] 报 Lead(结论 + eng-idea)→ surface Annie
- [todo] approve gate(founder-gated,停这;不自 ship)

## 两个战略结论(报 Annie)
1. homerail 明确不做软件 → 坐实我们「建并养真软件」是空地(好消息)
2. homerail vendor-neutral 不自造 harness → 跟我们 executor-backend(493/494/350)独立撞车(方向验证)
3. voice 层可借鉴(双 TTS 通道/生成式 UI 短朗读/执行前确认)→ 喂 FLY-1004 eng-idea + 我们 voice PRD

## 诚实边界
- 视频没转写(README/ROADMAP 已权威覆盖同内容);VAD 位置 / UI 是否 codex 做 / star 数 = UNKNOWN 快照;没实跑
