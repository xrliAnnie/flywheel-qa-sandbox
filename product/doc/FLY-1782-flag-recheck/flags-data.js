/**
 * FLY-1782 — 逐条体检的「人话判断」层。
 *
 * 纪律沿用 FLY-1136/1413:**机器事实和人话判断分家**。
 *  · 现在开还是关、改了怎么生效、读点在哪、哪个进程读 —— 全部只从 snapshot.json 出;
 *  · 这个文件只写「在干嘛(人话)」「为什么是这个状态」「建议怎么办」;
 *  · 这里**绝不复制现值** —— 重跑 extract 刷新现值不会跟人话打架。
 *
 * bucket(本轮口径,与 FLY-1413 的三桶对齐并加两桶):
 *   keep       留 —— 现状就是想要的样子,不动
 *   settle     固化 —— 值已经稳定/条件已满足,建议固成默认并退休这个开关
 *   clean      清 —— 已经死了或明确该删
 *   foundation 交地基 —— 本身没问题,但「改了要重启」这件事归 FLY-1778 一起解决
 *   diverge    分歧 —— HL 和 Tadashi 收敛不了,必须问 Annie
 *
 * strength(证据强度,不能混着写):
 *   verified     本轮追到了调用点/取到了实证
 *   default      没人显式设过,按代码默认跑;结论强度到此为止
 *   unresolved   查不到书面依据,只有回忆或空白 —— 明确标出来,不当结论
 */

/** @type {Record<string,{plain:string,why:string,bucket:string,strength:string,note?:string}>} */
export const FLAGS = {
	// ─────────────────────────────────────────────────────────────────────
	// 一、生命周期 / 存活检测(Bridge 判断 runner 和 Lead 是死是活)
	// ─────────────────────────────────────────────────────────────────────
	liveness_alerts: {
		plain:
			"一个 runner 已经拿到 ship 批准、却在真正 ship 之前死掉了——这种情况要不要发人工告警。开着=发。",
		why: "没人设过,跑代码默认「开」。Bridge 启动时读一次,改了要重启。",
		bucket: "keep",
		strength: "default",
	},
	readopt_parked_roles: {
		plain:
			"Bridge 重启后重新认领还活着的 runner 时,认哪些状态。开着=四种停靠状态都认;关掉=只认 running。",
		why: "没人设过,默认「开」。关掉会漏掉所有 park 在非 running 状态的 role——那正是它当初被造出来修的 bug。",
		bucket: "keep",
		strength: "default",
	},
	liveness_pane_dead: {
		plain: "用 tmux pane 是否已死来判断 runner 死活。",
		why: "没人设过,默认「开」。和 zombie_reconcile / heartbeat_readopt 合成同一个判活谓词。",
		bucket: "keep",
		strength: "default",
	},
	heartbeat_readopt: {
		plain: "心跳服务重新认领已存在的 session(而不是当成新的)。",
		why: "没人设过,默认「开」。关掉会退回 FLY-172 之前的行为。",
		bucket: "keep",
		strength: "default",
	},
	zombie_reconcile: {
		plain:
			"僵尸 session 探真:连续两轮探到 pane 不在就宣告失败,并给 Lead 发一份「没推上去的活」清单。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
	},
	liveness_activity_window_ms: {
		plain:
			"告警正文里判断「这个 runner 大概还活着 / 大概已经死了」用多长的活动窗口。默认 10 分钟。",
		why: "没人设过,默认 600000。它**只影响告警措辞,不影响任何裁决**——注册表原文就这么写的。",
		bucket: "keep",
		strength: "verified",
		note: "非法值会在运行时被 sanitize 回默认,所以显示值=真实生效值。",
	},
	crash_reaper: {
		plain: "回收崩掉/变成孤儿的 runner 进程。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
	},
	stale_terminal_close: {
		plain:
			"session 已经是终态、但它的 tmux 还活着超过阈值 → 自动去收掉(防泄漏)。关掉=只发通知不收。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
	},
	fleet_sensor_tmux_killswitch: {
		plain:
			"整台 tmux server 掉了的时候,按舰队级别一次性处理(成组迁终态、开一张 ticket、按 Lead 分组通知),而不是一个个 runner 各自崩。",
		why: "没人设过,默认「开」。关掉会退回一个个 runner 各自被 crash-reaper 收的旧行为。",
		bucket: "keep",
		strength: "default",
	},
	prune_park_guard: {
		plain:
			"两条会「删东西」的清扫(强转 completed、删 CommDB 行)在动手前,先看这个 session 有没有声明自己 park 了;声明了就否决清扫。",
		why: "没人设过,默认「开」。它取代了以前靠人手维护排除名单的做法。",
		bucket: "keep",
		strength: "default",
	},
	lead_dual_active_scan: {
		plain: "检测同一个 Lead 被起了两份(双活),立刻告警并标记后起的那个。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
	},
	viewer_session_reaper: {
		plain: "Bridge 启动时清掉泄漏的 viewer-<execId> tmux session。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
	},
	chrome_session_reaper: {
		plain: "周期清理泄漏的无头 Chrome 进程(agent-browser 用完没收干净的)。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
	},
	worktree_autoclean: {
		plain: "一轮活干完之后自动清掉 git worktree。",
		why: "没人设过,默认「开」。这是好几处清扫共用的总逃生口——关掉会同时冻结好几层清理。",
		bucket: "keep",
		strength: "default",
	},
	commdb_fsm_reconcile: {
		plain:
			"启动时对账:CommDB 说还在跑、但状态机已经终态且 tmux 已经死的,清掉。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
	},
	commdb_residue_harvest: {
		plain: "清掉只存在于 CommDB 的孤儿登记,和 StateStore 里的幽灵行。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
	},
	terminal_commdb_sync: {
		plain: "session 变成 failed/blocked 时,把终态异步同步回 CommDB。",
		why: "没人设过,默认「开」。这是上面两条清扫要修的问题的根因层。",
		bucket: "keep",
		strength: "default",
	},
	commdb_protection: {
		plain:
			"CommDB 里「还没被回答的、需要人处理的」行,在过期/收尾/清扫三条路径上都保住不删。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
	},
	continuity_preflight: {
		plain:
			"重新派工之前,先去 origin 上对一下同名分支和已开的 PR,免得从 main 另起一条分叉、把前一轮的活丢掉。",
		why: "没人设过,默认「开」。FLY-1718 刚加的安全回滚开关。",
		bucket: "keep",
		strength: "default",
	},
	doa_backoff: {
		plain:
			"重新派工前先看上一个 runner 是怎么死的;连续死就按 1/2/4/8 分钟退避,第五次交给 Lead 决定。",
		why: "没人设过,默认「开」。FLY-1718 的一部分。",
		bucket: "keep",
		strength: "default",
	},
	push_guard: {
		plain:
			"给 runner 的 worktree 装一个 pre-push 钩子,挡住对「已开 PR 的分支」做非快进推送或删除。",
		why: "没人设过,默认「开」。只在建 worktree 那一刻读,所以改了只影响之后新建的 worktree。",
		bucket: "keep",
		strength: "verified",
	},
	progress_resume_killswitch: {
		plain:
			"重启/被杀之后,runner 能不能从 progress.md 的游标接着做。关掉=每次都从头开始。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
	},
	ghost_guard_wait_ms: {
		plain: "起 runner 时等多久算「确实起来了」的确认窗口。默认 90 秒。",
		why: "没人设过,默认 90000。纯时间旋钮。",
		bucket: "keep",
		strength: "default",
	},

	// ─────────────────────────────────────────────────────────────────────
	// 二、ship / 批准链(谁能让一个 PR 合进去)
	// ─────────────────────────────────────────────────────────────────────
	auto_qa_killswitch: {
		plain:
			"全局总闸:code review 之后要不要自动起一个独立 QA runner。关掉=全舰停自动 QA。",
		why: "没人设过,默认「开」;实际是否起 QA 还要看每个项目自己的 qa.auto。",
		bucket: "keep",
		strength: "default",
	},
	qa_auto: {
		plain: "逐项目开关:这个项目的 PR 过了 review 之后要不要自动起 QA runner。",
		why: "六个项目里只有 flywheel 自己显式开了,其余五个都是默认关。这是刻意的——Flywheel 自研自测。",
		bucket: "keep",
		strength: "verified",
	},
	codex_hard_gate_killswitch: {
		plain:
			"硬门:任何 PR 没拿到 Codex APPROVED 就卡住,不许进 auto-QA、不许 merge。关掉=应急放行。",
		why: "没人设过,默认「开」。这是 Lead 明确要求必须可靠的那道门。",
		bucket: "keep",
		strength: "default",
	},
	merge_approval_gate_killswitch: {
		plain:
			"防抢跑:已经 merged 的东西,只有经过 verifyApproval 才算数;否则挂 merge_block 并大声告警(不自动 revert)。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
		note: "Bridge 侧和 CLI 侧各读一次,两边不一致时会 split-brain——注册表原文自己写明了这个风险。",
	},
	qa_done_gate_killswitch: {
		plain:
			"要求 QA 通过才让 session 收尾:需要 QA 的 session 必须有一份对得上当前 head 的 passed 记录。",
		why: "没人设过,默认「开」。豁免口写得很明确(无代码/无 PR/无 QA 标签/项目关了 qa.auto)。",
		bucket: "keep",
		strength: "default",
		note: "与上一条同样存在 Bridge/CLI 双读的 split-brain 风险。",
	},
	ship_ci_guard: {
		plain: "批准和最终 ship 之前,现场查一次 GitHub CI 是不是绿的。",
		why: "没人设过,默认「开」。每次 CLI 调用现读,所以改了下一次调用就生效。",
		bucket: "keep",
		strength: "default",
	},
	review_severity_policy_killswitch: {
		plain:
			"跨家族 review 的收敛政策:MEDIUM/LOW 不阻塞、并且尊重 Lead 已经裁决过的 finding。关掉=回到旧判法。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
	},
	founder_auto_approve: {
		plain:
			"Annie 在 [FLY-XX] thread 里说一句「可以」或点 ✅ → 系统认成 founder 批准 → 写 ship 门 → runner 自己 ship。",
		why: "没人设过,默认「开」。这是她日常批准的主通路。",
		bucket: "keep",
		strength: "default",
	},
	tier2_prefix_norm: {
		plain: "批准语义:允许剥掉纯语气前缀,让「嗯ship」也能确定性地当成「ship」。",
		why: "没人设过,默认「开」。关掉会让这类说法掉到更模糊的判定层。",
		bucket: "keep",
		strength: "default",
	},
	deferred_founder_approval: {
		plain:
			"如果 Annie 批准的时候这条正好被 hold 住,先把批准存起来,hold 解开后自动补上,而不是当场拒绝她。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
	},
	deferred_approval_ttl_ms: {
		plain: "上面那份「暂存的批准」能存多久。默认 45 分钟,过期要她重新确认。",
		why: "没人设过,默认 2700000。",
		bucket: "keep",
		strength: "default",
	},
	held_declined_reply: {
		plain:
			"被 hold 住的时候,给 Annie 在 thread 里发一句明文解释,而不是只回一个 ❓ 让她猜。",
		why: "没人设过,默认「开」。这是当初明确提出的硬要求之一。",
		bucket: "keep",
		strength: "default",
	},
	stale_ship_rewake: {
		plain:
			"把卡在「已批准待 ship」状态的 runner 重新唤醒(补上漏掉的自动 ship)。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
	},
	auto_linear_done: {
		plain:
			"runner 自己 ship 完、确认 merged 之后,自动把 Linear issue 翻成 Done。",
		why: "没人设过,默认「开」。只有拿到 merge 证据才会走到这一步。",
		bucket: "keep",
		strength: "default",
	},
	ship_gate_rebind: {
		plain:
			"QA 把证据提交上去导致 PR head 前移时,自动把 ship 门重新绑到新 head,而不是直接丢掉这道门。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
	},
	ship_gate_retire: {
		plain:
			"重新绑定之后,把被取代的那道旧 ship 门退休掉——同一时刻只留一道可绑的门。",
		why: "没人设过,默认「开」。关掉会回到「僵尸门堆着」的旧现状。",
		bucket: "keep",
		strength: "default",
	},
	ship_gate_card: {
		plain:
			"把发给 Annie 的 ship 卡片当成主载体(15 秒 grace),而不是靠 10 分钟的兜底节奏。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
	},
	ship_gate_card_grace_ms: {
		plain: "发出 ship 卡片之前等多久。默认 15 秒。",
		why: "没人设过,默认 15000。",
		bucket: "keep",
		strength: "default",
	},
	ship_gate_grace_ms: {
		plain:
			"Annie 的文字/✅ 对 ship 门的放行 grace。默认 15 秒;把它设成 600000 就等于回到旧的 10 分钟行为——**这个数值本身就是它的 kill-switch**。",
		why: "没人设过,默认 15000。",
		bucket: "keep",
		strength: "verified",
	},
	ship_ready_notify: {
		plain:
			"非 land 类的工程 workflow 停在 founder 门口时,同时通知 owning Lead 和 founder thread「这条可以 ship 了」。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
	},
	ship_ready_remind_ms: {
		plain: "上面那条停多久没人处理就提醒 Lead。默认 30 分钟。",
		why: "没人设过,默认 1800000。",
		bucket: "keep",
		strength: "default",
	},
	external_merge_reconcile: {
		plain:
			"有人在流程外把 PR merge 了(executor 直接合的残局),用一个兜底 pass 把账收敛回来。",
		why: "没人设过,默认「开」。注册表原文强调:**兜底不是许可**。",
		bucket: "keep",
		strength: "default",
	},
	merge_reconcile_window_days: {
		plain: "上面那个兜底 pass 往回看几天。默认 7 天。",
		why: "没人设过,默认 7。",
		bucket: "keep",
		strength: "default",
	},
	// ─────────────────────────────────────────────────────────────────────
	// 三、founder 通路(消息怎么送到 Annie、她的回复怎么送回来)
	// ─────────────────────────────────────────────────────────────────────
	founder_thread_notify: {
		plain: "卡在门上的时候给 Annie 发 thread 通知。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
	},
	founder_reply_deliver: {
		plain: "把 Annie 在门上的回复回投给对应的 runner。",
		why: "没人设过,默认「开」。这条关了 = 她说了话但没人收到。",
		bucket: "keep",
		strength: "default",
	},
	founder_reply_retry_max: {
		plain: "上面那条投递最多重试几次,超了就进死信并告警。默认 10 次。",
		why: "没人设过,默认 10。",
		bucket: "keep",
		strength: "default",
	},
	founder_reply_deadletter_age_ms: {
		plain: "重试的另一半阈值:超过这个时长也进死信。默认 30 分钟。",
		why: "没人设过,默认 1800000。和次数上限是双阈值。",
		bucket: "keep",
		strength: "default",
	},
	founder_reply_unreachable: {
		plain:
			"Annie 回复了、但那个 runner 已经联系不上——这属于数据不一致,发告警。",
		why: "没人设过,默认「开」。这条是 FLY-1570 拆看门狗时**特意保留**的:它做的是数据一致性对账,不是追人。",
		bucket: "keep",
		strength: "verified",
	},
	founder_notify_retry_max: {
		plain: "founder 动作台账的投递重试上限,超了标 failed 并告警。默认 5 次。",
		why: "没人设过,默认 5。",
		bucket: "keep",
		strength: "default",
	},
	founder_milestone_notify: {
		plain: "给 Annie 推里程碑消息。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
	},
	founder_review_gate_exclude: {
		plain:
			"Annie 回一个字母的时候,候选门里排除掉 review_design / review_code 这两类(免得她一句「ok」被安到 review 门上)。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
	},
	issue_gate_supersede_mode: {
		plain:
			"issue 上一堆门互相取代时的巡检模式。enforce=真去收敛,observe=只记账,0=停止新的改动。",
		why: "没人设过,默认 enforce。已经盖过 superseded 戳的历史记录永久有效,设 0 也不会回滚。",
		bucket: "keep",
		strength: "default",
	},
	ask_hygiene: {
		plain: "runner 收尾时,把挂在它名下、没人回答的提问清理掉。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
	},
	gatepoller_circuit: {
		plain: "轮询连续失败时的熔断(不要疯狂重试)。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
	},
	disposition_receipt: {
		plain:
			"Lead 处置完一条告警之后,在 issue thread 里落一条看得见的回执。记账永远写,这个开关只管「要不要投递给人看」。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
	},
	issue_status_emoji: {
		plain: "issue thread 标题上的状态 emoji + 重连标记。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
	},
	issue_status_word: {
		plain: "同一套状态,用文字而不是只用 emoji 标出来。",
		why: "没人设过,默认「开」。关掉退回纯 emoji。",
		bucket: "keep",
		strength: "default",
	},
	issue_attach_pin: {
		plain:
			"在 issue thread 里钉一条 tmux attach 的救援命令,方便人直接连进去看。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
	},
	issue_display_refresh: {
		plain:
			"三个显示面(标题、置顶、状态行)统一从真实状态派生,并在整个生命周期各个节点触发刷新。关掉=退回旧的单点刷新。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
	},
	issue_display_sweep_ticks: {
		plain:
			"显示自愈的兜底扫描周期(多少个 tick 扫一次)。默认 60,约 3 分钟;设 0 = 关掉扫描。",
		why: "没人设过,默认 60。",
		bucket: "keep",
		strength: "default",
	},
	terminal_thread_archive: {
		plain:
			"issue 全段结束 + Linear 已 Done + pane 已死 → 分钟级自动归档它的 thread。",
		why: "没人设过,默认「开」。关掉只剩 6 小时一次的兜底扫描。",
		bucket: "keep",
		strength: "default",
	},
	done_thread_reconcile: {
		plain: "兜底扫描:Done/Canceled 的 issue 如果 thread 还没归档,补归档。",
		why: "没人设过,默认「开」。QA 房的 Bridge 会被显式注入 0 做隔离,免得扫到真 Linear。",
		bucket: "keep",
		strength: "verified",
	},
	done_thread_reconcile_interval_min: {
		plain: "上面那个兜底扫描多久跑一次。默认 360 分钟;0 = 只在启动跑一次。",
		why: "没人设过,默认 360。",
		bucket: "keep",
		strength: "default",
	},
	done_thread_reconcile_dryrun: {
		plain: "让兜底扫描只记录不真归档(观察模式)。",
		why: "没人设过,默认关。它是排障工具,平时就该关着。",
		bucket: "keep",
		strength: "default",
	},
	done_thread_reconcile_max_per_run: {
		plain: "每轮最多归档多少条(防 Discord 限流)。默认 25。",
		why: "没人设过,默认 25。",
		bucket: "keep",
		strength: "default",
	},

	// ─────────────────────────────────────────────────────────────────────
	// 四、消息层 / 信箱(FLY-1573/1574 那条线)
	// ─────────────────────────────────────────────────────────────────────
	mailbox_queue: {
		plain:
			"信箱的租约重投 + 合批投递 + 死信闸。设成 0 会在运行时切回旧投递流。",
		why: "**这是 11 条被显式设过的之一:`=1`。** 但默认本来就是开,所以这一行不改变行为——它是一条「刻意写出来的宣告」,配合部署时的 ACK 就绪闸使用(restart-services 在闸没过时会把它压回 0)。",
		bucket: "keep",
		strength: "verified",
	},
	delivery_secret_path: {
		plain:
			"投递 ACK 用的那把 HMAC 密钥文件放哪。默认 ~/.flywheel/delivery-secret。",
		why: "没人设过,走默认路径。这是路径类配置,不该热改。",
		bucket: "keep",
		strength: "default",
	},

	// ─────────────────────────────────────────────────────────────────────
	// 五、DAG / workflow 派工(最敏感的一族——五条里四条被显式设过)
	// ─────────────────────────────────────────────────────────────────────
	workflow_template_dispatch: {
		plain: "总闸:派工走不走「模板 DAG」这条新路。关掉=回到旧的单会话派工。",
		why: "**被显式设过:`=1`(2026-07-31 Annie 拍板恢复 DAG 派工)。** ⚠️ 上一版审计管线会把它读成**关**——它那一行带行尾注释,老解析器把注释也算进值里了。本轮已修,并用行为反证:这次体检自己就是以 generalized workflow 节点跑的,只有它开着才会存在。",
		bucket: "keep",
		strength: "verified",
		note: "同时是 FLY-1436 的应急急停杆。红线:不许顺手改。",
	},
	workflow_generalized_templates: {
		plain: "让 schema-v2 那套模板参与选取/准入/提交。",
		why: "**被显式设过:`=1`,`.env` 第 151 行,光秃秃没有任何注释。** 注册表描述里仍写着「默认关,为了字节兼容」和一串前置条件。⚠️ **它的启用不属于 7-31 那次拍板** —— 那条拍板注释挂在第 161 行的 `workflow_template_dispatch` 上,和这一行无关。",
		bucket: "diverge",
		strength: "verified",
		note: "本轮**三次判断被推翻**,全过程见 audit.md §5 的 D-2 段。终稿口径:两条独立的腿 —— ①【谁批准的】查不到批准记录(而且 `workflow_generalized_templates` 连一条机械翻转记录都没有);②【是否在被依赖】重度在用(FLY-1693 e2e、529 房全链、今天四单含 E5 四单一体、claims 链当日二十多个 verdict)。**实证不顶替批准记录,没有批准记录也不等于它坏了。** Tadashi 的工程判断(是判断不是事实):属 registry 文档债,行动是更新条款、不是关开关。方向落在 ship 授权链上且无批准记录可援引 ⇒ 必须 founder 定。",
	},
	workflow_claims_write: {
		plain: "workflow claims 的影子写入 + 已登记执行的准入。",
		why: "**被显式设过:`=1`,`.env` 第 142 行,光秃秃没有任何注释。** 注册表原文仍写着「Must remain off until the pinned fresh-spawn E2E and peer-credential hardening gates pass」。⚠️ **它的启用也不属于 7-31 那次拍板。**",
		bucket: "diverge",
		strength: "verified",
		note: '与 `workflow_generalized_templates` 同一件事、同一个行动项。**本轮取到的机械证据(它比另一条硬)**:`~/.flywheel/audit.db` 的 `fleet_admin_audit` 记着这一行的翻转 —— `2026-07-19T00:54:09Z`,经 fleet 控制台(origin=loopback),`rawFrom:null → rawTo:"1"`,`applied`;8 分钟后 `teamlead.db` 落下第一条 `workflow_run`(01:02:05)。⚠️ 但这条记录只证明**什么时候、经什么面被翻开**,**不证明谁批准的** —— fleet 审计行不含人的身份;而 `founder_consent_audit` 的 action 词表里根本没有 flag 翻转这一类,所以它的沉默既不是批准也不是未批准,是**这条通路从来不记 flag**。',
	},
	workflow_claims_read: {
		plain:
			"让已登记的 workflow run 用 claims 来判断能不能 ship、以及读权威 head。",
		why: "**被显式设过:`=1`。** Bridge 和 CLI 都是活的权威消费方。",
		bucket: "keep",
		strength: "verified",
	},
	workflow_gate_carrier: {
		plain:
			"新起的 run 把 ship 批准冻结在「到达门口时」的载体上。已经在跑的老 run 不受影响。",
		why: "**被显式设过:`=1`。** 它只影响下一个新 run;真正决定行为的是 run 自己冻结的 epoch,不是这个 env。",
		bucket: "keep",
		strength: "verified",
	},
	land_node: {
		plain:
			"引擎自己拥有的 land 节点(合入 → 关 session → 清 worktree → 翻 Done/归档)。设 0 停止新的 land 激活,已经认领的继续收敛。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
	},
	workflow_vendor_at_dispatch: {
		plain:
			"每个 workflow 节点在起的时候现读「当前批准的派工配置」,而不是用当初钉死的快照。设 0 立刻回到钉死快照。",
		why: "没人设过,默认「开」。注册表标明这是应急逃生口。",
		bucket: "keep",
		strength: "default",
	},
	workflow_rework_reentry: {
		plain:
			"QA 或 Annie 要求返工时,重新进原来那个 actor;设 0 = 只 hold 住并告警,不驱逐也不另起。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
	},
	engine_dead_exec_sweep: {
		plain: "DAG 里执行体死了之后的恢复扫描。关掉=暂停做新的替换决定。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
	},
	engine_unlaunched_tripwire: {
		plain: "对「已准入但没真起来」的 workflow 重试做告警、围栏和恢复。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
	},
	workflow_turn_divergence_alerts: {
		plain:
			"引擎和 CommDB 对「轮到谁」判断不一致时,发严重告警。默认关=只在影子模式记录,不吵人。",
		why: "没人设过,默认关。**这是刻意的**:注册表原文说「先观察影子记录,再决定开不开」。它 8 月 11 号才加,现在动它没有观察依据。",
		bucket: "keep",
		strength: "verified",
	},
	cron_stale_guard: {
		plain:
			"起 run 撞 409 的时候,先看拦住它的是不是一个早就该失效的旧 blocker。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
	},
	instruction_path_check: {
		plain:
			"design review 的自动指令要绑定「已经提交上去的 plan 文件路径和内容指纹」,并由 Bridge 校验结果。",
		why: "没人设过,默认「开」。FLY-1718 的一部分,跨进程授权面,按政策不给网页开关。",
		bucket: "keep",
		strength: "default",
	},
	design_html_gate: {
		plain:
			"design 节点收工之前必须交一份给 Annie 看的设计 HTML,而且要带能对上当前 HEAD 的可信证据。",
		why: "没人设过,默认「开」。这是治理门,`=0` 只作 operator 应急放行。",
		bucket: "keep",
		strength: "default",
	},
	boot_sha_check: {
		plain:
			"Bridge 启动时打印自己跑的是哪个 commit,并跟 origin/main 比一下;落后就告警。纯观测,不影响启动。",
		why: "没人设过,默认「开」。分支 checkout(开发/QA 房)会自动静音。",
		bucket: "keep",
		strength: "default",
	},
	bridge_loop_guard: {
		plain:
			"Bridge 事件循环卡死时自己退出,好让 launchd 把它拉起来(launchd 自己盖不住这个缺口)。",
		why: "没人设过,默认「开」。注意:它只在 start() 时看一次,事后设 0 停不了已经跑起来的那个。",
		bucket: "keep",
		strength: "verified",
	},

	// ─────────────────────────────────────────────────────────────────────
	// 六、cmux / tmux 视图(Annie 打开侧栏看到的东西)
	// ─────────────────────────────────────────────────────────────────────
	cmux_linked_view: {
		plain: "cmux 的窗口拓扑用不用 linked view(一个窗对一个视图)。",
		why: "**被显式设过:`=0`,而且到今天仍然没有任何书面原因。** FLY-1413 那轮就把它列成 UNKNOWN,当时的处置是「维持 0,等 FLY-1364 ship 之后重测」。三周过去了,重测没人做,状态原样。",
		bucket: "diverge",
		strength: "unresolved",
		note: "Tadashi 当时的回忆是「某次 cmux 不稳定期间关掉的」——**那是回忆,不是证据**,不作为结论。",
	},
	cmux_view_invariant: {
		plain:
			"校验 managed 视图当前激活的是不是正确那个窗,不对就用安全方式修回来。",
		why: "**被显式设过:`=1`。** 默认本来也是开,所以这一行同样是「刻意宣告」而非行为改变。",
		bucket: "keep",
		strength: "verified",
	},
	cmux_strict_view: {
		plain: "managed tab 用独立的精确窗口视图。设 0 = 有序回滚到 grouped 拓扑。",
		why: "没人设过,默认「开」。Bridge 和 watcher **两边各读一次**——只改一边会留半套拓扑。",
		bucket: "keep",
		strength: "verified",
	},
	cmux_roster: {
		plain:
			"从 launchd/manifest 推出「现在应该有哪些 Lead」的名册,再拿去跟实际在跑的对账。",
		why: "没人设过,默认「开」。关掉只暂停名册派生和对账,不改既有视图行为。",
		bucket: "keep",
		strength: "default",
	},
	cmux_wal_quarantine: {
		plain:
			"某个视图的构建日志写坏了,就把它单独隔离掉,让别的视图继续对账;关掉=回到「一个坏全体停」。",
		why: "没人设过,默认「开」。只隔离四类纯语法/文件身份错误,其它不确定性仍然整轮 fail-closed。",
		bucket: "keep",
		strength: "verified",
	},
	cmux_close_request_killswitch: {
		plain:
			"关 runner 时写一个 close-request 标记,watcher 看到就立刻把过期的钉子摘掉。",
		why: "没人设过,默认「开」。Bridge 和 watcher 两侧都要改才完整。",
		bucket: "keep",
		strength: "default",
	},
	cmux_autostart_exec: {
		plain:
			"允许没人看管的 autostart 脚本直接自己跑 watcher,而不是只去守 launchd 的任务。",
		why: "没人设过,默认关。它自己写明的退役条件是「只用于 launchd 控制面故障的短时诊断,稳定后退役」;7 月 24 日加的,22 天里一次都没被打开过。",
		bucket: "settle",
		strength: "verified",
		note: "HL×Tadashi 收敛(2026-08-15):稳定标准定为「30 天无 autostart 相关告警」,**已达标** → 提议退役,但动作排在 FLY-1778 落地之后(要先有翻转审计)。⚠️ **退役动作本身仍需 Annie 点头,不由 FLY-1778 顺手带掉。**",
	},
	converge_cmux_symlink: {
		plain:
			"把散落的 cmux 脚本部署副本收敛回指向主 checkout 的符号链接(留档之后原子替换)。",
		why: "没人设过,默认「开」。它自己写明的退役条件是「全机不再存在可写部署副本路径」。",
		bucket: "keep",
		strength: "verified",
		note: "HL×Tadashi 收敛(2026-08-15)**推翻了我的初判**:保留,不退。converge 这套机制现在还是活的 —— FLY-1784 的部署注记刚用到它(cmux 侧 bin 副本 pull 之后要靠 converge 换字节)。",
	},
	tmux_keepalive: {
		plain:
			"给 tmux server 挂一个哨兵会话并关掉 exit-empty,这样最后一个业务会话没了,server 也不会跟着消失。",
		why: "没人设过,默认「开」。关掉只是停止后续维护,不会自动拆掉已有哨兵。",
		bucket: "keep",
		strength: "verified",
	},

	// ─────────────────────────────────────────────────────────────────────
	// 七、Lead 侧(逐 Lead 生效,不是 Bridge 全局)
	// ─────────────────────────────────────────────────────────────────────
	codex_lead_typing: {
		plain: "Codex Lead 在 Discord 里显示「正在输入…」。",
		why: "没人设过,默认「开」(和 Claude Lead 对齐)。",
		bucket: "keep",
		strength: "default",
	},
	roundtable_thread_autocontinue: {
		plain: "圆桌话题线程的自动接续。",
		why: "没人设过,默认「开」。launcher 会把结果折算成一个 *_EFFECTIVE 变量再传给下游,链路有点绕但一致。",
		bucket: "keep",
		strength: "default",
	},
	roundtable_thread_own_bot: {
		plain: "圆桌线程里要不要把自己这个 bot 发的消息也算进去。",
		why: "没人设过,默认关。开着容易造成 bot 自问自答。",
		bucket: "keep",
		strength: "default",
	},
	lead_chrome_enabled: {
		plain: "这个 Lead 能不能用 Chrome / claude-in-chrome。",
		why: "逐 Lead 从各自的 manifest 读。实测:**当前所有 Lead 都是 false**。",
		bucket: "keep",
		strength: "verified",
	},
	lead_core_mention_gated: {
		plain: "core 房里没被 @ 的消息只让 CoS 回;非 CoS 的 Lead 必须被点名才回。",
		why: "由 launcher 按 projects.json 的拓扑自己算,不是人手设的。",
		bucket: "keep",
		strength: "default",
	},
	lead_cross_dept_channel_ids: {
		plain: "Codex Lead 要去轮询、并且接受被 @ 的跨部门频道 id 列表。",
		why: "**被显式设过:一个频道 id(#leads-roundtable)。** 这是真配置值,不是开关。Lead 侧和 Bridge 侧各读一次,三类进程都要重启才换。",
		bucket: "keep",
		strength: "verified",
	},
	lead_dry_run: {
		plain: "Codex Lead 的预演模式:只描述打算做什么,不真的启动。",
		why: "没人设过,默认关。它是**启动时临时加在命令行上**的排障工具,本来就不该常驻在 .env 里。",
		bucket: "keep",
		strength: "verified",
	},

	// ─────────────────────────────────────────────────────────────────────
	// 八、治理门(按政策永远不给批量/网页开关)
	// ─────────────────────────────────────────────────────────────────────
	founder_consent_decision_mode: {
		plain:
			"founder-consent 硬门的模式。off=不管、audit_only=只记账不拦、enforce=真拦。",
		why: "**被显式设过:`audit_only`。** 这是 FLY-175 三段式上线的**第 1 阶**(off / audit_only / enforce 里的中间档)——先只记账不拦截,攒校准语料;第三档 enforce 还没走。",
		bucket: "keep",
		strength: "verified",
	},
	founder_attribution_gate: {
		plain:
			"批准门的回答必须归属到 founder 侧才算数(她本人 / Bridge / consent 服务)。",
		why: "没人设过,默认「开」。`=0` 只给 QA 房和应急用。",
		bucket: "keep",
		strength: "default",
	},
	comm_bypass_bridge: {
		plain: "应急:绕过 founder-consent 直接写 ship 门。",
		why: "没人设过,默认关。开一次就会留一条很响的审计记录。**必须保持关着。**",
		bucket: "keep",
		strength: "default",
	},
	lead_lease_bypass: {
		plain: "应急:绕过 Lead 身份租约的写授权。",
		why: "没人设过,默认关。同样是「留着但永远别开」的那类。",
		bucket: "keep",
		strength: "default",
	},
	founder_ux_gate: {
		plain:
			"所有实质性 issue 在开工前必须先跟 Annie 对齐(brainstorm 签字),只有带豁免标签的例外。",
		why: "六个项目都是默认 enforce,没人改过。",
		bucket: "keep",
		strength: "verified",
	},
	founder_ux_gate_killswitch: {
		plain:
			"全局把上面那道签字门**撤掉**。⚠️ 语义是反的:默认 OFF = 门被撤掉;要恢复原来的 enforce 才需要设 =1。",
		why: "没人设过,所以现在的实况是「门是撤着的」。这是 FLY-900 刻意翻的方向。",
		bucket: "keep",
		strength: "verified",
		note: "这条最容易被读反——名字里带 ENABLED,但默认值 false 的含义是「关掉门」。",
	},

	// ─────────────────────────────────────────────────────────────────────
	// 九、账号 / 配额 / 外部依赖
	// ─────────────────────────────────────────────────────────────────────
	quota_degraded_switch: {
		plain: "允许配额守护进程执行「已经在它自己配置里开启的」受控降级换号。",
		why: "没人设过,默认「开」。设 0 会立刻压制换号。",
		bucket: "keep",
		strength: "default",
	},
	quota_daemon_wake: {
		plain: "Bridge 收到可信的「撞配额」信号后,立刻叫醒配额守护进程。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
	},
	claude_account_identity_check: {
		plain: "给 Claude 账号池的每次读写做身份核验(确认这个凭据真的是那个账号)。",
		why: "没人设过,默认关。开它有前置条件:必须先灌一份可信映射并跑过 audit;7 月 16 日加的,30 天里前置一直没做。",
		bucket: "keep",
		strength: "verified",
		note: "HL×Tadashi 收敛(2026-08-15)**推翻了我的初判**:保留,并重起 30 天表。理由 —— 前置没做恰恰说明该做:Tadashi 当天早上刚撞过 active 标签与 keychain 真身不符的污染,这条防的正是那个。",
	},
	codex_gate_wait: {
		plain:
			"Codex 的常驻目标在必答门没被回答时保活等着,门解开后继续;设 0 = 直接判 blocked 终态。",
		why: "没人设过,默认「开」。读点在 claude-runner 包里,但持有它的适配器是 **Bridge 构造的**——所以是 Bridge 进程读。",
		bucket: "keep",
		strength: "verified",
	},
	voice_qa_presence_override: {
		plain: "语音链路的 QA 缝:设 =1 时假装 Annie 在场。**只给隔离测试台用。**",
		why: "没人设过,默认关。而且它自带保险:一旦置位又指向生产 Bridge,进程会直接拒绝启动。",
		bucket: "keep",
		strength: "verified",
	},
	remote_reports: {
		plain: "远程报告发布管线(把 HTML 报告发到一个不可猜的托管 URL)。",
		why: "没人设过,默认「开」。Bridge 和 CLI 两侧各自独立读——只改一侧会 split-brain。",
		bucket: "keep",
		strength: "verified",
	},
	reports_ttl_days: {
		plain: "报告链接保留几天。默认 7 天。",
		why: "没人设过,默认 7。",
		bucket: "keep",
		strength: "default",
	},
	fleet_console: {
		plain: "Fleet 控制台那一面 + 它的路由。关掉=回到旧 dashboard。",
		why: "没人设过,默认「开」。",
		bucket: "keep",
		strength: "default",
	},
	publish_broker: {
		plain:
			"对外发布(promote-commit / npm publish)的唯一执行点。开启会起一个 unix socket 请求面 + Annie ✅ 审批观察。",
		why: "没人设过,默认关。7 月 12 日建好,34 天里从没开过——注册表自己也写「真发布另需 token 供给 + founder 批」。",
		bucket: "settle",
		strength: "verified",
		note: "建议:确认近期没有对外发布计划 → 明确标成「建好待用,不排期」,或者干脆归档。",
	},
	runner_autocontinue: {
		plain: "让 runner 自动续跑(goal-driven,不用人再戳一下)。",
		why: "没人设过,默认关 —— 也就是说它在生产里**从来没被开过**。注册表原文写「先单-runner canary」,那次 canary 从没发生过;7 月 4 日加的,42 天。它的真实状态是【接线完整但从未启用】,**不是**「被 FLY-1774 取代之后的死代码」—— 这两个状态不一样,不能写混。",
		bucket: "settle",
		strength: "verified",
		note: "HL×Tadashi 收敛(2026-08-15,**结论翻过一次**):先按「有独立调用方就保留」判为留(armer 模块 + plugin.ts:9659 的独立 poller 确实只由它把门);拿到「生产从未启用」这个事实后 Tadashi 改判为**建议退役**。退的理由不是「它没用」,是**「它会误导读代码的人」**:它的意图已经被两个后继机制分食(Codex 停驻唤醒归 FLY-1774 auto-wake、Claude idle 续跑归 detection-gated recovery-nudge),armer+poller 从来没开过 = 从来没被要求证明过自己有必要;留着的唯一效果是让下一个读 plugin.ts 的人以为系统里还有第三条唤醒通道。⚠️ **退役动作本身仍需 Annie 点头,不由 FLY-1778 顺手带掉。**",
	},

	// ─────────────────────────────────────────────────────────────────────
	// 十、Runner 提示词 / skill 框架 / 逐项目能力
	// ─────────────────────────────────────────────────────────────────────
	skill_framework_mode: {
		plain:
			"runner 用哪套 skill 框架。superpowers / matt / bare / bare-ponytail 四条臂,或者 split=按 issue 稳定哈希分流做实验。",
		why: "**被显式设过:`split`。** 这是正在跑的实验形态,秒级可切回 superpowers。",
		bucket: "keep",
		strength: "verified",
	},
	skill_framework_split_participation: {
		plain:
			"split 分流下,这个项目参不参与实验臂。设 false = 这个项目钉回 superpowers。**这是退出杠杆,不是启用开关。**",
		why: "六个项目都是默认 true(都参与)。没人退出过。",
		bucket: "keep",
		strength: "verified",
	},
	doc_flow: {
		plain: "给 runner 的提示词里注入「写部门优先过程文档」那一段。",
		why: "逐项目:joycon-typeless / flywheel / tidal-echo 三个开着,其余三个默认关。是刻意的分布。",
		bucket: "keep",
		strength: "verified",
	},
	proofshot: {
		plain: "视觉验证(ProofShot)的自动触发。",
		why: "六个项目**全部默认关**,从没有项目开过。它依赖浏览器链路,而所有 Lead 的 Chrome 能力也都是关的。",
		bucket: "settle",
		strength: "verified",
		note: "建议:和 lead_chrome_enabled 一起看——两个都全关,说明这条能力线整体没在用。",
	},
	xiaohongshu_learning: {
		plain: "定期小红书收藏学习管线。",
		why: "六个项目**全部默认关**。这条能力在 FLY-222 建好,当前没有项目在用。",
		bucket: "settle",
		strength: "verified",
		note: "建议:确认是暂时不用还是不再用;不再用就归档,别留一个永远关着的项目开关。",
	},
	ponytail: {
		plain: "代码极简 ponytail 的逐项目 rollout。",
		why: "**项目层是 dormant 的**——注册表和代码注释都写明「run-infra 明确不加载它,项目里写了也没用」。这是 Annie 的例外条款。",
		bucket: "keep",
		strength: "verified",
		note: "它是 124 条里唯一一条「登记了但故意不生效」的。保持现状,但要在总表里显式标出来,免得有人以为设了就有用。",
	},

	// ─────────────────────────────────────────────────────────────────────
	// 十一、值型旋钮(不是决定,是数字)
	// ─────────────────────────────────────────────────────────────────────
};

/** 本轮把「值型旋钮 / 纯数字阈值」统一按同一条理由处理,不逐条重复造句。 */
export const VALUE_KNOB_DEFAULT = {
	plain: "数值阈值,不是「要不要做这件事」的决定。",
	why: "没人设过,跑代码默认值。",
	bucket: "keep",
	strength: "default",
};
