/**
 * FLY-1413 — 新增 62 个开关的补审内容(纯人工判断)。
 *
 * 这里 ONLY 放人话与建议。机器事实(现值、生效方式、读点、运行时硬关)一律
 * 只存在于 snapshot.json,由 build-html.mjs 按 `name` 拼接 —— 所以刷新
 * snapshot 不会和这里的文字打架。
 *
 * bucketSuggest: "clear"=清 · "dynamize"=动态化 · "keep"=留 · "unknown"=读不出
 * kind:          "bool"=开关 · "knob"=数值/路径配置 · "enum"=多选一
 *                knob 默认不给「清」选项;deadKnob:true 的例外(喂死巷道)。
 * group:         clear | dynamize_f | dynamize_e | dynamize_knob | keep_direct
 *                | keep_gate | keep_project | keep_percall | keep_qa | keep_path
 *
 * 诚实边界:除死壳那 13 条(research.md §3 有终点取证)外,我没有独立验证
 * 运行时行为;卡片统一标「运行未独立验证」。plain.why 读不出的写 UNKNOWN。
 *
 * 「现状」写的是磁盘上的配置值,不是运行进程内的活值 —— 见 research.md §8。
 */

export const FLAGS = [
	// ═══════════════ 清(14)═══════════════
	{
		name: "checkpoint_watchdog",
		group: "clear",
		bucketSuggest: "clear",
		kind: "bool",
		plain: {
			on: "（设了也没用）本来是：会话卡在等你拍板的检查点超过一小时，先推 runner 自己重试通知你；再一个整窗口还没动静，就在那条 issue 自己的 thread 里叫你。",
			off: "现在的实际情况：这条巡检整条不跑，一次都不会触发。",
			why: "FLY-1393 已经把这条巷道正式退役 —— 代码里的判断函数写死返回「关」，环境变量设成什么都复活不了。生产 .env 里还留着一行 =0，是历史残留。",
		},
		premise:
			"清 = 删这个环境变量 + 删已经不可达的巡检代码。删之前确认没有别的东西还在读它。",
	},
	{
		name: "legacy_delivery_watchdogs",
		group: "clear",
		bucketSuggest: "clear",
		kind: "bool",
		plain: {
			on: "（设了也没用）本来是：回开旧的 Lead 投递告警巷道，给还没迁完的老会话兜底。",
			off: "现在的实际情况：旧告警巷道整条不跑。新的 comm.db 消费循环和它自己的心跳照常工作，不受影响。",
			why: "同一次退役（FLY-1393）。它的判断函数返回类型直接被写死成「假」，留着变量只是为了让真值检查还能认出「运维那边配置过期了」。",
		},
		premise: "它是下面 park_watch 那一串的总闸，一起清。",
	},
	{
		name: "park_watch",
		group: "clear",
		bucketSuggest: "clear",
		kind: "bool",
		plain: {
			on: "（设了也没用）本来是：定期扫一遍有没有会话卡在阻塞、缺门、自己声明停车、QA 挂起这几种情况，该通知 Lead 的通知、该升级给你的升级。",
			off: "现在的实际情况：这条扫描永不启动。",
			why: "它的启动接的就是上面那个总闸，恒关。活着的 Bridge 自己也这么报（/health 里它是 effective_enabled:false）。",
		},
		premise:
			"注意：它同时也在「读点已经是随用随读、只差分类」那一组里 —— 但既然巷道已死，应该走清，不是动态化。",
	},
	{
		name: "park_watch_cadence",
		group: "clear",
		bucketSuggest: "clear",
		kind: "knob",
		deadKnob: true,
		plain: {
			on: "这是「停车扫描多久跑一次」（默认每 20 个轮询周期一次）。",
			off: "不适用 —— 它是个数字，不是开关。",
			why: "唯一读它的就是上面那条已经不跑的扫描。改这个数字不改变任何行为，是个死旋钮。",
		},
	},
	{
		name: "park_watch_n1_ms",
		group: "clear",
		bucketSuggest: "clear",
		kind: "knob",
		deadKnob: true,
		plain: {
			on: "这是「一般的停车放多久之后通知 Lead」（默认 10 分钟）。",
			off: "不适用 —— 数字，不是开关。",
			why: "同上：喂的是已退役的扫描，永远读不到。死旋钮。",
		},
	},
	{
		name: "park_watch_n2_ms",
		group: "clear",
		bucketSuggest: "clear",
		kind: "knob",
		deadKnob: true,
		plain: {
			on: "这是「通知过 Lead 之后再宽限多久，就升级到你的 issue thread」（默认 10 分钟）。",
			off: "不适用 —— 数字，不是开关。",
			why: "同上，死旋钮。",
		},
	},
	{
		name: "park_watch_qa_n3_ms",
		group: "clear",
		bucketSuggest: "clear",
		kind: "knob",
		deadKnob: true,
		plain: {
			on: "这是「健康的 QA / 重测挂起放多久之后，只给 Lead 发一条巡查提示（不惊动你）」（默认 2 小时）。",
			off: "不适用 —— 数字，不是开关。",
			why: "同上，死旋钮。",
		},
	},
	{
		name: "quota_daemon_cutover",
		group: "clear",
		bucketSuggest: "unknown",
		kind: "bool",
		plain: {
			on: "现在开着：账号配额守护进程健康之后，Bridge 里那套旧的换号执行面就退场，换号统一走守护进程一条路。",
			off: "回到「Bridge 内旧执行面 + 守护进程」两套并存的迁移中间态。",
			why: "它是**它自己写明的临时开关**。注册表原话：「临时两阶段迁移 flag；FLY-1284 在 enable 稳定 >=1 周后删除，并同步迁移 KIND_CONTRACTS.usage_limit」。生产已经显式打开了。",
		},
		leadOpinion:
			"我本来想直接建议「清」，但**它自己定的退役条件我没取证**（要「稳定运行 ≥1 周」，而 .env 那行没有日期注释）。给你一个前提没验过的预选结论不合适，所以预选「不确定」。",
		premise:
			"要转「清」需要三样证据：① 这个开关是哪天打开的 ② 守护进程这一周是健康的 ③ KIND_CONTRACTS.usage_limit 的同步迁移做了没。这三样齐了它就是明确的「清」。",
	},
	{
		name: "delivery_ack",
		group: "clear",
		bucketSuggest: "clear",
		kind: "bool",
		plain: {
			on: "（设了也没用）本来是：Lead 收到的事件要签收，没签收就限次提醒，提醒到头还没签就转死信并升级。",
			off: "现在的实际情况：整套签收不跑，投递直接旁路过去。",
			why: "它的判断是「旧投递巷道开着 **并且** 本开关不等于 0」—— 而左边那半 FLY-1393 已经写死成假，所以整个与式恒为假。把本开关设成 1 也复活不了。",
		},
		premise: "和 legacy_delivery_watchdogs 是同一批，一起清。",
	},
	{
		name: "delivery_unconsumed_v2",
		group: "clear",
		bucketSuggest: "clear",
		kind: "bool",
		plain: {
			on: "（设了也没用）本来是：「投递出去没被消费」的判据升级版 —— 停车 / 等审 / 待发布不再算漏，回报里引用了完整指令编号就算已消费。",
			off: "现在的实际情况：这条判据所在的扫描永不运行，新旧判据都不跑。",
			why: "它唯一的生产读点在那条空档扫描里，而那条扫描的启动同样接在已退役的旧投递总闸上，恒关。",
		},
		premise: "同上，一批清。",
	},
	{
		name: "delivery_ack_timeout_ms",
		group: "clear",
		bucketSuggest: "clear",
		kind: "knob",
		deadKnob: true,
		plain: {
			on: "这是「Lead 事件多久没签收就发第一条提醒」（默认 5 分钟）。",
			off: "不适用 —— 数字，不是开关。",
			why: "只被那个已经禁用的签收协调器在构造时读一次。协调器全仓只有一个实例、而且是关的 —— 死旋钮。",
		},
	},
	{
		name: "delivery_max_redeliver",
		group: "clear",
		bucketSuggest: "clear",
		kind: "knob",
		deadKnob: true,
		plain: {
			on: "这是「最多推几次签收提醒，就转死信并升级」（默认 5 次）。",
			off: "不适用 —— 数字，不是开关。",
			why: "同上，喂的是同一个已禁用的协调器 —— 死旋钮。",
		},
	},
	{
		name: "delivery_max_transport_failures",
		group: "clear",
		bucketSuggest: "clear",
		kind: "knob",
		deadKnob: true,
		plain: {
			on: "这是「传输失败几次就转死信并升级」（默认 5 次）。",
			off: "不适用 —— 数字，不是开关。",
			why: "同上，死旋钮。",
		},
	},
	{
		name: "ack_late_window_ms",
		group: "clear",
		bucketSuggest: "clear",
		kind: "knob",
		deadKnob: true,
		plain: {
			on: "这是「已经确认叫过你之后，多久之内的迟到签收还认」（默认 24 小时）。",
			off: "不适用 —— 数字，不是开关。",
			why: "同上，死旋钮。",
		},
	},

	// ═══════════════ 动态化 · F 组:读点已就位(14)═══════════════
	{
		name: "receipt_foundation",
		group: "dynamize_f",
		bucketSuggest: "dynamize",
		kind: "bool",
		plain: {
			on: "Lead 的防漏收据闭环全跑：入账、投递、到期提醒、重发、升级。",
			off: "只暂停「到期提醒 / 重发 / 升级」三样；入账和投递照常，Bridge 也不会替 Lead 代答。而且一开机就告警、之后每小时刷一次，提醒你现在是事故态。",
			why: "默认开。这是事故时的紧急回退阀，注册表明说「不得作为常态运行方式」。",
		},
		leadOpinion:
			"紧急阀却要重启 Bridge 才生效 —— 事故当下最不想做的事就是重启。代码里它已经是随用随读，差的只是注册表把它标成只读，而那是**故意**的（不想让人随手切）。所以这条要你拍的是政策不是技术：保持「必须慎重」，还是改成「能秒切、但切了就大声告警」。",
	},
	{
		name: "receipt_activation_dry_run",
		group: "dynamize_f",
		bucketSuggest: "dynamize",
		kind: "bool",
		plain: {
			on: "收据启用的演练模式：只算不提交 —— 算出哪些该追、容量多大，但不真的下发期限和催办。",
			off: "正式模式，该下发就下发。",
			why: "默认关。它是给容量验收和回滚演练用的，注册表明说正式启用时必须保持关闭。",
		},
		leadOpinion: "演练本来就该随开随关，现在开一次演练要重启一次 Bridge。",
	},
	{
		name: "park_biased_handoff",
		group: "dynamize_f",
		bucketSuggest: "dynamize",
		kind: "bool",
		plain: {
			on: "交接的时候，如果按名字找不到那个窗口，判「停车」而不是「关掉」。因为找不到窗口不等于人死了 —— 窗口名过时的健康 runner 也会这样。",
			off: "回到 FLY-1319 事故之前的行为：找不到就直接关掉。",
			why: "默认开，是那次事故的修复。",
		},
		leadOpinion: "事故回退阀，现在要重启才生效。",
	},
	{
		name: "prune_park_guard",
		group: "dynamize_f",
		bucketSuggest: "dynamize",
		kind: "bool",
		plain: {
			on: "声明了停车的会话，可以否决两种破坏性清扫：把「标记完成但还在跑」的强转成完成、以及删 CommDB 里的记录行。",
			off: "回到没有否决的老清扫，只剩人手维护的排除名单挡着。",
			why: "默认开。它取代的就是「靠人记得往名单里加名字」那种保护。",
		},
		leadOpinion: "回退阀，要重启。",
	},
	{
		name: "readopt_parked_roles",
		group: "dynamize_f",
		bucketSuggest: "dynamize",
		kind: "bool",
		plain: {
			on: "Bridge 重启后重新接管会话时，四种停车状态全认（在跑 / 等审 / 设计完成 / 待发布）。",
			off: "只认「在跑」—— 而保活模式下每个角色停在不同状态，只认「在跑」恰好把所有会停车的角色全漏掉。",
			why: "默认开，就是补那个漏洞的。（已经结束的会话永远不进候选 —— 重新接管一个终态等于复活死人。）",
		},
		leadOpinion: "回退阀，要重启。",
	},
	{
		name: "codex_gate_wait",
		group: "dynamize_f",
		bucketSuggest: "dynamize",
		kind: "bool",
		plain: {
			on: "Codex 常驻目标遇到「必须有人答」的门时保活等着，门答完接着往下走。",
			off: "回到遇到门就判定为阻塞终态（这一轮就废了）。",
			why: "默认开。",
		},
		leadOpinion: "回退阀，要重启 Bridge 才生效。",
	},
	{
		name: "quota_degraded_switch",
		group: "dynamize_f",
		bucketSuggest: "dynamize",
		kind: "bool",
		plain: {
			on: "允许配额守护进程执行「已经在它自己配置里开启的」受控降级换号。",
			off: "立刻压制，一次都不换。",
			why: "默认开。",
		},
		leadOpinion:
			"⚠️ 这条我建议排最前面：注册表原话是「=0 **立即**压制」，但实际改完并不会立刻生效 —— **说的和做的对不上**。号出问题时你会以为改一行就压住了，其实没有。读它的是**独立的配额守护进程**（不是 Bridge），要那个进程重启才算数。",
	},
	{
		name: "three_stage_codex_design_toggle",
		group: "dynamize_f",
		bucketSuggest: "dynamize",
		kind: "bool",
		plain: {
			on: "新开的三段式任务，设计那一段默认交给 Codex（gpt-5.6-sol，xhigh）。",
			off: "设计那一段默认交给 Claude / Fable。",
			why: "生产显式关着。注意它只在「新任务开始、且这次没单独指定设计用谁」时起作用；已经锁进某个任务的不受影响，单次派发指定的优先级更高。",
		},
		leadOpinion:
			"你换设计模型的频率不低，而现在改完要跑 restart-services.sh --bridge-only 才算数。",
	},
	{
		name: "issue_gate_supersede_mode",
		group: "dynamize_f",
		bucketSuggest: "dynamize",
		kind: "enum",
		plain: {
			on: "三档：enforce = 真的去收敛重复的 issue 门；observe = 只记录不动手；0 = 停止新的改写。",
			off: "设成 0 只停「新的」改写 —— 已经写下的记录永久有效，不会回滚。",
			why: "默认 enforce。",
		},
		leadOpinion:
			"三档之间切换现在要重启。它是有明确取值集合的多选一，技术上完全可以进控制台秒切（控制台已经支持枚举型）。",
	},
	{
		name: "ask_hygiene",
		group: "dynamize_f",
		bucketSuggest: "dynamize",
		kind: "bool",
		plain: {
			on: "runner 收尾的时候，把挂在它名下、没人回答的提问清掉（关闭时级联 + 巡检兜底扫一遍）。",
			off: "回到今天之前的老路径，门的记录里「最后是怎么解决的」那一栏留空。",
			why: "默认开。",
		},
		leadOpinion: "回退阀，要重启。",
	},
	{
		name: "stuck_pane_confirm",
		group: "dynamize_f",
		bucketSuggest: "dynamize",
		kind: "bool",
		plain: {
			on: "判定「卡住」并发告警之前，先看窗口和进程的实际证据（探活 → 连拍两帧 → 让模型判），只有拿到明确「健康」的证据才压住不报。",
			off: "少这层确认，直接按心跳判 —— 误报会变多。",
			why: "默认开，是专门压误报的。",
		},
		leadOpinion: "告警吵起来的时候你会想立刻调这个 —— 现在要重启。",
	},
	{
		name: "commdb_protection",
		group: "dynamize_f",
		bucketSuggest: "dynamize",
		kind: "bool",
		plain: {
			on: "「还没被回答、而且确实该有人管」的记录，在过期、收尾、清理这三条路上都保住不删。",
			off: "按老规矩该清就清（该有人管的事可能被顺手清掉）。",
			why: "默认开。",
		},
		leadOpinion: "回退阀，要重启。",
	},
	{
		name: "zombie_reconcile",
		group: "dynamize_f",
		bucketSuggest: "dynamize",
		kind: "bool",
		plain: {
			on: "僵尸会话探真：窗口探活分三态，连续两轮都「服务在、但找不到这个窗口」才宣告失败，并给 Lead 一份「这些活没推出去」的清单。",
			off: "逐字节回到旧的重新接管行为。",
			why: "默认开。它和另外两个开关合成一个判断，不是单独起效。",
		},
		leadOpinion: "回退阀，要重启。",
	},
	{
		name: "disposition_receipt",
		group: "dynamize_f",
		bucketSuggest: "dynamize",
		kind: "bool",
		plain: {
			on: "Lead 处置完一条检测告警之后，在那条 issue 的 thread 里落一条你看得见的回执。",
			off: "不投回执 —— 但处置本身照样记账，重新打开还能补最近 7 天的。",
			why: "默认开。它只管「投不投」，不管「记不记」。",
		},
		leadOpinion: "回退阀，要重启。",
	},

	// ═══════════════ 动态化 · E 组:读点真在启动/构造时捕获(9)═══════════════
	{
		name: "watchdog_liveness",
		group: "dynamize_e",
		bucketSuggest: "dynamize",
		kind: "bool",
		plain: {
			on: "W-1 进程存活探测：进程没了会叫人。",
			off: "这类不叫。",
			why: "默认开，是看门狗最小集的第一根。",
		},
		leadOpinion:
			"这一组和上面 F 组不同：它是真的在 Bridge 启动那一刻读一次就焊死了，要动态化得改读点，工作量比 F 组大。",
	},
	{
		name: "watchdog_loop_heartbeat",
		group: "dynamize_e",
		bucketSuggest: "dynamize",
		kind: "bool",
		plain: {
			on: "W-2：Lead 收件箱的投递循环有一条独立心跳，循环本身卡住也能被发现（不靠别的信号）。",
			off: "少这条独立心跳。",
			why: "默认开。",
		},
	},
	{
		name: "watchdog_blocked",
		group: "dynamize_e",
		bucketSuggest: "dynamize",
		kind: "bool",
		plain: {
			on: "W-4「活着但干不了活」：Lead 那半看阻塞关键字，Runner 那半看会话卡住信号。",
			off: "这类不报。",
			why: "默认开 —— 这是你自己裁定的：宁愿误报，不希望不报。",
		},
		leadOpinion:
			"它现在是「半动态」：Runner 那半下一次检查就生效，Lead 那半要重启。同一个开关两种脾气，该拉齐。",
	},
	{
		name: "commdb_residue_harvest",
		group: "dynamize_e",
		bucketSuggest: "dynamize",
		kind: "bool",
		plain: {
			on: "Bridge 启动时清一遍残渣：只登记在一边的孤儿会话、状态库里的幽灵、没主的检测升级。",
			off: "不清 —— 残渣会一直堆着。",
			why: "默认开。",
		},
	},
	{
		name: "terminal_commdb_sync",
		group: "dynamize_e",
		bucketSuggest: "dynamize",
		kind: "bool",
		plain: {
			on: "状态库里「失败 / 阻塞」这种终态，异步同步回 CommDB，两边不打架。",
			off: "不同步 —— 上面那种残渣会重新长出来（这条是根因层，上面那条是收拾层）。",
			why: "默认开。",
		},
	},
	{
		name: "terminal_thread_archive",
		group: "dynamize_e",
		bucketSuggest: "dynamize",
		kind: "bool",
		plain: {
			on: "一条 issue 全部段落结束 + Linear 标了 Done + 窗口已关 → 它的 thread 分钟级自动归档。",
			off: "两条入队路都不入队，只剩 6 小时一次的兜底扫描 —— thread 会在频道里挂很久。",
			why: "默认开。",
		},
	},
	{
		name: "lead_dual_active_scan",
		group: "dynamize_e",
		bucketSuggest: "dynamize",
		kind: "bool",
		plain: {
			on: "同一个 Lead 被起了两份的时候立刻告警，并标记后起的那个。",
			off: "应急停用这条检测。",
			why: "默认开。",
		},
		leadOpinion:
			"⚠️ 又一处「说的是应急、做的要重启」：注册表写「=0 应急停用」，同一句里又注明「改后需重启 Bridge」。",
	},
	{
		name: "cmux_linked_view",
		group: "dynamize_e",
		bucketSuggest: "unknown",
		kind: "bool",
		plain: {
			on: "cmux 的受管标签页用「一个标签对一个窗口」的拓扑（FLY-1272 的修复）。",
			off: "回到修复之前的「分组」老拓扑。",
			why: "**UNKNOWN —— 我读不出来。** 注册表默认是开，但生产 .env 里被显式设成了关；那一行没有注释，整个仓库里也搜不到任何地方记录为什么要关它。要问 Tadashi。",
		},
		leadOpinion:
			"我把它标成「不确定」而不是替它编一个理由。同一批里 cmux_view_invariant 反而是开着的（和默认一致），两条放一起更像是有意为之的中间态 —— 但没有证据，所以不写成结论。",
	},
	{
		name: "claude_account_identity_check",
		group: "dynamize_e",
		bucketSuggest: "dynamize",
		kind: "bool",
		plain: {
			on: "对 Claude 的当前号 / 候选号 / 切换动作 / 写进凭据池这四处，做一次「这个号真是它自称的那个号吗」的核验。",
			off: "不核验。",
			why: "默认关，而且是有明确原因地关着：注册表写明启用前必须先灌可信的号-标签映射并跑一次审计，否则会把好号误标成不匹配。",
		},
		leadOpinion:
			"读它的是**配额守护进程 + 一个独立的命令行工具**，都不是 Bridge —— 所以要开它得重启守护进程（命令行那半下次调用就生效）。真要启用那天，你会希望是「灌完映射、审计过、然后一键开」而不是「还得挑个能重启的时间」。",
	},

	// ═══════════════ 动态化 · 数值旋钮(3)═══════════════
	{
		name: "liveness_activity_window_ms",
		group: "dynamize_knob",
		bucketSuggest: "dynamize",
		kind: "knob",
		plain: {
			on: "这是「停车告警的正文里，拿多久之内有没有活动来判断『大概还活着 / 大概已经死了』」的时间窗（默认 10 分钟）。",
			off: "不适用 —— 数字，不是开关。",
			why: "默认值在跑。**它只影响那句话怎么写，绝不影响任何生死裁决** —— 活动证据是故意不作为裁决输入的。",
		},
		leadOpinion:
			"纯措辞旋钮，却要重启才能调。这类是动态化里风险最低的一批（调错了最多是话说得不准，不会误杀会话）。",
	},
	{
		name: "ship_ready_remind_ms",
		group: "dynamize_knob",
		bucketSuggest: "dynamize",
		kind: "knob",
		plain: {
			on: "这是「工作流停在等你拍板的门口多久之后，去提醒 Lead」（默认 30 分钟）。",
			off: "不适用 —— 数字，不是开关。",
			why: "默认值在跑。",
		},
		leadOpinion: "你嫌吵或者嫌慢想调它的时候，现在得重启。",
	},
	{
		name: "ghost_guard_wait_ms",
		group: "dynamize_knob",
		bucketSuggest: "dynamize",
		kind: "knob",
		plain: {
			on: "这是「起了一个 runner 之后，等多久来确认『投递 + 会话』真的建起来了」（默认 90 秒），超时就当幽灵处理。",
			off: "不适用 —— 数字，不是开关。",
			why: "默认值在跑。",
		},
	},

	// ═══════════════ 留 · 已经能秒切(15)═══════════════
	{
		name: "quota_daemon_wake",
		group: "keep_direct",
		bucketSuggest: "keep",
		kind: "bool",
		plain: {
			on: "Bridge 收到可信的「配额到顶」信号后，立刻把守护进程叫醒去处理，不用等它自己下一轮。",
			off: "不发这个唤醒信号，等守护进程自己轮到。",
			why: "默认开，而且**已经能秒切** —— 改了立刻生效，不用重启。",
		},
	},
	{
		name: "review_severity_policy_killswitch",
		group: "keep_direct",
		bucketSuggest: "keep",
		kind: "bool",
		plain: {
			on: "跨家族的审查收敛政策：中 / 低级别的意见不阻塞流程，并且尊重 Lead 已经裁决过的意见（不重复纠缠）。",
			off: "回到旧的判定方式。",
			why: "默认开，已经能秒切。",
		},
	},
	{
		name: "founder_review_gate_exclude",
		group: "keep_direct",
		bucketSuggest: "keep",
		kind: "bool",
		plain: {
			on: "你回一个单字母的时候，不把「设计评审 / 代码评审」这两种门算进候选，免得一个字误答到评审门上。",
			off: "回到旧的候选集合（这两种门也会被单字母命中）。",
			why: "默认开，已经能秒切。",
		},
	},
	{
		name: "retest_head_delta_guard",
		group: "keep_direct",
		bucketSuggest: "keep",
		kind: "bool",
		plain: {
			on: "代码没变就不重复跑重测 —— 拿不可变的 QA 判定基准和精确的区间 diff 比。",
			off: "每次都重新跑一遍。",
			why: "默认开，已经能秒切。",
		},
	},
	{
		name: "ship_ready_notify",
		group: "keep_direct",
		bucketSuggest: "keep",
		kind: "bool",
		plain: {
			on: "非 land 类的工程工作流停在你的门口时，同时通知负责的 Lead 和你的 issue thread 两路。",
			off: "不做这个双路宣告。",
			why: "默认开，已经能秒切。",
		},
	},
	{
		name: "engine_dead_exec_sweep",
		group: "keep_direct",
		bucketSuggest: "keep",
		kind: "bool",
		plain: {
			on: "DAG 里执行体死掉之后的恢复扫描 —— 发现死的，决定要不要换一个补上。",
			off: "暂停新的替补决定（已经在跑的照常收敛）。",
			why: "默认开，已经能秒切。",
		},
	},
	{
		name: "workflow_rework_reentry",
		group: "keep_direct",
		bucketSuggest: "keep",
		kind: "bool",
		plain: {
			on: "QA 或者你打回的时候，让原来那个执行体重新进场返工（它有上下文，比新起一个省）。",
			off: "挂起并告警，既不驱逐也不新起 —— 等人来处理。",
			why: "默认开，已经能秒切。",
		},
	},
	{
		name: "engine_unlaunched_tripwire",
		group: "keep_direct",
		bucketSuggest: "keep",
		kind: "bool",
		plain: {
			on: "工作流重试被卡住、或者「准了却一直没起来」的时候，告警 + 围栏 + 恢复。",
			off: "不管这类。",
			why: "默认开，已经能秒切。",
		},
	},
	{
		name: "skill_framework_mode",
		group: "keep_direct",
		bucketSuggest: "keep",
		kind: "enum",
		plain: {
			on: "Runner 用哪套技能框架：superpowers（原来的默认）/ matt / bare / split（按 issue 稳定哈希分流，做 A-B 对比）。",
			off: "设回 superpowers 就是停实验。",
			why: "生产现在是 split，在跑对比实验。**已经能秒切**，改了不用重启；已经在跑的会话不会被追改。",
		},
		leadOpinion:
			"实验杆，等对比出结论再定去留 —— 现在留。它是这 62 个里唯一一个「本来就设计成随时能停」的实验开关，可以当模板。",
	},
	{
		name: "workflow_template_dispatch",
		group: "keep_direct",
		bucketSuggest: "keep",
		kind: "bool",
		plain: {
			on: "工作流走「候选优先」的类型化快照引擎来派发任务。生产已经打开。",
			off: "逐字节回到老的派发方式。",
			why: "默认是关的，生产显式打开了。要真跑起来还得配合下面 claims 的读写两个开关。",
		},
		leadOpinion:
			"按「已经全量开着就该固化」的规矩，它像清理对象。但它是 FLY-1344 明确交给你控制的 DAG 杆，而 v2 那半（下面的 generalized_templates）还关着 = **上线在半途**。现在退休它等于上线中途把方向盘拆了。建议：DAG v2 收尾之后再转「清」，一批三个一起。",
	},
	{
		name: "land_node",
		group: "keep_direct",
		bucketSuggest: "keep",
		kind: "bool",
		plain: {
			on: "引擎自己管 land 这一步：批准过的合并 → 关会话 → 清 worktree → 标 Done / 归档。",
			off: "停止新的 land 启动；已经认领的那些继续跑完。",
			why: "默认开，已经能秒切。",
		},
	},
	{
		name: "workflow_generalized_templates",
		group: "keep_direct",
		bucketSuggest: "keep",
		kind: "bool",
		plain: {
			on: "打开 schema v2 的选型、准入、提交三处。",
			off: "默认关 —— 路由逐字节保持老样子。（v2 的模板其实一直在装、在发布，只是不绑就不用。）",
			why: "默认关，生产也没开。这是 DAG v2 上线的下一步，前置条件（一个固定的、真实全新起号的端到端验证）没过之前不能开。",
		},
		leadOpinion:
			"这是三个 DAG 杆里唯一还没扳的那根。它关着 = 上线没走完 —— 也正是我建议另外两根先别退休的理由。",
	},
	{
		name: "workflow_vendor_at_dispatch",
		group: "keep_direct",
		bucketSuggest: "keep",
		kind: "bool",
		plain: {
			on: "每个工作流节点在真正启动的那一刻，按「当前批准的派发配置」解析用谁 —— 而不是按任务开始时钉死的那份快照。",
			off: "立刻回到钉死的快照。",
			why: "默认开，已经能秒切。注册表明说它只作紧急逃生用。",
		},
	},
	{
		name: "workflow_claims_write",
		group: "keep_direct",
		bucketSuggest: "keep",
		kind: "bool",
		plain: {
			on: "工作流的 claims 影子写入 + 已登记任务的执行准入。生产已经打开。",
			off: "不写。",
			why: "默认关，生产显式打开了。任务开始时会把开关状态锁住，非开始阶段的钩子和重测是随用随读。",
		},
		leadOpinion: "和 template_dispatch 同一批 —— DAG v2 收尾后一起转「清」。",
	},
	{
		name: "workflow_claims_read",
		group: "keep_direct",
		bucketSuggest: "keep",
		kind: "bool",
		plain: {
			on: "已登记的持久三段式任务，改成用 claims 来判「能不能发布」和读权威的代码基准。生产已经打开。",
			off: "回到老的判定路径。",
			why: "默认关，生产显式打开了。Bridge 和命令行两边都是权威消费者。",
		},
		leadOpinion: "和上面两根同一批 —— DAG v2 收尾后一起转「清」。",
	},

	// ═══════════════ 留 · 治理门(2)═══════════════
	{
		name: "design_html_gate",
		group: "keep_gate",
		bucketSuggest: "keep",
		kind: "bool",
		plain: {
			on: "设计那一段完成之前，必须交一份这条 issue 自己的设计 HTML，而且要带上和当前代码绑定的可信证据。",
			off: "运维应急放行（跟这条任务走不走三段式无关）。",
			why: "默认开。",
		},
		leadOpinion:
			"这是**治理门**：按规矩治理门永远不进批量切换、也永远不做成随手可切 —— 能随手关的门不叫门。留，且保持只读。",
	},
	{
		name: "lead_lease_bypass",
		group: "keep_gate",
		bucketSuggest: "keep",
		kind: "bool",
		plain: {
			on: "紧急绕过 Lead 身份租约的写授权 —— 会强告警 + 留审计痕迹。",
			off: "默认关，正常走租约。",
			why: "默认关。它是「打开 = 放宽管控」型的例外，和大多数「打开 = 更安全」的开关方向相反。",
		},
		leadOpinion: "治理门，留，且保持只读。",
	},

	// ═══════════════ 留 · 其余(5)═══════════════
	{
		name: "skill_framework_split_participation",
		group: "keep_project",
		bucketSuggest: "keep",
		kind: "bool",
		plain: {
			on: "在 split 分流实验下，这个项目参与实验组。",
			off: "这个项目钉回 superpowers，不参与实验。",
			why: "6 个项目现在全是默认（参与）。**这是退出杠杆，不是启用开关** —— 改成 false 是把某个项目摘出来，不是把实验打开。",
		},
		leadOpinion:
			"它是逐项目配置，改配置文件就生效、不用重启 —— 已经是我们想要的形态，可以当扩大化的模板。",
	},
	{
		name: "cmux_view_invariant",
		group: "keep_percall",
		bucketSuggest: "keep",
		kind: "bool",
		plain: {
			on: "校验受管视图当前激活的到底是哪个窗口，并用「不破坏账本」的方式修回去。",
			off: "不校验、不修。",
			why: "默认开，生产也显式设成开（和默认一致）。",
		},
		leadOpinion:
			"它只被 cmux 那两个脚本读，每次调用现读 —— **已经是「下次调用就生效」，本来就不用重启**。所以它不属于要动态化的那批。",
	},
	{
		name: "ship_ci_guard",
		group: "keep_percall",
		bucketSuggest: "keep",
		kind: "bool",
		plain: {
			on: "在批准门和最终发布权限那两处，即时查一次 GitHub 的 CI 状态。",
			off: "紧急旁路掉 GitHub 这条证据线 —— 只在 GitHub / gh 本身挂了的时候用。",
			why: "默认开。",
		},
		leadOpinion:
			"由每次命令行调用现读 —— 同样已经是「下次调用就生效」，不用重启。不属于动态化对象。",
	},
	{
		name: "voice_qa_presence_override",
		group: "keep_qa",
		bucketSuggest: "keep",
		kind: "bool",
		plain: {
			on: "语音端到端测试专用的接缝：打开时把「founder 在场」当成已满足，好让无人值守的声学测试跑得下去。",
			off: "正常判定在场与否。",
			why: "默认关，生产永不置位。而且加了硬保险：一旦置位又指向生产 Bridge 地址，启动直接拒绝。",
		},
		leadOpinion:
			"测试专用接缝，留。**但不该把它做成能随手切** —— 那等于削弱那道硬保险。这条明确不进动态化。",
	},
	{
		name: "delivery_secret_path",
		group: "keep_path",
		bucketSuggest: "keep",
		kind: "knob",
		plain: {
			on: "这是「签收凭据用的那把 HMAC 密钥文件放在哪」（默认 ~/.flywheel/delivery-secret，权限 0600）。",
			off: "不适用 —— 路径，不是开关。",
			why: "默认路径在跑。",
		},
		leadOpinion:
			"**这是路径配置，不是开关。** 而且跑着的时候改它会让在途的签收凭据全部失效 —— 所以它不该做成热改，留在只读是对的。",
	},
];

/**
 * 附录:4 个「代码里当开关用、却没注册进 registry」的环境变量。
 * 它们不属于「新增 62」——压根没登记过,所以单列一节,不进 62 条的计数。
 * 机器事实不走 snapshot(registry 里没有它们),现值在这里如实标注并注明取证点。
 *
 * Codex design review R1 HIGH-3:这 4 条**不是一类东西**,不能给同一套选项。
 * `kind` 区分三类,决定给哪几个选项:
 *   "product_flag" —— 真的是功能开关、真的该登记 → 补登记 / 就地清掉 / 不确定
 *   "ops_lever"    —— 内部运维 rollout 杆,可以问要不要转正,但不是漏登记
 *   "internal_seam"—— 刻意不登记的内部接缝(QA 故障注入 / 会碰真人 Chrome 的回收)
 *                     **不给「补登记到控制台」这个选项** —— 那正是它们不该有的东西
 */
export const DRIFT = [
	{
		envVar: "FLYWHEEL_ALERT_ROUTING",
		kind: "ops_lever",
		current: "生产 .env 里 =1(开着)",
		evidence:
			'packages/teamlead/src/bridge/infra-event-router.ts:162 —— process.env.FLYWHEEL_ALERT_ROUTING === "1";真值白名单 truth.ts:282 写的是「internal ops lever … default-off (FLY-927)」',
		plain: {
			on: "告警按「谁负责」来路由，并对 /send 做门控。",
			off: "不路由，走原来的直通。",
			why: "生产开着（2026-07-09 那批 enable window 打开的）。白名单里它的定位是**内部运维 rollout 杆**，注释只说部署稳了之后「考虑」转正 —— 所以它不算漏登记，是还没转正。要问你的是：现在转正吗？",
		},
	},
	{
		envVar: "FLYWHEEL_ALERT_TICKETS",
		kind: "ops_lever",
		current: "生产 .env 里 =1(开着)",
		evidence:
			"packages/teamlead/src/LeadAlertNotifier.ts:684 + packages/teamlead/src/bridge/stuck-escalation.ts:582;truth.ts:284 同样标为 internal ops lever",
		plain: {
			on: "告警带 🎫 工单头、@ 上责任人、并带生命周期。**注意这不只是排版**：打开之后系统不再立刻叫你，改成先走工单生命周期，两轮自动恢复尝试都没救回来才由 T2 升级叫你。",
			off: "普通告警没有工单结构，但**卡住时是立刻叫你**。",
			why: "生产开着，定位是内部运维杆而不是漏登记。要问的是「转正吗」—— 而且因为它改的是「多久叫你」，这条值得你单独看一眼。",
		},
	},
	{
		envVar: "FLYWHEEL_QUOTA_QA_INJECTION",
		kind: "internal_seam",
		current: "生产没设(关)",
		evidence:
			"packages/teamlead/src/account-heal/quota-monitor-runtime.ts:444 / :454;truth.ts:131 明写「internal QA-only safety lever」——要 env=1 **加上** 隔离窗口标记才生效",
		plain: {
			on: "配额守护进程的 QA 故障注入接缝：显式 =1 **而且**窗口带隔离标记，两个条件都满足才真的注入故障。",
			off: "不注入。",
			why: "它是**刻意不登记**的测试接缝，不是漏登记。把故障注入放进控制台等于给它一个不该有的入口 —— 所以这条不提供「补登记」。",
		},
	},
	{
		envVar: "FLYWHEEL_CHROME_REAPER_MIGRATE_UNATTRIBUTED",
		kind: "internal_seam",
		current: "生产没设(关)",
		evidence:
			"packages/teamlead/src/bridge/plugin.ts:6468;truth.ts:190 明写「internal ops lever: opt-in reap of unattributed Chrome, default off (FLY-766)」",
		plain: {
			on: "允许回收那些「认不出是谁的」Chrome 进程。",
			off: "只回收认得出归属的，认不出的只打日志不动手。",
			why: "认不出归属的 Chrome **有可能是你自己开的窗口**。这条刻意留在代码里当运维接缝、不进控制台，是对的 —— 所以同样不提供「补登记」。",
		},
	},
];
