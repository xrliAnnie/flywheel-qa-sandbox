# FLY-2007 Capacity Stress Execution — Design Review R7 (freeze gate)

VERDICT: CHANGES REQUESTED

## 审阅快照与边界

- 审阅对象精确绑定 branch `flywheel-FLY-2007`、commit `8cb44dd0136b5ebe31b6e7b045719d3ba4d263f7`；开始与报告落盘前工作树均干净。
- 严格只读审阅；未修改、暂存、提交或推送任何仓库文件。唯一写入是本报告及 `/tmp` 下的隔离计算/反例产物。
- 本轮不重开已经明确延期的 B-strength #1/#3，也不要求取得 253 units/window。审查边界是 Lead 保留的 A/N/U、freeze binding、evidence selection、crash/ledger 与开窗前置条件。
- fresh verification：focused suite `74 passed, 0 failed`；analyser/simulator `node --check` 与 wrapper `bash -n` 通过；默认 `M=20000` 的真实 simulator 运行成功并输出 `controls ok; b_lb@A pass; range_lb@N pass`。ShellCheck 只有 wrapper `SC2012` info 与 test `SC2034` warning。
- 这些绿灯不能支持冻结：现有 suite 自己的 A 阳性路径使用不存在的 freeze 字符串 `FZ`、无 terminal hashes 的 ledger、以及手写 `pass:true` sensitivity，仍得到权威 A（test `:205-221`）。下文另有两个当前 HEAD 的执行反例。

## R6 blocking findings closure table

| R6 blocking finding | 状态 | R7 against-code closure evidence |
|---|:---:|---|
| **R6 #1 — A sensitivity 漏 L2；DGP 初态与 stationary estimand 不同；J provenance 不成立** | **PARTIAL** | 两个执行缺陷已关闭：初态按 stationary distribution 抽样（`simulate.mjs:83-107`）；8 DGP × L1/L2、`K=16`、每点 `alpha_MC/K`（`:181-209`）。当前代码的 J13/J30 全 16 点都过，见独立复算。可是 freeze contract 仍写已撤回的旧理由：spec `:49-66`、plan `:105-107`、analyser `:193-199` 都说 J13 不过/J30 薄过；simulator `:199-204` 甚至仍说 L2/J30 失败，`:260-268` 仍说 J=13 固定且不足。新的 `0.116→0.158` 理由没有写入 frozen source。故 mechanics CLOSED，freeze/provenance NOT CLOSED，合并为 PARTIAL。 |
| **R6 #2 — sensitivity/freeze gate 是可伪造 boolean；parameter/GOF/domain 合同未实现** | **NOT CLOSED** | analyser 仍只读 `configurations.*.pass === true`（`analyze.mjs:638-649`），不校验 schema、K/M、16 个 point rows、covered/lcb、controls、seed、alpha、freeze/config hash，也不重算 acceptance。suite 的 stub `pass:true` 仍是权威 A 阳性路径（test `:210-221`）；“另跑一次真 simulator”不使生产消费者拒绝 stub。simulator artifact 没有 freeze commit；spec `:232-250` 的 parameter confidence set、parameter extraction、GOF 与 W1–W3 applicability gate仍无实现。默认 artifact 顶层印 `M=20000`，但 `range_lb_N` 每点实际 `m=5000`（`simulate.mjs:208-209,231-244`；fresh output verified）。 |
| **R6 #3 — bundle/ledger/window/hash/replacement evidence selection** | **PARTIAL** | 正向绑定、窗口集合 `{1,2,3}`、receipt-window agreement、重复传入 bundle、部分 replacement target checks 已加入（`analyze.mjs:449-499`）。但 completed evidence 仍不是双向：一个额外 completed W1 可被调用者丢掉，选择另一个 W1 + W2 + W3，`censusProblems()` fresh 返回 `[]`。`artifacts` 只在存在时检查（`:474-480`），缺整个 map 或缺文件仍通过；receipt `attempt_id` 从不与 ledger/dir 比；analyser 不读目录内 canonical `state.json`，空目录配伪 ledger 也通过；credential failure 后的成功重跑可省略 `replacement_of`，fresh `censusProblems=[]`；replacement edge也不校验同一 window/一对一。另 main 仍要求至少一份 bundle（`:855`），所以 spec §4.0 的 no-bundle preflight failure 不能稳定产出 U artifact。 |
| **R6 #4 — actual freeze、ledger crash durability、frozen collection/schedule preflight** | **PARTIAL** | frozen参数 override、unknown schedule、straddle拒绝均已关闭（wrapper `:211-221,369-386`）；state rename 后有第二道 `sync`（`:127-138`）；dead PID+start-time stale lock可打破（`:101-123`）。但 actual freeze 仍可绕：wrapper只验证“commit exists”（`:218-221`），从未比较四个 blob；analyser仅在调用者可选地传 `--repo-root` 时才调用 `freezeDriftProblems`（`analyze.mjs:539-557`），CLI不要求该参数。现有 test 用不存在的 `FZ` 且不传 repo root仍得到 A。sensitivity无 freeze字段。receipt required set仍漏 spec §9.1 的 `shuttle_hours/read_at` 和 top-level attempt identity（`:503-527`）。此外 `mkdir .wrapper.lock` 与写 owner file之间崩溃会留下无 owner 的永久 lock；`rebuild_index` rename 后没有 durability fence（wrapper `:183-202`）。后两项 fail-closed，但 R5 crash合同与其测试仍只 PARTIAL。 |
| **R6 #5 — non-vacuous CI covers load-bearing gates** | **PARTIAL** | CI 与 exact step inventory已接入；74/74 fresh green；真实 simulator、L2/K16、positive-control UCB 与 corrected service fixture均加入（test `:227-268`）。但真实 simulator只跑 `--m 400`，生产 positive A仍用 stub；freeze test只直接调用 helper，不验证 CLI/wrapper强制；缺 extra completed survivor、state↔index、required hashes、attempt-id、mandatory replacement graph、ledger-only U、ownerless lock、START/PREFLIGHT/concurrency/index-loss crash tests。上述反例全部可在 74/74 下保持绿色。 |

## R5 minimum-set closure table

| R5 可冻结最小项 | 状态 | R7 closure judgment |
|---|:---:|---|
| **1. 闭合 A/U safety gate：terminal totality、required receipt、service/host、replacement/cap、canonical 双向 census** | **PARTIAL** | service/host survivor原反例与大部分 preflight字段已关闭；但 extra completed survivor、canonical state不读、hash/attempt identity可缺、replacement命名可省、no-bundle U不可生成仍在。`checkIntegrity()` 也仍不反向枚举 `byKey` 的额外 sample key（`analyze.mjs:318-352`）。当前仍能以不完整 provenance 发 A。 |
| **2. 闭合 ledger crash/concurrency：ownership、atomic/durable transitions、early crash、stale lock、terminal hashes、tests** | **PARTIAL** | directory-derived ID、live PID+start identity、locked terminal transition、state post-rename sync、terminal hash写入是真进展（wrapper `:101-180,242-256`）。但 ownerless global-lock crash point、index post-rename durability、canonical state/index消费、extra concurrent completed survivor及所列 crash/concurrency tests未闭合。 |
| **3. 本轮 sensitivity：#2，N 保留则 #4；完整 acceptance接 analyser** | **PARTIAL** | executable simulator与 #2/#4 两端点 driver已存在，默认真跑都绿；但 consumer仍是 `pass:true`，#4实际每点 5000，freeze/schema/GOF/parameter/applicability均缺。核心 acceptance仍可伪造。 |
| **4. 强制 freeze/schema binding** | **PARTIAL** | `freezeDriftProblems` helper本身能正确区分 `8cb44dd01` 与旧 commit，receipts也会比较传入字符串；但 wrapper不调用 blob compare、analyser调用可省、sensitivity未绑定、terminal hashes非 required。当前不是强制合同。 |
| **5. 非真空行为测试接 CI，mutation/document authority与代码一一对应** | **PARTIAL** | CI wiring与74项真实；但负载关键 bypass无测试，且 plan `:299` 仍说 15 条 mutation、当前实际为14，测试只要求文中某处出现“合计14条”（test `:276-282`），所以文档冲突继续全绿。 |
| **6. Lead trim歧义：authoritative N；exposure gap唯一口径** | **CLOSED** | spec明确保存 N原裁决及修正，最终 `{A,N,U}`（spec `:34-47`）；exposure gap唯一为 full-B all-clean 253（`:68-72`），calculator仍给 90/253/max=253（`analyze.mjs:706-726`）。不重开已延期 B sensitivity。 |

## Independent J=30 verification

### 1. `b_lb` 比较是否正确

正确，但要精确描述它量的是什么。

A family 的每-CP 水平是

```
a = A_ADV = 0.025 / (6 × 5) = 0.0008333333333333334.
```

冻结 grid 的最大 threshold 是 `c=0.2`。当全部 J 个 unit 都有 `p_j>0.2` 时，`K=J` 的单侧 CP lower 是 `a^(1/J)`，所以该 procedure 可达到的最大 `b_lb` 是

```
max b_lb(J) = 0.2 × a^(1/J).
```

fresh exact-code复算：

| J | `max b_lb` |
|---:|---:|
| 13 | `0.1159230768714` |
| 30 | `0.1579030870953` |

因此 `0.116` vs `0.158` 数字正确。它也不是只比较一个无意义的极端：在 `c=0.2`，超过 SLO 所需的最少 high units 从 J13 的 `10/13 = 76.9%` 降到 J30 的 `16/30 = 53.3%`；在 `c=0.1`，从 `13/13` 降到 `24/30 = 80%`。所以 J30 确实使 A 更容易被这个冻结下界证明。

限定：这不是 coverage 论证，也没有证明 J30 是“最小”或“最优”样本量；它是更大曝光带来更强 A 判别力的解析比较。既然 Lead 已明确把 **J=30** 作为该 trade-off 下的政策选择批准，J30 本身可辩护，不需要伪装成唯一数学解。

### 2. corrected simulator 数字

用当前 exact code、stationary initialisation、official seeds、`M=20000`、`K=16`、per-point alpha `0.025/16`，独立跑全 16 个 `(DGP, endpoint)`：

| J | worst point | covered/M | empirical | exact per-point LCB | all 16 pass? |
|---:|---|---:|---:|---:|:---:|
| 13 | g08/L2 | 19284/20000 | 0.9642 | **0.9601475804** | yes |
| 30 | g08/L2 | 19524/20000 | 0.9762 | **0.9728402935** | yes |

所以 coverage 论证确实已经死亡：J13也过。提示里的 J13 worst `0.9606` 与当前 K16 executable不逐字相同；当前可复现值是 `0.96015`，但不影响 pass/fail。

### 3. J judgment

**J=30 可辩护；当前 freeze artifact 不可辩护。** 三个 2.5h 窗按 15:30/18:30/21:15 PT 排列分别在 18:00/21:00/23:45 结束，在 Lead 保证 23:45 前无 fleet restart 的前提下，排期本身不构成 blocker。

但 frozen spec/code仍把已经被模拟器修正推翻的 coverage故事当成 J30 的授权依据，并且没有记录新的 tighter-lower-bound裁决。预注册的意义正是把实际理由在看 W 数据前冻结；不能冻结一个明知为假的旧理由，再靠聊天上下文替它改义。

## BLOCKING findings

### 1. HIGH — A/N sensitivity gate仍可由任意 `pass:true` artifact伪造

这是 current production path 的执行事实，不是 schema polish：suite line 210 写一个只有 schema字符串、两个 `pass:true` 与 summary的文件，line 220-221证明同一数据得到 authoritative A。`analyse()`完全不验证 simulator原子证据。

**Minimum fix:** 定义并强制 machine-readable sensitivity schema；绑定 exact freeze commit/config hash；对两项各要求 exact 16 points、frozen seed/alpha/K、每点真实 `m`/covered/lcb、controls；analyser从原子字段重算 acceptance。#4 要么按 spec 每点 M=20000，要么先有明确 Lead裁剪并同步合同。spec已经承诺的 parameter-set/GOF/applicability-domain要实现；若 Lead要裁，必须有显式新裁决，不能静默跳过。任何缺失/mismatch/out-of-domain ⇒ U。

### 2. HIGH — completed evidence仍可 survivor-select，canonical ledger/state/hash/replacement合同没有双向闭合

fresh counterexample A：ledger有两个 terminal completed W1和各一个W2/W3；调用者只传第二个W1+W2+W3；`censusProblems()`返回 `[]`。额外 completed window完全被忽略。

fresh counterexample B：attempt-001=`operator_credential` aborted；attempt-002成功W1但不写 `replacement_of`；W2/W3完成；三个 receipt都写 `attempt_id=99`，terminal rows不带 artifacts，四个 attempt目录里没有 canonical `state.json`；`censusProblems()`和`receiptProblems()`都返回 `[]`。

这仍允许调用者选择 evidence，并能在索引/回执/状态/产物不相互证明时发 A/N。

**Minimum fix:** canonical `attempt-*/state.json`为 truth，ledger必须逐字/结构等价于其rebuild；所有 terminal completed rows与 analysed bundles做**双向等集**，只允许恰好一个 W1/W2/W3，任何额外 completed row拒绝；dir suffix、ledger attempt_id/window、receipt attempt_id/window全相等；completed row必须含且只含四件 artifact hash并逐个对实际文件；同窗重跑必须有 `replacement_of`，target为具名同窗 replaceable failure，一对一、无链/环、edge总数≤2。支持零/部分 bundle的 ledger-driven U，使 preflight-only failure能产出合同规定的 authoritative U。

### 3. HIGH — four-blob freeze check是可选 helper，不是开跑/分析硬门

`freezeDriftProblems()`本身工作：fresh调用对 HEAD返回 `[]`，对 `058540393`准确报三个 script drift。但 wrapper只检查 SHA“是某个commit”；analyser省略 `--repo-root` 就不跑 helper；CLI甚至接受不存在的 `FZ`并能发 A；sensitivity不带 freeze identity。

**Minimum fix:** wrapper在写第一个 START **之前**比较四个 frozen blobs与 exact freeze commit；analyser将 repo root/blob compare设为不可省略并拒绝运行而非只靠调用约定；sensitivity/receipt/state/analysis全链同一 full SHA与 frozen-config hash。加入 stale-existing commit、nonexistent commit、dirty frozen file、missing repo root、sensitivity mismatch的行为测试。

### 4. MEDIUM — frozen J contract仍陈述已撤回的相反事实

这不是新一轮文字打磨：spec-baseline是预注册 authority，本轮唯一特别要求就是验证 J30 的剩余理由。当前 authority仍说 J13不足、J30薄过，simulator注释仍说L2/J30失败，analysis输出甚至仍印“13 units”假设（`analyze.mjs:674`）。这些与当前 executable及Lead的新裁决相反。

**Minimum fix:** 在 freeze commit里把 J裁决改为真实的 policy rationale及上述可复现 `0.115923→0.157903` 数字；明确它是判别力/可达到下界的选择，不是 coverage/minimal-J claim；删除四份指定 docs与三个 frozen scripts里所有 J13固定、J13 coverage fail、J26 fail、J30 thin-LCB、L2/J30 fail、J44/34绑定叙述。加一个 exact document/self-test contract，防止旧故事再次全绿。

## NON-BLOCKING advisories

1. global lock在 `mkdir` 成功但 owner pid文件尚未写入时崩溃，会留下无法证明持有者已死的 ownerless lock；后续每次等60秒后拒绝且不收敛。把 lock owner通过临时目录+原子rename发布，或定义安全grace/recovery协议。它当前 fail-closed，所以不作为额外 false-A blocker。
2. `rebuild_index()` 的 rename后没有与 state write相同的目录 durability fence；index虽可重建，但应补 fence及index-loss restart测试。
3. simulator的 seed-stability注释仍称“先运行”，实际仍在主 configurations之后计算；最终controls会veto，故仅是资源/叙述问题。
4. ShellCheck的 `SC2012`/`SC2034`不影响本 verdict。

## Freeze judgment

**不得冻结，不得开始 Window 1。**

J=30 本身已得到独立数值支持并可由 Lead作为增加 A 判别力的政策选择批准；corrected stationary simulator在 J13/J30 两端点都过；排期在给定 no-restart保证下也装得下。阻塞不在这些地方。

阻塞在三个当前可执行的 authoritative bypass：伪 `pass:true` sensitivity能发 A/N；调用者能丢弃额外 completed window并在缺 canonical state/hash/replacement identity时选择 evidence；freeze blob比较能被CLI/wrapper省略。再加 frozen authority仍陈述已撤回的 J 理由，本 commit不能充当诚实预注册点。

完成上面四个 minimum fixes，并把现有反例加入 CI 后，再做一次 exact-head freeze confirmation；不需要扩大到已延期的 B-strength #1/#3。

VERDICT: CHANGES REQUESTED
