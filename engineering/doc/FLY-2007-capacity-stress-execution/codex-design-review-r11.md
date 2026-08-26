# FLY-2007 Capacity Stress Execution — Design Review R11 (exact-head freeze confirmation)

VERDICT: CHANGES REQUESTED

## 审阅快照与边界

- 提示所称 HEAD `ed2faa635` 已不是当前 HEAD。实际 branch 为 `flywheel-FLY-2007`，当前 clean HEAD 是 `d024d021c0d56df2d1f88f7e66245d09dd5201dc`；`ed2faa635..d024d021c` 只改了 `engineering/doc/FLY-2007-capacity-stress-execution/progress.md`。
- 用户列出的四份 docs、三份 code 与 test 在 `ed2faa635` 和实际 HEAD 的 blob hash 全部相同。因此本轮对 R10 delta 的技术结论同时适用于这些文件在两 commit 的相同 bytes；但不能把 `ed2faa635` 表述为当前 exact HEAD。
- 本轮只复核 R10 blocker、新增两 gate、A/N/U eligibility 与相邻的 failure-retention 链；没有重开 Lead 已裁定的四态模型、A/N/U 合同强度、N 权威性、`delta=2.5pp`、B 文档层曝光或 `J=30`。
- 未修改、暂存、提交或推送任何仓库文件；写入仅限本报告 `/tmp/fly2007-design-review-r11.md`。

## R10 blocking finding：NOT CLOSED

R10 原始 blocker 是：frozen-M CLI 可在缺少 operative pre-registration 要求的 model-fit / parameter-set 与 W1–W3 applicability evidence 时发布 authoritative A（以及共享 eligibility 的 N）。

**二元确认：NOT CLOSED。** 新函数确实在进程内执行、已接入 `eligibility()`，显式 false 或缺少 gate object 会强制 U；但当前 gate 不是其声称消费的证据，而且 exact-head 自带的 frozen-M fixture 仍真实发布 A，同时没有有效的拟合证据或 lag-1 applicability 证据。

## BLOCKING finding

### 1. HIGH — 两个 gate 有名字和 wiring，但 frozen-M A 仍在拟合证据不存在、applicability 统计缺失时获准发布

这是本轮允许的唯一 blocking class 内的直接反例。

#### A. 所谓 parameter-set gate 没有实现 operative pre-registration 的 parameter-set / goodness-of-fit contract

- `spec-baseline.md:230-237` 仍把本程序定义为“在拟合出来的模拟器上”的 sensitivity，并冻结依赖参数置信集、参数提取、拟合优度门及 `alpha_param=0.025`；`plan.md:254-271` 明定拟合优度/参数集合门、各 configuration、W1–W3 applicability、controls 必须同时满足，缺一即 U；`plan.md:304` 仍把四项全过列为开跑验收。
- `simulate.mjs:316-338` 的 `gridStatistics()` 只取模拟得到的**单个 block rate**的样本 min/max，以及 lag-1 ACF 的样本 min/max。`parameterSetGate()`（`:350-360`）只问三个 pilot rate 是否位于这个 rate min/max 内；没有依赖参数提取、参数置信集、拟合优度统计量、拒绝阈值或任何对 `alpha_param` 的消费。
- Fresh exact-head 执行得到 frozen grid 的 `grid_rate_range=[0,1]`，所以 pilot 的 `0.6444 / 0.2889 / 1.0000` 全部通过。对二元 violation rate，这个范围覆盖所有可能观测值；它不能区分拟合好坏。代码搜索也确认 `ALPHA_PARAM` 只在常量声明和输出中出现，没有进入任何 gate 计算。
- 把输出诚实标成 `WEAK` 是正确披露，但披露不能单方面修改仍在 force 的 operative contract。既然 pilot per-tick series 不存在，真实 GOF 当前不可实现；在 Lead 明确裁掉/替换这项要求前，正确的 fail-closed 结果只能是 U，不能是 A/N。

#### B. applicability gate 的 mean 维度比较了不同统计量，当前实际为真空门

- CLI 在 `analyze.mjs:1021-1033` 计算每个 window×endpoint 的 30 个 block rates 的**均值**；但 simulator 在 `simulate.mjs:323-326` 收集的是每个模拟 block 的**原始 rate**，随后用这些 raw rates 的全局 min/max 作为域。
- 因此 observed window mean 与 simulated individual-block support 被拿来比较。Fresh frozen grid 的 raw-rate 域是 `[0,1]`，任何合法 window mean 都在其中；mean 维度无法让真实数据出域。这不是“宽但有效”的拟合域，而是量纲/统计量不一致的全通范围。

#### C. lag-1 applicability evidence 缺失时被当作通过；仓库自己的 authoritative-A fixture 正好走这条路径

- `lag1()`（`simulate.mjs:341-347`）在 30 个 block rates 恒定时返回 `NaN`。
- `applicabilityGate()`（`:365-373`）只有在 `Number.isFinite(o.acf)` 为 true 时才检查 ACF 是否在域内；非有限 ACF 没有产生 problem，所以 gate 返回 `pass=true`。JSON audit record 又把该 `NaN` 序列化成 `null`。
- test fixture `qa-fly-2007-phase0-analyze.test.sh:173-198` 为每个 window×endpoint 写 30 个恒为 `1.0000` 的 block rates；它的 ACF 必为 `NaN`。同一 test 在 `:237-243` 用 frozen M 明确要求这批数据发布 `authoritative_outcome=A`。
- Fresh suite 实际通过了该断言：`PASS with the block valid and the frozen M, the same data reaches A`。也就是说，当前 release seam 不是假设：authoritative A 在 applicability record 的每个 lag-1 值都不可计算时真实发布。
- test 文件在 R10 后 byte-unchanged，且全文件没有 `parameterSetGate`、`applicabilityGate` 或 `gridStatistics` 的断言/突变；78/78 因而没有覆盖两个新 gate 的非真空性。

**结论**：两 gate “都被调用且能在显式 false 时 veto”只证明 wiring，不证明 pre-registration evidence 存在。当前 frozen-M CLI 仍有一条已执行的 authoritative-A release path，缺少真实 parameter-set/GOF evidence，且缺少可计算的 W1–W3 lag-1 applicability evidence。R10 finding 未关闭。

**Minimum closure：**

1. parameter/fit：实现 spec/plan 已冻结的 parameter extraction、confidence set 与 GOF gate；若仓库确实缺少完成它所需的 pilot series，则必须在第一个 START 前取得明确 Lead 裁决，逐项从 operative pre-registration/acceptance contract 删除或替换这些要求。`WEAK` 标签本身不是裁决。
2. applicability：以同一统计量构造域（对每个模拟 window 计算 window mean 与 lag-1 ACF，再与每个 observed window×endpoint 比较）；要求预期的 3×2 条观测齐全且两个统计量都 finite，`NaN`/`null`/缺失一律强制 U。
3. 加一条 frozen-M 反例测试：当前恒定高 rate fixture 必须因 ACF 不可计算而得到 U；并为两个 gate 各加可变红的 mutation/negative fixture，不能只断言函数名或 `pass` 字段存在。

## failure-retention 复核

- **没有发现新的“attempt failure 从记录中消失”路径。** canonical `state.json` discovery、两向 census、service/host failure 不可替换、replaceable failure 必须有 `replacement_of` 等 R10 已关闭路径在本 delta 中 byte-unchanged。
- Fresh suite 再次证明：service/host failure 强制 U 且具名、不能被 later good window 替换；缺少 replacement edge 的 replaceable failure 以 `silent re-run` 强制 U；START orphan 被终结为 `crash_before_terminal` 并留在 ledger。
- 新 sensitivity catch 现在打印 error + stack 并 exit 1，不再伪装成一个可继续发布的“gate was not evaluated”结果。它不会产生 A/N；未将它升级为 blocking。

## NON-BLOCKING recorded items

1. **R10 carried — dormant `--bundle` parser / vacuous test wording**：`analyze.mjs:977` 仍接受并存储 `--bundle`，而 test `:214` 只 grep `--help`。该值不进入 discovery 或 authority，故 non-blocking；测试文字仍与真实 parser 行为不符。
2. **R9 carried — J=13 live residue / vacuous regex**：research `:236` 仍写 `J = 每窗 13`，但紧邻 `:241` 又写 J=30；现有窄 regex 仍抓不到该形状。执行常量是 30，故不是 false-A/N seam。
3. **R9 carried — N authority doc residue**：exploration 仍有 `{A,U}` / N descriptive residue，与 spec 和执行代码的 N-authoritative 裁决冲突；spec/code 是 authority，故 non-blocking。
4. **R9 carried — ownerless global-lock liveness**：wrapper 在 `mkdir .wrapper.lock` 成功、写 pid 前崩溃仍会留下无法证明 stale 的 lock。它 fail-closed，不制造 A/N，也不删除 attempt failure。
5. **R9 carried — rebuildable index durability**：`rebuild_index()` rename 后没有 `write_state()` 对等的 durability fence。index 可从 canonical state 重建，故不使 failure 消失。
6. **R9 carried — seed-stability ordering comment**：simulator 注释仍称该 control “runs FIRST”，实现仍先跑 configurations。controls 最终 veto，只是资源/叙述债。
7. **R9 carried — replacement liveness**：wrapper 仍没有合法写入 `replacement_of` 的 producer；replaceable failure 后会保持 U。它是 fail-closed liveness 债，不是 false-A/N。
8. **R10 advisory 8 — CLOSED**：`expectedProvenance()` / `sensitivityProblems()` 已删除；仅保留解释为何 artifact contract 被删除的注释。
9. **New — prompt SHA 已被 progress-only commit 超过**：实际 HEAD 是 `d024d021c`，不是 `ed2faa635`。目标 artifacts byte-identical，所以这不扩大本轮技术 blocker；任何后续 exact-head freeze/回执必须准确写清所选 freeze commit，不能声称 `ed2faa635` 是当前 HEAD。

## Fresh verification ledger

- `git branch --show-current` → `flywheel-FLY-2007`；`git rev-parse HEAD` → `d024d021c0d56df2d1f88f7e66245d09dd5201dc`；最终 `git status --porcelain=v1` 为空。
- `git diff ed2faa635..HEAD` → 仅 `progress.md`；用户列出的 docs/code/test blob 在两 commits 全部相同。
- `bash scripts/__tests__/qa-fly-2007-phase0-analyze.test.sh` → **78 passed, 0 failed**, exit 0；fresh wall time **54.72s**。
- suite 自身 fresh 确认 CI 真正运行该 suite，且 `ci-structure.test.sh` exact ordered inventory 含 `Test — FLY-2007 phase-0 analyser contract`；人工同时核对 `.github/workflows/ci.yml:863-864` 与 inventory `:398`。
- `node --check` analyser/simulator；`bash -n` wrapper/test → 全部 exit 0。
- Fresh in-process `gridStatistics()` → `{rate_min:0, rate_max:1, acf_min:-0.581863..., acf_max:0.930612...}`；`parameterSetGate()` → `pass=true`。
- Fresh direct gate probes：30 个恒 0.5 或恒 1.0 的 rates 均产生 `acf=NaN`（JSON 为 `null`），`applicabilityGate()` 均返回 `pass=true`；交替 0/1 的 finite `acf=-0.9667` 才被正确判出域。

## Freeze judgment

**不得冻结 `ed2faa635` 或当前 `d024d021c0d56df2d1f88f7e66245d09dd5201dc` 作为可开跑设计，也不得开始 Window 1。**

R10 的 caller-supplied artifact seam 仍保持关闭，failure-retention 链没有重新打开；拒绝严格只基于一个仍可执行的 authoritative-A 发布路径：当前 frozen-M fixture 在不存在 operative contract 要求的 parameter-set/GOF evidence、且六个 observed lag-1 applicability statistics 全部不可计算时仍输出 A。按现行 pre-registration，这些缺失必须强制 U。

VERDICT: CHANGES REQUESTED
