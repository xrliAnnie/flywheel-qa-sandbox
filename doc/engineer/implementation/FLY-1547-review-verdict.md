# FLY-1547 Cross-Vendor Review Verdict(FLY-1544 ② 合同履行记录)

**Executor vendor**: claude(claude-fable-5,generic 节点,attempt 5a4d2e89 gen 1)
**Reviewer vendor**: codex(gpt-5.6-sol,xhigh,`codex exec` 独立评审)
**Rounds**: 5(design R1/R2 + design/code R3 + code R4/R5,评审全文存 `/tmp/fly1547-design-review-r{1..5}.md`,已随轮折入)
**Date**: 2026-07-30

## 逐轮记录

| 轮 | 结论 | findings | 处置 |
|---|---|---|---|
| R1(design) | CHANGES REQUESTED | 10(6H/3M/1L) | 全部折入 design v3;F5 按其要求补两次真机 spike(裸 TUI 负向 + 远控附着正向) |
| R2(design) | CHANGES REQUESTED | 9(6H/2M/1L) | 全部折入;两条权限项按其指示上报 lead 裁决(§9:①放行/②A=显式例外) |
| R3(design+code) | CHANGES REQUESTED | 8(5H/3M) | 全部折入代码(串行锁/settle 合同/铃健康序/credential 代际缓存+原子发布/对账先行发送器/send 词汇/admit 警告) |
| R4(code) | CHANGES REQUESTED | 9 项判定 + 3 新缺陷 | 全部折入(单飞投递/READY durable 等待/daemon 泄漏与拆除严格化/enqueue 词汇边界/overdue 分集键);enqueue 守卫当场逮住测试用未分类 kind |
| R5(code) | CHANGES REQUESTED | 3 BLOCKING HIGH + 判定表 | **三条 blocker 已在 R5 后全部折入**(322367f3):B1 READY 完成态等待 + assignment 显式状态机(失败即下轮重试,超时=歧义受理);B2 拆除两事实权限证明(死 socket 绝不发信号/活 socket 需 holder→PGID 一致证明/护自身进程组,6 例矩阵测试);B3 pre-spawn durable intent + 单一 cleanup owner + ensureDead=false 一等公民 + 收养边界双事实检查 |

## 终局状态

- **无 APPROVED 轮**:R5 折入后**未再开 R6**,依 issue lead 明示指令(2026-07-30,doorbell message c6d0325a:「R5 结论出来就开 PR,别再加轮次」)。节点合同的"评到 APPROVED"环由 lead 的停轮指令收束;本文件如实记录该处置而非声称 APPROVED。
- R5 折入的三条 blocker 均有对应单测(v2-host 69 测含 B1 重试链 + B2 六例权限矩阵);全仓 6 包 **300 测绿**(94/69/23/18/71/25),lint+build 绿。
- **真机证据**:FLY-1546 三项可行性 PASS;codex 叫醒双 spike(负向:裸 TUI 隐形分叉;正向:远控附着铃 turn 渲染 pane);**E2E 7/7 ALL PASS**(隔离真 host+真 socket+真 claude lead 会话:FYI 读即销/账本读留痕/settle(reply) 派生路由+message-scoped 幂等/**lead 长轮询 4-26ms 即时唤醒**)。

## R5 认可的 residual(named follow-ups,不阻塞首合)

1. service.ts 冲突识别的 regex 兜底可删(错误名已保真传输);
2. 生产 `register-operator-lead.sh` 的 `--delivery-credential-out` + 精确选 PID 改造 = merge 后按 ops-notes 执行(feature 默认未配置);
3. 对账测试扩展到 host 生产源文件扫描(现为 host 四 kind 固定清单断言 + enqueue 运行时词汇栅栏双保险);
4. probe() 的 tmux+daemon 双事实全矩阵(收养边界已双事实;probe 本身仍 tmux 身份);
5. channel→doorbell 的单进程真集成测试(现为两侧独立单测 + E2E 覆盖);
6. codex 远控形态的 runner 语境真机 E2E(spike 已证形态;全链路真机验收在 FLY-1545 测试房落)。
