# FLY-2125 停驻申报按机器状态收敛 — 探索
Issue: FLY-2125 (https://linear.app/geoforge3d/issue/FLY-2125/病根-停驻体的-runner-stopped-申报无服务端合并节流同内容申报逐轮铸出lead-节律指令双重回执后仍-160-秒连发-7)
日期: 2026-09-03
基于: 无

## 1. 问题复核

FLY-2125 记录的是停驻 Codex execution 在 resident turn 结束时反复产生
`RUNNER-STOPPED`，每条同时占用 mailbox row、Lead event 与 Lead batch，最终让真实指令
排在大量无需处置的状态申报之后。Lead 在 2026-09-04 UTC 补充了三个仍在发生的样本：

- FLY-2147 execution `8baa35c5…` 在约八分钟内连续申报等待 QA；
- FLY-2296 execution `0f39390f…` 与 FLY-2259 execution `c557863a…` 同形；
- 三个 runner 接到人工节律指令后才放慢，但新的 runner 仍会复发。

我直接查询了当前 Flywheel CommDB，而不是把描述当成既成事实。复核得到两个同时成立的结论：

1. 服务器并非完全没有去重。FLY-2017 已在 `CommDB.recordRunnerStopDeclaration()`
   建立每 execution 一行的 `runner_stop_declarations` 当前沿账；相邻的完整 canonical
   content 逐字节相同时会返回 `duplicate`。
2. 现网风暴仍为真，但输入并非逐字节稳定。三个样本分别有 27/26、50/46、270/255
   （report 数/不同 content 数）；三个序列都没有相邻逐字节重复。FLY-2147 在
   `23:40Z–23:58Z` 的十条申报中，诸如“状态未变”“状态不变”“继续保持只读等待”
   只是在改写同一个等待事实，却产生了不同 hash。完全相同的正文也会在另一种改写之后
   重现，按 FLY-2017 的 A→B→A 边沿合同再次铸出。

所以本单病根比 issue 标题更窄也更具体：**现有 server edge key 把自由文本
`last-assistant-message` 当作机器生命周期状态的一部分，导致语义未变但 hash 持续变化。**
仅把 `collapse_key` 填成完整 content hash 不会改善，因为它仍得到同一批不同 hash。

## 2. 必须同时守住的边界

- 收敛发生在既有 `runner-stopped → CommDB/mailbox` 写入事务内，不新增告警层、timer
  或独立抑制服务。
- runner 仍每轮如实申报；是否铸出由服务器决定，不能再靠 prompt/Lead 指令维持节律。
- 同一机器状态内，final answer 的措辞、标点、链接或进度复述变化不是 lifecycle edge。
- completion、session terminal、pending gate/question、declared park、quota/context/error 等
  机器可判状态一变化，第一条必须立即入队；窗口不能挡住它。
- `RUNNER-STOPPED` 仍是单向 report；Lead 的 batch/event ACK、普通 ask/gate、completion
  breadcrumb 消费规则不变。
- 并发 detached reporter、乱序 derivation、进程重启与旧库升级必须保持原子、可重放。

## 3. 假设

1. `last-assistant-message` 是诊断说明，不是服务器可据以判断 lifecycle edge 的权威状态。
   如果它包含真正状态变化，该变化也必须已在更高优先级的 completion/session/pending/
   declared/error 分支中有机器证据；否则服务器无法在不引入 NLP 猜测的前提下区分
   “新事实”和“换句话说”。
2. 无状态变化仍可按 30 分钟输出一次心跳，满足运维可观测性；这不是 runner 自行节流，
   而是 CommDB 持久水位决定。
3. FLY-2017 的 A→B→A 合同应按**机器状态 key**解释：真实状态 A→B→A 三条都放行；
   同一机器状态下自由文本 A→B→A 不再伪造三条状态沿。

上述第 1 点已通过非阻塞问题 `bead7ba7-b2ec-4638-912c-894ab25cb57a` 向 Lead 明示；
等待答复期间可继续完成独立设计与验证。

## 4. 方案比较

### A. 机器状态 key + CommDB 持久窗口（推荐）

`runnerStopped()` 在推导 reason/detail 时同时得到一个只来自权威分支的 semantic key：

- completion：route + completion event identity；
- session terminal：status；
- pending：question/gate id；
- declared：kind + declared reason；
- classified failure：reason +规范化错误 detail；
- fallback：`idle_without_declared_completion`，不纳入自由文本 final answer。

CommDB 原子原语保存当前 semantic hash、最近实际铸出时间与最后 content。key 变化立即入队；
key 未变且不足 30 分钟返回 duplicate；满 30 分钟允许一条新心跳并推进水位。正文仍保留
本次诊断 detail，Lead 在允许的心跳上可看到最新说明。

优点是决策完全在服务端、跨进程持久，并且不猜自然语言。代价是需要扩充现有小表与原语。

### B. 对自由文本做词法/语义归一化

去停用词、删时间、Jaccard 或模型判相似。它无法给“真实 detail 变化立即放行”提供可靠
fail-open 边界，语言、链接与数字也会制造误判；还新增算法与依赖。拒绝。

### C. 仅使用 mailbox `collapse_key=hash(full content)`

这只把 FLY-2017 已有的 exact hash 换个存放位置，无法收敛现网 26/46/255 个不同正文；
若做永久 key 去重还会吞掉真实 A→B→A。拒绝。

### D. 继续强化 runner 节律规则

已有两轮 DONE 回执及 2026-09-04 三体复现证明 prompt 纪律不是可靠性边界。拒绝。

## 5. 推荐范围

只修改 `packages/flywheel-comm`：

1. 为 reason 推导附带最小、可测试的机器状态 key；
2. 扩充现有 `runner_stop_declarations` current row，使同 key 按 30 分钟窗口收敛；
3. 保持现有事务、question id、mailbox report 与 ACK 路径；
4. 用虚拟 `derivedAtMs`/clock 覆盖 N 次同状态、窗口边界、内容/机器状态变化、并发与重放；
5. 不改 TeamLead renderer、hook cadence、Lead rules 或普通 mailbox collapse 行为。

这也是 Ponytail 决策梯的最低可行层：复用现有表、事务和 SHA-256，不新增依赖、不抽象成
通用告警抑制器。
