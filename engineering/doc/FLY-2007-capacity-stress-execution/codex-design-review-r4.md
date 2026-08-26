# FLY-2007 Capacity Stress Execution — Design Review R4

VERDICT: CHANGES REQUESTED

## 审阅快照与边界

- 这是 design review，不是 code review；未修改任何仓库文件。
- 设计正文审阅绑定提交 `5198af1b7a89bfd22bb79e00802cd9f21341ca4c`，全部 file:line 证据均从该 commit blob 读取。分支当前 HEAD 是其后仅含 progress 更新的 `091f6be359f0b49e3f10e39601a8860f98fb7df6`；工作树在审阅开始时干净。
- 逐字核对了 R3 归档、v4 的 `exploration.md` / `research.md` / `plan.md`、不可修改的上游 `FLY-1986/plan.md` 与 collector。下表不以 `plan.md` §9 的作者处置表作为关闭证据。
- 中心结论：v4 的 familywise allocation 数学上成立，`J=90` 的算术也成立；但 `90` 只认证 B 的性能子门，不认证完整 B。另有 invalid-data totality、wrapper preflight、ledger crash recovery、敏感性验收与三文档漂移等冻结前阻塞项。因此本计划不能在只等待 Lead superseding decision 的条件下开 W1。

## R3 closure table（1–8）

| R3 项 | 状态 | v4 正文核对结论 |
|---:|:---:|---|
| 1. `inference_eligible` 位于 precedence 之前 | **PARTIAL** | `plan.md:107-122` 已明确 fixed `J=13`、完整性/ledger 条件、失败即 authoritative U、禁止 survivor-`J` exact，核心优先级洞已补。但 `plan.md:120-122,178-182` 同时要求 invalid 时仍计算 bounds、又规定 bundle 缺件即拒；collector 对 preflight/invalid block 会无 bundle 或产出 `NA`（`scripts/qa-fly-1986-load-probe.sh:480-498,503-548,804-838`）。故 gate 还不是覆盖所有 collector 终态的 total function，见 Finding 2。 |
| 2. range/equivalence/N 的完整 tail 与 endpoint allocation | **CLOSED** | `plan.md:135-144`、`research.md:244-249,313-325` 已冻结 B performance、B equivalence、A、N 的不同水平。独立推导见下：B 的 IUT 允许 aggregate gates 使用不同 per-CP level；`range_ub` 与当前 `range_lb` 公式各需 3 upper + 3 lower tails，再乘 G；N 再跨 2 endpoint union。allocation 本身正确。 |
| 3. superseding authority 是 pre-W1 hard gate | **CLOSED** | `plan.md:69-78,153-163,267-269` 已把裁决原文/回执放进 freeze 与 §7-1b；未获批不得开 W1，并声明 fallback 到上游三态。当前裁决尚未到账是预期外部条件，不是该门设计缺失。 |
| 4. sensitivity acceptance 不得靠 controls 假绿 | **PARTIAL** | `plan.md:232-244,273` 已要求 GOF/parameter-set、frozen grid 全点 simultaneous LCB、W1–W3 applicability 与 controls 分列，主体方向已补。但 `range_ub` 与 `range_lb` 明明使用两套不同水平（`research.md:319`），§5.5/§7-5 只验一个未展开的 “range/equivalence program”；验收未逐项强制两种方向/level，见 Finding 5。 |
| 5. A 与 N 的 adverse-family 总预算 | **CLOSED** | `plan.md:135-144` 明确 `alpha_A=alpha_N=0.025`，并只把 95% 标签用于 authoritative **adverse** family。独立推导确认 `P(false A or false N) <= alpha_A+alpha_N=0.05`；precedence 不会替代这个 union bound，但分配后足够。 |
| 6. wrapper/ledger 可执行且 crash-safe | **PARTIAL** | `plan.md:246-261` 已加入 GET allowlist、OS lock、START/PREFLIGHT/TERMINAL、原子目录与双向 census。但 `/health` 不能提供必须记录的 `pressure_hold`，wrapper 又禁止 DB；且 START 与目录创建跨两个持久对象没有 recovery/convergence 合同。见 Findings 3–4。 |
| 7. exposure calculator、600 标签与 dominance claim | **PARTIAL** | `plan.md:32-37,54,276` 已把 600 限定为 Hoeffding、加入 calculator/ceiling 验收，并在 `plan.md:193-194` 删除 uniform-dominance 理由。但 `J=90` 被误写成约 7 个 65 分钟窗可回答 B exposure，未纳入 B equivalence 的更严门；calculator 的 scenario/power/window aggregation 也未定义。`research.md:260` 还残留“已证 Hoeffding 更松”的错误句。见 Findings 1、7。 |
| 8. 三份文档同步、tie 与 mutation authority | **PARTIAL** | `plan.md:191,206-226` 已钉整数交叉乘法、tie fixtures 和 15-entry authoritative table。但 `plan.md:49` 仍写 6 条，`exploration.md:103-107` 仍写 7 条且旧 freeze/acceptance，`research.md:363` 仍写三件 bundle，`research.md:430` 仍禁止 wrapper 网络。见 Finding 7。 |

关闭统计：**3 CLOSED / 5 PARTIAL / 0 NOT CLOSED**。

## Familywise allocation：独立推导

令 endpoint `e in {L1,L2}`、window `w in {1,2,3}`、threshold grid `C` 大小为 `G=5`。对每个 `(e,w,c)`，单侧 CP upper/lower 的 tail error 分别记为 `a_U` / `a_L`。若对应 grid 上所有 CP tail 都覆盖，则

```text
b_ew <= U_ew := min_c [c + (1-c) pi_U,ew(c)]
b_ew >= L_ew := max_c [c pi_L,ew(c)]
```

### B family：IUT 在不同 per-CP level 下仍成立

- 单个 performance component 的 false-safe event 由 `G` 个 upper-tail events 控制；每个 CP 用 `alpha_B/G`，则该 component test 的 size `<= alpha_B`。
- 完整 B 要六个 performance components、L1 equivalence、L2 equivalence **全部**通过。其 null 是这些 component null 的并集，故是标准 intersection-union test：任一 null component 为真时，“全部通过”是“错误通过该 component”的子事件，概率 `<= alpha_B`。
- IUT 只要求每个 aggregate component test 的 size `<= alpha_B`；不要求它们内部使用相同 per-CP alpha。因此 performance 用 `alpha_B/G`、equivalence 用 `alpha_B/(6G)` 完全允许。六个 performance components、两个 endpoint equivalence gates、以及 performance-vs-equivalence 之间都无需再 Bonferroni。

对一个 endpoint 的 `range_ub`：

```text
R_e = max_w b_ew - min_w b_ew
range_ub,e = max_w U_ew - min_w L_ew
```

要让该上界对数据自适应选择的 max/min 仍有效，需要 3 个 window upper events 与 3 个 window lower events同时覆盖；每个 `U_ew` / `L_ew` 又各自选过 G 个 thresholds。因此共有 `3 x 2 x G = 6G` 个 atomic tail events，取

```text
a_eq = alpha_B/(6G) = 0.05/30 = 0.0016666667.
```

这是有效且保守的 allocation。不是 `12G`：endpoint 之间是 B 的合取/IUT，不需要除以 2。

### A family

A 是 6 个 `(endpoint,window)` components 的并集。每个 component 的 `b_lb=max_c b_lb(c)` 会自适应挑 threshold；只有全部 G 个 lower CP events 覆盖时，这个 max 才仍是合法 lower bound。因此 union 共 `6G` 个 atomic events：

```text
a_A = alpha_A/(6G) = 0.025/30 = 0.0008333333.
```

`max` 不会绕过 Bonferroni；它正是必须乘 G 的原因。该 allocation 控制任一 false A component 的 familywise error `<= alpha_A`。

### N family 与 `range_lb` 的 tail count

对一个 endpoint：

```text
range_lb,e = max(0, max_w L_ew - min_w U_ew).
```

当前公式需要全部六个 window tails：任一错误偏高的 `L_w` 都可能被 `max` 选中，任一错误偏低的 `U_w` 都可能被 `min` 选中。因此需要 3 lower + 3 upper；不能只保护事后被选中的两个 index。每个 tail 又含 G-grid selection，所以每 endpoint 是 `6G`。N 是两个 endpoints 的并集，再除以 2：

```text
a_N = alpha_N/(2*6G) = 0.025/60 = 0.0004166667.
```

这对当前 band-arithmetic 程序是正确的。可以设计别的 closed/pairwise procedure，但那不是 v4 写下的程序。

### authoritative adverse outcome 的 95% claim

令 `F_A` 为任一 false A claim，`F_N` 为任一 false N claim。上述 simultaneous bands 给出

```text
P(F_A union F_N) <= P(F_A) + P(F_N)
                  <= alpha_A + alpha_N
                  = 0.05.
```

所以“authoritative **adverse** outcome 有 overall 95% guarantee”按 familywise false-claim 语义成立，而且是 strong control；`A > N` precedence 只选择标签，不减少也不增加这个 bound。该结论不应扩写成“整个 B/A/N/U 四态都有统一 95% correctness”：B 另用自己的 `alpha_B=0.05`，U 也不是一个被 95% 认证的参数命题。

### `inference_eligible` 与 alpha levels

若 gate 的唯一行为是 `E=false -> U`，且绝不以 survivor `J` 重算，则任一 inferential claim event 变成 `E intersect claim`，只是原 claim event 的子集；即使 E 由观测数据决定，也不需要额外 alpha allocation。这里保证的是预注册 attempt 的无条件 type-I/FWER，不是 `P(error | E=true)` 的条件覆盖。

这项结论依赖 gate 真正只抑制 claims、replacement 原因与 `p_j` 独立且不能 cherry-pick。v4 在政策上这样要求；Finding 2 指出的是 gate/output 尚未对所有 collector 终态定义完，不是 alpha 需要再拆。

## `J >= 90`：独立重算与 B exposure 限定

全干净、`c=0`、`K=0` 时，单侧 CP upper 是

```text
pi_U = 1 - a^(1/J).
```

B 的单个 performance component 用 `a=alpha_B/G=0.01`。要求 `pi_U <= 0.05`：

```text
J >= ln(0.01) / ln(0.95)
  = 89.7811349607...
ceil -> 90.
```

复算边界：

| J | `1 - 0.01^(1/J)` | 结果 |
|---:|---:|---|
| 89 | 0.0504275851 | 5.0428%，失败 |
| 90 | 0.0498814927 | 4.9881%，通过 |

因此 `alpha_B/G=0.01` **是 B performance 子门的正确 exposure level**，因为六个 performance components 是 IUT，不除以 6。

但它**不是完整 B 的 exposure level**。完整 B 还要求每个 endpoint 的 `range_ub < delta=0.025`，其 atomic level 是 `a_eq=alpha_B/(6G)=1/600`。在三个窗口都全干净且同样有 J 个单元时，`L_w=0`、`U_w=1-a_eq^(1/J)`，所以 best-case equivalence 仍要求

```text
1 - (1/600)^(1/J) < 0.025
J > ln(1/600) / ln(0.975)
  = 252.665225172...
minimum integer J = 253 per window.
```

边界为：`J=252 -> range_ub=2.506516%`（失败），`J=253 -> 2.496734%`（通过）。因此在 v4 保持“三窗、每窗单独估一个 `b_w`”的 estimand 下：

- performance-only best case：每窗 90 单元 = 每窗 7.5 小时；三窗合计 22.5 小时；
- full-B all-clean best case（仅看统计 bounds）：每窗至少 253 单元 = 每窗约 21.08 小时；三窗合计约 63.25 小时；另仍须 sensitivity/applicability gates。

“约 7 个 65 分钟窗”只累计约 91 个单元，不能让原先三个 `b_w` 各自拥有 `J=90`；除非重新定义 pooling/window estimand，而那会同时改变 range tail count 与预注册合同。

## NEW findings

### 1. HIGH — exposure calculator 把 performance-only 的 `J=90` 冒充了完整 B 的 exposure，且 pooling/power scope 未定义

**Evidence:** `engineering/doc/FLY-2007-capacity-stress-execution/plan.md:32-37,54,88-92,113-118,135-140,276`; `engineering/doc/FLY-2007-capacity-stress-execution/research.md:131-140,319-338`; `engineering/doc/FLY-2007-capacity-stress-execution/exploration.md:135-137`.

`J=90` 只来自 performance 的 `alpha_B/G`；完整 B 的 all-clean equivalence best case 已需 `J=253` **per window**。v4 同时把 `J` 定义为每窗固定单元数，却把 90 总单元换算成约 7 个旧 65 分钟窗，未说明如何把它们变成三个 window-specific estimands。`scenario 区间` 也没有冻结 scenario set、目标 power、未来 `K(c)` 模型或 pooling 规则；“有输出 + ceiling mutation”可以让任意 calculator 假绿。

**Required change:** 把 90 明标为 “B performance subgate only”；按完整 B 的最严 gate 输出 all-clean bound（当前程序为每窗 253），冻结 future window/aggregation contract、scenario grid、power target、`K(c)`/dependence assumptions 与 impossible/unbounded 结果；加入 89/90、252/253、三窗不可偷池化的 acceptance fixtures。

### 2. HIGH — `inference_eligible` 不是覆盖 collector 全部终态的 total output contract，invalid 时的 `descriptive_only` 数值甚至可能不存在

**Evidence:** `engineering/doc/FLY-2007-capacity-stress-execution/plan.md:107-122,176-182,271-272`; `scripts/qa-fly-1986-load-probe.sh:480-498,503-548,804-838`.

plan 说 eligibility false 时 bounds/range “仍计算并印出”，但 collector 在 `unreachable` / auth failure / incomplete block 时把 point estimates 写成 `NA`，而 preflight failure 会在三份数据文件写入前退出。另一方面 analyzer 对四件 bundle “缺一即拒”。因此同一 failure 既可能是 authoritative U、process-level reject、又可能被实现者自行用 raw/survivor data 填成 misleading descriptive bounds；`upstream_literal_outcome` 在这些情形也没有定义。

**Required change:** 冻结逐终态表：preflight fail、partial run、`invalid_*`/`incomplete_expected`、numeric-but-void `timer_late`、complete-valid 各自的 ledger/receipt、`inference_eligible`、authoritative outcome、numeric field nullability 与 reason code。只有完整且数值定义明确的数据才可输出 `descriptive_only` bounds；其余必须 `not_computable`/null，且 compatibility outcome 也不得由 invalid data 伪造。Analyzer 必须对 ledger-only failure 仍稳定产出 U，而不是在 bundle loader 先无 schema 退出。

### 3. HIGH — wrapper 的 PREFLIGHT receipt 在 `GET /health` allowlist + DB ban 下不可实现

**Evidence:** `engineering/doc/FLY-2007-capacity-stress-execution/plan.md:169-172,250-257,274`; `engineering/doc/FLY-2007-capacity-stress-execution/research.md:387-394`; `packages/teamlead/src/bridge/plugin.ts:1816-1835`; `scripts/qa-fly-1986-load-probe.sh:306-325,364-367,535-548`.

`/health` schema 不含 `pressure_hold`；upstream collector 明确用 `sqlite3 -readonly` 查询 `fleet_pressure_hold`。worker identity 由 `lsof` + `ps` 得出，`load1` 也不是 `/health` 字段。v4 却要求在调用 collector **之前**由 `/health` 记录所有这些值，同时禁止 wrapper 打开任何 DB。不可修改的 collector 也没有 machine-readable preflight receipt 可供 wrapper 复用。

**Required change:** 冻结每个 PREFLIGHT 字段的真实 authority 与读取方法。可选方案是给 wrapper 一个精确的 local-read allowlist（同一 canonical DB path 的 `sqlite3 -readonly`、`lsof`/`ps`、`uptime`、plist read），并在 collector 入口再次 fence/比对；或从 receipt 删去 wrapper 无法权威取得的字段并以 collector terminal evidence 替代。Acceptance 必须逐字段用缺失/unknown/mismatch 变异变红，不能只 grep URL allowlist。

### 4. MEDIUM — START 与 attempt directory 之间仍有不可收敛 crash gap；“census 变红”不等于 crash-safe

**Evidence:** `engineering/doc/FLY-2007-capacity-stress-execution/plan.md:48-53,252-261,275`; `engineering/doc/FLY-2007-capacity-stress-execution/research.md:387-398`.

START append 与 directory creation 是两个不同持久对象，不可能由一次 rename 原子提交。先 START 后 mkdir 会留下 ledger-only attempt；先 mkdir 后 START 会留下 directory-only attempt。v4 的双向 census 会发现它，却没有 recovery/terminalization 规则，因而一次 wrapper crash 可永久毒化 eligibility。PREFLIGHT/TERMINAL 是否也在同一 writer lock/CAS 下、`receipt.json` 由谁在何时原子写入，也未定义。

**Required change:** 选一个唯一 allocation authority（例如原子 `mkdir attempt-NNN` + 目录内原子 START state，顶层 JSONL 只是可重建 index），或为两种 orphan 定义确定性的 recovery transaction；所有 transition 都要有锁/CAS、file + parent-dir durability、允许/禁止的 state graph 与 receipt ownership。Crash tests 必须证明重启后收敛到明确 TERMINAL/aborted 状态并继续 census，而不只是证明 analyzer 会红。

### 5. MEDIUM — sensitivity acceptance 没有机械区分两个不同 alpha 的 range procedures

**Evidence:** `engineering/doc/FLY-2007-capacity-stress-execution/plan.md:135-140,228-244,273`; `engineering/doc/FLY-2007-capacity-stress-execution/research.md:293-304,313-325`.

正文正确承认 `range_ub`（B，atomic `alpha_B/(6G)`）与 `range_lb`（N，atomic `alpha_N/(2*6G)`）必须算两套 interval；但 sensitivity/acceptance 只列一个未展开的 `range/equivalence program`。实现只验证更宽的 N bands，或只验证 B upper-range direction，都能在字面上满足“三个程序”却漏掉另一 claim path。

**Required change:** §5.5/§7-5 和输出 schema 逐项列出四个实际 configurations：`b_ub@B-performance`、`b_lb@A`、`range_ub@B-equivalence`、`range_lb@N`；每项分别在全部 frozen DGP/grid points 报 simultaneous LCB 与 pass/fail，B/A/N 只消费自己的那一项。

### 6. MEDIUM — acceptance 4b 的 `unreachable` fixture 可在 eligibility guard 被删后仍然“正确”变 U，不能证明 gate 会红

**Evidence:** `engineering/doc/FLY-2007-capacity-stress-execution/plan.md:206-226,269-275`; `scripts/qa-fly-1986-load-probe.sh:487-498`.

collector 遇 `unreachable` 会把两个 point estimates 写成 `NA`。即使实现绕过 eligibility，后续 numeric loader 也可能因 `NA` reject/U，因此 4b 的期望 U 仍绿，未证明 precedence 前的 gate 生效。§5.4 虽列“资格门被绕过”的 mutation，但未规定一个绕过后必然产出 A/B/N 的 decision-bearing fixture。

**Required change:** 增加 numeric-but-invalid fixture，例如 `timer_late > 2%`（collector 会保留数值但 `block_valid=false`），并把其余数据构造成 guard 删除后必判 A；实际删除/bypass gate 后测试必须红，恢复 gate 后必须得到 `U + reason=inference_ineligible`，全部 inferential claims/bounds 按 Finding 2 的 schema 降级。

### 7. MEDIUM — “三份文档已同步 / 15 条唯一权威 / dominance 已删除”的 v4 claim 仍被正文直接反驳

**Evidence:** `engineering/doc/FLY-2007-capacity-stress-execution/plan.md:45-50,206-226,357-366`; `engineering/doc/FLY-2007-capacity-stress-execution/exploration.md:101-120`; `engineering/doc/FLY-2007-capacity-stress-execution/research.md:254-264,361-379,426-430,453-464`.

- `plan.md:49` 仍写 6 条 mutation，`exploration.md:107` 仍写 7 条，和 primary table 的 15 条冲突；
- `exploration.md:103-107` 的 freeze/acceptance 仍漏 wrapper、alpha allocation、eligibility 与完整 sensitivity gates；
- `research.md:363` 仍把 run bundle 写成三件，和同文 `:458`/plan 四件冲突；
- `research.md:430` 仍说 wrapper 不开网络/DB，和 GET allowlist 冲突；
- `research.md:260` 仍声称 §C.3 已证 Hoeffding 更松，紧接着 `:263-264` 又承认不存在 uniform dominance。

**Required change:** 冻结前机械统一三份规范性正文；若 `plan.md §5.4` 是唯一 mutation authority，其他文档只链接它而不复述旧数量。统一四件 bundle、wrapper authority、freeze/acceptance scope，并删除剩余 uniform-dominance 句。加文档 contract test 检查这些 literal counts/sets，避免再漂移。

## Freeze / W1 judgment

**不具备“只差 Lead superseding decision 即可 freeze 并开 W1”的条件。** Superseding hard gate 本身已关闭；但即使裁决现在到账，Findings 1–7 仍使 calculator、invalid-data outcome、preflight receipt、crash recovery 与 acceptance 存在多个可实现版本，其中部分会低估 full-B exposure或让安全路径 validation 假绿。

达到可 freeze 的最小条件是：修正完整 B exposure 与 calculator contract；把 collector 全终态映射成 total fail-closed schema；给 PREFLIGHT 每字段可执行 authority；让 ledger crash 后可收敛；显式验证两套 range levels并使 4b 非真空；最后同步三份文档。完成后再做 R5 exact-text review；Lead 裁决到账仍是 W1 的必要条件，但不是当前唯一条件。

VERDICT: CHANGES REQUESTED
