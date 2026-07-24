/**
 * FLY-1413 — 收敛版 tab 的「裁决」数据(纯人工内容)。
 *
 * 背景:Annie 把流程从「她逐条圈 62 个」改成「HL + Tadashi 先 align 出每条该是
 * 什么值,再给她收敛版」。所以这份不是圈选页,是**待她拍**的裁决汇总。
 *
 * 这里 ONLY 放裁决与人话。所有机器事实(现值、是否显式设过、死壳取证、进程归属)
 * 一律来自 snapshot.json,由 build-tab.mjs 按 name 拼 —— 跟主页面同一条纪律。
 *
 * 口径铁律(Lead 两次要求):
 *  · **别把回忆写成结论** —— Tadashi 的回忆要标成回忆;
 *  · **也别把事实降级成回忆** —— 标错方向同样是标错,会低估证据强度。
 *    所以行标签 `recollectionLabel` **按条走**,不共用。
 */

/** 9 条在生产 .env 里被显式设过值的 —— Tadashi 逐条裁决。 */
export const EXPLICIT_RULINGS = [
	{
		name: "checkpoint_watchdog",
		ruling: "同意删",
		rulingKind: "delete",
		note: "Tadashi:追到终点调用点的取证比他的记忆强,无异议。",
	},
	{
		name: "three_stage_codex_design_toggle",
		ruling: "保持(关)",
		rulingKind: "keep",
		note: "design 后端改走每单显式 designBackend,全局开关维持关。",
	},
	{
		name: "skill_framework_mode",
		ruling: "保持(split)",
		rulingKind: "keep",
		note: "现行 shipped 形态。",
	},
	{
		name: "workflow_template_dispatch",
		ruling: "保持 —— 不许动",
		rulingKind: "frozen",
		note: "它不只是「保持」:同时是 **FLY-1436 应急 containment 的急停杆**。",
	},
	{
		name: "workflow_claims_write",
		ruling: "保持(在用)",
		rulingKind: "keep",
		note: "",
	},
	{
		name: "workflow_claims_read",
		ruling: "保持(在用)",
		rulingKind: "keep",
		note: "",
	},
	{
		name: "cmux_view_invariant",
		ruling: "保持",
		rulingKind: "keep",
		note: "FLY-1364 修复域的护栏。",
	},
	{
		name: "cmux_linked_view",
		ruling: "维持 0,待重测",
		rulingKind: "unknown",
		note: "见下面「两条说不清的」。",
		crossRef: "unknown",
	},
	{
		name: "quota_daemon_cutover",
		ruling: "先别删,单独取证",
		rulingKind: "unknown",
		note: "见下面「两条说不清的」。",
		crossRef: "unknown",
	},
];

/** 2 条 UNKNOWN —— 按 Tadashi 原话的诚实口径,回忆标成回忆。 */
export const UNKNOWNS = [
	{
		name: "cmux_linked_view",
		headline: "为什么关着 —— 没有任何书面原因",
		evidence:
			"Tadashi 查过 env 注释、git 历史、以及他自己的 memory,**都没有**记录。",
		recollectionLabel: "Tadashi 的回忆(不是证据)",
		recollection:
			"某次 cmux 不稳定期间关掉的(linked-view 同步在 cmux-sync 那族 bug 下会出乱子)。",
		recollectionCaveat: "这是**回忆,不是证据** —— 不作为结论写。",
		decision: "维持 0。待 FLY-1364 ship 之后重测再定。",
	},
	{
		name: "quota_daemon_cutover",
		headline: "退役条件今天正好到期,但「稳定」没人作证",
		evidence:
			"启用日期 ≈ **07-15**(取证:07-14 cutover 落地 commit「retire bridge switch pipeline」+ 07-15 config 注册,随 FLY-1182 PR #615 部署)。",
		recollectionLabel: "为什么先别删(退役条件与实况)",
		recollection:
			"它自己注册表里写的退役条件是「enable 稳定 ≥1 周后删除」—— 按 07-15 算,**今天正好满一周**。",
		recollectionCaveat:
			"但「**稳定**」这一半没人作证 —— **本周有过账号池污染**。满一周 ≠ 稳定满一周。(这两条都是事实:前者是注册表原文,后者是发生过的事件 —— 不是回忆。)",
		decision: "**删除动作单独取证后再做,不在 1413 顺手删。**",
	},
];

/** 死壳的两档 —— 7 条一直无异议 + 6 条经取证后 Tadashi 签字升级。两档现均为「确认可删」。 */
export const DEAD_SPLIT = {
	settled: {
		title: "7 条:Tadashi 一开始就确认无读者,无异议",
		names: [
			"legacy_delivery_watchdogs",
			"checkpoint_watchdog",
			"park_watch",
			"park_watch_cadence",
			"park_watch_n1_ms",
			"park_watch_n2_ms",
			"park_watch_qa_n3_ms",
		],
		note: "park 家族 5 条 + 总闸 legacy_delivery_watchdogs + checkpoint_watchdog。",
	},
	pending: {
		title: "6 条 delivery 家族:Tadashi 已签字升级 → 确认可删",
		names: [
			"delivery_ack",
			"delivery_unconsumed_v2",
			"delivery_ack_timeout_ms",
			"delivery_max_redeliver",
			"delivery_max_transport_failures",
			"ack_late_window_ms",
		],
		note: "Tadashi 点名要求:名字太像 FLY-1279 的 durable ACK,不想靠印象赌它们无关。已按他要求逐层取证(见下)。",
		verification: [
			"**全仓穷举读点**:排除 dist / 测试 / registry / truth 后,只有 3 个文件读这 6 个 —— `lead-event-delivery.ts`(4 个数值旋钮,都在 coordinator 构造函数里)、`lead-event-ack-policy.ts:13`、`plugin.ts:4459 / 4537 / 7213`。",
			"**每个读点的闸**:四处**全部**与 `legacyDeliveryWatchdogsOn` 相与。(`plugin.ts:4459` 是这次穷举才发现的读点,同样被闸住。)",
			"**总闸的实现**:`legacyDeliveryWatchdogsEnabled(env): false` → `watchdog-minimum-set.ts:41` `retiredWatchdogLaneEnabled(_env, _envVar): false { return false; }` —— 参数带下划线 = 根本不看,**返回类型就写死成 false**。",
			"**现行活通路读不读**(这层才真正回答顾虑):`plugin.ts:4471` 注释写明「FLY-1373: comm.db is now the one durable Lead-delivery authority」。活的是 `LeadInboxRuntime`(`plugin.ts:4484` **无条件构造**,不在任何 legacy 闸里);`lead-inbox-loop.ts` 读的 `FLYWHEEL_*` 数 = **0**,`lead-inbox-runtime.ts` 命中这 6 个 = **0**;它走的是另一个 flag `receipt_foundation`(FLY-1392),跟这 6 个无关。",
		],
		verdict:
			"「旧的死了」+「新的不读」两面都证到了。**Tadashi 已签字,从「待验」升级为「确认可删」** —— 他写的理由是:「不是名字像不像的印象判断,是终点取证」。上面四层保留在这里,因为那正是它被升级的依据。",
	},
};

/**
 * Tadashi 的生产实况复核结果 —— **按他自己定的口径记**。
 * 他的原话是「暂时没发现哪条默认值与我知道的生产行为对不上」,
 * 这是「复核未见异常」,**不等于「49 条已逐条验证」** —— 两种证据强度必须分开写。
 */
export const PROD_CROSSCHECK = {
	label: "Tadashi 生产实况复核:未见异常",
	body: "他按自己知道的生产行为过了一遍,**暂时没发现哪条默认值与实况对不上**。",
	caveat:
		"这是**「复核未见异常」,不是「逐条已验证」** —— 强度上弱于死壳那 13 条(那些逐个追到了调用点)。这两种证据我们分开写,不合并成一句「都验过了」。",
};

/** 顺带说明本波里归别人的执行项。 */
export const BATCH_NOTE = {
	text: "**FLY-1261(删 auto-QA 整套代码)随本波执行,归 1261** —— Tadashi 已把它排进 Batch 2 并认领。不在 1413 的范围里。",
};

/** 1 条别人家的,明确不进本单清理候选。 */
export const OWNED_ELSEWHERE = {
	name: "workflow_generalized_templates",
	owner: "FLY-1436",
	note: "work-kind cutover 两个 flag 之一。Annie 的红线:所有翻转动作收拢在 G-GO 批准后的受控序列内,**不存在提前翻转步**。**1413 绝对不碰。**",
};

/** 预留位:在建、尚未登记的开关。 */
export const RESERVED = [
	{
		envVar: "FLYWHEEL_CHAT_RECEIPTS",
		status: "FLY-1437 在建(kill switch,默认开)",
		note: "已出现在 `packages/teamlead/scripts/claude-lead.sh:1442`(往 Lead 传参)+ 一条 env 传播测试,但 `registry.ts` / `truth.ts` **都是 0 命中**。形态上正好属于「代码里当开关用、却没登记」那一类 —— **已知,预留,不当漂移抓**;登记后自然进下一轮增量。",
	},
];
