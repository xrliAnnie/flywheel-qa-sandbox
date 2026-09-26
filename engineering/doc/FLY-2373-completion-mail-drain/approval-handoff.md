# FLY-2373 设计批准与后续事项
Issue: FLY-2373 (https://linear.app/geoforge3d/issue/FLY-2373)
日期: 2026-09-26
基于: plan.md

有效 reviewVerdict=APPROVED；reviewerVerdict=APPROVED；round=1。
requestId: 50a52700-5102-48f9-b090-54b22e14f0b2
questionId: 23c8ef8c-2cce-4933-b0c2-d5a068cffecd

批准计划提交：393a408a5；本记录不修改已送审plan。非阻塞建议完整原文见review-round1.json。以下全部交Lead决定跟进，不宣称已实施或解决。

## settled-wake-left-pending-readers — MEDIUM
结算后 wake 仍留在 pending，但 plan 只让 phase reader、claim 和 sweep 过滤它，其余读 pending wake 的代码没有覆盖

处置：非阻塞 Follow-up，保留原建议交 Lead 决定；本设计节点不据此改写已批准机制。

## obligation-enumeration-root-undefined — MEDIUM
“全部当前义务”从哪些记录里枚举没有定义；started/finished 也没有对应的消费凭据来源

处置：非阻塞 Follow-up，保留原建议交 Lead 决定；本设计节点不据此改写已批准机制。

## page-size-vs-carrier-output-truncation — MEDIUM
服务端无法保证“所有页都输出给模型”，分页上限必须按 carrier 实际可见的工具输出上限来定

处置：非阻塞 Follow-up，保留原建议交 Lead 决定；本设计节点不据此改写已批准机制。

## successor-dispatch-gated-on-commdb-reconcile — LOW
后继派发依赖 CommDB settlement reconcile，但失败时的有界重试、告警和具体 dispatcher 文件都没写

处置：非阻塞 Follow-up，保留原建议交 Lead 决定；本设计节点不据此改写已批准机制。

## bridge-commdb-writable-lock-scope — LOW
完工路径需要从只读 CommDB 改为可写 IMMEDIATE 事务，这对 Bridge 事件循环的影响没有写

处置：非阻塞 Follow-up，保留原建议交 Lead 决定；本设计节点不据此改写已批准机制。

## retention-fragments-missing — LOW
新增的两张 CommDB 表没有写 retention 分类片段和保留策略

处置：非阻塞 Follow-up，保留原建议交 Lead 决定；本设计节点不据此改写已批准机制。

## gate-and-verify-approval-consumers — LOW
plan 只写了 check.ts，漏了 gate.ts 这个 consumeGateResponse 消费者；verify-approval 用的是纯查询 getResponse

处置：非阻塞 Follow-up，保留原建议交 Lead 决定；本设计节点不据此改写已批准机制。

## tests_not_run — LOW
worktree 没有安装依赖，本轮没有执行基线测试

处置：非阻塞 Follow-up，保留原建议交 Lead 决定；本设计节点不据此改写已批准机制。

## 验证边界
仅文档和HTML交互静态/VM验证；产品测试未运行，worktree没有安装依赖。真实529 Codex长turn和Claude回归属于后续QA。
本地Mermaid每图两次均权限错误，明确占位与源文件保留。
既有记忆已覆盖运输ACK不等于消费、精确身份与有效review gate；本次没有额外可复用角色判断需要新增，角色记忆保持不变。
