# FLY-2922 529 外层证据边界 — 探索
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-28
基于: 无

## Problem

本轮不重新设计 FLY-2922 的产品行为。统一恢复口、真实派发账本、completion 顺序和 carrier-close 边界已经在既有设计与实现评审中通过；当前唯一缺口是 QA harness 的递归证据等待。

外层 `scripts/qa-529-generalized-e2e.mjs --real` 驱动负责完成一整轮 529 真房并在结束后形成宿主侧证据。房内 QA 又按通用 QA 角色要求自行等待“宿主侧 529 最终回执”。于是出现闭环：外层驱动等房内 QA 给 verdict，房内 QA 等外层驱动结束后才存在的回执，双方都不能前进。2026-09-28 的 slot 6 + extra Lead 演练因此在 step 3 后停住；这不是 FLY-2922 产品恢复链失败，而是测试的证据所有权没有明确到单一主体。

成功定义：只有显式开启测试控制时，房内 QA 得到一条绑定当前 run / QA execution 的 Lead 指令，知道“外层 driver 是本轮唯一 529 证据生产者”；房内 QA 仍做节点内独立验证并提交真实 `qa-result`，外层 driver 仍必须跑完全部步骤并在房外记录最终证据。不开控制时保持现状，递归等待仍可被测试观察到。生产 QA 规则、产品状态机和证据判定都不放松。

## Constraints

- 只改 529 generalized harness；不改 `StateStore`、workflow dispatcher、QA 通用角色文件、strength-two judge 或生产 evidence API。
- 该控制必须显式 opt-in，只允许 generalized + real-runner 房；stub lane、普通生产 run、非 QA 节点和 tuple 不匹配全部 fail closed。
- 边界指令本身不是 PASS、不是 evidence receipt，也不能替代 driver 的 step 1–9 或最终 `evidence-run record`。
- 使用现有 Lead → Runner mailbox 通道和 slot-local 身份；不得伪造 founder、生产 Lead 或跨房身份。
- 所有测试按本仓 local-test-policy 逐个 concrete file 运行；不跑全仓/全包测试，不用 `vitest related` 扫整张 teamlead 图。

## Options

### A. 由外层 driver 发送 tuple-bound Lead 指令（推荐）

driver 在观察到当前 QA execution 后，用房间现有 Lead 身份经 `flywheel-comm send` 写入一条 durable instruction。正文固定说明外层 driver 是唯一 529 证据边界，并携带 `{issue, runId, qaExecutionId, slot, evidenceDir}`。driver 等到消息进入该 execution 的 mailbox 后再继续 QA readiness 观察。

优点：房内 QA 仍是真 Runner；复用已经存在的授权、recipient resolution、wake 和 inbox 机制；没有生产规则分支。缺点：需要把消息的幂等、归属和 delivery 失败写成 harness 前置条件。

### B. 允许 QA-only stub、其他节点保持真 Runner

在 real room 中按 nodeId 只把 QA 进程替换成 deterministic stub。

优点：容易避免递归等待，执行确定。缺点：这轮证据不再验证真实 QA Runner 如何接收边界、执行局部验证和给 verdict；还要扩大 `test-deploy` 的 mixed-runner 合同。作为故障诊断 fallback 可以保留讨论，但不作为本轮主方案。

### C. 在生产 QA prompt / evidence judge 中增加“外层证据”开关

优点：看似直接。缺点：把测试拓扑概念带入生产协议，并可能让普通 QA 绕过自持证据规则；违反“只改 harness、生产 QA 规则不变”。拒绝。

## Chosen Direction

选择 A。外层 driver 已经使用 slot Lead 身份开 question gate、读 slot CommDB 并绑定 run execution；它是最窄且已有权限的责任主体。新控制命名为 `--outer-evidence-boundary`，不设默认值。

边界消息只改变“谁产出这一轮 529 最终证据”，不改变“房内 QA 是否要验证候选 head”。房内 QA 的职责是：核对 exact head、执行本单相关检查、提交 `qa-result`；外层 driver 的职责是：驱动所有 workflow step、保留逐步证据、最后由宿主侧形成 strength-two receipt。任何一半失败都不能出 PASS 证据。

## Negative Guards

1. `--outer-evidence-boundary` 与非 `--real` 同用：参数解析立即拒绝。
2. room-info 不是 generalized real topology：启动前拒绝。
3. QA execution 尚未出现、已换代或不属于当前 run：不发送；重新解析当前 tuple。
4. mailbox recipient 解析不到 exact execution、Lead 身份不匹配或消息写入失败：driver fail closed，不继续等待假成功。
5. driver 重启：先查 owner/evidence state 和 mailbox 中同 tuple 的既有指令；存在则复用，不产生相互矛盾的第二条边界。
6. 外层流程未跑完：不得记录最终 evidence；边界消息永远不参与 PASS 判定。

## Honest Boundary

本设计解决“真房套真房”的递归证据死锁，使 FLY-2922 的统一恢复行为可以在一个外层 529 campaign 内被完整观察。它不证明产品修复本身正确，不替代 exact-head CI，也不允许普通 QA 跳过 Discord/529 验证。产品正确性仍由现有测试、外层 driver 全步骤、派发账本和下一轮独立 QA 共同证明。
