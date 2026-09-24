# FLY-2808 设计评审 R3 记录 — 评审记录
Issue: FLY-2808 (https://linear.app/geoforge3d/issue/FLY-2808/节点生命周期n1-设计主动退下与意外死亡的区分信号-六个会把退下当死亡的打断点怎么改-拉起的身份模型工作目录核对)
日期: 2026-09-24
基于: plan.md（R2 收据 review-receipt.json，planSha256 c551e0bd）

## 背景

重开 run `7fca976d-9d47-466d-84bc-1a53e0b90925`（eng_design attempt 1，exec `9d8dc71e-51a8-4244-86b1-388648650320`）。R2 批准后 plan.md 追加了 §11/§12，当前 blob 与 R2 收据不一致，本轮对新增内容做 scoped 复审并重绑设计门。

## 绑定

| 项 | 值 |
|---|---|
| review gate question | `d89b2485-47ee-45e3-bc55-5d8233d282c6` (checkpoint review_design) |
| Bridge manifest | revision 2，requestId `4948dce8-1909-45c9-9825-cd6a99173b90` |
| reviewedPlanBlobSha | `a8f1cf87f79a6b55dec45327d8823a285d820516`（commit `ad453e997`） |
| Codex thread | `01a0d457-d49d-7540-bba0-8ec51902aaba`（已归档） |
| await-codex-gate | design APPROVED，exit 0 |

## Round 1 — CHANGES REQUESTED（4 HIGH）

Codex 按当前 HEAD 核出四条「§12 自述与代码不符」：① 入口/retry admission 不带 `processLifecycle`（runs-route.ts:3652、actions.ts:1217）；② `beginWorkflowExecutionResume`/fallback 不按 §6 分类，身份错配也会被重试并最终 fresh fallback；③ Claude `onIdentityVerified` 在进程启动前由 launcher 自证；④ Claude/Codex kill 失败仍写 `process_tree_gone`。

处置：四条均为实现缺口而非设计变更；plan.md 新增 §6.1 失败类别枚举与允许动作表，§12 改写为诚实的实现状态记录，§12.2 逐项列出缺口、违反条款、必修行为与验收负例。

## Round 2 — APPROVED

Codex 确认新增内容与 §1–§10 一致，无新的设计级安全缺口；保留 1 条 LOW 非阻塞建议：§6.1/§12.2 中「原 body 已证明消失」应实现为「当前 generation 的物理 inventory（进程、window/session、daemon/socket）已证明 absent」，事务复核绑定 execution/generation/demand/owner 的证据 receipt，不是检查 process-body 行不存在，也不在事务内做外部探测。→ 记入实现节点核对清单，不改条文。

批准只覆盖设计文档，不代表本分支实现代码获批。
