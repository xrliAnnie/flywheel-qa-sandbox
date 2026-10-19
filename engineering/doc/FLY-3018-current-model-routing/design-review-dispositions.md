# FLY-3018 新派单按当前模型配置选模型 — 设计评审处置（第三次重开）
Issue: FLY-3018 (https://linear.app/geoforge3d/issue/FLY-3018/引擎路由-派单不带覆盖时老单的实现节点opus被解析成-codex-模型gpt-6-astra-gpt-56-sol回执仍写-opus)
日期: 2026-09-29
基于: plan.md

Codex 设计评审（reviewer gpt-6-astra / xhigh，线程 `01a0ebd3-1bda-7c93-9c49-0fc0c8a88546`）：

| 轮 | 结果 | 处置 |
|---|---|---|
| R1 | CHANGES_REQUESTED（HIGH 1：先 qa-result 再 teardown 会因凭据已消耗被拒；MEDIUM 1：CLI 不打印服务端 reason，preflight/留证不能假设看到原文） | 全部采纳 → plan v2.5.1（`3f429ab14`）：§4.4 顺序改为记录 → teardown → qa-result；§4.0/4.1/4.5 改正向条件 + 保留 CLI 原始输出，状态与 reason 分开写 |
| R2 | **APPROVED**（LOW 2，非阻断） | 见下；为保持已批准 plan blob `f7c12847…` 不动，两条 LOW 记在本文件，QA 节点执行时一并遵守 |

## R2 LOW 处置（QA 执行时视同 plan 正文）

1. **plan §4.0「Lead 裁定」段的半句**「只有 `room list` 不再 `room_service_disabled` 才执行 slot 4 deploy」读作：**只有满足上表第一道 preflight（`room list` exit 0 且返回有效 `{ok:true, rooms:[…]}`）才执行 slot 4 deploy**。CLI 不会打印 reason 字样，「没看到该字样」不算满足。
2. **plan §4.4 第 3 条括号里的 `operation_id` / `driver_exit_code` / `evidence_copy`** 是 **drill/wait 操作结果快照**（房服务返回），不是 evidence-run 的不可变请求回执。后者由 CLI 在发送前自动生成并持久化在 `<runner state dir>/evidence-run/<record_id>.json`（含 head/site/lane/record_url/rerun_spec 全部请求字段）。QA 两者都保留、分开命名，⛔ 不手工构造或修改该回执；同 id/同 payload 重试沿用它。
