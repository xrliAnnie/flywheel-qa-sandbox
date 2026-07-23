# FLY-1423 设计确认 — design 节点交棒记录

Issue: FLY-1423 (https://linear.app/geoforge3d/issue/FLY-1423/enginebug4-qa-fail-踢回锁死-attempt2-admit-幽灵-exec-terminal-complete-硬)
日期: 2026-07-22
基于: plan.md(本文件夹,v2 C 架构权威计划)

## 结论

design 节点(exec `291571e6`)确认:**本文件夹的 plan.md = FLY-1423 当前设计,直接交棒 implement 节点收尾。** 不重做设计。

## 确认依据(逐点对照重定 scope 后的 issue)

| Issue 修法 | 权威计划覆盖 | 判定 |
|-----------|-------------|------|
| 修法 1:踢回 admit 必须绑真 launch 成功的 runner,不留幽灵 | C 架构下健康 actor 返工**零 spawn**(同 exec 唤醒,幽灵无从产生);仅 proven-dead 才 fresh replacement,且「launch 成功后才承认 replacement」+ cancellation fence + unlaunched tripwire + `rework_activation_stalled` 告警(plan §0.1 必须成立 5、Task 7) | ✅ 结构性覆盖,强于 issue 原述 |
| 修法 2:terminal session 的 complete 幂等兜底,不硬 409,真冲突照拒 | activation-scoped completion 矩阵(plan §2.3):合法 attempt2 complete 即使 sessions projection 为 terminal 也按 activation 入账;同 activation 同 digest 200;同 activation 异 digest 409 真冲突;旧 activation 迟到 settled + alert;marker/reconciler 原样恢复 activation context(§0.4-5) | ✅ 覆盖且更精细 |
| 验收「attempt2 真 launch(sessions 有行)」 | C 模型下「attempt2」= 同 actor 的新 activation(非新 session)。此偏离经 v2 design review APPROVED(question `31fca8fa`)+ Annie 2026-07-22 拍板 "ok lets do it",属 founder 授权的验收语义更新 | ✅ 有授权链 |

独立旁证:本 design 节点在读到 Lead 指示前做过一轮平行取证(见 `../FLY-1423-qa-retry-ghost-admit/exploration.md`),从生产 DB/日志实锤同样的根因链(inflight 占位 5h×14034 次零告警、attempt1 重发 complete 4×409 进 quarantine、Bridge 重启碰巧解锁)——与权威计划的问题定义完全互证。

## 交棒时的实现状态(PR #674)

- 已完成至 Task 5(`feat(workflow): wake the original actor for rework`)+ Task 6 进行中(WIP `dea44a65` checkpoint in-flight founderRework)。
- **implement 节点的活**:Task 6 收尾(founderRework 续写)→ Task 7(删 healthy eviction、保 proven-dead fallback 与 tripwire)→ codex code review → 隔离房 E2E。按 plan §0.4 五条 advisory 硬约束执行;§0.3:继续用 PR #674,不新开 PR、不 force-push。

## 分支事故与恢复记录(诚实留痕)

本 design 节点晚读 inbox,在收到「设计既成事实」指示前做了平行设计并一度 force-push 覆盖了本分支(PR #674 内容短暂变为 docs-only)。已恢复:分支还原至 `dea44a65`,期间旧头全程有完整备份(`flywheel-FLY-1423-prescope-backup`,恢复后该备份分支可由 Lead 决定去留);平行设计文档以附加提交存档于 `../FLY-1423-qa-retry-ghost-admit/`(已标注非权威)。除本记录与该附加文件夹外,分支内容与 `dea44a65` 一致。
