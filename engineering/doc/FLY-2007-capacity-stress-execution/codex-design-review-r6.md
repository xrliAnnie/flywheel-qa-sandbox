# FLY-2007 Capacity Stress Execution — Design Review R6

VERDICT: CHANGES REQUESTED

## 审阅快照与边界

- 审阅对象绑定 commit `058540393f7c76738ed3fdc302a8f49a0864fa65`，branch `flywheel-FLY-2007`；开始和结束核对时工作树均干净。未修改任何仓库文件。
- 本轮只核 R5 的六项最小剩余集、其六个 numbered findings、用户点名的 PRNG/J 变更以及 `spec-baseline.md` 的未断言合同；不重开已裁掉的 B-strength 项。
- fresh verification：focused suite `65 passed, 0 failed`；analyser/simulator `node --check` 通过；wrapper `bash -n` 通过；默认 `M=20000` simulator 真跑成功并输出 `controls ok; b_lb@A pass; range_lb@N pass`。
- 绿灯不足以批准：本轮执行出了一个新的 A-direction blocking class（driver 只验证 L1，L2 在同一 frozen DGP 下明显不过），并复现了 R5 eligibility/freeze/sensitivity 类的剩余 bypass。依 Lead 指示，本报告把 blocker 列全后停止，不开启第七轮 polish。

## R5 minimum-set / findings closure table

| R5 最小项 / numbered finding | 状态 | R6 closure evidence |
|---|:---:|---|
| **1. A/U safety gate**；R5 Finding 1 eligibility/replacement/census | **PARTIAL — 未闭合** | R5 的原始反例确实关闭：一个 `health_unreachable` attempt 加三份高违约好 bundle，当前实现返回 U 并逐字命名 service failure（`analyze.mjs:418-425`，本轮执行复现）。required PREFLIGHT fields 和 default-refuse block classifier 也已接入（`:364-376,460-481`）。但 analysed bundles 没有绑定对应 ledger row 的 `attempt_id/window/disposition/artifact hashes`，completed window 只检查 `Set.size===3`，不检查集合恰为 `{1,2,3}`；`replacement_of` 完全不读。执行反例用 ledger windows `{1,2,4}`、三份 receipt 都写 window `99`、伪 sensitivity、伪 hashes，仍得到 `eligible=true,outcome=A`（`:401-454,484-505`）。 |
| **2. ledger crash/concurrency**；R5 Finding 3 | **PARTIAL — 未闭合** | mkdir-before-state 的 ID 已从目录名恢复；live owner 用 PID+start-time 防止并发 wrapper 误收敛；TERMINAL 写 hashes；坏 state 拒建 index（`run-window.sh:122-183,219-233`）。但全局 `.wrapper.lock` 没有 stale-owner recovery，只等 60 秒后永久拒绝；state/index rename 后没有 parent-directory durability fence；terminal hashes 从不由 analyser 与实际文件对账；R5 要求的并发、mkdir/START/PREFLIGHT crash、stale lock、index-loss tests 仍不存在（test 只覆盖一个 START orphan，`:142-148`）。 |
| **3. 本轮 sensitivity：#2，N 若保留则 #4**；R5 Finding 2 | **NOT CLOSED** | simulator 现在可执行，有 K=8、seed、MC LCB、naive/oracle/seed controls，A/N outcome 表面上分别看自己的 `pass`（`simulate.mjs:156-227`; `analyze.mjs:559-577`）。但 spec/plan 冻结要求的 parameter confidence set、parameter extraction、GOF gate、true-p grid 与 W1–W3 applicability-domain gate没有实现（`spec-baseline.md:228-250`; `plan.md:248-270`）。更严重的是 A driver 只跑默认 L1=150 ticks；同一 g08/seed/M/J 改成 L2=100 ticks 后 LCB 只有 `0.91776`。#4 实际每点只跑 `m/4=5000`，却顶层印 `M=20000`。analyser 又只信任任意 JSON 内的 `pass:true`，不校验 schema/K/M/seed/points/controls/freeze。 |
| **4. freeze/schema binding**；R5 Finding 4 | **NOT CLOSED** | wrapper 会拒绝“不存在的 commit”，receipt disagreement 会拒绝，analyser 缺参数会降 U（`run-window.sh:193-198`; `analyze.mjs:478-487`）。但这不是 actual-code binding：在当前 HEAD `058540393` 真跑 wrapper 并传旧 commit `a46a83cba`，它成功写了 `START/TERMINAL freeze_commit=a46a83cba`；只证明该字符串是某个 commit，没证明正在执行的 blobs 来自它。analyser 没有验证 commit 存在/等于运行代码，缺 freeze 时仍写 analysis、exit 0，而不是“refuses to run”；sensitivity artifact没有 freeze_commit。receipt 的 top-level attempt/window、shuttle/read_at 与 ledger terminal hashes也不校验。 |
| **5. non-vacuous behavioural tests + CI**；R5 Finding 5 | **PARTIAL — 未闭合** | CI wiring真实存在（`.github/workflows/ci.yml:864`），numeric-but-invalid fixture 有同数据 counter-fixture，mutation count由实际 `mutate` 调用派生；这是实质进展。剩余套件完全不执行 simulator；A gate 的 pass fixture正是手写 `{"configurations":{"b_lb_A":{"pass":true}}}`（test `:210-223`），因此把生产 bypass 当成阳性路径。service-failure test引入 duplicate attempt id且只断言“不为 A”；missing-freeze test在前一步已把 receipt 清空后运行，二者都不是单因果。ledger crash/durability、bundle↔ledger mapping、artifact hashes、actual freeze、L2 sensitivity均没有行为测试。 |
| **6. Lead trim 两个字面歧义**；R5 Finding 6 exposure shape | **CLOSED** | N 的原裁决与基于测量的修订都原文保留，本轮 authoritative set 明确为 `{A,N,U}`；exposure gap 唯一定义为“距 full B 的 all-clean 253 blocks/window”，不再承诺 A-direction/scenario 交付（`spec-baseline.md:34-72,222-226`）。calculator 仍正确给 performance=90、equivalence/full-B=253（`analyze.mjs:620-653`）。 |

## Independent PRNG verification

### sfc32-via-splitmix32

**核心 recurrence 正确。** `simulate.mjs:45-65` 的一步更新等价于 reference sfc32：

```
t = a + b + counter; counter++
a = b ^ (b >>> 9)
b = c + (c << 3)
c = rotl32(c, 21) + t
```

这与 [Apache Commons RNG 的 PractRand-derived SFC32](https://commons.apache.org/proper/commons-rng/commons-rng-core/jacoco/org.apache.commons.rng.core.source32/DotyHumphreySmallFastCounting32.java.html) 和 [Rust rand_sfc reference implementation](https://docs.rs/rand_sfc/latest/src/rand_sfc/sfc32.rs.html) 一致。`splitmix32` 的 Weyl increment、两次 `imul` 常数和 xor shifts 也按 32-bit wrapping 实现。独立 Python 整数实现对 seed `20260823` 的前 12 个 uint32 与仓库逐项相同：

```
2768454232,3115228163,2927360285,267518649,2061635486,1960963532,
1527588718,3910203178,2552141271,2805010765,2920496885,128902756
```

结论：R5 后替换掉截断 xorshift128+ 的方向与实现是 sound 的，不是本轮 blocker。

限定：PractRand-derived library seed paths通常把 counter 置 1 并先混合 15 轮；当前代码把 SplitMix32 的第四个输出直接作为 counter，且不 warm up。这是一个合理的 well-dispersed-state variant，但不是 reference seed procedure 的逐字实现。当前没有观测到由此造成的异常；建议在冻结说明里明确 variant，或采用 reference 15-round mixing，见 NON-BLOCKING advisory 1。

### seed-stability 6-SE tolerance

默认真跑得到四个 g08/L1、`m=2500` seed run：`[0.9636, 0.9624, 0.9660, 0.9592]`；spread `0.0068`，estimated SE `0.003785`，tolerance `6SE=0.022710`，通过。

这个容差作为**粗粒度仪器异常报警**可辩护：两个独立比例之差的 SE 是约 `sqrt(2)·SE`，所以 `6·single-SE` 相当于 `4.24` 个 pairwise SE；四次运行共六个 pair，正态近似 union bound 的误报上界约 `1.33e-4`。它足够宽，不会因普通 MC 抖动频繁误报，也会抓住已披露的约 4.03pp 坏 PRNG seed swing。

但它只检查一个 DGP、L1、较小 `m`，且无法发现“所有 seeds 同方向偏”的 generator/model defect；它只能 veto 仪器异常，不能代替 configuration coverage、endpoint coverage、GOF 或 applicability gate。当前代码虽注释称 stability “runs FIRST”，实际先计算 cfgA/cfgN/naive/oracle（`simulate.mjs:189-212`）；由于最终 `controlsOk` 能 veto，接受语义未被这个执行顺序破坏。

## Independent J derivation verification

### 原则判断：冻结前推导 J 本身是合法的

在没有 W1–W3 数据、只使用永久排除 pilot 的前提下，用预先声明的 DGP/power rule选样本量，符合上游 FLY-1986 §5.3“样本量必须由把握度推导”和 §5.5“第一个阶段 0 窗口前冻结”的要求。**这本身不是事后调参，也不存在用 W 数据反过来选择规则的经典 circularity。**

若用同一批 MC draws扫描多个 J、选第一个过线的 J、再把该同一结果当最终 coverage validation，则会产生 MC selection/multiplicity circularity；需要冻结独立 design/validation seeds，或把 J 候选也纳入 error allocation。当前仓库没有 machine-readable J-derivation artifact，无法审计表格来自哪个 seed/M 或是否独立验证，因此这条风险没有被排除。

### 当前 J=30 不能被批准

1. **NEW BLOCKER — 漏了 L2。** `runSensitivity()` 对 #2 的八个点调用 `coverageLower(...)` 时不传 ticks，全部使用默认 `TICKS.L1=150`（`simulate.mjs:106,189-192`）。A 可以由 L1 或 L2 任一分量触发，故必须覆盖两者。独立使用同一 g08、`A_ADV`、seed `20260823+7×101`、`M=20000`：

   | endpoint / J | empirical | exact per-point LCB |
   |---|---:|---:|
   | L1 / 30（official driver） | 0.96745 | 0.96387 — pass |
   | **L2 / 30** | **0.92305** | **0.91776 — fail** |
   | L2 / 34 | 0.93830 | 0.93351 — fail |
   | L2 / 45 | 0.96125 | 0.95737 — pass |

   所以 J=30 不能承载“全部 A-direction components”的 claim。

2. **DGP 数据与 estimand 不同分布。** spec 定义 `b` 为 stationary per-tick probability（`spec-baseline.md:74-82`），`trueB()`也用 stationary distribution；但每个 simulated window 都以 `P(bad)=0.5` 开始（`simulate.mjs:83-100`）。对 g08，stationary `P(bad)=(1-.9999)/[(1-.9999)+(1-.9990)]=0.09091`，不是 0.5。独立把初态改为 stationary、其余代码/seed/M不变后，g08/L1 在 **J=13** 已是 empirical `0.97825`、LCB `0.97527`。当前“J 必须从 13 增到 30”主要量到的是一个未预注册、与 `trueB` 不同分布的 initial transient。若 0.5 是刻意的 adversarial initial-state sensitivity，必须把它命名为额外假设并为对应 finite-window estimand定义真值；不能一边用非平稳启动采样，一边以 stationary `trueB` 判 coverage。

3. **冻结表不可由当前 executable path复现。** 默认 driver 的 g08/J30 是 `0.96745 / 0.96387`，不是 spec 的 `0.9651 / 0.9591`。同一 official seed/M 下 J26 是 `0.95820 / 0.95418`，已经 pass，却与 spec 的 `0.9530 / 0.9431`“仍不过”相反。`minUnitsForA()` 默认 `m=2000`，当前搜索下界直接等于已经选定的 `UNITS=30`，且在 noisy、实测非单调的 MC 序列上做 bisection（`:252-266`），不能证明 30 是最小通过值。本轮同 seed exhaustive 13..26 的第一处 pass是 J24；这不要求改成 24，只证明“J=30 由 frozen executable 推得”的 provenance 不成立。

4. **spec 自己仍矛盾。** `spec-baseline.md:100` 写 J=30，`:102` 紧接着又写“J 固定 13”；`plan.md:203`、analyser output assumption `analyze.mjs:600`、simulator `:10,243`仍把运行设计说成 13。freeze point不能同时冻结两个 J。

## BLOCKING findings

### 1. HIGH — NEW blocking class: A-direction sensitivity/J 只验证 L1；L2 在 frozen g08 下 J=30 明确失败

证据与数值见上一节。A 判据是六分量 union，L2 分量不是可省略的 advisory。当前 simulator 的 A gate通过不能支持 analyser 对 L2 lower bound 发权威 A；J=30 的 whole-contract claim因此失败。

**Freeze 前最小修复：** 在 frozen DGP 的时间单位语义下明确分别跑 L1/L2（或严格证明一个支配另一个），修正 stationary initial-state/true estimand mismatch，冻结可复现的 design-seed 与 independent validation-seed（或多 J error allocation），再由两端点的 binding result决定 J。不要用当前文档表继续开 W1。

### 2. HIGH — R5 sensitivity/freeze gate仍是可伪造 boolean，且 spec 的 parameter/GOF/domain合同未实现

`analyze.mjs:564-575` 只读 `configurations.*.pass === true`。本轮执行 production `analyse()`：传 schema=`anything`、只含两个 `pass:true` 的 JSON、ledger 内伪 freeze/hashes，仍得到 `eligible=true,outcome=A`。analyser不校验 sensitivity schema、K、M、seed、per-point rows/LCBs、controls、configuration alpha、freeze_commit，也不重算 pass。

同时 `alpha_param=0.025` 没有任何消费者；没有依赖参数置信集、pilot parameter extraction、GOF/parameter-set gate或 W1–W3 applicability-domain gate。N configuration还在 `runSensitivity({m:20000})` 内实际使用每点 `m=5000`（`simulate.mjs:193-195`），而顶层输出仍印 `M:20000`。

**Freeze 前最小修复：** 产出并冻结完整 machine-readable sensitivity schema，含 exact freeze commit/config hash、两端点、每点真实 m/covered/lcb、controls、GOF/parameter-set/applicability gates；analyser从原子字段重算/校验 acceptance，任何缺失、mismatch、out-of-domain均 U。若 parameter/GOF/domain被 Lead进一步裁掉，必须先有明确裁决并同步 spec；当前不能静默忽略。

### 3. HIGH — R5 census/schema仍未把三份被分析 bundle绑定到 ledger 的合法 completed windows

执行反例：磁盘有 attempt-001..003；ledger IDs连续且 terminal/completed，但 windows=`1,2,4`、terminal freeze/hash伪造；三份 receipt 的 attempt_id/window都写 `99`；数据全高违约、伪 sensitivity `pass:true`。实际结果：

```json
{"eligible":true,"outcome":"A","ledger_windows":[1,2,4],"receipt_windows":[99,99,99]}
```

原因是 `censusProblems()`只要求 completed window `Set.size===3`，不检查集合、唯一 completed attempt/window、bundle目录对应的 ledger row状态/窗口，也不比较 receipt identity或 terminal artifact hashes；重复传同一 bundle也没有拒绝。replaceable reason只计数，完全不要求/验证 `replacement_of` graph（`analyze.mjs:401-454`）。这仍允许调用者挑选/重排证据，是 R5 survivor-selection class的同类 bypass。

**Freeze 前最小修复：** 对每个 analysed bundle强制唯一对应 terminal completed row；directory name、attempt_id、window、freeze、artifact hashes全部一致；completed authoritative windows恰为 `{1,2,3}`且各一份；bundle paths唯一；replacement必须显式 `replacement_of` 一个具名 replaceable terminal、无链/环、总数≤2；任何其它 attempt失败按 total mapping U。

### 4. HIGH — actual freeze、ledger crash durability与开窗 preflight仍未达到 R5 最小合同

- **actual freeze bypass 已执行：** 当前运行代码 HEAD=`058540393`，传旧的现存 commit `a46a83cba`，wrapper接受并在 state写 `freeze_commit=a46a83cba`。因此“commit exists”不等于“running blobs are that commit”。analyser缺 `--freeze-commit` 时只是 outcome U、写文件并 exit 0；也不验证传入 SHA是 commit或等于自身 blobs。sensitivity没有 freeze字段。
- `.wrapper.lock` 只重试 60 秒，没有 owner identity/stale recovery；wrapper在 `mkdir .wrapper.lock` 后 crash会永久挡住后续 recovery（`run-window.sh:100-109`）。
- `sync` 在 rename前，rename后的 attempt dir与 ledger index parent directory均没有 durability fence（`:112-120,165-184`）。TERMINAL hashes虽写入，但 analyser从不核对。
- wrapper允许 `--blocks/--block-seconds/--endpoints`偏离 frozen 30/300/L1,L2；analyser不强制 block_seconds=300。wrapper读取 `shuttle_hours`，但 unknown不拒、也不计算 2.5h 窗是否跨班车；analyser的 required fields又漏掉 shuttle。J=34正是因跨班车被否决，因此这不是无关字段。

**Freeze 前最小修复：** 验证执行 checkout/相关 blobs与 exact freeze commit一致且冻结文件无漂移；sensitivity/receipt/state/analysis全链同一 commit；恢复 stale global lock；完成 rename后的目录 durability；消费 terminal hashes；冻结并强制 window/blocks/seconds/endpoints/schedule schema，跨 shuttle或 schedule unknown开跑前拒绝。

### 5. MEDIUM — R5 要求的 non-vacuous CI还没有覆盖上述 load-bearing gates

65/65是真绿，但套件没有运行 simulator，也没有验证 simulator output schema、L2、J derivation、GOF、M、seed control或 analyser对 sensitivity的消费。它把伪 `pass:true` stub当 A 阳性路径。service failure test带 duplicate attempt ID且只断言不为 A；missing-freeze test继承了上一条已清空的 receipt，均不能证明单一 guard。crash suite只测一个 START orphan，没有 active concurrency、mkdir-before-state、PREFLIGHT crash、stale lock、index loss/durability/hash mutation。

R5 最小集明确要求这些行为测试接 CI；当前生产反例全部能在 65/65 下保持绿色，所以此项没有 closure。

## NON-BLOCKING advisories

1. sfc32 recurrence是正确的；为减少实现歧义，可采用 PractRand-derived `counter=1 + 15 warm-up steps` seed procedure，或明确记录当前“4 个 SplitMix32 state、0 warm-up”的 variant并加入 frozen test vector。这不是本轮拒绝理由。
2. positive control 的 pass当前用 `LCB < 0.95`，这只说明“未证明覆盖≥95%”，不是“证明 under-cover”；严格方向应是 coverage 的 exact **upper** bound `<0.95`。本轮实际 empirical=0.57545，远低于 0.95，改正确方向不会改变结论，故列 advisory。
3. `seed_stability` 注释说先运行，代码实际后计算；最终 acceptance仍被它 veto，属叙述/资源浪费问题。若要真 fail-fast，应先算并异常即停止。
4. simulator被 stdin/dynamic-import 时，direct-invocation guard会对 `process.argv[1]='-'` 调 `realpathSync` 并抛 ENOENT；CLI直接执行正常，不影响 window contract。
5. ShellCheck fresh result：wrapper只有 `SC2012` info；test有 `SC2034` warning（变量实际在 eval string中使用）。均不影响本 verdict。

## Freeze judgment

**不具备 freeze 并开始 Window 1 的条件。**

R5 的原始 service-failure counterexample、required receipt fields、health receipt quoting、directory-derived attempt id、live owner lease、terminal hashes、CI wiring和 exposure-gap裁决都有真实进展；sfc32 replacement也通过了独立 recurrence/sequence核验。

但权威 A 目前由只跑 L1的 simulator放行，而同一 frozen g08 下 L2/J30的 exact LCB只有 0.91776；DGP又用非平稳 0.5 初态去评价 stationary `trueB`。此外 analyser仍可用伪 sensitivity、错 window/receipt/hash的 ledger产出权威 A，正在执行的代码也没有与 freeze SHA绑定。它们都位于 Lead保留的 A/N/U安全路径，不是 B-strength polish。

依 Lead 的收敛指示：这是一个新的 blocking class加上尚未关闭的 R5最小项，故停在本清单，不建议以 R7形式继续润色。修复并以 immutable exact head重新确认前，**不得启动 W1**。
