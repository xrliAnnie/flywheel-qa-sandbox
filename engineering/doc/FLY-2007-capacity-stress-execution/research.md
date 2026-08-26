# FLY-2007 容量压测执行 — 调研

Issue: FLY-2007 (https://linear.app/geoforge3d/issue/FLY-2007/容量压测执行-fly-1986-方案落地执行阶段-0-基线-1-标定-2-可转移性-3-生产标定产出-runner-放行阈值)
日期: 2026-08-23
基于: exploration.md

---

## A. 采集器逐行审计（`scripts/qa-fly-1986-load-probe.sh`，main `67da67b0c`）

### A.1 产出的两份 CSV 的真实字段

```
samples.csv : block_id,endpoint,tick,scheduled,start,end,outcome,secs
summary.csv : block_id,endpoint,n,met,missed,error,timer_late,
              violation_upper_conservative,violation_best_case,block_valid
```

- `scheduled/start/end` 是**共享单调时钟**读数（`CLOCK_KIND`，perl 优先），不是墙钟 —— 所以 tick 之间的间距可信，可以用来算游程与自相关。
- `outcome` 七态：`met` / `missed` / `error` / `timer_late` / `no_token` / `unreachable` / `invalid_auth`。
- `secs` 对 `missed` 被 `--max-time deadline` 截断（L1 约 0.5、L2 约 2.0），**所以哨兵数据里没有截止之后的延迟分布**（诊断模式已按 plan §16.1 砍掉）。分位数别去 samples.csv 里找，它按设计就没有。

### A.2 ★ `violation_upper_conservative` 不是置信上界（本单最重要的一条）

`:496`：

```awk
cons = (missed + err + late) / n
```

**点估计**。列名里的 `upper` 指的是「`timer_late` 按违约计入」这个**计数口径**（保守 vs `best_case` 排除口径），不是 upper confidence bound。

脚本自己的注释（`:461-465`）说得很准确 ——「conservative — timer_late counted as a violation. This is the certification **number**」—— 它没有声称自己是置信界。**是列名会让人读错**，而 plan §3 判 A/B/N 要的恰恰是置信界。

⇒ 缺口坐实：**采集器 → 判据之间没有分析层。本单要补的就是它。**

### A.3 每个区块的 tick 数是**恒定**的（重要，因为它决定退化时数据还在不在）

栅格是 `scheduled = base + tick * interval`，循环条件只看 `scheduled - base < duration`，**与请求耗时无关**：

- 迟到的 tick **照样写一行**（`outcome=timer_late`，`secs=NA`），不是跳过；
- 单 tick 的最坏成本 = `deadline` + 2 次时钟 fork（约 40 ms）：L1 ≤ 0.54 s < 2 s 栅格，L2 ≤ 2.04 s < 3 s 栅格 ⇒ **永远追得上栅格**。

⇒ 300 秒区块必得 **L1 150 行 / L2 100 行**，与退化程度无关。`n != expected` 只可能由采集器自身故障造成 ⇒ 那时 `block_valid=incomplete_expected`。

**这是好消息**：即使 Bridge 烂到 100% 违约，数据仍然是完整的、无偏的（按固定调度 tick 计），不会因为「太慢所以少采了」而把坏样本系统性丢掉。

### A.4 ⚠ 两个会让整块作废的脆弱点（分析层必须显式处理，不能装看不见）

`summarise_block` `:487-492`：只要块内出现 **任意一个** `no_token` / `unreachable` / `invalid_auth`，整块直接 `NA,NA,invalid_...`。

| 脆弱点 | 触发条件 | 风险 |
|---|---|---|
| **单个 `unreachable` 作废整个 5 分钟块** | 一次快速 000（连接被拒 / TLS / DNS），即 `secs < 0.8 × deadline` | 12 块的窗里蹦一次就少一块 |
| `invalid_auth` | token 过期 / 被换 | L2 整窗归零 |

⚠ `unreachable` 在**本单的场景里不是理论风险**：我们量的正是一个 accept 队列可能被打满的 Bridge。macOS 上 backlog 满通常是**丢 SYN**（⇒ 超时 ⇒ 落 `missed`，没事），但 `ECONNREFUSED` 也可能发生。

**不修采集器**（它过了 6 轮真 Codex，`unreachable` 与 `missed` 的区分本身是对的：不可达不该被洗成延迟结论）。**在 spec-baseline.md 里预注册窗口级怎么处置**，见 §C.4。

### A.5 并发追加同一个文件

`:851` 起，L1 与 L2 是两个**并发子壳**，各自 `>> samples.csv`。行长 < PIPE_BUF ⇒ O_APPEND 原子，FLY-1986 真跑实测「畸形行 0」。

⇒ 但这是**实测通过**，不是保证。分析层必须**逐行校验字段数并对畸形行 fail-loud**（不是静默丢弃 —— 静默丢弃会朝哪个方向偏，取决于是谁在写的时候被截断，不可知）。

### A.6 主体围栏（对本单的排期有硬约束）

每个区块**前**比对 `process_identity`，**后**再比对 identity + worker PID + `buildSha` + `health_is_serving`。
- 区块**前**不符 ⇒ `abort` **整个跑挂掉**（exit 2）；
- 区块**中**变了 ⇒ 该块 `COLLECTOR_FAILED` ⇒ `expected=-1` ⇒ `block_valid=incomplete_expected`。

⇒ **跨越班车重启的窗口会当场死掉或被作废。** 排期必须避开，见 §D。

---

## B. 现场事实（决定排期，不决定结局）

| 事实 | 测量 | 出处 |
|---|---|---|
| Bridge 在服务的 build | `buildSha = 57885f044d35b7d35391a249e7e0990971466093` | `/health`，2026-08-23 11:07 PT |
| 已部署 SHA **落后** origin/main | deployed `57885f044` ≠ `origin/main 67da67b0c` | `~/.flywheel/deployed-sha` |
| ⇒ **12:00 PT 班车会真的部署 + 重启** | updater plist `StartCalendarInterval` = 00:00 / 12:00 | `com.flywheel.updater.plist` |
| 上次重启 | `bridge_started_at = 2026-08-23T07:01:17Z` = 00:01 PT（上一班车） | `/health` liveness |
| 当时机器负载 | `load1 = 14.62`（1/5/15 = 14.62 / 12.19 / 11.60） | `uptime` |
| **正在发作** | `/api/sessions` 三发 200 / **26.10s、24.77s、18.49s**；`/health` 200 / **23.71s**；同 session 更早一发毫秒级 | 宽预算 `--max-time 60` 串行 curl |

⚠ **最后一行不判结局**（n=4、串行事务时间、非判据量 `b`），理由已在 exploration.md §4 逐条写明。它在这里只有一个用途：**说明分析层必须能处理 `b` 逼近 1 的情形**，而不只是「零违约时上界是多少」那一类算式。

---

## C. 分析层：方法选择（plan §17-① 移交出来的活）

> ⚠ **本节 v3。** v1 的 deff→Clopper–Pearson 被 Codex R1 打掉；v2 的 studentized 区块 bootstrap 被 **R2** 打掉（含**我写反了 bootstrap-t 的反演方向**这一条真错）。v3 **不再修那套机器，而是整个删掉它**，换一个**精确、无渐近、无数据依赖选择**的判据。
> 依据是 FLY-1986 §16.1 的既有裁定：真 Codex 连续五轮在并发机器上找到新缺陷，裁定是「**简单 = 净删除**」「砍掉源头比无穷尽地修」。我踩的是同一个坑，只是这次是统计机器。
> R1/R2 全文存 `codex-design-review-r1.md` / `-r2.md`。

### C.0 estimand（R1 F2 要求，v3 不变）

**估计目标** `b` = 产生该窗口观测序列的过程的**平稳每-tick 违约概率**，按**固定调度栅格**计（保守口径：`missed + error + timer_late`）。

- 不是「这 3900 秒里恰好发生的比例」（有限窗实现值，不需要推断）；
- 不是「未来任意窗口的风险」（要求跨窗平稳，而**跨窗平稳恰恰是 §C.9 要检验的**，不能预设）；
- ⇒ **每窗各估一个 `b_w`**；跨窗能不能共用一个 `b` 由等价检验回答。

### C.1 方向

覆盖率不足 ⇒ 上界偏低 ⇒ **把不安全判成安全**。这是 plan §17-① 点名的危险方向，也是 v1/v2 两次被打掉的原因。

### C.2 v1 与 v2 为什么都不成立（已复核）

| 版本 | 方法 | 致命处 |
|---|---|---|
| v1 | Kish deff → bootstrap 取 deff 上界 → 塞进 Clopper–Pearson | ① Kish 只匹配方差，换样本量换不回 binomial 模型；② 相邻 300 秒块不是已证独立的 cluster；③ `(x_eff,n_eff)` 取整后连近似精确性都没有 |
| v2 | studentized 平稳区块 bootstrap | ① **我把 bootstrap-t 的反演方向写反了** —— `t*=(b̂*−b̂)/se*` 时上界该用**下尾**分位数 `b̂−q_α·se`，我写成了 `b̂+q_{1−α}·se`；② IAT 估计量、`se`/`se*`、`b̂∈{0,1}` 的退化、跨块真实时间间隙 —— **全是空的**，而判 A 的下界就压在这套没写完的东西上 |

⇒ **deff 与朴素 CP 降为「只印不判」的描述量**（保留是因为 plan §2.2 用的就是 deff 的词汇，读者要能对上 2.54 / 1.69 两个数）。**bootstrap 整个删除。**

### C.3 ★ 先摆一条必须先说的算术：13 个块本来就认证不了 5%

把块当成完全独立的 `[0,1]` 观测，用有限样本的有界变量界：

| 方法 | J=13、零违约时的单侧 95% 上界 | 实算 |
|---|---|---|
| Hoeffding | **33.94%** | `sqrt(ln(1/0.05)/(2·13))` = 0.3394414 |
| 经验 Bernstein (Maurer–Pontil) 的加性项 | **71.73%** | `7·ln(2/0.05)/(3·12)` = 0.7172821 |

⇒ 零违约也认证不到 5%。Hoeffding 要把半径压到 5%，实数阈值是 **599.146**，**最小整数是 600 个独立单元**（v2 写「约 599」，是 off-by-one，R2 Finding 8 抓到，已改）。

**这不是方法差，是曝光量不够。** plan §4.4 的「3 窗 × 60 分」是在**独立性假设**下按 §5.3 那张表算的下限，而 plan §17-③ 已预警过它会不够。
⚠ **600 是 Hoeffding 的数，不是本单主判据的普适最小数（R3 Finding 7）。** 主判据（阈值-计数精确二项界）在**全干净**、B 方向 `α_B/G = 0.01` 下，只需要

```
J ≥ ceil( ln(0.01) / ln(0.95) ) = 90        # 实算：J=90 → 4.99%；J=89 → 5.04%
```

⇒ 90 个 300 秒单元 = 7.5 小时哨兵曝光。

⚠⚠ **但 `J ≥ 90` 只认证 B 的性能子门，不是完整的 B（R4 Finding 1）。** 完整的 B 还要过**等价门** `range_ub < δ`。全干净时 `range_ub = u = 1 − a^{1/J}`（`L_w = 0`），而等价门每个 CP 用的是 `α_B/(6G) = 0.001667`：

```
u < δ = 0.025  ⇒  J ≥ ceil( ln(0.001667) / ln(0.975) ) = 253      # J=253 → 2.4967%；J=252 → 2.5065%
```

⇒ **完整 B 的绑定约束是等价门，不是性能门**：

| 子门 | 每个 CP 的水平 | 全干净所需 `J` | 每窗曝光 |
|---|---|---|---|
| B 性能 | `α_B/G = 0.01` | **90** | 7.5 h |
| **B 等价** | `α_B/(6G) = 0.001667` | **253** | **21.1 h** |
| ⇒ **完整 B** | — | **253** | **21.1 h/窗，三窗合计 63.2 h** |

⚠ **这意味着上游 plan §4.4 给阶段 0 的「3 窗 × 60 分」，对完整 B 而言差了约 19 倍。** 这不是本单发明的困难 —— 上游 §17-③ 预告过「设计效应一旦大于容忍度，时长与场次数都要往上走」，只是它当时没有算这个数。

**δ 与曝光的关系**（供 founder / Lead 判断 2.5pp 这个政策值的**代价**，⚠ 这张表**不是**在建议改 δ —— δ 已由 Tadashi 批准，改它需要新的裁决）：

| δ | 等价门所需 J | 每窗曝光 | 三窗合计 |
|---|---|---|---|
| 0.010 | 637 | 53.1 h | 159.2 h |
| 0.020 | 317 | 26.4 h | 79.2 h |
| 0.025 | 253 | 21.1 h | 63.2 h |
| 0.050 | 125 | 10.4 h | 31.2 h |
| 0.100 | 61 | 7.5 h | 22.5 h |
| 0.150 | 40 | 7.5 h | 22.5 h |
| 0.200 | 29 | 7.5 h | 22.5 h |

（`δ ≥ 0.10` 之后等价门不再是绑定约束，性能门的 `J ≥ 90` 接管，所以曝光停在 7.5 h/窗。）

⇒ **本单的确定产出之一**：一个**预注册的 exposure calculator**（不是一句话），至少给出：
① 全干净时的 best case（上面那个 90）；② 基于冻结假设的 scenario 区间；③ **等价门所需的曝光**（§C.9 说明它本轮几乎必然 `inconclusive`，那个缺口也要给数）；④ 统一向上取整。它要有验收与突变检验，不能只是正文里的一个数。这正是上游 §17-③ 留的空。

### C.4 ★★ 唯一判据：阈值-计数精确二项界（v3 核心）

**思路**：不去近似 `b` 的抽样分布，而是用 `p_j ∈ [0,1]` 这个**恒真的有界性**，把 `b` 夹在两个**精确二项**量之间。

设单元级违约率 `p_1..p_J`（单元定义见 §C.5），门槛 `c ∈ [0,1)`，`K(c) = #{j : p_j > c}`，`π(c) = P(p_j > c)`。

```
上界： b = E[p] = E[p·1{p≤c}] + E[p·1{p>c}]
              ≤ c·P(p≤c) + 1·P(p>c)
              = c + (1−c)·π(c)
       ⇒ b_ub(c) = c + (1−c)·π_ub(c)

下界： b = E[p] ≥ E[p·1{p>c}] ≥ c·P(p>c) = c·π(c)
       ⇒ b_lb(c) = c · π_lb(c)
```

`π_ub` / `π_lb` = **Clopper–Pearson**（精确二项）作用在 `K(c) ~ Binomial(J, π(c))`。

**这两条不等式恒真**，不依赖正态近似、不依赖 bootstrap、不依赖方差估计、在 `b̂ = 0` 或 `1` 处**没有退化**。

**门槛网格**：预注册 `C = {0, 0.02, 0.05, 0.10, 0.20}`（G=5）。取 `b_ub = min_c b_ub(c)`、`b_lb = max_c b_lb(c)`。
⚠ **取 min/max 是在挑选，所以网格内必须做 Bonferroni**：每个 CP 用 `1 − α/G` 的水平。

**实算校验**（我逐个算过）：

| 情形 | 结果 |
|---|---|
| J=13 全干净，c=0，α=0.05 | `b_ub = 1−0.05^(1/13)` = **20.58%**（比 Hoeffding 的 33.94% **紧**） |
| J=13 全干净，c=0，α/G=0.01 | `b_ub` = **29.83%** ⇒ **B 不可达**，与 §C.3 一致 |
| J=13 且每块 `p_j > 0.2`，c=0.2，α=0.05 | `b_lb = 0.2 × 0.05^(1/13)` = 0.2 × 0.7942 = **15.9% > 5%** ⇒ **判 A** |
| 同上但 α/(G·6)=0.00167（A 的完整多重性，见 §C.8） | `b_lb` = 0.2 × 0.6114 = **12.2% > 5%** ⇒ **仍判 A** |

⇒ **该判得出的它判得出。**

⚠ **v3 曾写「精确界一致更紧、没有代价」—— 那是假的**（R3 Finding 7 给了反例）：J=13、11 块 `p=31/150`、1 块 `1/150`、1 块 `0` 时，`K = [12,11,11,11,11]`，阈值界给 **98.84%**，而 Hoeffding 给 **51.48%**。
⇒ **选它当唯一判据的理由是「有效性 + 简单」，不是「支配性」。** 支配性的说法已删除。

#### C.4.1 比较算子与整数算术（R3 Finding 8）

- 比较一律用**严格大于** `p_j > c`；
- ⚠ **`p_j = c` 是可达的**：块级比率是 `k/150`（L1）或 `k/100`（L2）这样的有理数，`c = 0.02` 时 `3/150` 恰好相等，`c = 0.10` 时 `15/150` 恰好相等；
- ⇒ **实现用整数交叉相乘判定**（`violations · den(c) > num(c) · n`），**绝不用浮点比较**；
- ⇒ **必须有 tie fixture**：`c ∈ {0, 0.02, 0.10}` 上各造一个 `p_j = c` 的样本，并有一条把 `>` 改成 `≥` 的突变检验。

#### C.4.2 门槛网格的预注册理由（Tadashi 要求「非事后的选择理由」）

`C = {0, 0.02, 0.05, 0.10, 0.20}`，在见到 W1–W3 之前冻结。理由，逐条：

| c | 为什么在网格里 |
|---|---|
| `0` | 「有没有任何违约」这个最自然的切分；全干净时它给出最紧的上界 |
| `0.02` | SLO 之下一档 |
| `0.05` | **就是 SLO 本身** —— 判据要在它上面有分辨力 |
| `0.10` | SLO 之上一档 |
| `0.20` | 之上第二档。⚠ **它在网格里是因为 pilot 数据显示 `b` 可能很大**（research §C.14 第 6 条已披露），不是看了 W1–W3 才加的 |

⇒ 大致等比的阶梯，把 SLO 夹在中间。`G = 5`。

### C.5 单元定义：**先验固定**，不做数据依赖合并（R2 Finding 5）

**v2 的洞**：v2 按「滞后-1 自相关 > 0.2 就合并单元」来选单元 —— 那是**用推断数据本身选 partition**，selection 的随机性没有计入界；而且观测到 `r₁ ≤ 0.2` 既不等于独立，也排除不了高阶/非线性依赖。

**v3**：

- **单元 = 300 秒哨兵块，先验固定，J = 每窗 13**。不合并、不按数据调整。
- `r₁` 仍然计算并报出，但**只作描述**，**不改变任何单元定义或判决**。
- **假设 A1（iid 单元）被显式命名**，并在结论页作为**限定条件**印出来 —— 不假装它成立。
- **A1 失效的代价由 §C.7 的模拟量化**，并按预注册规则决定该结论还能不能声称。

⚠ **`J` 是固定的 30，不是「幸存下来的那些」（R3 Finding 1）**：`unreachable` / 意外重启 / `timer_late` 超限**都不是随机缺失** —— 它们恰恰发生在机器最坏的时候。把它们删掉之后，剩下单元上的 `K` **不再是 Binomial(J, π)**，精确性就没了。
⇒ 处置**不是**换成幸存 `J` 重算，而是 §C.16 的 `inference_eligible` fail-closed 门。

### C.5b ★ `inference_eligible`：优先级之前的唯一 fail-closed 门（R3 Finding 1）

**v3 的洞**：v3 只给 **B** 加了「无不可认证块」，**A 与 N 没有完整性前置**；而优先级是 `A > N > U` ⇒ **拿幸存单元算出来的 A 或 N 会压过 U**。而幸存不是随机的（见 §C.5）。

**v4**：在**判任何结局之前**先过一道**唯一**的门。

```
inference_eligible = true  当且仅当，对每个端点、每个窗口：
   ① 该窗恰好有 J = 13 个单元，且每个单元 block_valid = true、
      无 no_token / invalid_auth / unreachable、timer_late 占比 ≤ 2%；
   ② run 级完整性合同全过（§C.12）；
   ③ ledger 无缺号、无重复目录、无未终结 attempt、无非法 replacement（§C.13）。
```

- `inference_eligible = false` ⇒ **`authoritative_outcome = U`，无条件**，并带 `availability_finding` 标记（⚠ **作废 ≠ 消失** —— 上游 §9-#15：它本身是一条可用性结论）；
- 此时 `b_ub` / `b_lb` / range **在可计算时仍印出，但一律标 `descriptive_only`**，**不得**用来声称 A / B / N；
  ⚠ **不可计算时印 `null` + 具名 reason，绝不印一个数**（R4 Finding 2：采集器遇 `invalid_*` 会把点估计写成 `NA`，`incomplete_expected` 也一样）。

⚠ **资格门必须是覆盖采集器所有终态的 total function（R4 Finding 2）** —— v4 只处理了「有 bundle 但块不合格」，漏了「根本没有 bundle」这一类：

| 采集器终态 | 有 bundle？ | 资格 | `reason` |
|---|---|---|---|
| preflight 失败（exit 1） | ❌ 无任何产物 | false | `no_bundle_preflight_failed` |
| 区块前 identity 变更 `abort`（exit 2） | ⚠ 可能有部分 | false | `aborted_subject_changed` |
| INT / TERM（130 / 143） | 部分 | false | `interrupted` |
| `incomplete_expected` | 有，点估计 `NA` | false | `incomplete_expected` |
| `invalid_notoken / unreachable / badauth` | 有，点估计 `NA` | false | `invalid_<kind>` |
| `block_valid = false`（`timer_late > 2%`） | 有，**点估计是数** | false | `timer_late_void` |
| 正常完成、13 块全合格 | 有 | **true** | — |
| ledger 缺号 / 目录孤儿 / attempt 未终结 | 任意 | false | `ledger_<kind>` |

⇒ **默认分支是 `false` + `reason=unclassified_terminal_state`**，不是「没匹配到就放行」。
- **只有**可独立证明的 operator 凭据故障或 harness / 存储故障可以重跑，去重新取得**完整的 13 个单元**（§C.13 的上限仍是 2 次）；
- ⚠ **绝不允许**改用幸存 `J` 重算并声称 exact。

### C.5c ★ 完整的错误率分配（R3 Finding 2 + Finding 5）

**v3 的洞**：v3 只给了 A 的 `α/(G·6)`，没写 range/equivalence 的 tail 分配与端点多重性；而且 **A 与 N 是两个各自 5% 的 family，并集最多到 10%**，`A > N > U` 的优先级消不掉这个并集。

**v4：两个 family，总预算钉死。**

| family | 总量 | 逻辑形状 | 分配到每个 Clopper–Pearson 的水平 |
|---|---|---|---|
| **达标（B 方向）** | `α_B = 0.05` | **交集（IUT）** —— 六个分量的性能门 **且** 等价门都要过 | ⚠ IUT ⇒ **分量之间、性能门与等价门之间都不需要 Bonferroni**（整体 ≤ α）。**只需网格内** ⇒ `α_B/G = 0.01`，单侧上界 |
| **不利（A 与 N）** | `α_adv = 0.05`，**拆成 `α_A = 0.025` + `α_N = 0.025`** | **并集** | 见下 |

**A**（任一分量 `b_lb > SLO`）：并集跨 **6 个分量** × **G 个门槛** ⇒ 每个 CP 用 `α_A/(6·G) = 0.025/30 = 0.000833`，单侧下界。

**N**（任一端点 `range_lb > δ`）：并集跨 **2 个端点** ⇒ 每端点 `α_N/2 = 0.0125`。
每个端点内要 3 个窗口的**同时**双侧区间 ⇒ Bonferroni 跨 **3 窗 × 2 尾** = 6 个 tail 事件，再跨 **G 个门槛** ⇒ 每个 CP 用 `α_N/(2·6·G) = 0.025/60 = 0.000417`。

**等价门（喂 B 的那一侧，`range_ub < δ`）**：属于**达标 family**，走 IUT ⇒ 自己用 `α_B`；其内部同样是 3 窗 × 2 尾 × G ⇒ 每个 CP 用 `α_B/(6·G) = 0.05/30 = 0.001667`。

⚠ **结论 schema 必须印出这张表**（`α_B` / `α_A` / `α_N` / 每个 CP 的实际水平 / `G`），否则读者无法判断某个 95% 标签管的是哪一层。
⚠ **`α_A + α_N = 0.05` ⇒ 「唯一权威的不利结局」整体有 95% 保障**；这是**主动选择**，不是把两个各 5% 的 claim 贴一个 95% 标签蒙混。

### C.6 只印不判的对照量

| 量 | 为什么留 |
|---|---|
| 朴素 Clopper–Pearson（按 tick） | 让读者看见相关性修正有多大 |
| Kish deff | 对上 plan §2.2 的 2.54 / 1.69 |
| Hoeffding 单元界 | 与 §C.4 的精确界交叉核对（**§C.3 已证它更松**） |
| 逐块 `p̂_j`、`r₁`、游程长度分布 | 描述形状 |

**它们不参与任何判决。** v2 曾要求「主判据与兜底判据都 ≤ SLO」，v3 删掉这条 —— 但 v3 给的理由（「精确界一致地更紧」）**是假的**，R3 Finding 7 给了反例（§C.4）。
**正确的理由**：判据只能有一个，多一个门就多一处要维护的合同、多一条会自相矛盾的路径；选阈值-计数精确界当**唯一**判据是因为它**有效**（在 A1 下 exact）且**简单**（可手算复核、无随机性、边界不退化），**不是因为它支配 Hoeffding**。

### C.7 模拟敏感性分析（R1 F3 + R2 F6；v3 范围大幅收窄）

**删掉 bootstrap 之后，模拟器只剩一件事**：量化 **A1 失效**对 §C.4 精确程序覆盖率的伤害。（v2 时它还要去验一个渐近方法，那层多重性随 bootstrap 一起消失。）

**冻结（与 spec 同一个 commit）**：模拟器代码、DGP 族（两态半马尔可夫）、依赖参数的置信集合、adversarial 网格（K 点）、真 `p` 网格、参数提取方法、拟合优度门、接受规则、种子。

**校准数据**：**只用已永久排除的 pilot 数据**（FLY-1986 evidence + 我开工的 4 发 curl）。W1–W3 数据只做事后 sensitivity，**不得改判决规则**。

**错误预算（v2 把 Bonferroni 写错了 —— R2 Finding 6）**：

- v2 写「每点单侧 95% 下界 ≥ 95%，按 K 点 Bonferroni」—— **自相矛盾**：Bonferroni 要求每点用 `1 − α_MC/K` 的置信度，不是仍用 95%；
- 而且依赖参数置信集自己也吃 `α_param`，两个各用 5% 的话联合失败概率最多约 10%，不是 5%。

**v3**：`α_param + α_MC ≤ 0.05`，预注册 `α_param = 0.025`、`α_MC = 0.025`。
每个网格点的覆盖率用**精确二项下界**、水平 `1 − α_MC/K`；**要求所有 K 点同时 ≥ 0.95**。

**M 由 K 与目标 slack 反推，不是先定一个数**：预注册 `K ≤ 20`、`M = 20000`，其依据是 —— 该配置下（`α_MC/K = 0.00125`）真覆盖率 ≥ 0.96 的点其精确下界能被推过 0.95；真覆盖率不足的点会 fail。`M` 与 `K` 一起印在输出里。

**两个对照（缺一不可，且用同一套 MC 判据）**：

| 对照 | 是什么 | 必须表现为 |
|---|---|---|
| 阳性 | **固定的、事先已知会让朴素 CP 覆盖不足**的 DGP | 朴素 CP **确实**覆盖不足 |
| oracle | 已知有效的方法在 iid DGP 上 | 覆盖率下界 ≥ 0.95 |

⚠ 任一对照异常 ⇒ 本次验证记 **inconclusive**，且**不得用同一批数据调完模拟器再宣布通过**。

**接受规则接到结局上（R3 Finding 4 补全 —— v3 漏了 range 程序，且验收可以只靠两个对照正常就过）**：

必须**同时**满足，缺一即 **U**：

1. **拟合优度门 / 参数集合门**通过（模拟器确实拟合上了 pilot 的依赖结构）；
2. **各 configuration 各自**在**所有 K 个 frozen 网格点**上的同时 LCB ≥ 0.95：`b_ub` 程序、`b_lb` 程序、**以及 range/equivalence 程序（按它自己实际用的 α 分配跑，不是借 b_ub 的）**；
3. **W1–W3 的实测依赖结构落在预注册的适用域内**（落在域外 ⇒ 模拟说的话管不到这批数据 ⇒ U）；
4. 两个对照正常 —— ⚠ **对照另列**：它们只能证明模拟器没有整个失灵，**不能**代替第 2 项。

⇒ 声称 **A** 要第 2 项里的 `b_lb` 过；声称 **B** 要 `b_ub` **与 range** 都过；声称 **N** 要 range 过。

⚠ **「exact」这个词必须带条件**：只有 §C.4 的两条矩不等式是**无条件恒真**的；整个判据是「**在 A1 下 exact**」。模拟器只支持**冻结 DGP 族内**的 sensitivity claim，它**不能**把未知的真实 DGP 变成 exact。全文已按此改写。

### C.8 多重性 —— 见 §C.5c

v3 的 §C.8 只覆盖了 A 与 B，漏了 range/equivalence 的 tail 分配与端点多重性，也没处理 A 与 N 两个 family 的并集（R3 Finding 2 + 5）。
⇒ **完整的错误率分配已统一到 §C.5c**，本节只留一条不变的结论：

⚠ **结论页不得把任何未校正的 marginal 95% 下界称为「已认证不达标」。**

### C.9 跨窗等价检验（R1 F5 + R2 F4；v3 换掉非光滑统计量）

**v2 的洞**：用 `max(b̂)−min(b̂)` 的 plug-in bootstrap —— 但 `max−min` 是**非光滑的排序泛函**，在 tie / near-tie 处普通 bootstrap 不能假定一致，**而 tie 恰恰是等价性最要紧的区域**；且「保持时间顺序的联合重采样」从未被定义成可验证的算法。

**v3：用区间算术，不用重采样。**

1. 对每个端点，给三个窗口各算一个**双侧**精确区间 `[L_w, U_w]`；**水平按 §C.5c 的分配**（喂 B 的 `range_ub` 用达标 family 的 α，判 N 的 `range_lb` 用不利 family 的 α —— ⚠ **两者水平不同，必须分别算两套区间**，v3 含糊地只写了一个「`1−α_eq/3`」）；
2. ⚠ **Bonferroni 对窗口之间的依赖是免疫的** —— 这正是选它的理由：同机同日的三窗**不需要**假设独立，也不需要任何联合模型。R2 F4 要的「联合算法」在这里被**取消需求**，而不是被补上；
3. 由并集界直接得到 range 的区间：
   ```
   range_ub = max_w U_w − min_w L_w
   range_lb = max(0, max_w L_w − min_w U_w)
   ```
4. **三态判定**（v1 把「TOST 没过」直接叫 N，那是**把低把握度当证据**）：

| 判定 | 条件 | 结局 |
|---|---|---|
| `equivalent` | `range_ub < δ` | 不阻止 B |
| `non-equivalent` | `range_lb > δ` | **N（已证非平稳）** |
| `inconclusive` | 其余 | **不放行，但不叫 N** |

5. **`δ = 2.5 个百分点` —— 已由 Tadashi 批准（2026-08-23，`ask 4b2088c1`），出处记为「Lead 在 FLY-1986 授权链下的仪器校准决策」。**
   **它是政策选择，不是推导结果**：「我们接受基线跨窗自发漂移 ≤ 2.5pp（= SLO 的一半）；超过即认为单窗阈值没有外部效度」。
   ⚠ v1 给它编的理由（「小于 SLO 一半的漂移不足以把认证翻转」）**是假的** —— 4.0% 与 6.0% 相差 2.0pp 却正好跨过 5% 的线。该理由已撤回，结论没有靠惯性活着，而是换了新支撑（Lead 的政策决定）。

⚠ **预先说明**：J=13 时每窗区间宽约 0.3，所以 `range_ub < 0.025` 几乎不可能 ⇒ **等价判定本轮几乎必然是 `inconclusive`**。这是**预先写下来的**，不是事后借口；它也是「所需曝光量」这个交付物要覆盖的第二个缺口。

### C.10 ★ 唯一权威结局 + 优先级（R2 Finding 3）

**v2 的洞**：v2 说「四态与上游三态**并列报出**」，等于**把冲突交给下游临场决定**；而且四态之间没有 precedence，同一批数据可以同时满足 A 与 N。

**v3**：

- 输出里**只有一个** `authoritative_outcome`；
- 上游字面判决作为 `upstream_literal_outcome` 字段印出，**显式标注 non-authoritative / compatibility only**；
- **优先级（预注册）**：`A > N > U`，`B` 与它们互斥（B 要求所有门都过）。
  - 理由：A 说「基线可证地坏」，N 说「跨窗可证地漂」。**基线坏的时候先修基线** —— 在一个坏基线上谈平稳性没有可执行的下一步。
  - 若 A 与 N 同时成立，`authoritative_outcome = A`，并在 `flags` 里带上 `also_non_equivalent`。
- **冲突处置写死**：若 `authoritative_outcome = U` 而 `upstream_literal_outcome = A`（这在本轮曝光下**是最可能出现的组合**），下一步**按 U 走**（加曝光重跑），并在结论页**点名**这个差异 —— 因为上游的 A 在这种情形下说的是「上界超了」，而上界超只代表**没证明好**，不代表**证明坏**。
- ⚠ **这是对上游判据表的一处修正，必须由 Tadashi 给出明确的 superseding decision 并记录在 `spec-baseline.md` 里**，不能靠「两份都报」蒙混。

### C.11 A/A 协议（R1 Finding 7；上游冻结点①的强制项）

A/A 工具已按 plan §16.1 移出采集器，但 plan §5.5 冻结点 ① 的合同**没有删除**「A/A 无害界与把握度必须在第一个阶段 0 窗口之前冻结」。

⇒ `spec-baseline.md` 必须写下 A/A 的**数值协议**（疏/密节奏、无害 margin、把握度、估计量、失败规则），**即使执行工具另案实现**。
⚠ 并写明：**本轮没跑 A/A ⇒ 观察者效应未排除**；已声明的自加负载是 plan §16.2 的**约一个核的 2.0%**（perl 时钟，每 tick 两次 fork）。这是限定，不是脚注。

### C.12 分析器输入 = 不可拆 run bundle（R1 F1；R2 补完整性合同）

输入 **四件套**：`samples.csv + summary.csv + meta.txt + receipt.json`，缺一即拒。

**为什么必须这样**：采集器的**块后**围栏（identity / worker PID / `buildSha` / `health_is_serving`）只通过 `summary.csv` 的 `expected=-1` 传递作废信号，而 `samples.csv` 的 150 行**仍然齐全** ⇒ 只读 samples 会**把已被作废的块重新认证**。

**run 级完整性合同（R2 Finding 1 补的）** —— v2 只写了「逐块交叉核对」，但**一个块同时从两份 CSV 里消失时，逐块核对会真空通过**：

| 检查 | 规则 |
|---|---|
| block ID 集 | 必须**恰为** `b1..b<meta.blocks>`，不多不少 |
| `(block, endpoint)` | 每对**恰有一条** summary 行 |
| tick 集 | 必须是 `0..expected−1` 的**完整整数集**，无重复无缺失 |
| 计数与点估计 | 与 `summary.csv` **逐字相符**（不符 ⇒ fail-loud：两者看到的不是同一次跑） |
| `meta.txt` 语义一致 | `build_sha` / `bridge_worker_pid` / `bridge_identity` 必须与 attempt ledger 的开跑回执**一致**；不一致 ⇒ **拒绝**（v2 只说「记进输出」，那不是规则） |
| 畸形行 | 字段数不符 / `outcome` 不在七态内 ⇒ **fail-loud，不静默丢弃** |

任何 `block_valid != true` / `incomplete_expected` / `invalid_*` ⇒ 该块**不可认证**，且**禁止该窗产出 B**。
输出里写 run bundle 哈希 + **冻结 commit hash**。

### C.13 attempt ledger 要机器可审（R1 F4；R2 Finding 7 补 receipt）

**v2 的洞**：ledger 是人工 Markdown、验收是人工核对 ⇒ 它能**记录**幸存者偏差，**发现不了**一次被省略的失败 attempt。而且采集器在 preflight 之前只建目录、preflight/dry-run **不写 `meta.txt`** ⇒ 存在「启动过但没有任何回执」的 attempt。

**v3**：

1. **两阶段、crash-safe 协议（R3 Finding 6）** —— v3 说「wrapper 无网络」却又要它在开跑前写下实时 `buildSha`，**两件事不可兼得**；且没有锁、没有 fsync/rename、没有双向对账 ⇒ 并发或 START 之后崩溃会留下无法判别的孤儿。
   ⇒ **v4**：
   - ⚠ **收窄禁令 —— 但 v4 收窄错了（R4 Finding 3）**：v4 只给 `GET /health`，可是 **`/health` 里没有 `pressure_hold`**（采集器用 `sqlite3 -readonly` 查 `fleet_pressure_hold`），worker identity 来自 `lsof` + `ps`，`load1` 来自 `uptime`，班车时刻来自 plist ⇒ **v4 要求 wrapper 记录的字段，它自己被禁止去读**。
     **v5：逐字段钉死 authority 的只读 allowlist**（每一项都用采集器**同一条**读法，保证两边看到同一个东西）：

     | PREFLIGHT 字段 | 权威来源 | 读法 |
     |---|---|---|
     | `buildSha` / `bridge_started_at` / `ok` / `shuttingDown` | Bridge | `GET /health`（**唯一允许的网络调用**） |
     | `pressure_hold` | StateStore | `sqlite3 -readonly <与采集器同一条 canonical path>`（**字面文件名，不拼 `file:` URI** —— 上游 R6#1 的教训） |
     | worker identity（PID + start-time） | 进程表 | `lsof` + `ps`，**与采集器同一套解析** |
     | `load1` | 宿主 | `uptime` |
     | 当期班车时刻 | launchd | `plutil -p <updater plist>`（**现读，不用缓存的认识**） |

     ⇒ 除上表之外：**任何网络、任何写方法、任何非上表的 DB 打开一律禁止**。
     ⇒ **验收必须逐字段用「缺失 / unknown / 与采集器不一致」三种突变变红**，不能只 grep URL allowlist（R4 Finding 3 的原话）。
   - ⚠ **单一分配权威（R4 Finding 4）**：v4 让 `START` append 与目录创建成为**两个持久对象**，一次 rename 提交不了两者 ⇒ 先 START 后 mkdir 留下 ledger-only 孤儿，先 mkdir 后 START 留下 directory-only 孤儿，双向 census 只能**发现**它，没有**收敛**规则 ⇒ 一次崩溃可以永久毒化 eligibility。
     **v5**：**目录本身就是分配权威** —— 原子 `mkdir attempt-NNN`（已存在即失败）就是 reservation；**durable 状态写在目录内**（`state.json`，写临时文件 + `fsync` + 原子 rename）；**顶层 JSONL 只是可重建的 index**，丢了可以从目录重建，**不构成第二个真相**。
   - **恢复规则（确定性，不是「报红了事」）**：任何**没有 TERMINAL 状态**且**其锁未被持有**的 attempt 目录，一律被确定性地终结为 `aborted` + `reason=crash_before_terminal`，**并计入 ledger**（⚠ 它**不会消失** —— 上游 §9-#15）。⇒ census 永远收敛。
   - **阶段 1（preflight 之前）**：单写者 OS 锁内原子建目录 + 写 `state=START`（冻结 commit hash、时间）；
   - **阶段 2（preflight 之后、调采集器之前）**：append 一条 `PREFLIGHT`（`GET /health` 读到的 `buildSha` / `bridge_started_at`、worker identity、`load1`、`pressure_hold`）；
   - **阶段 3**：append `TERMINAL`（exit code、状态、原因、产物哈希）；
   - **双向 census**：ledger 里的每个 `attempt_id` 必须有对应目录，每个 `attempt-*` 目录必须有对应 ledger 记录；任一方向不匹配 ⇒ fail-closed；
   - **测试必须覆盖**：并发 wrapper、START 之后崩溃、PREFLIGHT 之后崩溃、目录已存在、ledger 缺号。
2. 每个 attempt 用**不可复用**的目录 `evidence/attempt-<NNN>/`（不是 `w1/w2/w3`），窗口编号是 ledger 里的一个**属性**，不是目录名；
3. attempt 结束写终结回执：exit code、状态、原因、产物哈希；
4. **分析器与结论生成必须读 ledger，并 fail-closed 拒绝**：`attempt_id` 有缺号、目录重复、attempt 未终结、服务/宿主失败被当成 replacement、超过 retry 上限；
5. **替换策略**（R1 F4）：服务/宿主相关的作废（`unreachable`、意外重启 / identity 变更、`timer_late` 超限）**不得**被替换成 B 的证据 —— 它们使该窗乃至阶段 0 **无法认证**，并**本身作为可用性结论保留**（上游 §9-#15：作废 ≠ 消失）。**只有**可独立证明的 operator 凭据故障或 harness / 存储故障可重跑，原 attempt 留档，重跑上限 **2 次**。

### C.14 预注册的诚实边界（R1 Finding 6）

⚠ **这不是「未受污染的盲预注册」，是 pilot-informed prospective confirmation。**

**已看过的 prior artifact**：

| 出处 | 我看到的 |
|---|---|
| `FLY-1986-load-stress-knee/plan.md`（全文） | 方法、判据数值、§16 三次真跑表（`b` = 0.644 / 0.289 / 1.000，load 9.9–15.4） |
| `FLY-1986-load-stress-knee/evidence/*` | 原始 CSV 与汇总 |
| 我开工时的 4 发宽预算 curl | `/api/sessions` 26.1 / 24.8 / 18.5 s，`/health` 23.7 s，load1 14.62 |

**它们实际影响了哪些设计选择**（逐条，不含糊）：

1. 知道存在约 190 秒的相关结构 ⇒ 才会去处理序列相关；
2. 采用 deff 的词汇（源自 plan §2.2）；
3. 预期朴素 CP 会覆盖不足 ⇒ 才把它设成阳性对照；
4. 知道 `b` 可能到 1.000 ⇒ 才要求判据在 `b̂∈{0,1}` 处不退化（**这一条直接淘汰了 v2 的 bootstrap**）；
5. 知道 `b` 可能很大 ⇒ 才意识到需要**下界**来判 A；
6. 知道 `b` 可能很大 ⇒ §C.4 的门槛网格才向上取到 0.20。

**处置**：永久排除在 W1–W3 的主推断之外（不进 `b_ub`/`b_lb`、不进等价检验、不进 Q0 结论），只用于**模拟器校准**与上述设计启发。
**这段历史不使新样本的推断无效，但使「盲预注册」的说法不诚实**，所以不说它。

**冻结范围**：`spec-baseline.md` + 分析器 + 模拟器 + wrapper（开跑回执）+ 测试 + 种子 + 输出 schema **在同一个 commit 里**。该 commit hash 写进每一份分析输出与每一份开跑回执。W1 之后若必须修 bug，须留变更账、证明未改动任何已冻结的统计规则，并由独立复核决定是否需要重新取数。

### C.15 零写入怎么证（R1 Finding 9）

⚠ 「跑前跑后 `/health` 三字段相等」**不是零写入证明**：65 分钟里真实 Flywheel 工作**本来就可能**合法改变 `sessions_count`；相等也排除不了「写了又改回来」。而 plan §3 明确要求阶段 0 **不启用准入静默、不挡真实工作** ⇒ 那三个字段**本来就该会变**。

⇒ 三字段快照**降为环境上下文**；零写入用**机制**证：采集器沿用它已有的 GET allowlist + `sqlite3 -readonly` + 写调用突变测试；**分析器 / 模拟器**证明**不打开任何网络连接、不打开任何数据库**；**wrapper** 证明它只做 §C.13 那张表里逐字段列出的只读调用（`GET /health` 是唯一网络调用），表外的任何请求 / 任何写方法 / 任何其它 DB 打开都必须让测试**变红**；三者都只写显式声明的输出路径。

---
## D. 排期约束（R1 Finding 10 把 v1 的绝对时刻删掉了）

| 约束 | 来源 | 结果 |
|---|---|---|
| 窗口不得跨 00:00 / 12:00 | plan §6.1-4 + updater plist `StartCalendarInterval` | 班车时刻前后是禁区 |
| 班车**会**重启（本次） | deployed `57885f044` 落后 `origin/main` | 跨班车的跑会 `abort`（§A.6） |
| ≥3 窗 × ≥60 分，不同时段 | plan §3 | — |
| **≥1 窗在舰队重启后 >4 小时** | plan §3 | ⚠ 从**真实 restart 时间戳**算，不从预测的 12:00 算 |

⚠ **v1 写死了 12:30 / 16:30 / 19:30 三个时刻，那是错的**（R1 Finding 10）：写下它们的时候（11:15 PT），距 12:30 只剩 75 分钟，而在那之前还必须做完 R1 返工、再评审、写并 commit 预注册、实现分析器+模拟器+测试、跑 dry-run。**硬赶会直接破坏冻结点** —— 而冻结点是这整件事唯一的诚实性凭据。

**规则（不含任何绝对时刻）**：

1. 第一个窗 = **以下三件全部落地之后的最早合格时段**：(a) 方法与代码的**冻结 commit**；(b) plan §7 的验收项通过；(c) ⚠ **Tadashi 对四态结局的 superseding decision 已写进 `spec-baseline.md`**（§C.10，R3 Finding 3 的开跑硬门）；
2. 每窗 preflight **实测并记录**：在服务的 `buildSha`、worker identity、**权威的 Bridge restart 时间戳**（`/health` 的 `bridge_started_at`）、当期 launchd schedule；
3. 「>4h」从第 2 步实测的 restart 时间戳算；
4. 班车延迟、SHA 与预期不符、或稳定期不足 ⇒ **整体顺延**，不为保住某个时刻牺牲预注册。

---

## E. 结论：本单要造的东西

| 组件 | 吃什么 | 吐什么 |
|---|---|---|
| **wrapper**（`qa-fly-2007-phase0-run-window.sh`） | 窗口序号 | 两阶段 crash-safe 的 **attempt ledger** 记录 + 不可复用的 attempt 目录（§C.13） |
| **分析器**（`qa-fly-2007-phase0-analyze.mjs`） | **run bundle 四件套**：`samples.csv` + `summary.csv` + `meta.txt` + `receipt.json`，缺一即拒（§C.12） | `inference_eligible` 判定（§C.5b）→ 唯一 `authoritative_outcome`（§C.10）；`b_ub` / `b_lb`（§C.4）、三态等价判定（§C.9）、**错误率分配表**（§C.5c）、**exposure calculator**（§C.3）；只印不判的对照量（§C.6） |
| **模拟器**（`qa-fly-2007-phase0-simulate.mjs`） | 已永久排除的 pilot 数据（校准） | 各 configuration（见 plan §5.5 的表）在 K 个 frozen 网格点的同时 LCB + 拟合优度门 + 适用域 + 两个对照（§C.7） |

- **不动采集器**；
- **零依赖**：Node ESM + 纯 bash。精确二项用**对数空间 CDF + 对 p 二分**；判据里**没有随机性**（bootstrap 已删），只有模拟器用固定种子 PRNG；
- 自检用 `FLY-1986/plan.md §5.3` 那张**已被独立复核过的**表当阳性对照，外加 §C.4 的四个手算点与 §C.4.1 的 tie fixture；
- **`spec-baseline.md` + 分析器 + 模拟器 + wrapper + 测试 + 种子 + 输出 schema + 门槛网格 `C` + 全部 α 分配 + superseding decision 回执，在同一个 commit 里冻结**，再取第一个样本（§C.14）。
