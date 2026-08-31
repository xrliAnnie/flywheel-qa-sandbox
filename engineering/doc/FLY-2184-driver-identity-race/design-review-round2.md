# Design Review — plan.md (Round 2)

Date: 2026-08-31
Author: Codex
Status: APPROVED

## Summary

Round 1 的五项阻塞均已闭环，更新稿现在同时保留了 stub 的 fail-closed authority error 与 driver 的既有 A3 诊断语义，并把 pre-push PR 判定、真 validator 对照组、CI 消费和 slot-local room 契约写成可验证步骤。方案与当前源码边界兼容，scope、顺序和回滚面清晰，可以进入实施。

## What's Good (Keep)

- `pollRemotePrAuthority` 改为返回 discriminated union，共享层只负责 observation 收敛，stub 与 driver 各自决定错误/A3 进程语义；这消除了 Round 1 中“共享 helper 耗尽必抛”与 driver “耗尽必须进入 preflight”之间的矛盾。
- 已有 PR 的发现被前移到 push 之前，并优先消费 durable `state.lastCompletion.prNumber`；known-PR 路径明确禁止 create，fresh 路径只 create 一次，且新增的“首次 post-push 观察为空”用例直接覆盖原竞态窗口。
- C5 现在先生成完整合法 env，再从最终 env 删除 summary role 后调用真 `authorizeLeadWrite`，所以正向与反向探针都确实经过 validator；assembler 自身的缺键守卫也保留独立测试。
- 对照组固定放进 CI 已点名的 `qa-generalized-e2e-lib.test.mjs`，避免新增未被 workflow 消费的测试文件；dist 缺失仍为响亮失败，不存在 silent skip。
- `summaryConfigHome` 从“非空字符串”升级为 slot-root 锚定的绝对路径合同，并为 consumer 拒绝矩阵与 writer 传参/落字段同时补测试，能够证明不会回落到 operator HOME 或其它 slot。
- validator/CLI/package 生产控制面保持零改动；lease DB 隔离、exact-head CI、真机 QA 验收和单 PR 回滚边界均保持不变。

## Issues & Recommendations

1. **非阻断实施提醒：必须按计划真正移动跨函数时序。** 当前源码仍是 `completeImplement` 先调用会 push 的 `commitFile`，再调用 `ensurePullRequest`（`qa-529-generalized-stub.mjs:390-395`）。实施时应在 `completeImplement` 中先取得 durable/pre-push PR observation，再调用 `commitFile`，最后把“known PR 或 confirmed fresh”判定传给 async ensure/poll；不能只在现有 `ensurePullRequest(context, head)` 内加查询，否则查询实际仍发生在 push 后。更新稿的步骤与测试已经足以约束这一点，无需改设计。

2. **非阻断实现精度：`pollRemotePrAuthority` 的“不抛错”应限定为已成功取得的 PR observation 分类。** 注入的 `list()` 若因 `gh`/网络/JSON 错误直接抛出，现有行为应继续作为基础设施失败传播，不能伪装成 `fatal`/`exhausted` 后被 driver 映射为 A3 authority diagnosis；若希望连依赖错误也 union 化，则需另设明确的 operational-error kind。当前 issue 只处理最终一致性，保持依赖异常 fail-fast 是最小且一致的实现。

## Verdict

APPROVED — ready to implement
