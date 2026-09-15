# FLY-2557 Epic 判定范围 — 探索
Issue: FLY-2557 (https://linear.app/geoforge3d/issue/FLY-2557/epic-流程intake-epic-进-in-progress-自动触发拆解bridge-监听-linear-epic无)
日期: 2026-09-14
基于: plan.md

## 决策过程（下方已有有效修订）
R1唯一HIGH：`no-epic-discriminator-runner-issues-become-intakes`。
Lead问题：`cde17197-6e08-4136-9aa0-03058c2e5b98`。本文记录备选的实际取舍，不选择或扩大需求；未获得裁定前不将任一方案写成实现合同。

原需求以「无parent＋项目department label＋进入started」描述Epic入口。现有系统会自动将普通Runner单推进started，因而这三项也会命中普通单。新入口又明确必须支持零子单Epic，不能恢复children>0来避开问题。

## 当前代码核对
`packages/teamlead/src/bridge/linear-issue-starter.ts`：

- `settledStateResult`遇到已started时返回`already_started`；这只说明当前状态，不证明是谁设置。
- `attemptLinearIssueStarted`对backlog/unstarted在重读确认未变化后调用`updateIssue(issueId,{stateId})`，随后验证已started。
- `MarkStartedResult`只含started/outcome/reason/errorClass，不含本次stateHistory span ID或变更actor。
- 因此「已有执行记录」是执行历史事实，不是「这一次started由Bridge造成」的精确证明。

## 备选及其边界
| 备选 | 能解决什么 | 仍需明确的取舍 |
|---|---|---|
| 保持原三项定义 | 完全沿用原文入口；无新增founder操作 | 普通单误入需要Lead接受并给出合法收口；必须通过正式review-ruling处置HIGH，不能由作者自行当已批准 |
| 排除有Flywheel执行/派发记录的单 | 可抑制Runner起跑引起的一部分通知 | 真Epic若自身跑过Runner可能漏收；无执行历史的普通单仍会误入；不足以证明完整Epic判定 |
| 有子单，或显式Epic声明（标签/字段） | 既有树与零子单Epic可明确识别 | 需要明确声明的单一来源、首次迁移和founder新增操作；原需求未要求该操作，不能擅加 |
| 精确排除Bridge发起的那次状态段 | 可区分同单的机器自动开始与人重新开始 | 现有starter没有精确段来源收据；需另设计持久化来源链，不能以时间接近或所有历史执行代替 |
| 仅根据状态修改actor | 意图接近「founder设置即派工」 | stateHistory无actor；普通Issue.history有创建初期缺失限制，当前无Bridge webhook绑定；不能保证新建Epic60秒内可判定 |

## 不能替代完整验收的负例
最终选定判据必须同时覆盖：零子单真Epic可进入；Runner启动的普通单不形成拆解待办；重复started不重投；普通单不会永远挂needs_founder；真实Epic已有子单时不重复拆；真Epic存在历史执行时按裁定处理；首次backfill不产生一批伪待回答问题。

以上是裁定前的取舍记录；以下修订为最终采用范围。

## 已收到的有效修订
Lead问题 `cde17197-6e08-4136-9aa0-03058c2e5b98` 初答后，`[lead-instruction da084518-89ac-4ddc-a8ba-231d67cad46e]` 明确替代其第四条件：

> An issue qualifies as an Epic when it has no parent, carries the department label, is in started, AND at least one of: (a) it has one or more child issues, or (b) it has no Flywheel dispatch record in this project (no sessions row / no workflow_run row for that issue id). So: roots with children are Epics regardless of runner history; zero-child roots are Epics only if never dispatched. Everything else in the earlier ruling stands (no Epic label, backfill=true first pass, zero-child backfill = one thread line + Lead decision). Write this into the plan, fix the HIGH, open one new review.

已落实到plan.md §3.4，并同步查询、原子准入、页面、pending失效及测试矩阵。九条advisory按Lead指令只保留Follow-ups，不扩修。此修订是范围裁定；正式review gate仍需新一轮有效APPROVED，不把Lead消息当评审通过。
