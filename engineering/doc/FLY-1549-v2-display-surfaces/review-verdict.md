# Cross-Vendor Review Verdict — FLY-1549

**Issue**: FLY-1549([v2] 按 FLY-907 PRD 实现三个显示面)
**Executor vendor**: claude(claude-fable-5,FLYWHEEL_V2_VENDOR=claude)
**Reviewer vendor**: codex(codex-with-fallback exec,cross-vendor per FLY-1544 ②)

## Design review(plan + 实现 + 测试逐轮验证)

| Round | Verdict | Findings | 摘要 |
|---|---|---|---|
| R1 | CHANGES REQUESTED | 7 | DB authority 显式必填+epoch 校验 / 终态优先级(closure.failed > gate.settled;expired→受阻)/ 429 Retry-After horizon 持久化 / sweep 主路径化(冻结条目不占批槽)/ header 1900 单消息预算 / 标题只剥自管前缀+100 预算 / tmux probe 超时 |
| R2 | CHANGES REQUESTED | 3 | headerPinned 持久化(未 pin 不算收敛)/ 多 active 超预算合同重定义(折叠计数,永不静默丢)/ 标题 strip 精确 token 匹配(✅P0 保留) |
| R3 | CHANGES REQUESTED | 3 | pin 404 清记录补发 / fp 快路径要求 pin 确认 + render version 升 2 / probe 4-并发 + 全快照预算 |
| R4 | CHANGES REQUESTED | 1 | 收敛后外删/取消置顶自愈(sweep 远端核验 GET) |
| R5 | CHANGES REQUESTED | 3 | unpin/PUT-404 连 fp 一起清(不可卡死)/ 核验瞬时失败挡归档 / 核验裁决 CAS 防竞态 |
| R6 | CHANGES REQUESTED | 2 | CAS 纳入 archivedAt / archive catch-up await 前后双 CAS |
| R7 | CHANGES REQUESTED | 1 | 内联 issue_closed 归档窗纳入 per-issue fence(holdIssue) |
| R8 | CHANGES REQUESTED | 1(测试强度) | fence 顺序测试 mutation-proof 化 |
| R9 | **APPROVED** | 0 | codex 自跑 mutation check 双向验证;95/95 相关测试、typecheck、v2-host build 全过 |

**Design final verdict: APPROVED(R9,评审 HEAD `68924613`)**

## Code review(PR #733 全 diff,xhigh)

| Round | Verdict | Findings | 摘要 |
|---|---|---|---|
| C-R1 | CHANGES REQUESTED | 4 | 未落地 pass 清旧 fp(A→B半写→回A 不得假收敛)/ reader 校验 envelope v+cutover_epoch 对齐权威 reader(跨代拒绝)/ FLYWHEEL_V2_DB_PATH 强制绝对路径 / sweep 周期严格非负整数校验(NaN 会废掉两个 cadence 闸) |
| C-R2 | 见下 | | |

## Lead 指路折入

FLY-1255 vendor-neutral model display:面 B 行复用 `renderRunnerModelDisplay()` threadMarker,`attempts.model` 进快照与 fingerprint;面 A 无模型位不碰(零 scope 扩张)。

## Accepted residuals(评审知情)

1. 同路径陈旧 DB 副本无法完全检测(显式 `FLYWHEEL_V2_DB_PATH` + cutover_epoch 校验 + 运维纪律;R1 #1 记录)。
2. sweep 游标进程内存,重启归零从头轮转(无饥饿;R1 #4 记录)。
3. 多 active 超预算时仅拓扑靠前的 blocked/active 块带可见 attach 命令,其余折入计数摘要(R2 #2 重定义的合同,显示恒全量诚实)。
4. archived thread 上被 founder 删除的 header 不自愈(冻结即自由;R4 记录)。
5. 本机环境性测试失败与 main 基线逐字节一致(11 文件 13 测试,生产 token/真 tmux 所致),CI 干净环境为准。
