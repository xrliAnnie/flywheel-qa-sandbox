import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
	publicBody,
	publicEvent,
	publicExplanation,
	publicIdentity,
	publicPrecondition,
	publicProof,
	publicReplacement,
} from "./qa-fly-2456-report-fields.mjs";
import { verdictRound } from "./qa-fly-2456-verdict.mjs";

const hash = (raw) => createHash("sha256").update(raw).digest("hex");
const escapeHtml = (value) =>
	String(value).replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			],
	);
const prose = (value) =>
	String(value)
		.replaceAll("|", " / ")
		.replace(/[\r\n]+/g, " ");
function readRound(path, round) {
	const raw = readFileSync(path),
		verdict = JSON.parse(raw);
	if (
		verdict.round !== round ||
		!["pass", "fail", "needs-attribution"].includes(verdict.status) ||
		!Array.isArray(verdict.evidence) ||
		verdict.evidence.length < 5
	)
		throw new Error(`${round} verdict identity or evidence missing`);
	const files = verdict.evidence.map((entry) => {
		if (typeof entry.path !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256))
			throw new Error("evidence reference invalid");
		const bytes = readFileSync(entry.path);
		if (hash(bytes) !== entry.sha256) throw new Error("evidence hash mismatch");
		return JSON.parse(bytes);
	});
	// verdictRound records its five primary inputs in this order, before leaf proofs.
	const [manifest, shape, observed, zero, fixture] = files;
	const keys = [
		"manifestPath",
		"shapePath",
		"observePath",
		"zeroImpactPath",
		"fixturePath",
	];
	const replay = verdictRound({
		round,
		...Object.fromEntries(
			keys.map((key, i) => [key, verdict.evidence[i].path]),
		),
	});
	for (const key of [
		"status",
		"round",
		"head",
		"eligible",
		"succeeded",
		"successRate",
		"failures",
		"pending",
		"explanations",
		"zeroImpactDeltas",
		"evidence",
	])
		if (!isDeepStrictEqual(verdict[key], replay[key]))
			throw new Error(`verdict replay mismatch: ${key}`);
	if (
		manifest.config?.slot !== (round === "r1" ? 4 : 1) ||
		!/^[a-f0-9]{40}$/.test(verdict.head)
	)
		throw new Error("slot or head invalid");
	if (
		!Array.isArray(observed.timeline?.sessionEvents) ||
		!Array.isArray(observed.timeline.workflowRunEvents)
	)
		throw new Error("raw timeline missing");
	for (const label of ["B1", "B2", "B3"]) {
		const body = observed.bodies?.[label],
			s = shape.bodies?.[label],
			count = label === "B1" ? 2 : 1;
		if (
			s?.session?.status !== (label === "B3" ? "ship_parked" : "running") ||
			!s.turn ||
			(label === "B3"
				? s.turn.holder_exec_id === body?.executionId
				: s.turn.holder_exec_id !== body?.executionId) ||
			!body ||
			typeof body.executionId !== "string" ||
			typeof body.runId !== "string" ||
			!Array.isArray(body.sessionEvents) ||
			!Array.isArray(body.workflowEvents) ||
			!Array.isArray(s?.bindings) ||
			s.bindings.length !== count ||
			s.bindings.some(
				(b, i) =>
					b.execution_id !== body.executionId ||
					b.run_id !== body.runId ||
					b.node_id !== "implement" ||
					b.attempt !== i + 1 ||
					b.mode !== (i ? "wake" : "spawn"),
			) ||
			new Set(s.bindings.map((b) => b.activation_id)).size !== count
		)
			throw new Error(`${round} ${label} body shape invalid`);
	}
	return {
		verdict,
		manifest,
		shape,
		observed,
		zero,
		fixture,
		proofs: Object.fromEntries(
			verdict.evidence.map((entry, i) => [entry.path, files[i]]),
		),
		reference: { path, sha256: hash(raw) },
	};
}
function roundText(r) {
	const { verdict: v, manifest, observed: o } = r;
	const bodies = ["B1", "B2", "B3"]
		.map((label) => {
			const b = publicBody(o.bodies[label]);
			return `${label}：issue ${publicIdentity(manifest.config.issues[label])}，execution ${prose(b.executionId)}，run ${prose(b.runId)}；${prose(b.classification)}。${b.replacement ? `替换体因果凭据：${prose(JSON.stringify(publicReplacement(b.replacement)))}。` : ""}`;
		})
		.join("\n\n");
	const timeline = ["sessionEvents", "workflowRunEvents"]
		.map((kind) => [kind, o.timeline[kind]])
		.map(
			([kind, events]) =>
				`${kind}（${events.length} 行）：\n\n${events.length ? events.map((row) => "    " + JSON.stringify(publicEvent(row))).join("\n") : "未观察到该类下界后事件。"}`,
		)
		.join("\n\n");
	return `${v.round === "r1" ? "修前" : "修后"}（${v.round}，slot ${manifest.config.slot}）：${v.status}。HEAD ${v.head}。有资格体认回 ${v.succeeded}/${v.eligible}（${v.successRate * 100}%）。\n\n${bodies}\n\n事件时间线（只展示白名单身份、时间、类型与 attempt；原始 payload 见私有证据）：\n\n${timeline}`;
}
function fixtureText(r) {
	const pre = publicPrecondition(r.fixture.precondition);
	const cycleStatus = ["pass", "fail", "needs-attribution"].includes(
		r.fixture.cycle1?.status,
	)
		? r.fixture.cycle1.status
		: "unknown";
	return `${r.verdict.round}：roomInfoHidden=${r.fixture.roomInfoHidden === true}，gateHeld=${r.fixture.gateHeld === true}，cycle1=${cycleStatus}。前置墙钟 ${pre.startedAt ?? "未附起点"} → ${pre.endedAt ?? "未附终点"}，${pre.waitedMs ?? "UNAVAILABLE"}ms；maintenanceTicks=${pre.maintenanceTicks ?? "UNAVAILABLE"}；${JSON.stringify(pre.tickEvidence)}。`;
}
/** Read-only report composition. Both verdict files and every referenced proof must remain available. */
export function composeReportPair({ r1Path, r2Path }) {
	try {
		const rounds = [readRound(r1Path, "r1"), readRound(r2Path, "r2")];
		const status = rounds.some((r) => r.verdict.status === "fail")
			? "fail"
			: rounds.some((r) => r.verdict.status === "needs-attribution")
				? "needs-attribution"
				: "pass";
		const failures = rounds.flatMap((r) =>
				r.verdict.failures.map((x) => `${r.verdict.round}: ${x}`),
			),
			pending = rounds.flatMap((r) =>
				r.verdict.pending.map((x) => `${r.verdict.round}: ${x}`),
			);
		const evidence = rounds.flatMap((r) => [
			r.reference,
			...r.verdict.evidence,
		]);
		const production = rounds
			.map(
				(r) =>
					`${r.verdict.round}：${r.verdict.status}；失败 ${r.verdict.failures.length} 项，待归因 ${r.verdict.pending.length} 项。\n\n${Object.entries(
						r.zero,
					)
						.map(
							([group, value]) =>
								`${prose(group)}：${(typeof value === "string" ? [[group, value]] : Object.entries(value)).map(([phase, path]) => `${prose(phase)} ${prose(JSON.stringify(publicProof({ ...r.proofs[path], ...r.verdict.zeroImpactDeltas?.[group]?.[phase] })))}`).join("；")}`,
						)
						.join(
							"\n\n",
						)}\n\n生产终态归因：${prose(JSON.stringify(r.verdict.explanations.map(publicExplanation)))}。`,
			)
			.join("\n\n");
		const markdown = `# FLY-2456 · 529 真机重启演练(2352 reown)· 修前/修后对照\n\n两轮证据合并判定：${status}；修前认回 ${rounds[0].verdict.succeeded}/2，修后认回 ${rounds[1].verdict.succeeded}/2。B3 是 parked 非 holder 阴性对照，不计入分母。\n\n${rounds.map(roundText).join("\n\n")}\n\n生产零影响\n\n${production}\n\n仅展示白名单字段、计数和归因摘要；command、env、原始 payload 及任意嵌套对象不进入发布稿。完整取证保持私有 0600，按文末 path 与 SHA256 复核。\n\n夹具与盲区\n\n${rounds.map(fixtureText).join("\n\n")}\n\n设计要求隐藏 room-info.json（room-info.json.drill-hidden），仅解除 isCodexReownExcluded 的 FLY-2211 排除，代码接缝为 packages/teamlead/src/bridge/codex-session-reown.ts。gate --no-block 只建立 gateHeld=true 的资格，不修改 reown 逻辑；两轮是否满足这两个夹具以上述记录为准。\n\n房间使用 --no-lead，founder gate 与 Discord 面不在观察范围。生产活 WAL 不作逐字一致声明；污染检查依据哈希绑定的一致性副本。报告本身不证明 exact-head CI；如 R2 是本地 merge 头，须随报告附 diff 统计及 CI 字节差异。\n\n拆房后登记残留包括 ~/.flywheel/state/launch-commits/<exec>、~/.flywheel/qa-evidence/ 归档、沙箱远端分支与标记 do not merge 的 PR 历史；slot alert-deadletter 若存在须交 Lead 隔离。R1 attempt 2 如将等待延长到 30 分钟，须补充实际等待记录；未提供时不推定等待时长。\n\n建议\n\n${status === "pass" ? "两轮所附判据成立，交 founder 决定 FLY-2352；本报告不授予合并或发布权限。" : "先处理失败或待归因项；本报告不据此批准 FLY-2352。"}\n\n${failures
			.concat(pending)
			.map((x) => "- " + prose(x))
			.join(
				"\n",
			)}\n\n证据文件及 SHA256\n\n${evidence.map((e) => `- ${prose(e.path)}: ${e.sha256}`).join("\n")}\n`;
		return {
			status,
			rounds: rounds.map((r) => ({
				round: r.verdict.round,
				slot: r.manifest.config.slot,
				head: r.verdict.head,
				status: r.verdict.status,
				eligible: r.verdict.eligible,
				succeeded: r.verdict.succeeded,
				successRate: r.verdict.successRate,
			})),
			failures,
			pending,
			evidence,
			markdown,
			html: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>FLY-2456 修前/修后对照</title><style>body{max-width:1000px;margin:40px auto;padding:20px;font:16px/1.7 system-ui}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><main><pre>${escapeHtml(markdown)}</pre></main></html>`,
		};
	} catch (error) {
		return { status: "fail", failures: [error.message] };
	}
}
