# FLY-2007 Capacity Stress Execution — Design Review R5

VERDICT: CHANGES REQUESTED

## 审阅快照与边界

- 用户指定的审阅提交是 `a46a83cba`。审阅开始时，分支 `flywheel-FLY-2007` 的实际 HEAD 已前进到 `0b68a7a239c811b9a3d8d764ed3ae43c737f7d0b`；`a46a83cba` 是它的直接父提交，二者唯一差异是 `engineering/doc/FLY-2007-capacity-stress-execution/progress.md`。本报告的正文、实现、测试及全部 file:line 证据均绑定 immutable commit `a46a83cba`。
- 工作树干净；未修改任何仓库文件。执行只读检查及 `/tmp` 隔离反例。
- 本轮严格应用 Lead 的 contract-strength trim：**不要求**执行 B 的 `b_ub @ B-performance` sensitivity、`range_ub @ B-equivalence` sensitivity，也**不要求**现在实际取得 `J >= 253` / 63.2 小时曝光。它们只需如实记录。
- 但 Lead 明确未 override 安全路径；`inference_eligible` totality、非法 replacement、crash ledger、以及若要权威声称 A 所必须的 `b_lb @ A` sensitivity 都仍是本轮硬门。
- 当轮验证：focused harness `50 passed, 0 failed`；analyser self-test `40/40 passed`；wrapper `bash -n`、两个 `.mjs` 的 `node --check` 均通过；ShellCheck 只有 `SC2012` info。下述反例说明这些绿灯不足以支撑冻结。

## R4 closure table（7 个 R4 findings + 5 个 PARTIAL R3 carry-over）

| 来源 / 项 | 状态 | v5 文本 + `a46a83cba` 实现核对 |
|---|:---:|---|
| **R4 #1** — `J >= 90` 不是完整 B；calculator 的 aggregation/scenario | **PARTIAL** | `spec-baseline.md:182-186` 与 analyser `:501-520` 已正确给出 performance=90、equivalence=253、`full_B=max(...)=253`；本轮也不要求执行 B。但 plan 仍预注册 `A 方向所需曝光 + scenario 区间`（`plan.md:65,299`），实现只给 all-clean B 与 delta cost table，没有这两项。剩余缺口属于“A/U + exposure gap”的交付形状，不是要求 B sensitivity。 |
| **R4 #2** — eligibility 必须覆盖 collector 全终态 | **NOT CLOSED** | spec 的 total table 已写（`spec-baseline.md:113-126`），实现没有：CLI 先要求至少一个完整四件 bundle（analyser `:208-210,645-649`），`classifyBlock` 只看 summary 的 `block_valid`（`:340-352`），ledger 又不读 failure reason/replacement（`:378-395`）。实测一个 `health_unreachable` attempt 后补三份成功高违约 bundle，得到 `eligible=true, outcome=A`。 |
| **R4 #3** — PREFLIGHT 逐字段 authority 可执行 | **PARTIAL** | wrapper 已复用 collector 的 `/health`、`read_pressure_hold`、PID resolver、`uptime`、`plutil`（wrapper `:202-241`），且实测 DB 不可读时以 `pressure_hold_unknown`/rc=1 终结，核心修复真实生效。但 §9.1 把 `ok`、`shuttingDown` 列为 PREFLIGHT 字段（spec `:240-246`），receipt 并未保存二者（wrapper `:254-269`）；`bridge_started_at` 也未做 non-empty gate。所谓逐字段 mutation 验收仍只有 grep（test `:129-139`）。 |
| **R4 #4** — ledger crash 后确定性收敛 | **NOT CLOSED** | 目录作为 allocation authority 的方向已实现，但 crash 正好发生在 `mkdir` 与首次 state 之间时，recovery 从不存在的 state 读 attempt id，生成 `{"attempt_id":,...}` 后仍 rc=0（wrapper `:126-147,171-175`；当轮已执行复现）。此外运行中释放全局锁（`:161-176`），下一 wrapper 会把仍活跃的 START/PREFLIGHT attempt 当 orphan 终结（`:126-136`），`finish` 又在锁外覆盖 state（`:178-181`）。 |
| **R4 #5** — 四种 sensitivity configuration 不得互相顶替 | **NOT CLOSED** | spec 已按 Lead trim 公开把 #1/#3 降为文档层、#2/#4 标 gate-critical（`spec-baseline.md:199-210`）。但 simulator 只有若干导出 helper、在第 122 行即结束，没有 frozen grid、seed set、GOF/parameter-set、K 点 driver、接受判定或输出；analyser 完全不消费 sensitivity 结果，却能直接发 A/N/B（analyser `:405-480`）。不要求 B 的 #1/#3；**A 的 #2 仍未闭合**。若本轮仍允许 N，#4 也必须闭合。 |
| **R4 #6** — numeric-but-invalid fixture 证明 eligibility guard 非真空 | **NOT CLOSED** | analyser 的 `classifyBlock(false)` 单点 self-test 存在（`:573-575`），但 prereg 要求的“其余数据构造成删 guard 必判 A、删门变红、恢复后 U”的端到端 mutation 不存在（`plan.md:294-295`；test `:84-119,151-175`）。当前 harness 无法证明 precedence 前的真实 gate wiring。 |
| **R4 #7** — 三文档同步 + 可变红文档合同 | **NOT CLOSED** | research 仍写“§C.3 已证 Hoeffding 更松”及“三个程序”（`research.md:306,344,520`），exploration 仍把 `J>=90` 写成“本判据只需”并把已到账 authority 写成“待裁决”（`exploration.md:141,163`）。测试只搜索一个旧短语并要求 plan 至少出现一次“15 条”（test `:178-187`），所以这些实际漂移仍 50/50 通过。 |
| **R3 carry #1** — eligibility 位于 precedence 之前 | **PARTIAL** | analyser 的表面顺序正确：`:445-448` 先以 eligibility 强制 U，再在 `:450-457` 判 A>N>B/U。但 eligibility 本身不是 total，且非法 replacement 可穿透，所以安全性质未闭合。 |
| **R3 carry #4** — sensitivity acceptance 不得由 controls 假绿 | **PARTIAL** | 文档已列 gate-critical #2/#4，simulator 也有 `coverageLower` / `coverageRangeLower` helper（simulator `:71-98`），但没有任何可执行 acceptance 或 analyser wiring；controls、GOF、K/M/LCB 也未运行。 |
| **R3 carry #6** — wrapper/ledger 可执行且 crash-safe | **PARTIAL** | pressure authority 与 `pressure_hold=NA` fail-closed 已关闭；replacement enforcement、active-attempt ownership、mkdir-before-state crash、durable rename、terminal hashes与双向 census 未关闭。 |
| **R3 carry #7** — exposure calculator、600 标签、dominance | **PARTIAL** | `max(90,253)`、ceiling、delta cost 与 600 descriptive 标签均在代码中；A-direction/scenario 缺失，research 的 dominance 残句仍在。 |
| **R3 carry #8** — 文档同步、tie、mutation authority | **PARTIAL** | 整数交叉乘法与 reachable tie tests 已关闭（analyser `:103-147,547-553`）。但 plan 的 15 项表与实际 14 个 `mutate` 调用不是同一集合，研究/探索文档仍漂，CI 也未引用该测试。 |

## Implementation vs pre-registration conformance

| 检查点 | 结论 | 证据与判断 |
|---|:---:|---|
| per-CP alpha 常量 | **CONFORMS** | spec §3（`:86-98`）冻结的公式与 analyser `:191-194` 完全一致：`A_PERF=0.05/5=0.01`；`A_EQUIV=0.05/(6*5)`；`A_ADV=0.025/(6*5)`；`A_RANGE=0.025/(2*6*5)`。这里使用公式的精确值，不把文档展示的六位小数当新常量。 |
| `boundUpper` / `boundLower` | **CONFORMS** | `boundUpper` 对每个 c 算 `c+(1-c)*cpUpper` 后取 min（analyser `:116-131`）；`boundLower` 算 `c*cpLower` 后取 max（`:133-148`），与 spec `:44-56`、R3 推导一致。严格 `>` 使用整数交叉乘法（`:103-113`）。 |
| range inequalities | **CONFORMS** | `rangeUb=max(U)-min(L)`、`rangeLb=max(0,max(L)-min(U))`（analyser `:150-162`）与 spec `:141-149` 一致；B/N 分别使用不同 alpha 的 interval sets（analyser `:417-433`）。 |
| run-bundle integrity | **PARTIAL / FAIL-CLOSED GAP** | block/summary/tick/count checks 大体存在（analyser `:269-335`），但 receipt identity 字段只有“存在时才比较”（`:329-332`）；字段全部缺失仍实测 eligible=true。另 `byKey` 中没有对应 summary 的额外 sample key 没有被反向枚举（`:291-325`）。不满足 spec `:128-140` 的 exact contract。 |
| collector terminal-state totality | **NON-CONFORMING** | spec `:113-126` 明列 no-bundle preflight、abort、signal、partial、invalid、numeric void、ledger/default。实现的 bundle loader 会在 total classifier 之前拒绝缺件，ledger reason 又不进入 classifier；没有 `no_bundle_preflight_failed` / `aborted_subject_changed` / `interrupted` 等映射。 |
| eligibility gate + frozen precedence | **PARTIAL** | 代码形状确为 gate above precedence，且 eligible path 是 A > N > B/U（analyser `:443-458`）；但未实现 sensitivity gate、replacement gate与 total terminal gate，故 end-to-end precedence contract 不成立。 |
| sensitivity gate | **NON-CONFORMING** | spec `:168-175,188-210` 要求 A 消费 #2，当前 simulator 没有执行入口/冻结 grid/GOF/acceptance，analyser 也没有 sensitivity 输入。B #1/#3 的不执行符合 Lead trim，不列为 blocker。 |
| exposure calculator 取两个子门 MAX | **CONFORMS（核心）** | analyser `:501-517` 明确 `fullB=Math.max(perf,equiv)`，fresh self-test 验证 90/253。未完成的 A-direction/scenario 另见 Finding 6。 |
| wrapper §9.1 read set | **PARTIAL** | 实际只出现一次 `curl`，复用 collector 的 pressure/PID reader，并用 `uptime`/`plutil`；`health_is_serving` 确实检查 `ok:true` 与 `shuttingDown:false`（upstream collector `qa-fly-1986-load-probe.sh:346-355`）。但 receipt 不保存这两个预注册字段，且字段级 missing/unknown/mismatch 没有行为测试。 |
| `pressure_hold=NA` fail-closed | **CONFORMS（已执行）** | wrapper `:243-251` 明确只接受 0。当轮以不存在的 StateStore path 运行 `--dry-run`：rc=1，state/ledger 均为 TERMINAL aborted、`reason=pressure_hold_unknown`。这不是 grep 推断。 |
| ledger crash/concurrency convergence | **NON-CONFORMING** | mkdir-before-state 反例已生成 invalid JSON；活跃 attempt 无 per-attempt lock/lease；全局 lock crash 无 stale-owner recovery；state rename 后没有 parent-dir durability；terminal state 没产物哈希；analyser 也没有 filesystem side 的双向 census。 |
| freeze binding | **NON-CONFORMING** | spec `:7-10` 要求每份分析输出与 attempt 绑定冻结 SHA。wrapper 只检查参数非空（wrapper `:157-159`）；analyser 的 `--freeze-commit` 是 optional，缺失仍写 `null` 并成功（analyser `:628-650`）。没有验证 SHA 等于实际 frozen commit。 |
| tests vs prereg | **NON-CONFORMING** | test 虽有 50 assertions，但只有 **14** 个 `mutate` 调用（test `:84-119`），与 plan §5.4 的 15 项不是同一表；numeric-invalid eligibility、illegal replacement、simulator acceptance、active concurrency、mkdir/PREFLIGHT crash、双向 census、field mismatch、freeze binding均无人断言。仓库 `.github` / package scripts 对测试名的搜索为 0，未接 CI。 |

## NEW findings

### 1. HIGH — eligibility/ledger 不审失败原因或 replacement，服务失败可以被三份幸存 bundle 洗掉并产出 A

**Evidence:** `engineering/doc/FLY-2007-capacity-stress-execution/spec-baseline.md:100-126,230-248`; `scripts/qa-fly-2007-phase0-analyze.mjs:208-210,329-395,405-480`; `engineering/doc/FLY-2007-capacity-stress-execution/research.md:448-459`.

`ledgerProblems` 只检查 ID 连续、目录字符串不重复、state=TERMINAL、disposition 存在；它完全不看 `reason`、`window`、`replacement_of`、可重跑类别或两次上限，也不确认 ledger→filesystem 的反向 census。bundle loader 又只加载调用者挑出的三份四件套。

当轮构造了 ledger：attempt 1=`health_unreachable/aborted`，attempt 2–4=completed，三份 bundle 全为高违约、完整 valid。实际返回：

```json
{"inference_eligible":true,"ineligibility_reasons":[],"authoritative_outcome":"A"}
```

这正是安全合同禁止的 survivor/replacement 路径。另一个当轮反例把三份 receipt 的 `preflight` 全置空，仍得到 `eligible=true`，因为 identity 字段只在存在时比较。

**Required change:** 让 eligibility 从 canonical attempt directory census + ledger state graph 出发，而不是只审调用者选择的成功 bundles；逐一实现 spec §4.0 terminal mapping；服务/宿主失败必须使相应窗口/阶段 U，只有具名 operator/harness/storage 原因可带 `replacement_of` 重跑且总数 ≤2；receipt 的 required fields 缺失即拒。ledger-only/no-bundle failure 也必须稳定产出 U + exact reason，而不是 loader 先退出或被后续成功 bundle 洗掉。

### 2. HIGH — A/N 的 gate-critical sensitivity 完全未接入 outcome，A/N 可以在未验证 A1 失效代价时直接成为权威结局

**Evidence:** `engineering/doc/FLY-2007-capacity-stress-execution/spec-baseline.md:22-30,168-210`; `engineering/doc/FLY-2007-capacity-stress-execution/plan.md:242-265`; `scripts/qa-fly-2007-phase0-simulate.mjs:25-122`; `scripts/qa-fly-2007-phase0-analyze.mjs:405-480`.

simulator 到第 122 行结束，只导出 PRNG、一个 DGP、四个 coverage helper 与 LCB helper；没有 frozen dependency parameter set、adversarial/true-p grid、seed list、GOF、K、acceptance、controls report、CLI 或 schema。analyser 不接受 sensitivity artifact，也不检查其 freeze SHA/configuration/结果；只要 bounds 过线就发 A/N。

Lead trim 不会关闭这个缺口：B 的 #1/#3 明确延期，**但 A 的 #2 仍是 A/U 产品路径**。Section 0.1 对 B 的延期是公开、诚实的，并非 silent descope；真正的 silent descope 发生在实现——正文说 A 要 #2，代码却完全绕过它。

另有一处 authority 不一致：Lead 的后续措辞是本轮产物 “A or U plus the exposure gap”，但 spec `:30,168-186` 又把 #4/N 保留为 gate-critical 并允许权威 N；代码也会返回 N。若 “A or U” 按字面执行，N 应本轮降为 U + descriptive flag；若仍要权威 N，则需明确确认后续 trim 没有移除 N，并实现 #4。不能静默选择第三种路径“保留权威 N 但不跑 #4”。

**Required change:** 至少为 #2 冻结并实现完整 simulator driver、pilot-only calibration/GOF、parameter set、≤20 点 grid、seeds、M=20000、per-point `alpha_MC/K` LCB、controls 与 machine-readable result；analyser 必须校验同 freeze commit/config 后才允许 A，任何 missing/inconclusive/out-of-domain 均 U。对 N 按上段二选一。**不要求**本轮实现或通过 B 的 #1/#3。

### 3. HIGH — ledger recovery 在 allocation 最早 crash 点生成坏账，并会把仍活跃的并发 attempt 当 orphan

**Evidence:** `engineering/doc/FLY-2007-capacity-stress-execution/spec-baseline.md:230-248`; `scripts/qa-fly-2007-phase0-run-window.sh:97-148,160-181`; `engineering/doc/FLY-2007-capacity-stress-execution/plan.md:267-284`.

`mkdir attempt-NNN` 与首次 state write 仍是两个动作。若在中间 crash，`converge_orphans` 从不存在的 `state.json` 读不到 `attempt_id`，却继续写：

```json
{"attempt_id":,"dir":"attempt-001","state":"TERMINAL",...}
```

当轮真实运行 `--recover-only` 返回 0，随后 `JSON.parse` 返回 1。协议声称“确定性收敛”，实际收敛成 analyser 无法读取的 ledger。

并发问题更严重：wrapper 写 START 后释放唯一全局锁，再执行最长 65 分钟的 preflight/collector；第二 wrapper 一拿到锁就把所有非 TERMINAL 目录终结为 crash orphan。没有 per-attempt owner/lease/liveness fence。第一个 wrapper 的 `finish` 又在锁外写 state，可把这条 aborted 覆盖为 completed。`write_state` 的全局 `sync` 在 rename **之前**，也没有对 rename 后 parent directory 做 durability fence；全局 lock owner crash 后没有 stale-lock恢复；TERMINAL 也没有 spec 要求的产物哈希。

**Required change:** 为每个 attempt 建立可验证的 active ownership（per-attempt lock/lease + PID/start-time identity，或等价协议），所有 state transition 用同一锁/CAS；无 state 时从严格校验过的目录名恢复 ID；给全局 lock stale-owner recovery；临时文件 fsync、rename、parent-dir fsync；TERMINAL 写产物哈希；加入 mkdir 后、START 后、PREFLIGHT 后、active concurrency、stale lock、index loss 的真实 crash/convergence tests。

### 4. MEDIUM — freeze/receipt schema 不是强制合同，缺字段或 `freeze_commit=null` 仍可成功

**Evidence:** `engineering/doc/FLY-2007-capacity-stress-execution/spec-baseline.md:7-10,128-140,238-248`; `scripts/qa-fly-2007-phase0-run-window.sh:157-181,220-271`; `scripts/qa-fly-2007-phase0-analyze.mjs:208-258,327-332,628-650`.

wrapper 要求任意非空 freeze string，却不验证它是 frozen commit；analyser 根本不要求 `--freeze-commit`。receipt 没保存 §9.1 的 `ok`/`shuttingDown`，`bridge_started_at` 可空；analyser 对 build/PID/identity 的缺失不报错。TERMINAL state 没产物哈希。这样“同 commit 冻结并写进每份输出/attempt”的 preregistration evidence 可以在字段缺失时全绿。

**Required change:** 冻结 exact receipt/state/analysis schema；所有 required 字段做 setness/type/format 校验；freeze SHA 在 wrapper 与 analyser 均 mandatory，并与被审 frozen commit/允许的 immutable manifest 对照；PREFLIGHT 记录 `ok=false?` 与 `shuttingDown=false` 的原始/规范字段；TERMINAL 带 bundle hashes；缺失、unknown、mismatch 的每字段 behavior test 必须变红。

### 5. MEDIUM — “50/50”含多项静态存在性/vacuous checks，且没有覆盖 preregistration 真正要求的 guards

**Evidence:** `engineering/doc/FLY-2007-capacity-stress-execution/plan.md:210-240,286-301`; `scripts/__tests__/qa-fly-2007-phase0-analyze.test.sh:84-139,142-187`; `engineering/doc/FLY-2007-capacity-stress-execution/research.md:306,339-350,520`; `engineering/doc/FLY-2007-capacity-stress-execution/exploration.md:141,163`.

- plan §5.4 说 15 个 authoritative mutations，实际只有 14 个 `mutate` 调用，且集合不同。plan 要求的 summary void、block-set deletion、ledger gap、undeclared write、A/N allocation swap、eligibility bypass 等没有对应 mutant；实现增加了其它 mutants不能替代原表。
- `writes go only through writeFileSync` 只断言代码里至少出现一次 `writeFileSync`；新增一个越界写仍会通过。wrapper 的 pressure/never-reuse/orphan checks 多为 grep 某个字符串，dead code 或 comment 也能过。
- simulator 从未被 test 执行；numeric-but-invalid guard、失败 replacement、active concurrency、mkdir/PREFLIGHT crash、双向 census、字段 mismatch、freeze binding均未断言。
- 文档合同测试说“exactly one place”却只检查 plan 里 `grep -c '15 条' >= 1`，并只搜索一个旧 dominance 短语，所以 research/exploration 的实际漂移仍绿。
- repository-wide search 未发现 `.github`、package scripts 或 workspace config 引用这个测试名，与 `plan.md:301` 的 CI 要求不符。

**Required change:** 让 authoritative mutation table 与实际 mutants 一一对应；用行为反例而非字符串存在性验证 safety gates；加入 simulator→analyser integration、numeric invalid、replacement、各 crash point和逐字段 tests；文档合同比较 exact sets/枚举；把 focused harness 接入 CI。修复后应演示每个关键 guard 的 mutant 确实让 suite 红，而不是只重跑未突变版本。

### 6. MEDIUM — exposure output 没实现 preregistered 的 A-direction/scenario contract，“exposure gap”含义在 Lead trim 后仍不唯一

**Evidence:** `engineering/doc/FLY-2007-capacity-stress-execution/plan.md:48,65,145,299`; `engineering/doc/FLY-2007-capacity-stress-execution/spec-baseline.md:22-30,182-186`; `scripts/qa-fly-2007-phase0-analyze.mjs:489-521`.

代码正确记录了 B performance=90、B equivalence=253、full B=max=253 与 delta cost；这满足“B 支撑项保留在文档层”的核心数字。但 plan 仍把“A 方向所需曝光、scenario 区间”列为必备输出，代码没有任何 future-K/power/scenario 计算。本轮产品若是“A 或 U + exposure gap”，U 之后到底报告“距 B 的 all-clean gap”、还是“在冻结坏场景下距 A 的证明 gap”，会给出完全不同的下一步。

**Required change:** 在取 W1 前用 Lead trim 明确冻结本轮 `exposure gap` 的唯一 schema/算法。若只要求记录 B 的 all-clean gap，删除/降格 plan 中 A-direction/scenario 的 executable promise并保持诚实；若 U 必须给 A-direction gap，则冻结其 scenario/power/K 模型并实现。这里不要求执行 B sensitivity 或实际跑 63.2 小时。

## Section 0.1 / contract-strength trim judgment

**对 B 的处置是诚实的，不是 silent descope。** `spec-baseline.md:22-30,182-186,199-210` 清楚写明 #1/#3 文档层、本轮不可执行、B 结构性不可达，并保留 253/63.2h 的代价。这一部分符合 Lead ruling，本报告不把它列为冻结阻塞。

**但 section 0.1 仍有两处必须在冻结前对齐：**

1. 后续正文和实现把本轮产品写成/做成 **A/N/U**，而引用的 Lead trim 是 **A or U**；这不是 B-strength 问题，而是 authoritative outcome scope 漂移。
2. 文本声明 A 的 #2 gate-critical，代码却不消费它；这是对 A/U 支撑强度的实际 silent descope。

因此，不能以“B 已显式延期”为由放过 eligibility、replacement、ledger 或 A-sensitivity；它们都位于 Lead 保留的 A/U 安全路径。

## Freeze judgment

**不具备 freeze 并开始 Window 1 的条件。** 数学核心——四个 alpha 常量、upper/lower inequalities、range 算术、严格 tie、full-B 的 max(90,253)、以及 `pressure_hold=NA` fail-closed——均正确。但当前 implementation 可以：

- 在记录过 service failure 后用三份幸存 bundle 发出权威 A；
- 在没有任何 gate-critical sensitivity 结果时发 A/N；
- 把 allocation 最早 crash 点“恢复”为 invalid JSON；
- 在 receipt required fields/freeze binding 缺失时仍把 inference 判 eligible；
- 让上述缺口在 50/50 harness 中全部保持绿色。

### 可冻结的最小剩余集

1. **闭合 A/U safety gate**：terminal totality、required receipt fields、service/host failure 与 replacement/cap、canonical 双向 census；补反例后 analyzer 只能 U。
2. **闭合 ledger crash/concurrency**：active ownership、原子/durable state transitions、mkdir-before-state recovery、stale lock、terminal hashes及各 crash-point tests。
3. **只实现本轮真正需要的 sensitivity**：#2 必须有完整可执行 acceptance 并接入 analyser；N 要么本轮降为 U+flag，要么明确保留后实现 #4。**#1/#3 继续延期，不是 blocker。**
4. **强制 freeze/schema binding**：wrapper/analyser/receipts/output 都必须绑定同一 immutable freeze commit，缺字段/unknown/mismatch fail-closed。
5. **把非真空行为测试接 CI**，并使 mutation/document authority 与代码一一对应。
6. **对齐 Lead trim 的两个字面歧义**：本轮是否允许权威 N；`exposure gap` 是哪一个冻结算法。若 Lead 既有文字已足够，按其字面收窄文档/实现即可，不需要扩大 B 合同。

完成以上最小集后再做 exact-head R6。当前结论不要求任何已延期的 B-strength 执行项。

VERDICT: CHANGES REQUESTED
