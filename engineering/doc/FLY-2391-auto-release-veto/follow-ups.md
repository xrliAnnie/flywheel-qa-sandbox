# FLY-2391 默认发布与否决 — 非阻塞建议
Issue: FLY-2391 (https://linear.app/geoforge3d/issue/FLY-2391/1143b4-auto-ship-on-silenceopt-out-fail-closed-状态机-否决窗口绑不可变候选delivery)
日期: 2026-09-14
基于: plan.md

有效 design-review verdict 为 APPROVED（R1），0 blocking findings；以下 9 MEDIUM、2 LOW 为服务端明确分类的非阻塞建议。保留完整问题与 findingKey，由 Lead 决定后续处理；不把它们冒充已修复，不据此自动缩减本单范围或重开设计评审。实现交接须携带这些开放项。原始结构化回复见 review-r1.json。

## MEDIUM · postclaim-negative-latch-gap

T13 回到 awaiting_attempt 后，committing 期间记下的 veto/负面信号没有在转移表里被带进第二次 claim

§5 的 T20 规定 committing 期间的 veto/故障只记 post_claim_intervention、状态不变；T13 随后把周期送回 awaiting_attempt，只要求『重查 green 和失效』。§9 的 invalidateCustomerReleaseCycles 明确只失效『未 claim 周期』，所以 committing 窗口内出现的瞬时 unknown（如 outbox 扫描读错误）不会写 latch。失败路径：14:00 claim → 14:00:03 扫描错误产生 unknown → 14:00:05 端点确定 CAS 412（零写入）→ T13 回 awaiting_attempt → 14:00:20 扫描恢复 green → 第二次 claim 通过 → 发布，违反 PRD §5.2『当前候选出现负面即取消本周期、恢复也不再开窗』。veto 那一半被 §5 权限表达式的 `!veto` 和 §8.3.4 的『有新的负面就取消』救回来了，但这三处说法互相不一致，而本文把转移表声明为『全转移合同 + 每行具名测试』，实现方只照表写就会漏。建议：新增一行 T13b（committing/commit_unknown 期间任何 veto/hold/unknown 一律同事务写入 cycle 级 latch，任何后续 claim 必须读它），并在 §11.1 交错矩阵补『claim→veto/unknown→412 no_write→再 claim』用例。

处置：开放的非阻塞 advisory；已报 Lead，尚未采纳或修复。

## MEDIUM · decision-token-trust-boundary

新增 FW_RELEASE_DECISION_TOKEN 与 release bot token 落在 Bridge 主机，未说明存放/擦除/诚实边界，与 FLY-2102 的机制化不变量相接不上

plugin.ts:5227 的 scrub 是按精确名字删 FW_CUSTOMER_RELEASE_TOKEN / FW_NPM_GAT_TOKEN（FLY-2102 把『FW token 不得进入 Bridge env』从纪律升级为机制并由启动 seam 测试锁死）。本计划在同一进程里新增一个同族 FW_ 令牌（+ release bot token），§2 只说『保留对旧名字的启动删除』，没说新令牌存哪、是否进 Bridge process.env、是否排除在 fleet-capture/诊断转储/execFile 子进程之外。更重要的是 §8.4 断言 releaseDecisionRequired=true 后『手动来源必须是 Bridge 已验证 founder go』——但 permit 的权威只是一个 bearer role，本机 full-access Lead/Runner（FLY-350 已接受 contract-only 信任）读到该令牌即可自铸 permit，再用共享 gh 身份 dispatch executor 完成一次跳过否决窗口的客户发布。失败路径：任一本机 agent 读 .env → PUT permit → dispatch executor → 客户指针移动，账本显示 trigger=silence_auto。这不比现状更差（今天同一身份就能 dispatch payload-promote-commit.yml），但设计必须写出：令牌落点、子进程 env 白名单（RUNNER_PANE_BASE_ALLOWLIST 只覆盖 tmux pane）、以及『policy=true 只挡没有 decision token 的调用方，不挡本机 full-access agent』这句诚实边界，否则 §12 的激活证据会把它当成强授权保证。

处置：开放的非阻塞 advisory；已报 Lead，尚未采纳或修复。

## MEDIUM · bridge-manifest-and-prepare-orchestration-unspecified

Bridge 读 manifest 的能力与 prepare/executor 的 dispatch 通道在合同里缺位

T01 要冻结 manifest 里的 beta entry、T04 要 deriveVetoBinding+回读验 hash、§8.2 claim 前要『远端 manifest 探测』、T12/T15 要重查 exact op+tuple——这些都必须由 Bridge 读 /admin/manifest。但 §8.1 的 API 表里 decision-writer 只有 pending/permit/attempt 三条，正文又写『不能调用 customer manifest』（customer manifest 指 GET /manifest 还是 /admin/manifest 未定义）。同样，T03『dispatch B1』与 T10『只准备执行器』没有说明由谁、用哪个凭据触发 workflow_dispatch，以及 Bridge 如何判定 prepare 的『等价证明齐』（Actions run 结论从哪读）。仓里已有先例应被引用并复用：packages/teamlead/src/bridge/beta-release-github.ts + beta-release-credentials.ts（B6 beta lane 的 workflow dispatch/凭据模型）。失败路径：实现方按 API 表写完才发现 Bridge 没有任何 manifest 读路径，只能临时给 decision-writer 加权限或让 Bridge 复用更宽的能力，授权面在实现期被悄悄放大。

处置：开放的非阻塞 advisory；已报 Lead，尚未采纳或修复。

## MEDIUM · liveness-fail-closed-cancels-nearly-every-cycle

在当前部署节奏下，窗口几乎必然被『重启/换部署源/Gateway 重连』取消，计划未量化也未给缓解

§9 规定 Bridge 启动统一取消 window_open/awaiting_attempt，§7 规定 Gateway 断线/session invalid 即使 resume 成功也不恢复周期。而 scripts/restart-services.sh 的头注就是『FLY-20: Auto-restart Bridge + Lead after merge』——每次 merge 到 main 都会重建并重启 Bridge，同时改写 ~/.flywheel/deployed-sha；B3 evaluate.ts 又要求 localDeployedSha === frozen sourceCommit 且 policy.soakHours=12 的连续 heartbeat。一个早上 notice、下午 deadline 的 2–8 小时窗口，跨过任意一次 merge 部署就同时踩中『重启取消』和『not_currently_deployed → unknown』。Discord Gateway 的 op7 重连在数小时窗口内也是常态，而 RESUMED 会补投漏掉的事件，所以『resume 成功仍取消』属于过度保守。结果是 fail-closed 安全但功能近乎永不触发，A7 灰度里『另一个到期 green 无动作成功』这条验收可能永远拿不到。建议：A4 observe 阶段必须统计取消原因分布；并考虑窗口期内让 restart-services 延后重启（或把 window_open 做成可跨重启恢复 + 重连后按 RESUMED 补投判定），否则在 §13 明确写成已知产品限制。

处置：开放的非阻塞 advisory；已报 Lead，尚未采纳或修复。

## MEDIUM · manual-go-path-and-cycle-state-model-inconsistency

T17 的 cancelled→manual_ready 与『终态/write-once binding/release_id UNIQUE』冲突，且 T02/T05 取消的周期没有可 rebind 的 op

①数据模型：§4 规定 customer_release_cycles 的 binding_json『prepared 后 write-once』、release_id UNIQUE，而 T17 让同一 cycle 从 cancelled 走到 manual_ready 并绑定一个全新的 releaseId/VetoBinding，新绑定写到哪一行没有定义；同时 T19 说『任意终态重复动作返回原 receipt』，cancelled 到底是不是终态自相矛盾。②路径缺口：§7 的手动 go 只描述了 rebind-prepared-artifact（源为旧的完整 prepared op），但 T02（c=hold/unknown 在 evaluating 阶段就取消）和 T05（prepare 失败）根本没有 prepared op 可 rebind，而 PRD §5.2 恰恰要求 hold/unknown 时 founder 可以显式 go。失败路径：hold 周期里 Annie 想手动发，系统既没有候选卡也没有定义如何为她重新 prepare，只能退回人工 workflow，等于本设计对 PRD §5.2 的 hold 分支没有交付。

处置：开放的非阻塞 advisory；已报 Lead，尚未采纳或修复。

## MEDIUM · cycle-uniqueness-key-does-not-enforce-one-window-per-week

UNIQUE(project_id, slot_date) 不能表达『每周期只开一次窗口』

cycleId/唯一键都按 slot_date（配置时区当周发布日的 YYYY-MM-DD）。§3 只防住了『改 policyRevision 再生成同一周窗口』，但改 weekday 或改 timezone 会产生同一 ISO 周内的另一个 slot_date，DB 唯一约束不拦，于是同一周开出第二张默认发布卡——正是 PRD §5.2『每周 release cycle 只开一次否决窗口』要禁止的形状。虽然配置变更要 bump epoch 并取消未 claim 周期，但 epoch 取消的是旧周期，不阻止新 slot_date 立刻开一个新窗口。建议唯一键改成（project, iso_week）或在 policy 层显式断言『同一 ISO 周内已存在任何非 observe 周期即拒绝新建』，并把 weekday/timezone 变更的用例加进 §11.1。

处置：开放的非阻塞 advisory；已报 Lead，尚未采纳或修复。

## MEDIUM · claim-lateness-unbounded

deadline 与 claim 之间没有配置化的上界，卡片承诺的『今天下午发』可能在几天后兑现

§8.2 只说 claim 必须晚于 deadline、执行器就绪后才授权；§11.1 写了『ready attempt 排队一天 → 本周期过时则取消』，但『过时』在 §3 配置表、§4 表结构（只有 deadline_at，没有 claim_not_after）和 §5 转移表里都没有定义。payload-release 是全局 queue，beta 6h lane、prepare、cleanup 都会排在前面。失败路径：执行器排队到次日凌晨才 ready，那时 B3 恰好 green、无 veto、binding 未变 → T11 成立 → 在 Annie 完全没在看的时间点自动发布，而卡片上写的是『今天下午截止』。建议在配置里加 claim_deadline_local（或 deadline + N 小时）并写进 cycles 表与 T10/T11 条件。

处置：开放的非阻塞 advisory；已报 Lead，尚未采纳或修复。

## MEDIUM · gateway-interactions-endpoint-not-rechecked

application 的 interactions_endpoint_url 只在激活时证明为空，窗口期内被改写会让否决静默丢失

Discord 的规则是：app 一旦配置了 Interactions Endpoint URL，按钮交互就走 HTTP 而不再经 Gateway 投递。§2 把『无 HTTP interaction endpoint 的配置证明』划归一次性激活操作，§7 启动时也只校验 /users/@me 与 application identity。持有该 release bot token 的任意本机进程可以 PATCH /applications/@me 设置 endpoint URL；此后 Annie 点『别发』时 Bridge 的 Gateway 收不到 INTERACTION_CREATE，周期表现为『沉默』→ 自动发布。这与 §13『送达证明不是已读证明』属于同一类诚实性问题，但后果是否决被吞。修法很便宜：把 GET /applications/@me 的 interactions_endpoint_url === null 加进 §6 的 30 秒复验与 §8.2 claim 前探测清单，不一致即 T09。

处置：开放的非阻塞 advisory；已报 Lead，尚未采纳或修复。

## MEDIUM · scope-phasing-vs-simplicity

一次交付 6 张表 + 6 条端点 API + 新 Discord app + 新 workflow/environment + 端点 policy，建议分期并先用已有 hash 绑定的 commit 通道走通 A5

CLAUDE.md 要求『设计简单、执行彻底』。permit/控制信箱这一层买到的增量，相对于『Bridge 直接 dispatch 现有 payload-promote-commit.yml 并传 --expected-sha256』，主要是端点侧的审计记录与 claim 时刻的新鲜度重判——而铸 permit 的和 dispatch 的是同一个 Bridge，所以对『Bridge 被攻陷』这个威胁模型收益有限（见 decision-token-trust-boundary）。payload-promote.mjs:cmdCommit 已经把批准 hash 绑死在 CAS 内重查（含 deriveVetoBinding 再核），main-only + environment release + confirm=COMMIT 也已就位。建议把 I1–I3（cycle 账本 / 通知 / 否决）+ 复用现有 commit workflow 作为第一期，正好覆盖 §12 的 A5『真手动 E2E』；把窄 executor / permit / releaseDecisionRequired 作为第二期，在第一期实测出确实需要 claim 时刻重判后再做。这样也能更早拿到 A4 observe 的取消原因分布（见 liveness 条）。

处置：开放的非阻塞 advisory；已报 Lead，尚未采纳或修复。

## LOW · new-workflow-not-covered-by-structure-guards

新的特权 workflow 需要同步扩展 release-workflows-structure.test.sh 的 per-file 允许表

scripts/__tests__/release-workflows-structure.test.sh 的 S4b/S4e 是按文件枚举的允许表（COMMIT 只允许 FW_CUSTOMER_RELEASE_TOKEN、BETA/PROMOTE 只允许 FW_BETA_PUBLISH_TOKEN），新增的 payload-auto-release.yml 与 FW_AUTO_RELEASE_EXECUTOR_TOKEN 不在任何一条允许表里，也就没有结构性守卫（40-hex pin、main-only、queue、secret 允许表、无 id-token）。§11.2 把该脚本列进验证命令，但 I4 的交付物只写了 payload-auto-release.test.mjs。建议在 I4 明确要求扩展该 shell 结构测试，并加突变用例（把 executor 环境换成 release、加入 customer token、去掉 pin 都要红）。

处置：开放的非阻塞 advisory；已报 Lead，尚未采纳或修复。

## LOW · flag-must-be-declared-in-registry

auto_release_on_silence_enabled 需要在 packages/config/src/feature-flags/registry.ts 按 call_time 读时机声明

I1 只写了『flag 定义』。仓里的单一真相是 packages/config/src/feature-flags/registry.ts（FLY-709）：只有每个 in-Bridge 读点都是 call_time 的 flag 才是 direct 可切换，否则关停要重启；registry 还带 drift 扫描器与 readSites 契约。§3 要求这个 flag 可以在不重启的前提下 disable 新 claim（§8.3『disable 阻止新 claim』），所以读时机必须是 call_time 并在 registry 里声明 category/polarity/scope/readSites，否则 disable 只能靠重启，而重启本身会取消周期、掩盖 flag 行为是否真的生效。

处置：开放的非阻塞 advisory；已报 Lead，尚未采纳或修复。


## Round1 code review 非阻塞建议（待 Lead 处理）

结构化来源code-review-r1.json / question 1e80e742-ec6f-4f60-a9da-ec3aa1494585。有效verdict仍因HIGH CI枚举为CHANGES_REQUESTED，以下不是已解决清单：

- MEDIUM repeat-post-claim-intervention-events：已latch周期重复来源故障会持续追加事件。
- MEDIUM commit-unknown-downgraded-by-late-no-write：需核对迟到no_write是否足以解除unknown锁定与计划边界。
- MEDIUM readiness-verdict-route-can-latch-cancel-cycle：scoped readiness probe的持久verdict可能取消release cycle。
- LOW reservation-race-window-not-synchronized：两进程测试未保证实际锁等待；只能报告去重结果，不能报告确定竞争路径。
- LOW manual-go-self-attested-delivery：Gateway接入时应考虑先保存独立manual送达证明，再与go核对。
- LOW stale-cancel-reason-after-manual-go：manual阶段仍带auto取消原因，后续report需明确区分其历史含义。

## 2026-09-15 接手续裁定

Lead instruction 504407ab-4b10-4ae7-b674-e4f1193a8e78 转交 request 69634f2f / round 4 / head 2ef65d09e 的有效 APPROVED，六项上述 code-review MEDIUM/LOW 保持 advisory，未修复、不为其另开评审。该转交不覆盖后续新代码 HEAD；集成计划内三份 detached 提交后，最终仍需 fresh exact-head review。

## Post-conflict review follow-ups

Nonblocking findings from gate `68e7d268-1e50-4d1f-b202-42eaaf3a10af`, reported to Lead and outside the approved HIGH-only repair: `terminal-cycle-reinvalidation-unbounded` (MEDIUM), `bug-source-health-writer-gap` (MEDIUM), and `release-commit-cross-package-relative-import` (LOW).

A separate live database-recovery probe observed no host restart on the first tick after the old connection was closed (expected recovery-call count 3, observed 2). This remains a follow-up reported to Lead; the stable-wrapper repair proves database identity refresh after stopped-host recovery, not live recovery/drain success.
