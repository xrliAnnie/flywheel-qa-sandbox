# FLY-2007 容量压测执行 — Design Review R3

VERDICT: CHANGES REQUESTED

## 审阅快照与边界

- 这是 design review，不是 code review；未修改任何仓库文件。
- 评审绑定提交 `f07c726af1198c86286f2fb93f594cba5111dccb`。主计划 blob 为 `46c4f57b0ec429af6d16d9bb6caf1c956daafbc5`。
- 逐字核对了 v3 的 `exploration.md`、`research.md`、`plan.md`，R1/R2 归档，以及不可修改的上游 `FLY-1986/plan.md` 与 collector。以下不采用 `plan.md` §9 的作者自报处置状态代替正文证据。
- 中心结论：阈值-计数界的两条代数不等式与 **A1（单元 iid）条件下**的 CP 构造成立；但 fixed-`J`/作废块状态机、equivalence 完整错误预算、敏感性验收和上游 superseding authority 仍有阻塞缺口。

## R2 全量关闭账本（6 个 R1 carry-over + 8 个 R2 新发现）

| R2 项 | 状态 | v3 正文核对结论 |
|---|:---:|---|
| R1 #1 carry-over：run bundle 完整性 | **CLOSED** | `plan.md:139-143` 与 `research.md:287-299` 已要求 block ID 恰为 `b1..b<meta.blocks>`、每个 `(block,endpoint)` 恰一条 summary、完整 tick 集、逐字计数核对和 meta/receipt 身份不一致即拒。具体 R2 缺口已关闭；三份文档对 receipt 的后续漂移另见新 finding 8。 |
| R1 #2 carry-over：主置信程序/有限样本前提 | **CLOSED** | 有缺陷的 bootstrap 已从判据删除，Hoeffding 已降为只印不判；`research.md:133-176`、`plan.md:145-151` 给出新的、在 A1 下完整可算的 CP 程序与先验固定单元。A1 的适用范围和无效块删选问题是 v3 新程序的新缺陷，见新 findings 1、4；不再复活旧 bootstrap finding。 |
| R1 #3 carry-over：模拟网格 simultaneous rule | **CLOSED** | `research.md:197-205`、`plan.md:182-187` 已明确 `α_param=0.025`、`α_MC=0.025`、每点水平 `1-α_MC/K`、`K≤20`、`M=20000`，修正了 v2 的“每点 95% 再 Bonferroni”矛盾。验收表没有真正验主程序是新的交付缺陷，见 finding 4。 |
| R1 #4 carry-over：attempt ledger 能发现漏记 attempt | **PARTIAL** | `plan.md:196-200` 已加入 collector 前 start receipt、单调 ID、不可复用目录、terminal receipt 与 analyzer fail-closed，方向正确。但 wrapper 被同时禁止联网、却要在 start receipt 中写入实时 health/preflight 字段，且没有并发 ID 分配、两阶段回执、orphan 目录双向对账合同；当前协议仍不能实现其声称的审计保证。见 finding 6。 |
| R1 #5 carry-over：δ 与跨窗三态 | **PARTIAL** | `research.md:246-256`、`plan.md:106` 已把 `δ=2.5pp` 写成 Lead 批准的政策选择，旧伪推导已撤回；range 算术也正确。但 `exploration.md:143-148` 仍写“待裁决”，而两侧/网格/窗口/端点的完整 interval family 未冻结。见 findings 2、8。 |
| R1 #8 carry-over：一单四阶段、B 后 BLOCKED | **PARTIAL** | 主计划 `plan.md:228-235` 已正确写 option 2：一单四阶段、不另拆 issue、Phase 0=B 后 blocked、§17-②③ 留本单。可是 `exploration.md:143-148` 仍把是否拆单写成待裁事项；整个 v3 文档集尚不一致。见 finding 8。 |
| R2 new #1：bootstrap-t 程序/反演/边界缺失 | **CLOSED** | `research.md:110-117` 与 `plan.md:145-151` 已从判据中净删除整套 bootstrap；不需要再修该无效程序。`research.md:376` 的残留“bootstrap”字样是文档漂移，见 finding 8。 |
| R2 new #2：A 的六分量 multiplicity | **CLOSED** | `research.md:221-231`、`plan.md:109-117` 已正确把 A 作为六分量并集，使用每个 CP `α/(G·6)`；B 的六分量合取仍正确使用 IUT、无需分量间 Bonferroni。A 与 N 两个 family 共同形成唯一 outcome 时的总体错误率是新问题，见 finding 5。 |
| R2 new #3：四态互斥/唯一权威/上游冲突 | **PARTIAL** | `plan.md:119-127`、`research.md:260-272` 已写唯一 `authoritative_outcome`、`A>N>U` 和 compatibility-only 字段，也正确承认需要 superseding decision。但决定尚未取得，且步骤/验收没有把它设为 W1 前硬门。见 finding 3。 |
| R2 new #4：range CI 无可审算法 | **PARTIAL** | `research.md:237-252` 的区间算术替换是正确方向，两个 range 公式本身有效；但“每窗双侧区间”的 threshold-grid/tail 分配、两个端点的 N union、以及 A1 失效时 range gate 的敏感性门都未定义。见 finding 2。 |
| R2 new #5：数据依赖 merge 不能产生 Hoeffding 独立单元 | **CLOSED** | `research.md:167-176`、`plan.md:147-150` 已删除数据依赖 merge，固定 300s 单元，并将 Hoeffding 降为描述量。事后删除 non-certifiable unit 是另一种 selection，见 finding 1。 |
| R2 new #6：模拟 multiplicity/α 预算 | **CLOSED** | `research.md:197-205` 已给出自洽的两层预算与 simultaneous per-grid rule；`M=20000` 的数值理由也成立。验收没有检查主程序/GOF 是新问题，见 finding 4。 |
| R2 new #7：ledger 无 start receipt | **PARTIAL** | start/terminal receipt 与机器审计条款已写入 `plan.md:190-200`，但其预检来源、并发分配与 crash/reconciliation 合同仍缺，不能声称 fail-closed 已闭合。见 finding 6。 |
| R2 new #8：Hoeffding 最小整数 off-by-one | **CLOSED** | `research.md:123-128` 已正确写实数阈值 599.146、最小整数 600。600 只属于 Hoeffding 半径，不是新主判据的普适最小曝光；见算术核验与 finding 7。 |

关闭统计：**8 CLOSED / 6 PARTIAL**。

## 新阈值-计数界：独立推导与验证

### 1. 两条不等式

令随机单元率 `P∈[0,1]`，`b=E[P]`，`π(c)=P(P>c)`，`c∈[0,1)`。则

```text
b = E[P·1{P≤c}] + E[P·1{P>c}]
  ≤ c·P(P≤c) + 1·P(P>c)
  = c + (1-c)π(c).

b ≥ E[P·1{P>c}]
  ≥ c·P(P>c)
  = cπ(c).
```

因此 `b_ub(c)=c+(1-c)π_ub(c)` 与 `b_lb(c)=cπ_lb(c)` 的方向正确。只有这两条 moment inequality 是无条件恒真；置信覆盖还需要下述 A1。

### 2. CP 的随机变量与方向

若 A1 成立，即 `P_1,…,P_J` iid，则 `I_j(c)=1{P_j>c}` iid Bernoulli(`π(c)`)，所以

```text
K(c)=Σ_j I_j(c) ~ Binomial(J,π(c)).
```

CP 确实作用在正确的参数 `π(c)=P(P_j>c)` 上。对单侧 tail error `a`：

```text
π_L(k;J,a) = 0                                      , k=0
             BetaQuantile(a; k, J-k+1)             , k>0

π_U(k;J,a) = BetaQuantile(1-a; k+1, J-k)           , k<J
             1                                      , k=J.
```

上界关于 `π` 单调递增，故 `b_ub` 必须用 `π_U`；下界也关于 `π` 单调递增，故 `b_lb` 必须用 `π_L`。v3 的方向正确。

### 3. threshold grid 的 Bonferroni

对 upper family，若每个阈值用 `a=α/G`，则

```text
P(∀c∈C: π(c)≤π_U(c)) ≥ 1-Σ_c α/G = 1-α.
```

在该 simultaneous event 上，`b≤b_ub(c)` 对所有 `c` 同时成立，所以 `b≤min_c b_ub(c)`。lower family 同理，得到 `b≥max_c b_lb(c)`。因此，对 `min upper` / `max lower` 做网格内 Bonferroni 是正确且保守的；阈值事件彼此嵌套并不使 Bonferroni 失效。

对 A 的六个 endpoint×window 分量再做 Bonferroni，使用每个 CP `α/(G·6)`，也正确控制“任一分量误报 A”的概率不超过 `α`。B 是六分量合取的 IUT，分量间无需再除以 6；但 grid 内仍须除以 G。

### 4. 边界与 exact ties

- `c=0`：`b≤π(0)`；lower contribution 恒为 0。全干净时 `K(0)=0`，CP upper 正常工作。
- `K=0`：`π_U=1-a^(1/J)`，`π_L=0`。
- `K=J`：`π_L=a^(1/J)`，`π_U=1`。
- `P_j=c`：v3 在 `research.md:137` 和 `plan.md:24-25` 钉的是严格 `>`。tie 进入 `P≤c` 一侧；上界推导和下界推导都仍成立。`P_j=0.02`、`0.10` 等确实可由 `k/150` 或 `k/100` 达到。
- 文本已经钉住 operator，但没有钉住实现必须用整数交叉乘法、也没有 exact-tie fixture；若从四位小数或浮点比较重建 `K`，会把预注册分类交给表示细节。见 finding 8。

### 5. `J` 变化与不可认证块

纯数学上，不同 window/endpoint 可以使用不同的、**事先固定或与 `P_j` 独立的** `J_{we}`；每个 CP 只要代入自己的 `J_{we}`，range interval 也不要求三窗样本量相同。

但 v3 的真实删块不是这个情形：`unreachable`、restart/identity change、`timer_late` 超限正与坏服务/坏宿主状态相关。把这些单元删掉后，保留下来的 `K|J_retained` 一般不再是目标总体的 Binomial 样本；CP 的“exact”覆盖随之失效。主计划一边写 `J=13` 固定，一边只对 B 明令“无不可认证块”，却仍允许 A/N 优先于 U，形成实质缺口，见 finding 1。

### 6. coherent / monotone

对任一 `c`，CP 有 `π_L(K)≤K/J≤π_U(K)`。令样本单元均值为 `p_bar`，则

```text
c·K/J ≤ p_bar ≤ c+(1-c)·K/J.
```

所以对每个阈值都有

```text
b_lb(c) ≤ p_bar ≤ b_ub(c),
```

进而 `max_c b_lb(c) ≤ p_bar ≤ min_c b_ub(c)`。因此同一完整数据集上 `b_lb` 不会超过 `b_ub`。当任何 `p_j` 增大时，各 `K(c)` 只会不减，CP limits 也随 K 不减，聚合后的 upper/lower 都是数据坐标逐点单调的。

### 7. 跨窗 range 区间算术

若三窗区间 `[L_w,U_w]` 在一个 simultaneous event 上同时覆盖各 `b_w`，令 `R=max_w b_w-min_w b_w`，则

```text
R ≤ max_w U_w - min_w L_w,
R ≥ max_w L_w - min_w U_w,
R ≥ 0.
```

所以 v3 的

```text
range_ub = max_w U_w - min_w L_w
range_lb = max(0, max_w L_w - min_w U_w)
```

都是有效界；跨窗口 Bonferroni 也不需要窗口独立。缺陷不在这两个公式，而在 v3 没有把生成每个 `[L_w,U_w]` 所需的 grid×tail error allocation、端点 union 和 A1 sensitivity 写成完整程序，见 finding 2。

## Headline 算术独立重算

| 项目 | 独立重算 | 结论 |
|---|---:|---|
| `J=13, K=0, c=0, α=0.05` | `1-0.05^(1/13)=0.2058166652` | **20.58% 正确**；这是未做 G=5 selection correction 的单阈值数。 |
| `J=13, K=0, c=0, α/G=0.01` | `1-0.01^(1/13)=0.2982961713` | **29.83% 正确**；这是 B 主程序在 c=0 的 grid-adjusted 数。 |
| `J=13, K=13, c=0.2, α=0.05` | `0.2×0.05^(1/13)=0.1588366670` | **15.9% 正确**。 |
| 同上，`α/(G·6)=0.05/30` | `0.2×(0.05/30)^(1/13)=0.1222717290` | **12.2% 正确**。 |
| Hoeffding，`J=13, α=0.05` | `sqrt(ln(20)/(2×13))=0.3394414118` | **33.94% 正确**。 |
| empirical Bernstein additive term | `7 ln(40)/(3×12)=0.7172821161` | **71.73% 正确**；只是 additive term，不是完整 interval。 |
| Hoeffding 半径压到 5% | `ln(20)/(2×0.05²)=599.1464547`，取 ceiling | **最小整数 600 正确**。 |

重要限定：600 是 **Hoeffding** 的最小单元数，不是 v3 新 judge 的普适最小数。若所有单元都为零，新 judge 在 B 的 `α/G=0.01` 下只需

```text
J ≥ ceil(ln(0.01)/ln(0.95)) = 90
```

才使 `1-0.01^(1/J)≤0.05`；实际所需曝光还取决于各阈值的未来 `K(c)` 与 equivalence power。

## NEW findings（v3 rewrite 引入或暴露）

| # | Severity | 具体缺陷 | 证据（file:line） | 必须修改 |
|---:|:---:|---|---|---|
| 1 | **HIGH** | **fixed-`J` exact judge 与 non-certifiable block 状态机冲突；A/N 可以在信息性删块后越过 U。** v3 声明单元先验固定、`J=13`，但只给 B 加“无不可认证块”；A/N 表没有完整性前置。另一处又说 service/host invalid 使 window/Phase 0 无法认证，而 `A>N>U` 会让用 survivors 算出的 A/N 压过 U。`unreachable`/restart/`timer_late` 不是随机缺失，删后 retained-J 条件下的 K 不再保证 Binomial。 | `engineering/doc/FLY-2007-capacity-stress-execution/plan.md:104-107,147-150,194-200`; `engineering/doc/FLY-2007-capacity-stress-execution/research.md:298,305-311` | 在 outcome precedence **之前**设唯一 `inference_eligible` fail-closed 门：任一 required unit/endpoint 非认证、ledger gap、未终结 attempt 或 service/host invalid ⇒ authoritative U（另保留 availability flag），A/B/N 数值只能 descriptive。只有独立证明的 operator/harness/storage 故障可按固定上限重跑并重新取得完整 13 单元；否则须给出 missingness-aware 保守方法，不得改用 retained `J` 宣称 exact。 |
| 2 | **HIGH** | **range 算式正确，但 equivalence/N 的置信程序仍没定义完整，会在危险方向误报 equivalent。** v3 说每窗取双侧 `1-α_eq/3` 区间，却没说明 threshold grid G=5 与上下两 tail 如何分配；也没定义两个 endpoint 中“任一 non-equivalent ⇒ N”时的 endpoint multiplicity。更严重的是 A1 sensitivity 只列 `b_ub`/`b_lb` 的 A/B 接受规则，没有覆盖使用不同双侧水平的 range/equivalence 程序。 | `engineering/doc/FLY-2007-capacity-stress-execution/research.md:153-154,216-219,233-252`; `engineering/doc/FLY-2007-capacity-stress-execution/plan.md:104-115,178-188` | 冻结每个 CP 的精确 tail error（grid×2 tails×3 windows；若 N 是两个 endpoint 的 union，再处理 endpoint family），明确 B 的两个 endpoint equivalence 是 IUT 而 N 的 endpoint union 不是。敏感性模拟必须跑**完整的 range 程序及其实际 α allocation**；未过则 equivalence 不得开 B、也不得报 N。 |
| 3 | **HIGH** | **上游 outcome table 的 superseding decision 被正确请求，却没有成为开跑硬门。** 上游仍权威地定义 A=`任一 b_ub>SLO`。v3 承认替换它必须由 Tadashi 明确批准，但当前流程只要求 §7 的 2/3/5 后就开 W1，§7 也只检查输出格式，不检查授权已经取得。没有决定时，作者无权把 compatibility 字段降为 non-authoritative。 | `engineering/doc/FLY-1986-load-stress-knee/plan.md:200-210`; `engineering/doc/FLY-2007-capacity-stress-execution/plan.md:64-71,119-127,202-215` | 把“Lead superseding decision 的精确文本/receipt 已写进 `spec-baseline.md`”加入 freeze 与 W1 前 acceptance gate。若决定未批或被拒，计划必须保留上游三态为唯一权威，不能执行 v3 precedence。当前 request 的 framing 是正确的，缺的是取得并门控 authority。 |
| 4 | **MEDIUM** | **模拟器被正确降为 sensitivity，但验收可以只因两个 controls 正常而通过，未要求主 judge、GOF 和 adversarial K 点本身通过；同时摘要把 A1-conditional exact 写成无条件“恒真/精确”。** controls 只能证明 simulator 没完全失灵，不能证明待用程序覆盖。有限的 semi-Markov grid 也不能把未知真实 DGP 变成 exact。 | `engineering/doc/FLY-2007-capacity-stress-execution/plan.md:9,21-28,135,148,180-188,206-217`; `engineering/doc/FLY-2007-capacity-stress-execution/research.md:189-219` | §7-5 必须逐项要求：GOF/parameter-set gate 通过；实际 upper、lower、range 程序在所有 frozen K 点的 simultaneous LCB 均达标；W1–W3 落在预注册适用域，否则 U；controls 另列。全文把“exact”改成“**在 A1 下 exact**”，只把两条 moment inequality 称为无条件恒真，并明确 simulator 只支持冻结 DGP family 内的 sensitivity claim。 |
| 5 | **MEDIUM** | **A 的内部 `÷(G·6)` 正确，但单一 authoritative adverse outcome 在 A 与 N 两个 5% family 间仍有 selection multiplicity。** 在“六个 b 都不坏且 range≤δ”的共同 null 下，误报 A 或误报 N 的并集最多可到 `α_A+α_eq`（若各 0.05，就是 0.10）。`A>N>U` precedence 不消除这个 union。B 同时要求 performance 与 equivalence 则仍是 IUT，不需要在两门间 Bonferroni。 | `engineering/doc/FLY-2007-capacity-stress-execution/plan.md:109-126`; `engineering/doc/FLY-2007-capacity-stress-execution/research.md:221-231,260-270` | 明确总体错误率合同：若要说唯一 authoritative outcome 具有整体 95% 保障，需令 `α_A+α_N≤0.05`（或 closed testing/simultaneous band）；若政策只要求每个 claim 各自 5%，必须在结论 schema 明示“无全局 95% outcome guarantee”，不得用一个 95% 标签笼统覆盖状态机。 |
| 6 | **MEDIUM** | **ledger 协议在 preflight 来源、并发和 crash 边界上不可执行。** wrapper 被禁止任何网络，却必须在调用 collector 前把实时 `buildSha`、identity、`bridge_started_at`、`pressure_hold` 等写进 start receipt；文档没给这些值的可信来源。单调 ID/JSONL 也没有 lock、两阶段 append、fsync/rename 或 ledger↔`attempt-*` 目录双向 reconciliation；并发 wrapper 或 start 后 crash 会留下无法判别的 orphan。 | `engineering/doc/FLY-2007-capacity-stress-execution/plan.md:44-49,89-96,131-135,190-200,206-212` | 设计 crash-safe 两阶段协议：任何 preflight 前先在锁内 reserve `attempt_id` 并 durable append START；随后用允许的只读 preflight（或 collector 的 machine-readable preflight）append PREFLIGHT；最后 append TERMINAL。定义唯一写者/OS lock、原子目录创建、两边 census、orphan/并发/crash-point tests。相应收窄“wrapper 无网络”为明确 GET allowlist，而不是不可同时满足的绝对禁令。 |
| 7 | **MEDIUM** | **“所需曝光量”没有算法或验收，且 600/“精确界一致更紧”会误导实现。** 600 仅是 Hoeffding 半径的答案；新主 judge 的 all-clean grid-adjusted best case 是 90。阈值界也不一致支配 Hoeffding：例如 J=13、11 块 `p=31/150`、1 块 `p=1/150`、1 块 0 时，`K=[12,11,11,11,11]`，阈值 upper=98.84%，而 Hoeffding upper=17.54%+33.94%=51.48%。主 judge 单独使用仍可有效，但“总更紧、无信息损失”的理由是假的。 | `engineering/doc/FLY-2007-capacity-stress-execution/plan.md:30-33,50,107,150-151,202-215`; `engineering/doc/FLY-2007-capacity-stress-execution/research.md:123-131,178-187`; `engineering/doc/FLY-2007-capacity-stress-execution/exploration.md:131` | 把 600 明标为 descriptive Hoeffding 数；为主判据预注册 exposure calculator（至少给 all-clean best case、基于冻结假设的 scenario range、equivalence 所需曝光，统一 ceiling），并加 acceptance/mutation tests。删除“精确界一致更紧/没有代价”的支配性 claim；选择它作为 sole judge 的理由应是 validity + simplicity，而非不存在的 dominance。 |
| 8 | **MEDIUM** | **三份 v3 文档仍给出相互冲突的可实现合同，且 exact-tie boundary 未进入验收。** `exploration` 仍把 δ/拆单写成待裁；`research` 的 run bundle 漏 receipt，尾部又写“主+兜底”和 bootstrap；测试数量分别写 6、7、10。虽然严格 `>` 已在公式钉住，四个手算点和十条 mutation 都没有 reachable tie (`p_j=c`) fixture。 | `engineering/doc/FLY-2007-capacity-stress-execution/exploration.md:103-107,133-148`; `engineering/doc/FLY-2007-capacity-stress-execution/research.md:281-299,368-378`; `engineering/doc/FLY-2007-capacity-stress-execution/plan.md:45,137-151,161-176,202-215,228-235` | 冻结前同步三份正文：决定状态、四件套 run bundle、sole judge、零 bootstrap、wrapper freeze、统一 mutation 数。实现从整数 violation count 与 n 以交叉乘法判断 `p_j>c`，并加入 `p_j=c`（至少 0、0.02、0.10）、`K=0`、`K=J`、`>`→`≥` mutation 与浮点/rounding 反例。 |

## Scope 与 authority 核验

- **δ=2.5pp**：`plan.md:106` 与 `research.md:254-256` 正确写成 Lead 明批的政策选择，并明确旧“不会跨 SLO”的推导已撤回；这部分主文本正确。`exploration.md:143-148` 仍写待裁，必须同步。
- **option 2 scope**：`plan.md:228-235` 正确写“一张 FLY-2007 管四阶段、不另立 issue、Phase 0=B 后 BLOCKED 而非 DONE、环境到位继续、§17-②③ 留本单”。这是正确的 authority 记录；`exploration.md` 的待裁表仍与之冲突。
- **superseding request**：请求本身 framing 正确——它清楚指出修改的是已合入上游 outcome authority，给出 compatibility 字段和冲突动作，并要求 Tadashi 的明确 superseding decision 写入 `spec-baseline.md`。但“已请求”不等于“已授权”；在该 decision 到账前，v3 outcome table 不能成为执行权威，且 W1 必须被硬门阻止。

## 结论

新 bound 的数学骨架可以保留：不等式正确，CP 参数/方向正确，grid Bonferroni 正确，range arithmetic 正确，全部 headline 算术也都按各自口径算对。当前不批准的原因不是要求复活 bootstrap，而是 v3 尚未把这个正确的条件性构造闭合成一个可执行、fail-closed、有完整 familywise contract、并获得上游授权的 judge。

VERDICT: CHANGES REQUESTED
