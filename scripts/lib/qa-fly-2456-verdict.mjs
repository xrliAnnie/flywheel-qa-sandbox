import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { publicAttribution, publicBody } from "./qa-fly-2456-report-fields.mjs";
import { scanDelta } from "./qa-fly-2456-scan.mjs";

const escapeHtml = (value) =>
	String(value).replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			],
	);
function fleetProof(record) {
	if (
		!Array.isArray(record?.added) ||
		record.added.length ||
		!Array.isArray(record.removed)
	)
		return false;
	if (record.status === "pass") return record.removed.length === 0;
	return (
		record.status === "needs-attribution" &&
		record.removed.length > 0 &&
		Array.isArray(record.attributions) &&
		record.attributions.length === record.removed.length &&
		new Set(record.removed.map((r) => `${r.kind}:${r.line}`)).size ===
			record.removed.length &&
		record.removed.every(
			(row) =>
				record.attributions.filter(
					(a) =>
						a.kind === row.kind &&
						a.line === row.line &&
						typeof a.executionId === "string" &&
						a.executionId &&
						["sessions.terminal_at", "session_events"].includes(
							a.terminalEvidence?.source,
						) &&
						Number.isFinite(
							Date.parse(a.terminalEvidence.at ?? a.terminalEvidence.ts),
						),
				).length === 1,
		)
	);
}
function leadProcProof(record, lead) {
	if (
		record.status !== "needs-attribution" ||
		lead?.status !== "pass" ||
		lead.toolStatus !== record.status ||
		lead.mode !== record.mode ||
		!Array.isArray(lead.failures) ||
		lead.failures.length ||
		!Array.isArray(lead.rows)
	)
		return false;
	const rows = ["removed", "added"].flatMap((set) =>
		record[set].map((row) => ({ ...row, set })),
	);
	return (
		rows.length === lead.rows.length &&
		rows.every((row) => {
			const matches = lead.rows.filter((a) =>
				["pid", "ppid", "lstart", "command", "attribution", "set"].every(
					(k) => a[k] === row[k],
				),
			);
			if (matches.length !== 1) return false;
			const a = matches[0];
			return (
				typeof a.rule === "string" &&
				a.rule.length > 0 &&
				typeof a.evidence === "string" &&
				(["slot", "host_transient"].includes(a.kind) ||
					(a.set === "added" &&
						(a.kind === "production_added" ||
							(record.mode === "post-teardown" &&
								a.kind === "added_unattributed"))))
			);
		})
	);
}
export function verdictRound({
	round,
	manifestPath,
	shapePath,
	observePath,
	zeroImpactPath,
	fixturePath,
}) {
	const failures = [],
		pending = [],
		evidence = [];
	const read = (path) => {
		const raw = readFileSync(path);
		evidence.push({
			path,
			sha256: createHash("sha256").update(raw).digest("hex"),
		});
		return JSON.parse(raw);
	};
	try {
		const manifest = read(manifestPath),
			shape = read(shapePath),
			observed = read(observePath),
			zero = read(zeroImpactPath),
			fixture = read(fixturePath);
		if (
			!["r1", "r2"].includes(round) ||
			manifest.config?.round !== round ||
			manifest.config.slot !== (round === "r1" ? 4 : 1) ||
			!/^[a-f0-9]{40}$/.test(manifest.config.head)
		)
			throw new Error("round identity invalid");
		if (
			shape.status !== "pass" ||
			!Array.isArray(shape.failures) ||
			shape.failures.length ||
			observed.status !== "pass"
		)
			failures.push("campaign eligibility or observation failed");
		for (const label of ["B1", "B2", "B3"]) {
			const starts = Object.values(manifest.steps ?? {}).filter(
				(e) =>
					e.intent?.detail?.kind === "start" &&
					e.intent.detail.label === label &&
					e.receipt,
			);
			if (starts.length !== 1) throw new Error("body start identity ambiguous");
			const start = starts[0].receipt.result,
				body = observed.bodies?.[label];
			const issue = manifest.config.issues?.[label],
				control = fixture.cycle1?.bodies?.[label];
			if (
				typeof issue !== "string" ||
				!/^FLY-\d+$/.test(issue) ||
				manifest.bodies?.[label]?.issueId !== issue ||
				starts[0].intent.detail.issueId !== issue ||
				start.issueId !== issue
			)
				throw new Error("manifest issue binding mismatch");
			if (
				control?.executionId !== start.executionId ||
				control.runId !== start.workflowRunId ||
				!Array.isArray(control.sessionEvents) ||
				control.sessionEvents.length
			)
				throw new Error("cycle1 body proof mismatch");
			if (
				!body ||
				!start.executionId ||
				body.executionId !== start.executionId ||
				body.runId !== start.workflowRunId ||
				shape.bodies?.[label]?.executionId !== start.executionId
			)
				throw new Error("evidence body identity mismatch");
			const expected =
				label === "B3"
					? "skipped_not_holder"
					: round === "r1" && label === "B1"
						? "replaced"
						: "succeeded";
			if (body.classification !== expected)
				failures.push(
					`${label}: expected ${expected}, observed ${body.classification}`,
				);
		}
		if (
			round === "r1" &&
			(!Array.isArray(observed.bodies.B1.preparedEvents) ||
				observed.bodies.B1.preparedEvents.length)
		)
			failures.push("R1 unexpectedly prepared recovery capabilities");
		if (
			round === "r2" &&
			(observed.bodies.B1.attempt2PreparedProof !== true ||
				!Array.isArray(observed.capabilityDriftEvents) ||
				observed.capabilityDriftEvents.length)
		)
			failures.push("R2 attempt2 preparation or global drift guard failed");
		if (
			fixture.roomInfoHidden !== true ||
			fixture.gateHeld !== true ||
			fixture.cycle1?.status !== "pass" ||
			!Array.isArray(fixture.cycle1.timeline?.sessionEvents) ||
			fixture.cycle1.timeline.sessionEvents.length
		)
			failures.push("same fixture or cycle1 zero-event proof missing");
		const pre = fixture.precondition;
		const tickUnavailable =
			pre?.tickEvidence?.status === "unavailable" &&
			pre.maintenanceTicks === null &&
			pre.tickEvidence.reason === "no_unconditional_tick_observable" &&
			pre.tickEvidence.rulingQuestionId ===
				"c7791d8e-0d58-44d2-af0f-28b371382737" &&
			typeof pre.startedAt === "string" &&
			typeof pre.endedAt === "string" &&
			Number.isFinite(Date.parse(pre.startedAt)) &&
			Number.isFinite(Date.parse(pre.endedAt)) &&
			Date.parse(pre.endedAt) <= Date.now() &&
			Date.parse(pre.endedAt) - Date.parse(pre.startedAt) === pre.waitedMs;
		const clockProvided =
			pre?.startedAt !== undefined || pre?.endedAt !== undefined;
		const clockValid =
			typeof pre?.startedAt === "string" &&
			typeof pre?.endedAt === "string" &&
			Number.isFinite(Date.parse(pre.startedAt)) &&
			Number.isFinite(Date.parse(pre.endedAt)) &&
			Date.parse(pre.endedAt) <= Date.now() &&
			Date.parse(pre.endedAt) - Date.parse(pre.startedAt) === pre.waitedMs;
		const ticksProven =
			pre?.tickEvidence === undefined &&
			Number.isInteger(pre?.maintenanceTicks) &&
			pre.maintenanceTicks >= 2 &&
			(!clockProvided || clockValid);
		if (
			pre?.status !== "pass" ||
			!Number.isFinite(pre.waitedMs) ||
			pre.waitedMs < 600000 ||
			!(tickUnavailable || ticksProven) ||
			pre.termination?.purpose !== "precondition" ||
			pre.termination.status !== "terminated" ||
			pre.termination.noop !== false ||
			!["pass", "needs-attribution"].includes(pre.fleet?.status) ||
			typeof pre.archivePath !== "string" ||
			!pre.archivePath
		)
			failures.push("precondition incomplete");
		const groups = {
			fleet: ["live", "postTeardown"],
			proc: ["live", "postTeardown", "teardown"],
			comm: ["before", "liveAfter", "postTeardown"],
			launchCommits: ["liveAfter", "postTeardown"],
			prodState: ["before", "liveAfter", "postTeardown"],
			alerts: ["liveAfter", "postTeardown"],
			runnerWindows: ["full", "teardown"],
		};
		const explanations = [];
		const zeroImpactDeltas = { comm: {}, prodState: {}, alerts: {} };
		const processAttributions = [];
		const baselines = {
			comm: read(zero.comm?.before),
			prodState: read(zero.prodState?.before),
		};
		if (!fleetProof(pre?.fleet))
			failures.push("precondition fleet proof incomplete");
		else if (pre.fleet.status === "needs-attribution")
			explanations.push({
				group: "precondition",
				phase: "postTeardown",
				attributions: pre.fleet.attributions,
			});
		for (const [group, phases] of Object.entries(groups))
			for (const phase of phases) {
				const record = read(zero[group]?.[phase]);
				if (["comm", "prodState"].includes(group)) {
					const delta = scanDelta(baselines[group], record);
					zeroImpactDeltas[group][phase] = delta;
					if (delta.status !== "pass")
						failures.push(
							`${group}/${phase} new pollution or invalid scan proof`,
						);
					continue;
				}
				if (group === "alerts") {
					if (
						!Number.isSafeInteger(record.baselineHitCount) ||
						record.baselineHitCount < 0 ||
						!Array.isArray(record.pollution) ||
						record.newHitCount !== record.pollution.length
					)
						throw Error("alerts delta proof missing");
					zeroImpactDeltas.alerts[phase] = {
						baselineHitCount: record.baselineHitCount,
						newHitCount: record.newHitCount,
					};
				}
				if (
					["fleet", "proc"].includes(group) &&
					(!Array.isArray(record.added) || !Array.isArray(record.removed))
				)
					throw new Error(`${group}/${phase} incomplete diff`);
				if (
					group === "proc" &&
					(!Array.isArray(record.unexplained) ||
						(record.status === "pass" && record.unexplained.length))
				)
					throw new Error("process explanation missing");
				if (
					group === "runnerWindows" &&
					(!Number.isSafeInteger(record.before) ||
						record.before < 0 ||
						!Number.isSafeInteger(record.after) ||
						record.after < 0 ||
						!Array.isArray(record.explanations) ||
						(record.before !== record.after && !record.explanations.length))
				)
					throw new Error("runner window proof missing");
				if (record.status === "needs-attribution") {
					if (group === "proc" && zero.procLead?.[phase]) {
						const lead = read(zero.procLead[phase]);
						if (leadProcProof(record, lead))
							processAttributions.push({
								phase,
								path: zero.procLead[phase],
								rows: lead.rows.map(({ pid, set, kind, rule }) => ({
									pid,
									set,
									kind,
									rule,
								})),
							});
						else pending.push(`${group}/${phase}`);
					} else if (
						group === "fleet" &&
						phase === "postTeardown" &&
						fleetProof(record)
					)
						explanations.push({
							group,
							phase,
							attributions: record.attributions,
						});
					else pending.push(`${group}/${phase}`);
				} else if (record.status !== "pass")
					failures.push(`${group}/${phase} failed`);
				if (
					group === "proc" &&
					phase === "live" &&
					record.added?.some((p) => p.attribution !== "SLOT")
				)
					failures.push("live process addition not attributed to slot");
				if (
					group === "alerts" &&
					(!Array.isArray(record.pollution) || record.pollution.length)
				)
					failures.push(`alerts/${phase} slot pollution`);
				if (
					group === "launchCommits" &&
					(!Array.isArray(record.unknown) || record.unknown.length)
				)
					failures.push(`launchCommits/${phase} unbounded delta`);
			}
		let previous;
		for (const phase of [
			"before",
			"liveAfter",
			"preTeardown",
			"postTeardown",
		]) {
			const health = read(zero.health?.[phase]);
			if (
				health.ok !== true ||
				!/^[a-f0-9]{40}$/.test(health.buildSha) ||
				!Number.isFinite(health.uptime) ||
				health.uptime < 0 ||
				(previous &&
					(health.buildSha !== previous.buildSha ||
						health.uptime < previous.uptime))
			)
				failures.push(`production health/${phase} discontinuity`);
			previous = health;
		}
		const ledger = read(zero.killLedger);
		if (
			ledger.status !== "pass" ||
			!Array.isArray(ledger.refusals) ||
			ledger.refusals.length
		)
			failures.push("kill ledger isolation refusal or missing proof");
		const succeeded = ["B1", "B2"].filter(
			(label) => observed.bodies[label].classification === "succeeded",
		).length;
		const status = failures.length
			? "fail"
			: pending.length
				? "needs-attribution"
				: "pass";
		const attributionText = explanations
			.flatMap((group) =>
				group.attributions.map(
					(a) => `- ${JSON.stringify(publicAttribution(a))}`,
				),
			)
			.join("\n");
		const deltaText = Object.entries(zeroImpactDeltas)
			.flatMap(([group, phases]) =>
				Object.entries(phases).map(
					([phase, delta]) =>
						`${group}/${phase}：基线 ${delta.baselineHitCount ?? "不可用"}，新增 ${delta.newHitCount ?? "不可用"}。`,
				),
			)
			.join("\n\n");
		const markdown = `# FLY-2456 · ${round} 真机重启演练证据判定\n\n本轮判定：${status}。有资格体认回 ${succeeded}/2（${succeeded * 50}%）；B3 为非 holder 阴性对照，不计分母。\n\n被测 HEAD：${manifest.config.head}。\n\n${["B1", "B2", "B3"].map((label) => `${label} (${publicBody(observed.bodies[label]).executionId})：${publicBody(observed.bodies[label]).classification}。`).join("\n\n")}\n\n生产零影响（before→after 零新增；历史命中仅披露）：九组证据已逐项读取；${failures.length} 项失败，${pending.length} 项待归因。${explanations.length} 组生产终态归因如下。\n\n${deltaText}\n\nLead 进程归因（原始工具状态保留）：${JSON.stringify(processAttributions)}\n\n${attributionText}\n\n夹具与盲区：隐藏 room-info 解除 FLY-2211 排除；gate 使靶体满足 reown 资格。两轮必须使用同夹具。生产活 WAL 不作逐字相等声明；使用一致性副本污染扫描。launch-commits、归档及沙箱 PR/分支为已登记残留。\n\n前置维护观察：${tickUnavailable ? `UNAVAILABLE (no_unconditional_tick_observable); 墙钟 ${pre.startedAt} → ${pre.endedAt}, ${pre.waitedMs}ms; Lead ruling ${pre.tickEvidence.rulingQuestionId}。未声称两次 tick 已观测。` : `维护 tick 记录 ${pre.maintenanceTicks}, 等待 ${pre.waitedMs}ms。`}\n\n建议：${status === "pass" ? "本轮条件成立；两轮对照齐全后交 founder 决定 FLY-2352。" : "先处理失败或待归因项，不据此批准 FLY-2352。"}\n\n${failures
			.concat(pending)
			.map((x) => `- ${x}`)
			.join(
				"\n",
			)}\n\n证据文件及 SHA256：\n\n${evidence.map((e) => `- ${e.path}: ${e.sha256}`).join("\n")}\n`;
		return {
			status,
			round,
			head: manifest.config.head,
			eligible: 2,
			succeeded,
			successRate: succeeded / 2,
			failures,
			pending,
			explanations,
			zeroImpactDeltas,
			processAttributions,
			evidence,
			markdown,
			html: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>FLY-2456 ${round}</title><style>body{max-width:960px;margin:40px auto;padding:20px;font:16px/1.7 system-ui}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><main><pre>${escapeHtml(markdown)}</pre></main></html>`,
		};
	} catch (error) {
		return {
			status: "fail",
			failures: [...failures, error.message],
			pending,
			evidence,
		};
	}
}
