# FLY-2141 Epic 残余扫描 — 设计增量修正
Issue: FLY-2141 (https://linear.app/geoforge3d/issue/FLY-2141/2108b-epic-残余扫描巡检钟上补回头看-epic-还剩什么-空位拉活)
日期: 2026-09-04
基于: plan.md（blob `315bcc8c933f3107fda2e1fb79abb1dd13c817b6`）

## 治理裁定原文

以下为 Lead 对 design review finding `scope-trigger-invariant-vs-discovery-order` 的逐字裁定：

> 治理裁定(Lead,FLY-1404 §6 增量修正机制;plan blob 315bcc8c 保持 pinned,不回退不改写):
> 【裁定 · scope-trigger-invariant-vs-discovery-order】评审说得对:「trigger=scope ⇒ remainingForLead>0」这条不变量废除。remainingForLead=0 且 trigger=scope 是**正常静默结果**(名册空、Epic 在本 Lead 范围内已无剩余),不是非法 shape,不铸活、不出页、不报 finding。真故障与「本来没活」必须留下不同痕迹,靠**显式失败通道**区分,不靠计数:查询/账本不可读 ⇒ 结构化 UNAVAILABLE(structural: epic_residual_invalid 之类稳定 token)+ 不产出 fact;查询成功且 0 ⇒ normal fact,渲染为「无剩余」。assertEpicResidualFact 只断言 fact 内部一致性(计数非负、trigger 合法、来源可追溯),B13 对应改为「scope+0 = 合法 nothing-remaining」。补一条测试:空名册+范围内零剩余 → 静默 normal;账本不可读 → UNAVAILABLE 且无 fact。
> 【执行】不改 plan.md。在本单 doc 目录追加 design-correction.md(abolished: 该不变量 + B13 的非法 shape 条款;retained: 其余全保留;逐字引用本裁定),对同一 blob 再开一次 exact-blob review,请求里附 design-correction.md 路径。复审若只重提这一个 findingKey ⇒ 视为已裁(Lead acceptance)继续 C3;有新阻塞级发现才停下报我。另:你现在没有 tmux 窗口(CommDB 仍是 :pending),我看你的 codex home 和 git 提交知道你活着;照常干,不用管。

## Abolished

本增量修正仅废除以下两项：

1. `assertEpicResidualFact` 的 `trigger === "scope" ⇒ remainingForLead > 0` 不变量。
2. B13 中把 `trigger="scope"` 且 `remainingForLead=0` 归为非法 shape 的条款。

`trigger="scope"`、`remainingForLead=0` 现在是合法的 internally-consistent available fact，表示该 Lead 在成功观测到的 Epic 范围内没有剩余归属项。patrol 的空名册路径将其作为正常静默结果：不铸 tick，不渲染，不报 finding。

## Retained

除上述两项外，plan.md blob `315bcc8c933f3107fda2e1fb79abb1dd13c817b6` 的目标、非目标、接口、失败 token、TDD 顺序、B1–B20 及验收门全部保留。尤其保留：

- 查询、账本读取、schema 或残余事实校验失败走结构化 `kind:"unavailable"` 与稳定 allowlist token；不得把故障伪装成 `remainingForLead=0`。
- 成功查询且 `remainingForLead=0` 走 `kind:"available"`，与 `unavailable` 在判别联合上明确区分。
- 名册为空时，只有成功 available fact 且 `remainingForLead>0` 才铸 scope-triggered tick；available+0 与 unavailable 都不铸。
- `assertEpicResidualFact` 继续校验 fact 内部一致性：schema、枚举、时间来源、非负安全整数、计数和、子集边界、identifier、priority、ownership 与 token allowlist。

## 修正后的验收解释

- B9：`remainingForLead=0` 是正常 available 静默分支；unavailable 是失败静默分支，两者必须由 `kind` 区分。
- B13：`trigger="scope"` 且 `remainingForLead=0` 是合法 nothing-remaining，不进入固定 invalid 降级；B13 其余非法 shape 仍 fail-closed。
- B19：空名册 + 成功查询 + 范围内零归属项 ⇒ normal available fact 后静默；空名册 + 账本不可读 ⇒ `UNAVAILABLE`，不得产生 available fact，也不铸 tick。

必须新增回归测试：

1. 空名册、成功 materialize、范围内零剩余归属项 ⇒ `kind:"available"`、`trigger:"scope"`、`remainingForLead:0`，patrol 静默。
2. 空名册、账本不可读 ⇒ `kind:"unavailable"` 且稳定 token，无 available fact，patrol 静默。

