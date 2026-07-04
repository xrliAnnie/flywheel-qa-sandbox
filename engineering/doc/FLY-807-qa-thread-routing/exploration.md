# FLY-807 auto-QA thread 路由错误 — 探索

Issue: FLY-807 (https://linear.app/geoforge3d/issue/FLY-807/infra-auto-qa-的-qa-thread-落错频道建到-core-对-founder-不可见-按-label-路由到对-lead)
日期: 2026-07-03
基于: 无

## 1. 问题(Annie + Cass 2026-07-03 现场诊断)

auto-QA(FLY-579/643)为每个 issue 起独立 `QA·FLY-XX` Linear issue 时,该 issue 自
己的 Discord 聊天 thread 本应按父 issue 的 Linear label 路由到对应 Lead 的频道(如
`Flywheel` label → Eng Tadashi → eng 频道),但实际观察到的现象是:不论父 issue
挂什么 label,QA thread 全部落到 `#flywheel-core`(CoS Aunt Cass 的频道),并且创建
时没有把 founder 加进 thread member → Discord 侧栏不显示 → founder 对 QA 生命周期
完全不可见。

诉求拆成四点:
1. 路由修正:QA thread 应落到对应 Lead 的频道,不是一律落 core。
2. @founder / 加 member:创建时让 founder 侧栏可见。
3. Lead relay QA 生命周期(started/stage/verdict)到该 thread,不静默。
4. 挪走已经堆积在 `#core` 的存量 QA/eng thread。

## 2. 假设 & 排查方向

在读代码前列出的候选假设:
- QA thread 创建路径是否 hardcode 了 core channel id?
- QA session 的 `issueLabels` 有没有正确从父 issue 透传?
- `resolveLeadForIssue`(或等价的 label→Lead 映射)本身逻辑是否有 bug(大小写、
  fallback 行为)?
- founder 加 member 的逻辑是否只在"正常" thread 创建路径存在,QA 路径被跳过?
- 存量清理:Discord/代码里有没有"挪 thread 到别的 channel"的机制?

用一个 Explore 子代理 + 本会话独立代码审计双线核实,结论详见 `research.md`。
