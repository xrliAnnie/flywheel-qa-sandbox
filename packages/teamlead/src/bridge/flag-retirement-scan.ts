import { createHash } from "node:crypto";
import {
	computeFlagScan,
	type FeatureFlagSpec,
	type FlagScanScopeState,
	type FlagView,
	type ProposedFlagScan,
	type ResolvedFlagKeepBinding,
} from "flywheel-config";
import type {
	FlagProvenanceInput,
	FlagScanLeg,
	FlagScanRunItemInput,
	FlagScanRunRow,
	StateStore,
} from "../StateStore.js";

export const FLAG_SCAN_LEASE_MS = 2 * 60_000;
export const FLAG_SCAN_VISIBILITY_FENCE_MS = 5 * 60_000;
export const FLAG_SCAN_REMOTE_CLOCK_SKEW_MS = 30 * 60_000;
export const FLAG_SCAN_MAX_PENDING_AGE_MS = 24 * 60 * 60_000;
export const FLAG_SCAN_TIME_ZONE = "America/Los_Angeles";
export const FLAG_SCAN_LOCAL_HOUR = 8;

const DAY_MS = 24 * 60 * 60_000;
const FLAG_SCAN_LOCAL_FORMATTER = new Intl.DateTimeFormat("en-US", {
	timeZone: FLAG_SCAN_TIME_ZONE,
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	weekday: "short",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hourCycle: "h23",
});

interface ZonedDateParts {
	year: number;
	month: number;
	day: number;
	weekday: string;
	hour: number;
	minute: number;
	second: number;
}

function zonedDateParts(epochMs: number): ZonedDateParts {
	const values = new Map<string, string>(
		FLAG_SCAN_LOCAL_FORMATTER.formatToParts(epochMs).map((part) => [
			part.type,
			part.value,
		]),
	);
	const numberPart = (name: string): number => {
		const value = Number(values.get(name));
		if (!Number.isInteger(value)) {
			throw new Error(`flag scan timezone formatter omitted ${name}`);
		}
		return value;
	};
	return {
		year: numberPart("year"),
		month: numberPart("month"),
		day: numberPart("day"),
		weekday: values.get("weekday") ?? "",
		hour: numberPart("hour"),
		minute: numberPart("minute"),
		second: numberPart("second"),
	};
}

function epochForFlagScanLocalTime(input: {
	year: number;
	month: number;
	day: number;
	hour: number;
}): number {
	const desiredAsUtc = Date.UTC(
		input.year,
		input.month - 1,
		input.day,
		input.hour,
	);
	let candidate = desiredAsUtc;
	for (let iteration = 0; iteration < 4; iteration++) {
		const actual = zonedDateParts(candidate);
		const actualAsUtc = Date.UTC(
			actual.year,
			actual.month - 1,
			actual.day,
			actual.hour,
			actual.minute,
			actual.second,
		);
		const adjusted = candidate + desiredAsUtc - actualAsUtc;
		if (adjusted === candidate) return candidate;
		candidate = adjusted;
	}
	const resolved = zonedDateParts(candidate);
	if (
		resolved.year !== input.year ||
		resolved.month !== input.month ||
		resolved.day !== input.day ||
		resolved.hour !== input.hour ||
		resolved.minute !== 0 ||
		resolved.second !== 0
	) {
		throw new Error("could not resolve the fixed flag scan local slot");
	}
	return candidate;
}

/** Latest Sunday 08:00 America/Los_Angeles slot at or before `nowMs`. */
export function latestFlagScanSlotAtOrBefore(nowMs: number): number {
	if (!Number.isFinite(nowMs)) throw new Error("flag scan time must be finite");
	const local = zonedDateParts(nowMs);
	const weekdayIndex = [
		"Sun",
		"Mon",
		"Tue",
		"Wed",
		"Thu",
		"Fri",
		"Sat",
	].indexOf(local.weekday);
	if (weekdayIndex < 0) {
		throw new Error(`unexpected flag scan weekday: ${local.weekday}`);
	}
	const localDateUtc = Date.UTC(local.year, local.month - 1, local.day);
	const sunday = new Date(localDateUtc - weekdayIndex * DAY_MS);
	let slot = epochForFlagScanLocalTime({
		year: sunday.getUTCFullYear(),
		month: sunday.getUTCMonth() + 1,
		day: sunday.getUTCDate(),
		hour: FLAG_SCAN_LOCAL_HOUR,
	});
	if (slot > nowMs) {
		const previousSunday = new Date(localDateUtc - (weekdayIndex + 7) * DAY_MS);
		slot = epochForFlagScanLocalTime({
			year: previousSunday.getUTCFullYear(),
			month: previousSunday.getUTCMonth() + 1,
			day: previousSunday.getUTCDate(),
			hour: FLAG_SCAN_LOCAL_HOUR,
		});
	}
	return slot;
}

export function flagScanIsDue(
	nowMs: number,
	latestCommittedAt?: number | null,
): boolean {
	return (
		latestCommittedAt === undefined ||
		latestCommittedAt === null ||
		latestCommittedAt < latestFlagScanSlotAtOrBefore(nowMs)
	);
}

export type FlagScanEffectResult =
	| { status: "done"; evidence: string }
	| { status: "ambiguous"; evidence?: string }
	| { status: "degraded"; evidence: string };

export type FlagScanReconcileResult =
	| { status: "found"; evidence: string }
	| { status: "pending"; evidence: string }
	| { status: "missing" };

export interface FlagRetirementScanEffects {
	createLinearBatch(input: {
		runToken: string;
		title: string;
		body: string;
	}): Promise<FlagScanEffectResult>;
	reconcileLinearBatch(input: {
		runToken: string;
		createdAfter: number;
	}): Promise<FlagScanReconcileResult>;
	publishReport(input: {
		runToken: string;
		title: string;
		html: string;
	}): Promise<FlagScanEffectResult>;
	postDiscord(input: {
		runToken: string;
		body: string;
	}): Promise<FlagScanEffectResult>;
	reconcileDiscord(input: {
		runToken: string;
		createdAfter: number;
	}): Promise<FlagScanReconcileResult>;
	notifyLead(input: {
		runToken: string;
		eventId: string;
		partIndex: number;
		partCount: number;
		body: string;
	}): Promise<FlagScanEffectResult>;
}

export interface FlagScanSourceSnapshot {
	rows: Array<{ spec: FeatureFlagSpec; view: FlagView }>;
	expectedProjectNames: string[];
}

export interface FlagRetirementScannerDependencies {
	store: StateStore;
	loadSources(): Promise<FlagScanSourceSnapshot>;
	loadProvenance(currentFlagNames: string[]): Promise<FlagProvenanceInput[]>;
	effects: FlagRetirementScanEffects;
	alertFailure(message: string): Promise<void>;
	now(): number;
	newRunToken(): string;
	leaseOwner: string;
	enabled: () => boolean;
	/** Reconcile durable failure-mailbox intents before doing new scan work. */
	recoverFailureAlerts?: () => void;
}

export type FlagScanOutcome =
	| { status: "disabled" }
	| { status: "not_due" }
	| { status: "failed"; error: string }
	| { status: "lost_race" }
	| { status: "pending"; runId: number }
	| { status: "published"; runId: number }
	| {
			status: "dry_run";
			runToken: string;
			candidateCount: number;
			linearBody: string | null;
			html: string | null;
	  };

function canonicalDigest(canonical: string): string {
	return createHash("sha256").update(canonical).digest("hex");
}

function parseKeepBinding(
	spec: FeatureFlagSpec,
	store: StateStore,
): ResolvedFlagKeepBinding | "unbound" | undefined {
	if (spec.longTermKeep !== true) return undefined;
	const match = spec.keepReason?.match(
		/^(\d{4}-\d{2}-\d{2}) \[flag-scan:([^\]]+)](?::|\s|$)/,
	);
	if (!match) return "unbound";
	const [, decidedAt, runToken] = match;
	const frozen = store.getFlagKeepBinding(runToken!, spec.name);
	if (!frozen) return "unbound";
	return {
		runToken: runToken!,
		canonical: frozen.canonical,
		decidedAt: decidedAt!,
	};
}

function escapeHtml(value: unknown): string {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

interface RenderableFlagScanItem {
	flagName: string;
	canonical: string | null;
	description: string | null;
	currentValue: string | null;
	stableForMs: number | null;
	askPhrase: string | null;
	reason: string | null;
	provenance: Record<string, unknown> | null;
}

function displayCurrentValue(canonical: string): string {
	try {
		const parsed = JSON.parse(canonical) as { k?: unknown; v?: unknown };
		if (parsed.k === "dormant") return "dormant";
		return JSON.stringify(parsed.v) ?? "不可显示";
	} catch {
		return "不可显示";
	}
}

function displayStableDuration(stableForMs: number): string {
	const dayMs = 24 * 60 * 60 * 1_000;
	const hourMs = 60 * 60 * 1_000;
	const days = Math.floor(stableForMs / dayMs);
	const hours = Math.floor((stableForMs % dayMs) / hourMs);
	return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
}

function provenanceSummary(item: RenderableFlagScanItem): string {
	const provenance = item.provenance as {
		status?: string;
		sourceIssue?: string | null;
		author?: string;
		incarnationCommit?: string;
		prNumber?: number | null;
	} | null;
	if (!provenance) return "来源查询不可用";
	const evidence = [
		provenance.sourceIssue ?? "无主",
		provenance.author,
		provenance.incarnationCommit?.slice(0, 10),
		provenance.prNumber ? `#${provenance.prNumber}` : null,
	].filter(Boolean);
	return evidence.join(" · ");
}

function itemLine(item: RenderableFlagScanItem, askCount: number): string {
	const digest = item.canonical ? canonicalDigest(item.canonical) : "无";
	const facts = [
		item.currentValue === null ? null : `  - 当前值: \`${item.currentValue}\``,
		item.stableForMs === null
			? null
			: `  - 稳定时长: ${displayStableDuration(item.stableForMs)}`,
		`  - 当前样本摘要: \`${digest}\``,
		`  - 来源: ${provenanceSummary(item)}`,
		item.description === null ? null : `  - 人话说明: ${item.description}`,
		`  - 已问过: ${askCount} 次`,
	].filter((line): line is string => line !== null);
	return `- **${item.flagName}** — ${item.askPhrase ?? item.reason ?? "待核"}\n${facts.join("\n")}`;
}

export function renderFlagScanLinearBody(input: {
	runToken: string;
	items: ReturnType<StateStore["getFlagScanRunItems"]>;
}): string {
	const sections: Array<{
		title: string;
		buckets: string[];
	}> = [
		{ title: "候选", buckets: ["candidate"] },
		{ title: "无主候选", buckets: ["orphan_candidate"] },
		{ title: "已认领（retiring）", buckets: ["claimed"] },
		{ title: "判据不可用", buckets: ["no_clock", "keep_unbound"] },
	];
	const lines = [
		`<!-- flywheel:flag-governance run=${input.runToken} -->`,
		"本单是逐条裁决请求，不进派工、不指派 Runner。",
		"",
		"扫描产出的是候选清单，删除动作由人点头后另行执行；系统永不自动删除 flag，也不自动创建清理执行单。",
	];
	for (const section of sections) {
		const items = input.items.filter((item) =>
			section.buckets.includes(item.bucket),
		);
		lines.push("", `## ${section.title}`);
		if (items.length === 0) {
			lines.push("无");
			continue;
		}
		for (const item of items) lines.push(itemLine(item, item.askCount));
	}
	lines.push(
		"",
		"## 裁决方法",
		"请对每个候选分别答「留」或「清」。「留」请给一句理由；「清」只会进入后续人工拆单，绝不会在本扫描里删除。",
	);
	return lines.join("\n");
}

export function renderFlagScanReport(input: {
	runToken: string;
	items: ReturnType<StateStore["getFlagScanRunItems"]>;
	scopeState: FlagScanScopeState[];
}): string {
	const candidates = input.items.filter(
		(item) => item.bucket === "candidate" || item.bucket === "orphan_candidate",
	);
	const cards = candidates
		.map((item) => {
			const projectStability = input.scopeState
				.filter((row) => row.flagName === item.flagName && row.scope !== "*")
				.sort((left, right) => left.scope.localeCompare(right.scope))
				.map((row) => {
					const stableForMs =
						row.streakStartedAt === null
							? null
							: Math.max(0, row.lastSampledAt - row.streakStartedAt);
					return `${row.scope}: ${
						stableForMs === null
							? "无稳定样本"
							: displayStableDuration(stableForMs)
					}`;
				})
				.join(" · ");
			return `
			<section class="card" data-flag="${escapeHtml(item.flagName)}" data-digest="${escapeHtml(item.canonical ? canonicalDigest(item.canonical) : "无")}">
				<div class="row"><div><h2>${escapeHtml(item.flagName)}</h2><p>${escapeHtml(item.askPhrase)}</p></div><span class="pill">已问 ${item.askCount} 次</span></div>
				<dl><dt>人话说明</dt><dd>${escapeHtml(item.description ?? "无")}</dd><dt>当前值</dt><dd><code>${escapeHtml(item.currentValue ?? "无")}</code></dd><dt>稳定时长</dt><dd>${escapeHtml(item.stableForMs === null ? "无" : displayStableDuration(item.stableForMs))}</dd>${projectStability ? `<dt>逐项目稳定</dt><dd>${escapeHtml(projectStability)}</dd>` : ""}<dt>当前样本摘要</dt><dd><code>${escapeHtml(item.canonical ? canonicalDigest(item.canonical) : "无")}</code></dd><dt>来源</dt><dd>${escapeHtml(provenanceSummary(item))}</dd></dl>
				<label>裁决<select class="verdict"><option value="">请选择</option><option value="留">留</option><option value="清">清</option></select></label>
				<label>一句理由 / 备注<textarea class="reason" rows="2" placeholder="留：为什么还需要；清：可补充拆单注意事项"></textarea></label>
			</section>`;
		})
		.join("\n");
	return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>每周 flag 留/清裁决</title>
<style>:root{color-scheme:light;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;background:#f5f5f7;color:#1d1d1f}*{box-sizing:border-box}body{margin:0}.wrap{max-width:980px;margin:auto;padding:48px 22px 80px}.hero{background:linear-gradient(135deg,#fff,#eef5ff);border:1px solid #e3e3e8;border-radius:28px;padding:34px;box-shadow:0 18px 50px #0000000d}.eyebrow{color:#06c;font-weight:700}.muted{color:#6e6e73;line-height:1.6}.warning{border-left:4px solid #ff9f0a;padding:12px 16px;background:#fff8e8;border-radius:10px}.card{background:#fff;border:1px solid #e3e3e8;border-radius:22px;padding:24px;margin-top:18px;box-shadow:0 8px 30px #0000000a}.row{display:flex;justify-content:space-between;gap:16px}.pill{background:#eef5ff;color:#06c;border-radius:999px;padding:7px 11px;height:max-content;font-size:13px}h1{font-size:40px;margin:8px 0}h2{margin:0 0 8px}dl{display:grid;grid-template-columns:130px 1fr;gap:8px;margin:18px 0}dt{color:#6e6e73}label{display:block;font-weight:650;margin-top:14px}select,textarea{display:block;width:100%;margin-top:7px;border:1px solid #c7c7cc;border-radius:12px;padding:11px;background:#fff;font:inherit}button{margin-top:24px;border:0;border-radius:999px;background:#0071e3;color:#fff;padding:13px 22px;font-weight:700;cursor:pointer}#copy-status{margin-left:12px;color:#248a3d}#copy-status.copy-fail{color:#b25000}#copy-fallback{display:none;min-height:160px}</style></head>
<body><main class="wrap"><header class="hero"><div class="eyebrow">固定每周 · 逐条裁决</div><h1>这些 flag 还要留着吗？</h1><p class="muted">同一解析后生效值连续两次采样相同且间隔满 7 天，才会出现在这里。本页只收集你的「留 / 清」意见。</p><p class="warning"><strong>不会自动删除。</strong>扫描产出的是候选清单，删除动作由人点头后另行执行。</p></header>
${cards || '<section class="card"><h2>本轮没有候选</h2></section>'}
<button id="copy-all" type="button">复制全部</button><span id="copy-status" role="status"></span><p class="muted">留言后点「复制全部」，把结果贴回 Discord。本页留言不会自动回传。</p><textarea id="copy-fallback" readonly rows="8" aria-label="手动复制裁决汇总"></textarea></main>
<script nonce="__CSP_NONCE__">(()=>{const prefix="flag-governance:"+location.pathname+":";const cards=[...document.querySelectorAll(".card[data-flag]")];const fallback=document.getElementById("copy-fallback");const status=document.getElementById("copy-status");for(const card of cards){const flag=card.dataset.flag;const verdict=card.querySelector(".verdict");const reason=card.querySelector(".reason");const saved=JSON.parse(localStorage.getItem(prefix+flag)||"{}");verdict.value=saved.verdict||"";reason.value=saved.reason||"";const save=()=>localStorage.setItem(prefix+flag,JSON.stringify({verdict:verdict.value,reason:reason.value}));verdict.addEventListener("change",save);reason.addEventListener("input",save)}document.getElementById("copy-all").addEventListener("click",async()=>{const lines=["flag 周扫描裁决 · run ${String(input.runToken).replaceAll("<", "\\u003c")}"];for(const card of cards){const flag=card.dataset.flag;const digest=card.dataset.digest;const verdict=card.querySelector(".verdict").value||"未答";const reason=card.querySelector(".reason").value.trim();lines.push("- "+flag+": "+verdict+" | canonicalDigest: "+digest+(reason?" — "+reason:""))}const text=lines.join("\\n");let copied=false;try{if(navigator.clipboard&&navigator.clipboard.writeText){await navigator.clipboard.writeText(text);copied=true}}catch{}if(!copied){fallback.value=text;fallback.style.display="block";fallback.focus();fallback.select();try{copied=document.execCommand("copy")}catch{copied=false}}if(copied){fallback.style.display="none";status.className="";status.textContent="已复制，请贴回 Discord"}else{fallback.value=text;fallback.style.display="block";fallback.focus();fallback.select();status.className="copy-fail";status.textContent="浏览器不允许自动复制;下方文本已选中,请按 ⌘C 贴回"}})})();</script></body></html>`;
}

function renderDiscordBody(input: {
	run: FlagScanRunRow;
	linearEvidence: string;
	reportStatus: string;
	reportEvidence: string;
}): string {
	return [
		`flag 周扫描 · ${input.run.candidateCount} 个候选待逐条裁决（留/清）`,
		input.reportStatus === "done"
			? `报告: ${input.reportEvidence}`
			: `报告发布失败，见 Linear 单（${input.reportEvidence}）`,
		`Linear: ${input.linearEvidence}`,
		`\`flywheel:flag-governance run=${input.run.runToken}\``,
	].join("\n");
}

export function renderLeadAlertChunks(
	run: FlagScanRunRow,
	items: ReturnType<StateStore["getFlagScanRunItems"]>,
	maxLength = 1_800,
): string[] {
	const debt = items.filter(
		(item) => item.bucket === "no_clock" || item.bucket === "keep_unbound",
	);
	if (debt.length === 0) return [];
	const header = `flag 周扫描判据不可用 · ${debt.length} 条（只通知工程 Lead，不打扰 Annie）`;
	const lines = debt.map(
		(item) => `- ${item.flagName}: ${item.reason ?? item.bucket}`,
	);
	const footer = `[flag-scan:${run.runToken}]`;
	const fixedLength = header.length + footer.length + 2;
	if (maxLength <= fixedLength) {
		throw new Error(
			"Lead alert chunk budget is smaller than its fixed framing",
		);
	}
	const payloadBudget = maxLength - fixedLength;
	const pieces: string[] = [];
	for (const line of lines) {
		for (let offset = 0; offset < line.length; offset += payloadBudget) {
			pieces.push(line.slice(offset, offset + payloadBudget));
		}
	}
	const payloads: string[] = [];
	let current = "";
	for (const piece of pieces) {
		const next = current ? `${current}\n${piece}` : piece;
		if (next.length > payloadBudget) {
			payloads.push(current);
			current = piece;
		} else {
			current = next;
		}
	}
	if (current) payloads.push(current);
	return payloads.map((payload) => `${header}\n${payload}\n${footer}`);
}

function validateProvenanceSet(
	flagNames: string[],
	provenance: FlagProvenanceInput[],
): Map<string, FlagProvenanceInput> {
	const byName = new Map(provenance.map((row) => [row.flagName, row]));
	if (
		byName.size !== provenance.length ||
		byName.size !== flagNames.length ||
		flagNames.some((name) => !byName.has(name))
	) {
		throw new Error("provenance result does not exactly cover the registry");
	}
	return byName;
}

function buildFrozenItems(
	proposed: ProposedFlagScan,
	provenance: Map<string, FlagProvenanceInput>,
	specs: FeatureFlagSpec[],
): FlagScanRunItemInput[] {
	const specByName = new Map(specs.map((spec) => [spec.name, spec]));
	const items: FlagScanRunItemInput[] = [];
	for (const candidate of proposed.candidates) {
		const source = provenance.get(candidate.flagName)!;
		const spec = specByName.get(candidate.flagName)!;
		items.push({
			flagName: candidate.flagName,
			bucket: source.status === "resolved" ? "candidate" : "orphan_candidate",
			canonical: candidate.canonical,
			description: spec.description,
			currentValue: displayCurrentValue(candidate.canonical),
			stableForMs: candidate.stableForMs,
			askPhrase: candidate.askPhrase,
			reason: candidate.reason,
			provenance: source,
		});
	}
	for (const row of proposed.claimed) {
		items.push({
			flagName: row.flagName,
			bucket: "claimed",
			canonical: null,
			description: specByName.get(row.flagName)?.description ?? null,
			currentValue: null,
			stableForMs: null,
			askPhrase: null,
			reason: `已由 ${row.retiringIssue} 认领退场`,
			provenance: provenance.get(row.flagName) ?? null,
		});
	}
	for (const row of proposed.noClock) {
		items.push({
			flagName: row.flagName,
			bucket: "no_clock",
			canonical: null,
			description: specByName.get(row.flagName)?.description ?? null,
			currentValue: null,
			stableForMs: null,
			askPhrase: null,
			reason: `${row.class}: ${row.reason}（连续 ${row.indeterminateStreak} 次）`,
			provenance: provenance.get(row.flagName) ?? null,
		});
	}
	for (const row of proposed.keepUnbound) {
		items.push({
			flagName: row.flagName,
			bucket: "keep_unbound",
			canonical: null,
			description: specByName.get(row.flagName)?.description ?? null,
			currentValue: null,
			stableForMs: null,
			askPhrase: null,
			reason: row.reason,
			provenance: provenance.get(row.flagName) ?? null,
		});
	}
	return items.sort((left, right) =>
		left.flagName.localeCompare(right.flagName),
	);
}

function owedLegs(items: FlagScanRunItemInput[]): FlagScanLeg[] {
	const leadDebt = items.some(
		(item) => item.bucket === "no_clock" || item.bucket === "keep_unbound",
	);
	return [
		"linear",
		"report",
		...(leadDebt ? (["lead_notify"] as const) : []),
		"discord",
	];
}

export function createFlagRetirementScanner(
	deps: FlagRetirementScannerDependencies,
): {
	scanIfDue(): Promise<FlagScanOutcome>;
	dryRun(): Promise<FlagScanOutcome>;
	recoverPending(): Promise<FlagScanOutcome>;
} {
	const enabled = deps.enabled;

	async function fail(error: unknown): Promise<FlagScanOutcome> {
		const message = error instanceof Error ? error.message : String(error);
		await deps.alertFailure(`flag weekly scan failed closed: ${message}`);
		return { status: "failed", error: message };
	}

	function recoverFailureAlertsAtTickEntry(): void {
		deps.recoverFailureAlerts?.();
	}

	function failedOutcome(error: unknown): FlagScanOutcome {
		return {
			status: "failed",
			error: error instanceof Error ? error.message : String(error),
		};
	}

	async function compute(dryRun: boolean): Promise<FlagScanOutcome> {
		const observedLatest = deps.store.getLatestFlagScanRun();
		try {
			const sources = await deps.loadSources();
			const keepBindings = new Map<
				string,
				ResolvedFlagKeepBinding | "unbound"
			>();
			for (const { spec } of sources.rows) {
				const binding = parseKeepBinding(spec, deps.store);
				if (binding) keepBindings.set(spec.name, binding);
			}
			const proposed = computeFlagScan({
				rows: sources.rows,
				expectedProjectNames: sources.expectedProjectNames,
				prevState: deps.store.getFlagScanState(),
				prevScopeState: deps.store.getFlagScanScopeState(),
				anchors: deps.store.getFlagKeepAnchors(),
				keepBindings,
				now: deps.now(),
			});
			const flagNames = sources.rows.map(({ spec }) => spec.name);
			const provenanceRows = await deps.loadProvenance(flagNames);
			const provenance = validateProvenanceSet(flagNames, provenanceRows);
			const items = buildFrozenItems(
				proposed,
				provenance,
				sources.rows.map(({ spec }) => spec),
			);
			const requiredLegs = owedLegs(items);
			const runToken = deps.newRunToken();
			if (dryRun) {
				const previewItems = items.map((item) => ({
					runId: 0,
					...item,
					askCount:
						(proposed.nextState.find(
							(state) => state.flagName === item.flagName,
						)?.askCount ?? 0) +
						(item.bucket === "candidate" || item.bucket === "orphan_candidate"
							? 1
							: 0),
				}));
				const hasCandidates = requiredLegs.includes("linear");
				return {
					status: "dry_run",
					runToken,
					candidateCount: items.filter(
						(item) =>
							item.bucket === "candidate" || item.bucket === "orphan_candidate",
					).length,
					linearBody: hasCandidates
						? renderFlagScanLinearBody({ runToken, items: previewItems })
						: null,
					html: hasCandidates
						? renderFlagScanReport({
								runToken,
								items: previewItems,
								scopeState: proposed.nextScopeState,
							})
						: null,
				};
			}
			const committed = deps.store.commitFlagScan({
				expectedLatestCommittedAt: observedLatest?.committedAt ?? null,
				runToken,
				now: deps.now(),
				proposed,
				items,
				provenance: provenanceRows,
				requiredLegs,
			});
			if (!committed.committed) return { status: "lost_race" };
			if (committed.run.status === "published") {
				return { status: "published", runId: committed.run.runId };
			}
			return processPending(committed.run);
		} catch (error) {
			return dryRun ? failedOutcome(error) : fail(error);
		}
	}

	async function reconcileVisibleLeg(
		run: FlagScanRunRow,
		leg: "linear" | "discord",
	): Promise<void> {
		const current = deps.store
			.getFlagScanRunLegs(run.runId)
			.find((row) => row.leg === leg);
		if (
			current?.status !== "ambiguous" ||
			current.reconcileNotBefore === null ||
			deps.now() < current.reconcileNotBefore
		) {
			return;
		}
		const createdAfter = run.startedAt - FLAG_SCAN_REMOTE_CLOCK_SKEW_MS;
		const result =
			leg === "linear"
				? await deps.effects.reconcileLinearBatch({
						runToken: run.runToken,
						createdAfter,
					})
				: await deps.effects.reconcileDiscord({
						runToken: run.runToken,
						createdAfter,
					});
		if (result.status === "found") {
			deps.store.adoptAmbiguousFlagScanLeg({
				runId: run.runId,
				leg,
				evidence: result.evidence,
			});
		} else if (result.status === "pending") {
			deps.store.deferAmbiguousFlagScanLeg({
				runId: run.runId,
				leg,
				now: deps.now(),
				reconcileNotBefore: deps.now() + FLAG_SCAN_VISIBILITY_FENCE_MS,
				evidence: result.evidence,
			});
		} else {
			deps.store.requeueAmbiguousFlagScanLeg({
				runId: run.runId,
				leg,
				now: deps.now(),
			});
		}
	}

	async function attemptLeg(
		run: FlagScanRunRow,
		leg: FlagScanLeg,
	): Promise<void> {
		let current = deps.store
			.getFlagScanRunLegs(run.runId)
			.find((row) => row.leg === leg);
		if (!current) return;
		if (
			current.status === "claimed" &&
			current.leaseExpiresAt !== null &&
			current.leaseExpiresAt <= deps.now()
		) {
			if (leg === "report") {
				deps.store.requeueExpiredReportFlagScanLeg({
					runId: run.runId,
					now: deps.now(),
				});
			} else if (leg === "lead_notify") {
				deps.store.requeueExpiredLeadNotifyFlagScanLeg({
					runId: run.runId,
					now: deps.now(),
				});
			} else {
				deps.store.markExpiredVisibleFlagScanLegAmbiguous({
					runId: run.runId,
					leg,
					now: deps.now(),
					reconcileNotBefore: deps.now() + FLAG_SCAN_VISIBILITY_FENCE_MS,
				});
			}
			current = deps.store
				.getFlagScanRunLegs(run.runId)
				.find((row) => row.leg === leg);
		}
		if (leg === "linear" || leg === "discord") {
			await reconcileVisibleLeg(run, leg);
			current = deps.store
				.getFlagScanRunLegs(run.runId)
				.find((row) => row.leg === leg);
		}
		if (current?.status !== "pending") return;
		const claim = deps.store.claimFlagScanLeg({
			runId: run.runId,
			leg,
			leaseOwner: deps.leaseOwner,
			now: deps.now(),
			leaseMs: FLAG_SCAN_LEASE_MS,
		});
		if (!claim.claimed) return;
		const items = deps.store.getFlagScanRunItems(run.runId);
		try {
			if (leg === "linear") {
				const title = `flag 周扫描 ${new Date(run.committedAt).toISOString().slice(0, 10)} · ${run.candidateCount} 个候选待裁决(留/清)`;
				const result = await deps.effects.createLinearBatch({
					runToken: run.runToken,
					title,
					body: renderFlagScanLinearBody({ runToken: run.runToken, items }),
				});
				if (result.status === "done") {
					deps.store.completeFlagScanLeg({
						runId: run.runId,
						leg,
						leaseOwner: deps.leaseOwner,
						evidence: result.evidence,
					});
				} else if (result.status === "ambiguous") {
					deps.store.markFlagScanLegAmbiguous({
						runId: run.runId,
						leg,
						leaseOwner: deps.leaseOwner,
						now: deps.now(),
						reconcileNotBefore: deps.now() + FLAG_SCAN_VISIBILITY_FENCE_MS,
					});
				}
				return;
			}
			if (leg === "report") {
				const result = await deps.effects.publishReport({
					runToken: run.runToken,
					title: `flag 周扫描 · ${run.candidateCount} 个候选`,
					html: renderFlagScanReport({
						runToken: run.runToken,
						items,
						scopeState: deps.store.getFlagScanScopeState(),
					}),
				});
				if (result.status === "done") {
					deps.store.completeFlagScanLeg({
						runId: run.runId,
						leg,
						leaseOwner: deps.leaseOwner,
						evidence: result.evidence,
					});
				} else if (result.status === "degraded") {
					deps.store.degradeFlagScanLeg({
						runId: run.runId,
						leg,
						leaseOwner: deps.leaseOwner,
						evidence: result.evidence,
					});
				}
				return;
			}
			if (leg === "lead_notify") {
				const chunks = renderLeadAlertChunks(run, items);
				const evidence: string[] = [];
				for (const [index, body] of chunks.entries()) {
					const result = await deps.effects.notifyLead({
						runToken: run.runToken,
						eventId: `flag-scan:${run.runToken}:no-clock:${index + 1}/${chunks.length}`,
						partIndex: index + 1,
						partCount: chunks.length,
						body,
					});
					if (result.status !== "done") return;
					evidence.push(result.evidence);
				}
				deps.store.completeFlagScanLeg({
					runId: run.runId,
					leg,
					leaseOwner: deps.leaseOwner,
					evidence: JSON.stringify(evidence),
				});
				return;
			}
			const legs = new Map(
				deps.store.getFlagScanRunLegs(run.runId).map((row) => [row.leg, row]),
			);
			const linear = legs.get("linear");
			const report = legs.get("report");
			if (!linear?.evidence || !report?.evidence) return;
			const result = await deps.effects.postDiscord({
				runToken: run.runToken,
				body: renderDiscordBody({
					run,
					linearEvidence: linear.evidence,
					reportStatus: report.status,
					reportEvidence: report.evidence,
				}),
			});
			if (result.status === "done") {
				deps.store.completeFlagScanLeg({
					runId: run.runId,
					leg,
					leaseOwner: deps.leaseOwner,
					evidence: result.evidence,
				});
			} else if (result.status === "ambiguous") {
				deps.store.markFlagScanLegAmbiguous({
					runId: run.runId,
					leg,
					leaseOwner: deps.leaseOwner,
					now: deps.now(),
					reconcileNotBefore: deps.now() + FLAG_SCAN_VISIBILITY_FENCE_MS,
					evidence: result.evidence,
				});
			}
		} catch {
			if (leg === "linear" || leg === "discord") {
				deps.store.markFlagScanLegAmbiguous({
					runId: run.runId,
					leg,
					leaseOwner: deps.leaseOwner,
					now: deps.now(),
					reconcileNotBefore: deps.now() + FLAG_SCAN_VISIBILITY_FENCE_MS,
				});
			}
			// report and Lead notification stay claimed until their bounded lease
			// expires; their recovery contracts intentionally differ from visible
			// Linear/Discord effects.
		}
	}

	async function processPending(run: FlagScanRunRow): Promise<FlagScanOutcome> {
		for (const leg of ["linear", "report", "lead_notify", "discord"] as const) {
			try {
				await attemptLeg(run, leg);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				try {
					await deps.alertFailure(
						`flag weekly scan pending recovery failed for run ${run.runToken}, leg ${leg}: ${message}`,
					);
				} catch {}
			}
		}
		try {
			deps.store.finalizeFlagScanRunIfSettled(run.runId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			try {
				await deps.alertFailure(
					`flag weekly scan pending recovery failed for run ${run.runToken}, leg finalize: ${message}`,
				);
			} catch {}
		}
		return deps.store.getFlagScanRun(run.runId)?.status === "published"
			? { status: "published", runId: run.runId }
			: { status: "pending", runId: run.runId };
	}

	async function recoverPending(): Promise<FlagScanOutcome> {
		if (!enabled()) return { status: "disabled" };
		recoverFailureAlertsAtTickEntry();
		const pending = deps.store.getPendingFlagScanRun();
		if (!pending) return { status: "not_due" };
		const settled = await settleStalledPendingRun(pending);
		return settled ?? processPending(pending);
	}

	async function settleStalledPendingRun(
		run: FlagScanRunRow,
	): Promise<FlagScanOutcome | null> {
		const now = deps.now();
		const ageMs = now - run.committedAt;
		const crossedSlot =
			latestFlagScanSlotAtOrBefore(now) >
			latestFlagScanSlotAtOrBefore(run.committedAt);
		if (ageMs < FLAG_SCAN_MAX_PENDING_AGE_MS && !crossedSlot) return null;
		const reason = crossedSlot
			? "crossed into a newer Sunday slot"
			: "stalled for 24h";
		try {
			await deps.alertFailure(
				`flag weekly scan run ${run.runToken} ${reason}; unsettled legs are being settled degraded so future slots remain runnable`,
			);
		} catch {}
		deps.store.settleStalledFlagScanRun({
			runId: run.runId,
			settledAt: now,
			reason,
		});
		return { status: "published", runId: run.runId };
	}

	return {
		async scanIfDue(): Promise<FlagScanOutcome> {
			if (!enabled()) return { status: "disabled" };
			recoverFailureAlertsAtTickEntry();
			const pending = deps.store.getPendingFlagScanRun();
			if (pending) {
				const settled = await settleStalledPendingRun(pending);
				if (!settled) return processPending(pending);
				if (!flagScanIsDue(deps.now(), pending.committedAt)) return settled;
			}
			const latest = deps.store.getLatestFlagScanRun();
			if (!flagScanIsDue(deps.now(), latest?.committedAt)) {
				return { status: "not_due" };
			}
			return compute(false);
		},
		dryRun: () =>
			enabled() ? compute(true) : Promise.resolve({ status: "disabled" }),
		recoverPending,
	};
}
