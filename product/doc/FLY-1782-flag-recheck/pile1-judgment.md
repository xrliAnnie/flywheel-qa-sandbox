# FLY-1782 · ① 那一堆的逐条判断(哪些真该留)

**日期**: 2026-08-15
**任务来源**: HL —— 「判 ① 那 115 条里哪些真该留,目标 < 20」
**判据**: Annie 给的两条口子 —— **真正还在测的** / **真正需要保留多种选择的**
**状态**: 等 HL 对齐;**没有做页面**(HL:先给判断结果)

---

## 0. 先对一处账:你的 ②=9 和我的 ②=11,差的那 2 条是真差异

我核了差额来源,**不是谁算错,是筛选口径不同**:

| | 条数 | 口径 |
|---|---|---|
| 你的 ② | 9 | **.env 里显式设过** 且 ≠ 默认值 |
| 我的 ② | 11 | **任何来源**的当前生效值 ≠ 默认值 |

差的 2 条是 `qa_auto` 和 `doc_flow` —— 它们**不在 .env 里**,是**逐项目 config**:

| 开关 | 默认 | 实际 | 按 .env 口径筛 |
|---|---|---|---|
| `qa_auto` | false | flywheel = **true**,其余五个 false | ❌ 漏掉 |
| `doc_flow` | false | joycon-typeless / flywheel / tidal-echo = **true** | ❌ 漏掉 |

⚠️ **这两条漏掉是有后果的**:它们正是「删了会悄悄改行为」的那一类 ——
按默认删掉 `qa_auto` ⇒ **Flywheel 自己的 PR 不再自动起 QA**;
按默认删掉 `doc_flow` ⇒ 那三个项目的 runner **不再写过程文档**。
**而这恰好是 Tadashi 那条硬门要防的东西。** 建议把口径统一成「任何来源」,别只筛 .env。

另:我那 2 条「机器判不了」(`lead_core_mention_gated` 由 launcher 现算、`ponytail` 项目层 dormant)
你并进了 ①。它们删不删没有机器答案,建议单独留着问,不要混进批量。

---

## 1. ① 的判断结果(111 条)

| 分类 | 条数 | 处置 |
|---|---|---|
| **建议留**(严格按她两条口子) | **11** | 见 §2 |
| **break-glass 候选**(第三个口子,**她没给,我不替她加**) | **6** | 见 §3 —— 要你和她定 |
| **建议删 + 固化成现值** | **94** | 见 §4 |

**加上 ② 里该留的 4 条**(`skill_framework_mode` · `founder_consent_decision_mode` · `qa_auto` · `doc_flow`):

- **只按她给的两条口子** ⇒ 最终留 **15**
- **若 break-glass 也算** ⇒ 最终留 **21**

⇒ 两种口径都落在她 <20 的附近,说明判据是校准得上的。**差别就是 §3 那一个问题。**

---

## 2. 建议留的 11 条(在 ① 里)

### 2.1 真正还在测的

| 开关 | 依据 |
|---|---|
| `skill_framework_split_participation` | 四臂实验的逐项目退出杠杆(和 ② 里的 `skill_framework_mode` 成对) |
| `workflow_turn_divergence_alerts` | 注册表原文:默认关 = 影子模式,「**先观察影子记录再决定开不开**」。8-11 才加,观察期没满 |

### 2.2 真正需要多种选择的

| 开关 | 依据 |
|---|---|
| `founder_ux_gate` | 逐项目枚举(off / audit_only / enforce),六个项目可以各不相同 |
| `issue_gate_supersede_mode` | 枚举(enforce / observe / 0),**observe 是排障档** —— 出问题时要能只看不动 |

### 2.3 她本轮亲口要留的

| 开关 | 她的原话 |
|---|---|
| `publish_broker` | 留着,以后要 enable |
| `xiaohongshu_learning` | 留着,值得专门排期 |
| `proofshot` | 「这个 enable,我们来开始用吧」(⚠️ 见 §5) |

### 2.4 QA 缝 / 应急 override(删了就没有退路)

| 开关 | 依据 |
|---|---|
| `comm_bypass_bridge` | 应急绕过 founder-consent 直写 ship 门 |
| `lead_lease_bypass` | 应急绕过 Lead 身份租约 |
| `founder_attribution_gate` | =0 是 QA 房专用 |
| `voice_qa_presence_override` | QA-only seam,生产永不置位 |

---

## 3. 🔴 一个她没给的第三个口子 —— 我不替她加,摆给你们定

那 54 个急停开关,**严格按她的两条口子,一个都留不下**:它们既不是「还在测」,也不是「需要多选」。
按她的口径就该全部固化成开、把开关删掉。

**但其中有一小类不一样,我认为值得单独问她一句:**

> **守着「ship 这条路」本身的那几个急停开关 —— 删掉之后,如果它守的那道门自己坏了,就没有退路了。**

| 开关 | 它守的门坏掉时,这个开关是唯一的出路 |
|---|---|
| `codex_hard_gate_killswitch` | Codex 评审挂了 ⇒ 所有 PR 卡死,=0 是唯一放行方式 |
| `merge_approval_gate_killswitch` | 批准链路挂了 ⇒ 同上 |
| `qa_done_gate_killswitch` | QA 记录链路挂了 ⇒ 同上 |
| `ship_ci_guard` | GitHub / gh 证据链挂了 ⇒ 同上 |
| `design_html_gate` | 设计 HTML 校验挂了 ⇒ design 节点收不了工 |
| `founder_ux_gate_killswitch` | 签字门本身出问题时的全局撤除杆 |

**为什么我不自己把它们塞进「留」**:
这是**第三条判据**(「坏了之后还有没有退路」),**她只给了两条**。我按记过的纪律不替她扩判据。

**两种选择的代价都摆出来**:
- **留**(共 21 条,略超 20)⇒ 多留 6 个开关,换「守门的东西坏了还能自救」
- **删**(共 15 条)⇒ 更干净,但以后这几道门任何一道出故障,**恢复手段从「改一行 .env」变成「改代码 + 重新部署」**

**我的建议:留**,理由是这六条的共同点是「**它坏的时候,你正好最需要它**」;而它们的持有成本只是 registry 里六行。
但**这是取舍不是技术题**,而且加判据这件事该由她拍。

---

## 4. 建议删 + 固化成现值的 94 条

**这 94 条的共同事实:当前生效值 == 默认值** ⇒ **固化成现值和固化成默认是同一件事** ⇒ **删了零行为变化。**
(这也是为什么 ② 那 11 条要单独走 —— 只有它们两值不同,删的方向才是个选择。)

### 4.1 急停开关(49)

liveness_alerts · mailbox_queue · prune_park_guard · readopt_parked_roles · tmux_keepalive · converge_cmux_symlink · cmux_wal_quarantine · cmux_roster · cmux_view_invariant · cmux_strict_view · codex_gate_wait · lead_dual_active_scan · quota_degraded_switch · quota_daemon_wake · auto_qa_killswitch · review_severity_policy_killswitch · progress_resume_killswitch · cmux_close_request_killswitch · founder_review_gate_exclude · founder_auto_approve · stale_ship_rewake · auto_linear_done · founder_reply_unreachable · ask_hygiene · founder_milestone_notify · engine_dead_exec_sweep · workflow_rework_reentry · engine_unlaunched_tripwire · remote_reports · fleet_console · commdb_residue_harvest · terminal_commdb_sync · cron_stale_guard · ship_gate_rebind · external_merge_reconcile · ship_gate_retire · ship_gate_card · tier2_prefix_norm · viewer_session_reaper · chrome_session_reaper · fleet_sensor_tmux_killswitch · done_thread_reconcile · land_node · workflow_vendor_at_dispatch · commdb_protection · continuity_preflight · push_guard · instruction_path_check · doa_backoff

### 4.2 功能开关(45)

liveness_activity_window_ms · cmux_autostart_exec · claude_account_identity_check · boot_sha_check · gatepoller_circuit · founder_thread_notify · ship_ready_notify · ship_ready_remind_ms · founder_reply_deliver · deferred_founder_approval · held_declined_reply · deferred_approval_ttl_ms · founder_notify_retry_max · founder_reply_retry_max · founder_reply_deadletter_age_ms · heartbeat_readopt · liveness_pane_dead · worktree_autoclean · bridge_loop_guard · issue_status_emoji · issue_status_word · issue_attach_pin · issue_display_refresh · issue_display_sweep_ticks · crash_reaper · stale_terminal_close · commdb_fsm_reconcile · ship_gate_grace_ms · merge_reconcile_window_days · ship_gate_card_grace_ms · codex_lead_typing · roundtable_thread_autocontinue · lead_chrome_enabled · roundtable_thread_own_bot · lead_dry_run · reports_ttl_days · ghost_guard_wait_ms · runner_autocontinue · done_thread_reconcile_interval_min · done_thread_reconcile_dryrun · done_thread_reconcile_max_per_run · delivery_secret_path · zombie_reconcile · terminal_thread_archive · disposition_receipt

> ⚠️ 按你的硬要求,上面 49 条**属于急停开关,即使删也要单独走,不混进批量执行**。
> 我把它们和功能类分开列,就是为了执行单能分批。

---

## 5. 两条查实结果(HL 点名要的)

### 5.1 ❌ 我上一版关于 `proofshot` 的说法是**错的**,已撤回

**我写过**:「所有 Lead 的 `lead_chrome_enabled` 都是 false ⇒ 只开 proofshot 跑不起来」。
**后半句错了。** HL 和 Tadashi 拿证据纠正,我自己也独立核了一遍,确认他们对:

| 核验项 | 结果 |
|---|---|
| `proofshot` 是什么 | 独立 npm CLI(v1.3.2),依赖只有 commander / chalk / detect-port |
| 它怎么起浏览器 | 经 `agent-browser`(v0.27.1),**自带无头浏览器**;`--headed` 是**可选**开关 ⇒ 默认无头 |
| 两个包里引用 `FLYWHEEL_LEAD_CHROME_ENABLED` 的次数 | **0** |
| HL 的活体证据 | 18:21 发布体检页时 ProofShot 正常跑完(输出 `Browser: Chromium (headless)`),**而同一时段我在报 claude-in-chrome 断连** ⇒ 一个在工作、另一个同时坏着 ⇒ **两者失败独立 ⇒ 不是同一个宿主** |

⇒ **ProofShot 单独开就能用,她的指令不缺任何一步。** 这条「做不到」是我造出来的假障碍,已删。

**我错在哪**:把三层压成了一层 ——
**MCP 工具**(全局,都有)/ **扩展连接**(我报的 not connected 是这层)/ **Lead 的 `--chrome` 标志**(全 fleet 未设,性质重得多:它把 Lead 接进 Annie 本人已登录的浏览器会话)。
这三层共用「Chrome」这个词,但不是同一个东西 —— **和我这两天一直在提醒别人的「共用一个名字 ≠ 同一个东西」是同一个错**,只是这次犯的人是我。

### 5.2 `founder_ux_gate` 现在到底还拦不拦 —— **查实了:不拦。但它不是空壳。**

HL 怀疑它是空壳(只找到「把 mode 记到 session」的埋点)。**查实的结论比「空壳」更精确,而且两者处置不同:**

**拦截代码是真的、而且完整** —— 有四个真实消费点:

| 位置 | 它在 false 时做什么 |
|---|---|
| `event-route.ts:2450` | implement 阶段守卫,`block` 时**真的返回 409** ⇒ 关闭时整段跳过 |
| `founder-ux/routes.ts:122` | 轮询路由 ⇒ 关闭时**立即返回 approved: true** |
| `Blueprint.ts:2181` | 提示词注入 ⇒ 关闭时不注入签字要求 |
| `claude-lead.sh:2649` | Lead 规则文件挂载 ⇒ 关闭时不挂 |

**但四个消费点全部与同一个谓词相与**:
`isFounderUxGateEnabled() = FLYWHEEL_FOUNDER_UX_GATE_ENABLED === "1"`(`founder-ux-config.ts:79`)

**而那个变量:生产 .env 里 0 命中,活着的 Bridge 进程 env 里也 0 命中** ⇒ 谓词恒 false ⇒ **四处全部短路。**

⇒ **准确结论:门是真的,但被 FLY-900 在全舰级别默认关掉了,而且没人设过那个重新打开的变量。**
⇒ **逐项目那个 `founder_ux_gate.mode` = enforce 是真配置,但今天是死的** —— 它只在全局谓词通过之后才被读。

**这对我自己的 ③ 名单是个更正**:我把 `founder_ux_gate` 列进「真正需要多种选择」,
但**一个当前不生效的枚举谈不上「需要多种选择」**。真正的杠杆是 `founder_ux_gate_killswitch`(那个 =1 才恢复的变量)。
⇒ 建议:这两条**合成一个决定**摆给她 —— 问的是「**这道签字门要不要回来**」,不是「保留几个开关」。

## 6. 我没做的

- **没做页面**(你说先给判断结果)
- **没建执行单**
- **没有替 §3 那个第三判据做决定**
- **没有因为「要删 95%」把任何一条直接标成建议删** —— §4 那 94 条的依据是「两值相等 ⇒ 删了零变化」,不是口号

---

## 7. 🔴 `qa_auto` 源头冲突查实了 —— **规则文档对,registry 错**

HL 的问题:规则文档说 auto-QA 全队默认开(opt-out),registry 读到默认 false、只有 flywheel 开。哪个是真的?

**答案:规则文档是对的。registry 的 `default: false` 是错的。**

**权威在解析器,不在任何一份文档** —— `packages/teamlead/src/bridge/auto-qa-policy.ts`
的 `resolveAutoQaPolicy()` 头注释逐字写着:

> **FLY-752 flipped the per-project default from OPT-IN to OPT-OUT (fleet-wide default-on).**

它的判定顺序第 6 条:
> otherwise(absent config / no `qa` block / `auto` absent / `auto: true`)→ **ON(opt-out default)**

⇒ **那五个「没写 qa.auto」的项目,实际是开着的,不是关着的。**
⇒ 而 registry 声明的是 `polarity: opt_in` / `default: false` —— **和运行时相反。**

### 7.1 对三堆的直接影响

| | 改前 | 改后 |
|---|---|---|
| `qa_auto` 归堆 | ②(以为 flywheel 偏离默认) | **①**(六个项目实际全开 = 真默认) |
| ② | 11 | **10** |
| ① | 111 | **112** |

⇒ **同时回答了你问的「算不算多选」:它根本不是逐项目差异 —— 六个项目效果一样,全是开。**
所以它**不符合「本来就需要多种选择」**,应按 ①(删 + 固化成开)处理。
⇒ 另外:**flywheel 那条显式 `qa.auto: true` 是冗余的** —— 不写它也是开。

### 7.2 ⚠️ 这件事暴露的**系统性风险**,比 qa_auto 本身重要

**registry 的 `default` 列不是权威** —— 对有「复合策略函数」的 flag,真正的缺省在解析器里。
**而 registry.ts 自己的头注释早就写明了这一点**(第 13–16 行):

> It does NOT replace compound policy functions (**e.g. resolveAutoQaPolicy**) — those stay;
> the registry lists the individual layers.

**它甚至点名了 `resolveAutoQaPolicy` 当例子** —— 而我的 ①②切分**正好是拿 registry 的 default 列做判据的**,一头撞了进去。

**我复查的范围和限度(不夸大)**:我把 **7 条逐项目 flag 全查了解析器**,结论是:

| flag | registry default | 运行时真缺省 | 一致? |
|---|---|---|---|
| `qa_auto` | false | **ON** | ❌ **不一致** |
| `doc_flow` | false | 严格 `=== true` 才开 ⇒ 关 | ✅ |
| `founder_ux_gate` | "enforce" | `FOUNDER_UX_GATE_DEFAULT_MODE = "enforce"`(`types.ts:325`) | ✅ |
| `proofshot` / `xiaohongshu_learning` / `ponytail` / `skill_framework_split_participation` | 见表 | 未发现复合解析器 | ✅ |

⇒ **逐项目那一族里只有 qa_auto 一条错。**
⚠️ **但我没有把 117 条 env flag 的解析器全部逐条查一遍** —— 所以正确说法是
「**逐项目族已查清,env 族未做同等复查**」,不是「只有这一条错」。
**建议**:执行单动手前,对**每一条要删的 flag** 都做一次「registry default vs 解析器真缺省」的对照 ——
因为固化方向错了就是悄悄改行为,而这正是这条规则要防的东西。
