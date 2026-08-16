# FLY-1782 · ① 那 112 条的「有解析器 / 没有 / 待查」三态

**更新于**: 2026-08-15 · **任务来源**: HL —— 「这条优先级最高,它决定执行单能不能分批」
**为什么要这一列**: `qa_auto` 证明了 **registry 的 default 列不是权威** ——
有复合策略函数的 flag,真缺省在解析器里。**固化方向搞错 = 悄悄改行为。**

---

## 0. 结果

| 三态 | 数 | 能不能进批量 |
|---|---|---|
| **无解析器** | **78** | ✅ 可批量 —— 就地布尔判读,值即结果 |
| **无解析器(数值 sanitizer)** | **3** | ✅ 可批量 —— 只解析+回落默认,无多输入策略 |
| 🔴 **有解析器** | **9** | ❌ **逐条核 registry default vs 解析器真缺省之后才准进单** |
| **待查** | **22** | ⏸ 需人工看一眼再定 |

⇒ **可直接分批的 = 81 条;需先做一步核对的 = 9 条;需人工过目的 = 22 条。**

---

## 1. 🔴 有解析器的 9 条(动手前必须逐条核)

### 1.1 共享 gate 函数族(4)—— env 名只是常量,真值由 `resolveDefaultOnGate` 之类算出

- `codex_hard_gate_killswitch`
- `merge_approval_gate_killswitch`
- `qa_done_gate_killswitch`
- `founder_attribution_gate`

### 1.2 逐项目配置族(5)—— 必经 loader/policy

- `qa_auto`
- `skill_framework_split_participation`
- `proofshot`
- `xiaohongshu_learning`
- `founder_ux_gate`

> ✅ **分类器的阳性对照**:`qa_auto` —— **唯一已知有这个 bug 的 flag** —— 是分类器**自己**归进这一堆的,
> 不是我手工塞进去的。**尺子能抓到已知的那条,才敢用它去找未知的。**

---

## 2. 待查的 22 条

`mailbox_queue`, `liveness_activity_window_ms`, `converge_cmux_symlink`, `auto_qa_killswitch`, `issue_gate_supersede_mode`, `ship_ci_guard`, `deferred_approval_ttl_ms`, `founder_reply_deadletter_age_ms`, `workflow_rework_reentry`, `issue_display_sweep_ticks`, `ship_gate_grace_ms`, `external_merge_reconcile`, `merge_reconcile_window_days`, `ship_gate_card_grace_ms`, `reports_ttl_days`, `ghost_guard_wait_ms`, `comm_bypass_bridge`, `runner_autocontinue`, `done_thread_reconcile_interval_min`, `done_thread_reconcile_max_per_run`, `delivery_secret_path`, `instruction_path_check`

**为什么留成待查而不是硬判**:它们的读法是混合形态(例如 `args.env ?? process.env` 的可注入 env、
先取原始值再解析的两步式、或在同一文件里既有布尔判读又有别的用法)。
**机器判不准的,我不给一个像样但没依据的答案** —— 这 22 条按 HL 的硬门就该人工过目后再进单。

---

## 3. 方法与限度(诚实写清)

**判据**(只看该 flag 自己的读点,已按词边界匹配,避免前缀撞名):
- 就地布尔判读(`env.X !== "0"` / `=== "1"` / shell 的 `${{VAR:-1}}` / `load_cmux_bool_flag X 1`)⇒ **无解析器**
- 只有数值解析 + 回落默认 ⇒ **无解析器(数值 sanitizer)**
- env 名只作常量声明、真值在别处算 ⇒ **有解析器**
- 逐项目配置 ⇒ **有解析器**(必经 loader)
- 其余 ⇒ **待查**

⚠️ **我自己在这个分类器上犯过一次、并修掉了**:最初用 `includes(token)` 匹配,
导致 `FLYWHEEL_SHIP_GATE_CARD` 命中了 `FLYWHEEL_SHIP_GATE_CARD_GRACE_MS` 这另一个 flag ——
**又是「共用一个前缀 ≠ 同一个东西」**。改成词边界匹配后,待查从 33 降到 22。
**记这一笔是因为:量具本身也会犯本轮那个招牌错误。**

⚠️ **限度**:这一列只覆盖 **① 的 112 条**;② 的 10 条和 ? 的 2 条**没做**(它们本来就要逐条走,不进批量)。


---

## 4. 投影到「95 条执行候选」上(HL 要的那份)

| 三态 | 数 | 进不进批量 |
|---|---|---|
| 无解析器 | **72** | ✅ |
| 无解析器(数值 sanitizer) | **3** | ✅ |
| 🔴 **有解析器** | **1** | ❌ `qa_auto` —— 不进批量 |
| ⏸ 待查 | **19** | 人工过目后再定 |

⇒ **94 条可进入分批评估,1 条明确挡下,19 条先过目。**

**为什么 112 条里有 9 条「有解析器」,投到 95 条只剩 1 条**:另外 8 条本来就不在执行候选里 ——
`founder_ux_gate` / `proofshot` / `xiaohongshu_learning` / `skill_framework_split_participation` 在「留」或「问她」;
四条共享 gate 函数族(`codex_hard_gate_killswitch` 等)在 **break-glass 单独组**等她。
⇒ **带解析器的本来就大多不该进批量 —— 这个分布本身是一次交叉验证,不是自说自话。**

### 待查 19 条

`mailbox_queue` · `converge_cmux_symlink` · `auto_qa_killswitch` · `workflow_rework_reentry` · `external_merge_reconcile` · `instruction_path_check` · `liveness_activity_window_ms` · `deferred_approval_ttl_ms` · `founder_reply_deadletter_age_ms` · `issue_display_sweep_ticks` · `ship_gate_grace_ms` · `merge_reconcile_window_days` · `ship_gate_card_grace_ms` · `reports_ttl_days` · `ghost_guard_wait_ms` · `runner_autocontinue` · `done_thread_reconcile_interval_min` · `done_thread_reconcile_max_per_run` · `delivery_secret_path`

---

## 5. Tadashi 的新发现:比「default 写错」更严重

**`qa_auto` 那一行错的不只是 `default`,`polarity: "opt_in"` 也是错的。**
根因:FLY-752 把代码翻成 default-ON 时,**注册表那一行没跟着翻**。

⇒ **这不是「删 flag 时才咬人」,是当下的活风险**:任何东西按 `registry.default` 行事
(dashboard 开关 / 脚本 / 人),**auto-QA 会被静默关掉**。

⇒ 他的处置比口径更硬:做成 **CI 断言** —— 凡 `readSites` 指向解析器的行,
`polarity` / `default` 必须与解析器实际行为一致,不一致就红。**已折进 FLY-1455,不新开单。**
