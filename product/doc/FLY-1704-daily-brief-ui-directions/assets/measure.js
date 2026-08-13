/**
 * FLY-1704 — 版式尺子。research.md §1 / plan.md §2 那些数就是它量出来的。
 *
 * 用法:在任意一版早报页面开控制台,整段粘贴运行。
 *
 * 双模式(plan.md §2):
 *   - anchor    : 页面带 [data-fw-item] / [data-fw-prose](本单四个 mockup)
 *   - legacy-v8 : 没有锚点,回落到 v8 的 .card / .row .k / .row .v
 * 输出必带 mode —— 「新脚本量 v8 拿到 0」这种假绿必须看得出来。
 *
 * 尺子自检(2026-08-11 在 v8 线上页实跑,已核):
 *   mode "legacy-v8" / itemCount 24 / labelCount.byLeafScan 74 /
 *   cjkPerLine.max 46 / proseWidthPx.max 665 / boxedPerItemMax 10 /
 *   fullyBoxedItems 24 / pageHeight 9790 / screensAt900 10.9
 * 复现不了就是尺子坏了,先修尺子再量 mockup。
 *
 * 注:boxedPerItemMax 是 10 不是 9 —— 旧版脚本只数后代,漏了卡片自己(9 后代 + 1 根 = 10)。
 * fullyBoxedItems 是 24 —— v8 每张卡都被 box-shadow 罩住,这就是「卡片感」的实际来源。
 */
(() => {
	const FIELD_WORDS = [
		"这是什么",
		"为什么值得你看",
		"跟我们什么关系",
		"哪里能借鉴",
		"为什么没深入",
	];
	const fail = (msg) => {
		const e = `MEASURE_FAILED: ${msg}`;
		console.error(e);
		return e;
	};

	// ---- 🔴 页高必须在「打开时的样子」量,行宽必须在「读的时候」量 --------
	// 两个数要的是两种状态,不能用同一次快照:
	//   页高  = 默认(折叠)状态 —— 那才是她一打开看到的长度
	//   行宽  = 展开状态 —— 折叠区收着时量不到,会拿到 0 个样本然后「通过」
	// 先记默认高度,再展开。
	const collapsedHeight = document.body.scrollHeight;

	// 🔴 展开必须走**真实交互路径**,不许直接扒 [hidden]。
	//    先前这里是 `[hidden] -> removeAttribute`,结果把方向 C 的一个真 bug 盖住了:
	//    C 的 20 条清单点了根本打不开(处理器拿 nextElementSibling 当面板,而 C 的下一个兄弟是摘要行),
	//    但尺子绕过点击直接掀开,照样量到正文、照样 PASS —— 确定性假绿。
	//    现在:点真的开关,然后**断言真的开了**。开不了就 MEASURE_FAILED,不再替它圆场。
	const expandAll = () => {
		document.querySelectorAll("details").forEach((d) => {
			d.open = true;
		});
		document.querySelectorAll("[data-acc]").forEach((r) => r.click());
	};
	expandAll();

	const stillHidden = [...document.querySelectorAll("[data-fw-prose]")].filter(
		(p) => p.offsetParent === null && p.getClientRects().length === 0,
	);
	if (stillHidden.length)
		return fail(
			`${stillHidden.length} prose blocks still hidden after clicking every [data-acc] — ` +
				`展开交互是坏的(别靠扒 [hidden] 掩盖它)`,
		);

	const visible = (el) =>
		el.offsetParent !== null || el.getClientRects().length > 0;

	// ---- 模式判定 ---------------------------------------------------------
	const anchored = document.querySelectorAll("[data-fw-item]");
	const mode = anchored.length ? "anchor" : "legacy-v8";
	const items =
		mode === "anchor" ? [...anchored] : [...document.querySelectorAll(".card")];
	if (!items.length)
		return fail("no items found (both [data-fw-item] and .card are empty)");

	// ---- 行宽:每条取它自己的正文 -----------------------------------------
	const proseOf = (item) =>
		mode === "anchor"
			? [...item.querySelectorAll("[data-fw-prose]")].filter(visible)
			: [...item.querySelectorAll(".row .v")].filter(visible);

	const widths = [];
	const proseProblems = [];
	items.forEach((item, i) => {
		const ps = proseOf(item);
		// anchor 模式下每条必须恰好 1 个可见正文块 —— 只查总数挡不住「这条 2 个那条 0 个」
		if (mode === "anchor" && ps.length !== 1) {
			proseProblems.push(
				`${item.getAttribute("data-fw-item") || `#${i}`}: ${ps.length}`,
			);
		}
		ps.forEach((p) => {
			const cs = getComputedStyle(p);
			const ctx = document.createElement("canvas").getContext("2d");
			ctx.font = cs.font;
			const cjk = ctx.measureText("电").width; // 全角步进宽
			const w = p.getBoundingClientRect().width;
			if (w > 0 && cjk > 0)
				widths.push({ px: Math.round(w), cjk: Math.round(w / cjk) });
		});
	});
	if (mode === "anchor" && proseProblems.length)
		return fail(
			`items without exactly 1 visible prose -> ${proseProblems.join(", ")}`,
		);
	if (!widths.length) return fail("no visible prose measured");

	const cjks = widths.map((w) => w.cjk).sort((a, b) => a - b);
	const median = cjks[Math.floor(cjks.length / 2)];

	// ---- 容器数:含条目根元素自身 -----------------------------------------
	const isBoxed = (s) => {
		// 🔴 句子里的 <code> 小色块不是「容器」。这条指标量的是**块级的框中框嵌套**
		//    ——「读之前要先解析几层结构」。行内 code chip 属于排版,不属于结构。
		//    (发现过程:方向 D 卡在 4,查出来第 4 个就是行内 <code>。
		//     把门槛从 3 调到 4 是「写一把刚好能通过的尺子」;把行内排除掉才是修尺子。
		//     v8 基线也用这把新尺子重量过,两边同尺。)
		if (s.display === "inline") return false;
		const border = ["Top", "Right", "Bottom", "Left"].some(
			(d) => s[`border${d}Width`] !== "0px" && s[`border${d}Style`] !== "none",
		);
		const bg =
			s.backgroundColor !== "rgba(0, 0, 0, 0)" &&
			s.backgroundColor !== "rgb(255, 255, 255)";
		return border || bg;
	};
	// 🔴「被围成一张卡」不止 border 一种做法。v8 实测:.card 只有 4px 左边框 + 一条
	//    box-shadow(0 1px 3px rgba(0,0,0,.06)) + 12px 圆角 —— 截图上看到的那个「框」
	//    其实是**阴影**不是边框。只查四边 border 会让「每条都罩一层投影」的版式拿满分。
	//    所以卡片包围 = 四边 border **或** 任何可见 box-shadow。
	const enclosed = (s) => {
		const allFour = ["Top", "Right", "Bottom", "Left"].every(
			(d) => s[`border${d}Width`] !== "0px" && s[`border${d}Style`] !== "none",
		);
		const hasShadow = s.boxShadow && s.boxShadow !== "none";
		return allFour || hasShadow;
	};

	let boxedMax = 0;
	let fullyBoxedItems = 0;
	items.forEach((item) => {
		const self = getComputedStyle(item);
		// 「零卡片边框」必须独立验收 —— 围一圈只算 1 个,boxedPerItem<=3 挡不住它
		if (enclosed(self)) fullyBoxedItems++;
		let n = isBoxed(self) ? 1 : 0;
		item.querySelectorAll("*").forEach((e) => {
			if (isBoxed(getComputedStyle(e))) n++;
		});
		boxedMax = Math.max(boxedMax, n);
	});

	// ---- 字段名:锚点 + 与模式无关的兜底叶子扫描 --------------------------
	const byAnchor = document.querySelectorAll("[data-fw-label]").length;
	const byLeafScan = [...document.querySelectorAll("*")].filter(
		(e) =>
			e.children.length === 0 && FIELD_WORDS.includes(e.textContent.trim()),
	).length;

	const out = {
		mode,
		itemCount: items.length,
		labelCount: { byAnchor, byLeafScan },
		cjkPerLine: { min: cjks[0], median, max: cjks[cjks.length - 1] },
		proseWidthPx: {
			min: Math.min(...widths.map((w) => w.px)),
			max: Math.max(...widths.map((w) => w.px)),
		},
		boxedPerItemMax: boxedMax,
		fullyBoxedItems,
		// 打开就看到的长度(默认折叠态)—— 拿来跟 v8 的 10.9 屏比的是这个
		pageHeight: Math.round(collapsedHeight),
		screensAt900: +(collapsedHeight / 900).toFixed(1),
		// 全部展开后的长度 —— 「如果她每条都点开」的上限,单独报,不跟上面混
		screensExpanded: +(document.body.scrollHeight / 900).toFixed(1),
	};
	// 门槛(plan.md §2)—— 只对 anchor 模式判定;legacy-v8 是被对照的基线,不判它 PASS/FAIL
	out.verdict =
		mode !== "anchor"
			? "BASELINE (not graded)"
			: byAnchor === 0 &&
					byLeafScan === 0 &&
					out.cjkPerLine.max <= 40 &&
					boxedMax <= 3 &&
					fullyBoxedItems === 0
				? "PASS"
				: "FAIL";
	console.table(out);
	return JSON.stringify(out, null, 1);
})();
