# FLY-2007 容量压测执行 — Design Review R2

VERDICT: CHANGES REQUESTED

## 审阅快照与边界

- 这是 design review，不是 code review；未修改任何仓库文件。
- 请求指定 `HEAD 8ff033fde`。实际干净工作树的 HEAD 是 `8f9d286dff2ca07e7d4766febcd9d3c050742876`；后一个提交只改了 `progress.md`。本轮三个目标文档在两者之间逐字相同，因此以下结论同时绑定 v2 提交 `8ff033fde` 与当前 HEAD 的相同文档 blob。
- 上游合同按 `engineering/doc/FLY-1986-load-stress-knee/plan.md` 与 `scripts/qa-fly-1986-load-probe.sh` 当前内容核对，不接受 v2 §9 的自报处置状态代替正文证据。

## R1 finding 逐项关闭账本

| R1 # | 状态 | 核对过的正文证据与判断 |
|---:|:---:|---|
| 1 | **PARTIAL** | `plan.md:108-112`、`research.md:252-264` 已把输入改成三件套，核对 endpoint/tick/计数/点估计，传播 `block_valid`，并输出 bundle/analyzer hash，主体作废信号不会再只留在 `summary.csv` 而被忽略。但正文没有钉死 run 级 block ID 集必须恰为 `b1..b<meta.blocks>`、每个 `(block, endpoint)` 恰有一条 summary；一个 block 若同时从两份 CSV 消失，列出的“逐块”交叉核对可真空通过。`meta.txt` 的 identity/PID/SHA 也只是“记进输出”，没有写成语义一致性拒绝规则。原 finding 要求的整包完整性尚未全闭合。 |
| 2 | **PARTIAL** | `research.md:96-118` 已钉 estimand 并撤销 deff→CP；`research.md:157-182` / `plan.md:114-122` 换成 stationary bootstrap + Hoeffding。方向被正确改写，但主 bootstrap 的 block selector、studentization、边界及上下界公式仍未形成可执行的有效置信程序，Hoeffding 单元也不满足其声称的有限样本前提；见新 finding 1、5。 |
| 3 | **PARTIAL** | `research.md:184-205`、`plan.md:144-153` 已诚实降级为 sensitivity，冻结 simulator/DGP/grid/seed，限制 calibration 数据，加入固定 under-coverage control、oracle 与 Monte Carlo 下界。可是“每点单侧 95% 下界 + 按网格 Bonferroni”并不是一个已定义的 simultaneous rule，参数置信集与 Monte Carlo 两层错误预算也未分配；见新 finding 6。 |
| 4 | **PARTIAL** | `plan.md:75` 删除“第 13 块抵 invalid”，`plan.md:155-161` / `research.md:266-275` 写了 replacement policy、服务/宿主失败禁止替换、非服务失败最多重跑 2 次。可是 ledger 仍是人工 Markdown，验收也是人工（`plan.md:173`），没有不可遗漏的 attempt-start receipt、连续 attempt ID 或 analyzer 对 ledger 的 fail-closed 消费；它能记录幸存者偏差，却不能发现一次被省略的失败 attempt。见新 finding 7。 |
| 5 | **PARTIAL** | 旧 margin 理由已撤回；`research.md:216-232` 改为单一 `max(b̂)-min(b̂)`、三态 verdict 与 policy rationale。用户本轮给出的 Lead 决定使 2.5pp 这一政策选择本身成立。但 v2 仍写“挂起/待拍板”（`research.md:232`；`exploration.md:132-137`），且“保持时间顺序的联合重采样”没有定义成可验证的 range interval；见新 finding 4。 |
| 6 | **CLOSED** | `research.md:277-299` 明确称为 pilot-informed prospective confirmation，列出 prior artifacts 与五项设计影响，永久排除旧 observation；`plan.md:48-60`、`research.md:299` 把 spec、analyzer、simulator、tests、seed、schema 冻结在 W1 前同一 commit，并规定 post-W1 bugfix ledger/独立复核。 |
| 7 | **CLOSED** | `research.md:245-250` 把 A/A cadence、margin、power、estimand、fail rule 明列为 `spec-baseline.md` 强制数值协议，并披露本轮没跑 A/A；`research.md:234-243` / `plan.md:96` 写出 B 合取门的 IUT 论证。该 IUT 论证正确；共享数据再进入等价门不要求独立。 |
| 8 | **PARTIAL** | `plan.md:189-193` 正确写了 option 2 的核心：issue 保留四阶段、Phase 0=B 后 BLOCKED 而非 DONE、环境到位继续 1/2/3。但 `plan.md:194` 仍把“是否另立 issue 承接 1/2/3 与 §17-②③”留作待裁决，和本轮 Lead 已裁“§17-②③ 留在本 issue、不开新 issue”冲突。正文尚未完整记录最终 scope。 |
| 9 | **CLOSED** | `research.md:301-308`、`plan.md:104`、`plan.md:172` 已把 `/health` 前后值降为环境上下文；零写入改由无 network/DB open、仅声明路径写入及可变红突变测试证明。 |
| 10 | **CLOSED** | `plan.md:62-75`、`research.md:309-325` 删除绝对时刻，以 freeze+验收后的最早合格窗口调度；`>4h` 从实测 `bridge_started_at` 计算，并规定 schedule/SHA/稳定期不满足时整体顺延。 |

## 指定专项核查结论

| 项目 | 结论 |
|---|---|
| C.3 算术 | `sqrt(ln(20)/(2*13)) = 0.339441...`，33.9% 正确；`7*ln(40)/(3*12) = 0.717282...`，71.7% 正确。因此 13 个独立 `[0,1]` 单元即便全零也不能用这两个界认证 5%，headline 方向成立。Hoeffding 的实数阈值是 599.146...，最小整数是 **600**，不是“约 599”；见新 finding 8。 |
| C.4 四态 | 把“证据不足”从“已证明坏”中分出 U 是统计语义上的改进；把 A 定成 one-sided lower bound > SLO 也是合理的“已证坏”方向。但当前 A 未控制六项 search multiplicity，四态也未解决与上游字面 A 的权威冲突及 A/N 重叠；见新 finding 2、3。 |
| C.6 两个 bounds | 若主界是有效的 95% 上界，则要求主界和兜底界都 `≤SLO` 等价于取两者最大值，只会缩小 B 的拒绝域；不需要两界独立，也不会把主界的 false-B rate 放大。这个组合逻辑本身成立。问题是当前两种组成方法并未各自按声称的方式有效，尤其 Hoeffding “兜底界”没有独立单元；见新 finding 1、5。 |
| C.10 IUT | 对 B 的六个 endpoint×window 分量，零假设为“至少一个不达标”，只有六个分量都拒绝才放行，整体 type-I error `≤α`；相关性不破坏这个包含关系。同一数据还进入 equivalence gate，而最终 B 要两门都过，也只会再缩小拒绝域。C.10 成立，但它不替 A 的“任一项越线”提供 multiplicity 保护。 |
| δ=2.5pp | 本轮 Lead 给出的“接受最多 2.5pp 自发跨窗漂移；再大则单窗阈值无外部效度”是诚实的 policy rationale，不冒充数据推导。`max-min` + equivalent/non-equivalent/inconclusive 的判决拓扑 coherent；v2 需把批准状态写实，并把 inference algorithm 补完整。 |
| C.13 ledger | replacement policy 的决策方向正确，但现有人工 ledger 只能声明“不得挑幸存窗”，不能证明没有漏记一次失败；尚未关闭 survivor-bias audit hole。 |
| §8.1 scope | option 2 的 phase-gated continuation 与 B→BLOCKED 已写对；“是否另拆 issue”仍待裁的句子写错，必须按本轮 Lead 最终决定改成“不拆，§17-②③ 留在 FLY-2007”。 |

## NEW findings

| # | Severity | 具体缺陷 | 证据（file:line） | 必须修改 |
|---:|:---:|---|---|---|
| 1 | **HIGH** | **studentized stationary bootstrap 不是一份已定义、可实现的置信程序，并且写出的 bootstrap-t 反演方向错误。** “观测 IAT”没有 estimator、ACF truncation/window、负相关/非有限估计、endpoint/window 粒度；从同一推断数据选择 ℓ 本身并非必然无效，但 selector 的随机性必须属于被分析的完整算法，在每个模拟 replicate 重新选择，不能把选出的 ℓ 当固定。`se` 与每次的 `se*` 如何算完全没定义；若需 nested bootstrap 也未写。按文中 `t*=(b̂*−b̂)/se*`，上界应使用**下尾**分位数 `b̂−q_α se`，不是未经对称性证明的 `b̂+q_{1−α}se`；下界才用 `b̂−q_{1−α}se`。`b̂=0/1` 时 IAT/ACF 与 `se*` 退化，许多 replicate 会除零，而决定 A 的 `b_lb` 没有边界 fallback。`plan.md:217` 所指的 `research C.4/C.8` 实际没有补这个 fallback。把各 collector block 的 tick 直接排序还会把 block 间可变的 post-block health 间隙当成一个普通 tick 间隔。 | `research.md:157-172`; `plan.md:114-122,217`; collector 的 block 后 health/fence 位于 `scripts/qa-fly-1986-load-probe.sh:863-883` | 在 W1 前写死完整算法：允许的 stationary/mixing DGP、IAT/自动 block-length estimator 及整数规则、如何处理 block 边界与真实时间间隙、`se/se*` 估计、正确的一侧 bootstrap-t 反演、invalid replicate 规则。为 `b̂=0/1` 和近边界预注册能同时给 `b_ub/b_lb` 的 boundary-valid 方法；sensitivity 必须对每个 Monte Carlo 数据集重跑**整个** selector+interval，而非条件在一次选出的 ℓ 上。 |
| 2 | **HIGH** | **新 A 是六次 5% 检验的 union，却没有 simultaneous error control。** A 取“任一 endpoint/window 的 one-sided 95% lower bound > SLO”；在“六项都不高于 SLO”的 global null 下，任一项偶然越线的概率可远超 5%。C.10 的 IUT 只保护“六项全过才 B”的交集，方向相反，不能保护 A。 | `research.md:146-151,234-243`; `plan.md:89-98` | 为 A 冻结一个 global level-0.05 test：例如六项 simultaneous lower confidence band、Bonferroni/Holm 分配，或对 `max_i b_i` 的有效联合检验；明确方法间和 endpoint/window 间的 family。结论页不得把未校正的任一 marginal 95% 下界称为“已认证不达标”。 |
| 3 | **HIGH** | **四态不是互斥状态机，也没有唯一权威。** 同一数据可同时满足 A（某窗 `b_lb>SLO`）和 N（range `b_lb>δ`），表里没 precedence/多标签规则。更直接地，当前 13-unit fallback 使上游字面 `b_ub>SLO` 几乎必定报 A，而新表可能报 U；上游 A 要开诊断/返场，新 U 要加曝光，`plan.md` 只说“两份都报”，等于把冲突交给 downstream 临场决定。上游合同仍逐字定义 A=`任一 b_ub>SLO`。 | `plan.md:85-98,174`; `research.md:135-155`; upstream `engineering/doc/FLY-1986-load-stress-knee/plan.md:200-223` | 在 W1 前取得并记录明确的 superseding decision；输出只设一个 `authoritative_outcome`，上游 literal 值只能标成 non-authoritative compatibility field，并规定冲突时动作。让状态互斥（写 precedence）或明确采用多标签 `A+N`，且分别定义下一步。仅“并列报告”不够。 |
| 4 | **HIGH** | **跨窗 range test 只有口号，没有覆盖率可审的联合算法。** 三个不同时段窗口并非同步 panel；“保持时间顺序的联合重采样”没有说明如何跨窗口间隔、不同 endpoint grids 与共同宿主状态构造 joint replicate，也没说明 range 上下界的反演。`max-min` 在相等/近相等窗口处是 non-smooth ranked functional，普通 plug-in bootstrap 在 tie/near-tie 处不能直接假定一致；而 tie 正是 equivalence 最重要的区域。一个偏低的 upper bound 会误报 `equivalent` 并打开 B。 | `research.md:216-232`; `plan.md:91-97,118-122` | 保留已批准 δ 与三态，但冻结一个明确的联合模型/重采样算法、cross-window covariance 假设、gap 处理与 range CI 构造；用 least-favourable `range=δ`、exact ties、near-ties、跨窗共同冲击做 size/coverage 与 power 验证。若不能证明普通 range bootstrap，改用 simultaneous window-mean contrasts/置信集或适用于 directionally differentiable range 的方法。并把文档中的 δ“待裁”改成已批准及其 provenance。 |
| 5 | **MEDIUM** | **C.8 的数据依赖 merge 不能把 Hoeffding 变成“有限样本界”。** Hoeffding 需要独立 bounded units；观测到 lag-1 autocorrelation `≤0.2` 既不等于独立，也不排除 higher-lag/nonlinear dependence。先看同一推断数据的 `r1` 再选择 partition，还引入未计入 bound 的 selection randomness；“预注册选择规则”不等于 unit 预先固定。奇数 unit 如何合并也未定义。因此 33.9% 是“假设 13 个独立块”下的正确算术，不是当前数据上已成立的 fallback coverage。 | `research.md:120-133,174-182,207-214`; `plan.md:118-122` | 二选一：预先固定由外部/pilot 依据确定、并有独立/混合假设支撑的 units，或改用对所声明 dependence class 有效的 concentration/subsampling 方法并计入 selector。否则把 Hoeffding 明确降为 policy veto/描述性 sensitivity，不得称 finite-sample bound；合并奇数与停止规则也须写死。 |
| 6 | **MEDIUM** | **M=20000 没有解决 grid multiplicity；当前 acceptance 不是 simultaneous coverage statement。** “每点单侧 95% LCB ≥95%，按 K 点 Bonferroni”自相矛盾：Bonferroni 要求每点置信度 `1−α_MC/K`（或等价 simultaneous band），不是仍用 95%。依赖参数置信集本身还消耗 `α_param`；若它和 MC band 各用 5%，联合失败概率最多约 10%，不是 5%。oracle/control 也只写经验 coverage `≥95%`，没有相同的 Monte Carlo lower-bound rule。固定 `M=20000` 是否足够取决于 K、familywise α 与方法真实 coverage 距 95% 的 slack，不能由 M 单独保证。 | `research.md:184-205`; `plan.md:144-153,171` | 先冻结 K 与总错误预算，写成 simultaneous pass rule：例如 `α_param+α_MC≤0.05`，每点用 `1−α_MC/K` 的 exact lower bound（或一个 simultaneous binomial band），所有点同时 `LCB≥0.95`；controls 使用同样明确的 MC 判据。由 K、目标 power/slack 反推 M，而不是先固定 20000。 |
| 7 | **MEDIUM** | **新 attempt ledger 没有可审计的 start receipt，失败 attempt 仍可被省略。** 交付路径只有 `w1..w3`，命令也只写 `wN`；重跑没有唯一目录/序号合同。collector 在 preflight 前只创建目录，preflight/dry-run 不写 `meta.txt`，而 partial run 后又拒绝覆盖旧三件套，所以既存在“启动过但没有 receipt”的 attempt，也没有规定 retry 应落到哪里。最终检查只是“人工确认 ledger 有每一个窗口”，无法发现 ledger gap。 | `plan.md:34-38,77-83,155-173`; `scripts/qa-fly-1986-load-probe.sh:804-816` | 在调用 collector 前原子写入单调 `attempt_id` 的 start receipt（freeze hash、时间、目标 SHA、输出目录）；每次 attempt 用不可复用目录并保留 exit/status/reason/raw hash。analyzer/结论生成必须读取 ledger，拒绝 ID gap、重复目录、未终结 attempt、服务失败 replacement 或超 retry cap；不能只靠人工 Markdown。 |
| 8 | **LOW** | **Hoeffding 最小单元数 off by one。** `ln(1/0.05)/(2·0.05²)=599.146...`；要满足半径 `≤5%` 的整数 J 必须 `ceil(...) = 600`。写“约 599 个”会让后续精确 exposure calculator 少一个单元，尽管不推翻“13 不够”的 headline。 | `research.md:124-133`; `plan.md:17-20` | 改成“实数阈值 599.146，最小整数 600”，并让 exposure 输出统一做 ceiling。 |

## 结论

v2 诚实关闭了 preregistration disclosure、A/A/IUT、零写入与调度四类问题，也正确复算出当前 13 blocks 绝不可能经 Hoeffding gate 认证 5%。但中心交付 `b_ub/b_lb` 仍没有一份边界可用、公式正确、selection-aware 的完整算法；新 A 漏了 multiplicity，range equivalence、dual outcome authority、simulation multiplicity 与 attempt audit 也未闭合。W1 不得在这些 HIGH 项修正并重新通过 design review 前启动。
