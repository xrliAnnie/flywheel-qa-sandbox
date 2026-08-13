/**
 * FLY-1260 M1 — Blueprint runner prompt inventory (real measurement).
 *
 * Drives the real Blueprint (source, via tsx) through an explicit context
 * matrix, captures every appendSystemPrompt, segments each capture into
 * instruction blocks by anchor strings, and measures UTF-8 bytes + Unicode
 * chars per block. Fails loudly (exit 1) if any source-declared anchor is
 * never captured by the matrix (coverage reconciliation).
 *
 * Run from repo root:  TMPDIR=/tmp npx tsx engineering/doc/FLY-1260-harness-prompt-audit/harness/inventory.mjs
 * (TMPDIR override needed when the runner's TMPDIR lives under ~/.flywheel —
 * tsx's IPC socket path blows the unix-socket length limit there.)
 *
 * Outputs (same directory):
 *   inventory-data.json      — per-scenario ordered blocks with sizes + sha256
 *   inventory-manifest.json  — provenance (SHAs, units, matrix inputs, versions)
 *
 * AFTER regenerating, run the repo formatter over this folder or CI lint fails:
 *   npx @biomejs/biome@2.1.4 check --write engineering/doc/FLY-1260-harness-prompt-audit/
 * JSON.stringify always expands short arrays; biome collapses the ones that fit
 * and wants a trailing newline. Output is never byte-stable across runs anyway
 * (the manifest carries a generatedAt timestamp), so formatting costs nothing.
 *
 * Zero production writes: reads source, writes only into this doc folder.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");

const { Blueprint } = await import(
	path.join(REPO, "packages/edge-worker/src/Blueprint.ts")
);
const { PreHydrator } = await import(
	path.join(REPO, "packages/edge-worker/src/PreHydrator.ts")
);
const { AgentDispatcher } = await import(
	path.join(REPO, "packages/edge-worker/src/AgentDispatcher.ts")
);

// ---------------------------------------------------------------------------
// Anchor registry. `source` anchors are reconciled against Blueprint.ts text:
// every anchor listed here MUST exist in source, and every capture-anchor
// found in source by the scan regex MUST be listed here (drift → fail).
// ---------------------------------------------------------------------------
const ANCHORS = [
	{
		id: "qa-verdict",
		text: "QA VERDICT (MANDATORY — this is how the pipeline gates the founder):",
	},
	{
		id: "doc-flow",
		text: "DOC-FLOW (project doc conventions — this project has doc_flow enabled):",
	},
	{
		id: "progress-ledger",
		text: "PROGRESS LEDGER (restart-resilient — keep this current as you work):",
	},
	{
		id: "founder-ux-gate",
		text: "FOUNDER-UX GATE (this project enables founder_ux_gate):",
	},
	{
		id: "pipeline-preamble",
		text: "PIPELINE PREAMBLE — run BEFORE any other work:",
	},
	{
		id: "lead-report-back",
		text: "LEAD REPORT-BACK (MANDATORY — terminal output is NOT a report):",
	},
	{ id: "brainstorm-gate", text: "BRAINSTORM GATE (MANDATORY — do NOT skip):" },
	{
		id: "code-review-gate",
		text: "CODE REVIEW GATE (codex author — MANDATORY, run BEFORE the APPROVE GATE below):",
	},
	{
		id: "approve-gate",
		text: "APPROVE GATE (MANDATORY — do NOT skip; non-blocking review flow):",
	},
	{ id: "question-gate", text: "QUESTION GATE (use when needed):" },
	{
		id: "completion-reporting",
		text: "COMPLETION REPORTING (MANDATORY — run when finished):",
	},
	// FLY-1260 R2 (Codex code review HIGH-1): the generic checkpoint loop emits
	// `${cpName.toUpperCase()} GATE:` for review_design / review_code as TEMPLATE
	// literals, so the old double-quote-only source scan never saw them and
	// segment() folded them into the neighbouring gate (approve-gate on S02,
	// question-gate on S06). Distinct Blueprint blocks — register them.
	{ id: "review-design-gate", text: "REVIEW_DESIGN GATE:" },
	{ id: "review-code-gate", text: "REVIEW_CODE GATE:" },
	// Markdown section anchors emitted by Blueprint around injected file content.
	{ id: "agent-role", text: "## Agent Role" },
	{ id: "baseline-rules", text: "## Baseline Rules" },
	{
		id: "codex-env-translation",
		text: "## Environment Translation (codex runner)",
	},
	// FLY-1260 R2: three-stage phase blocks the old matrix under-captured (prefix).
	{ id: "qa-fix-round", text: "## QA Fix Round " },
	{ id: "keepalive", text: "## Three-stage keep-alive" },
	// FLY-1260 R2: further blocks the capture-driven fail-closed gate surfaced.
	{ id: "retry-context", text: "## Retry Context (Attempt #" }, // prefix; attempt varies
	{
		id: "finish-no-transport",
		text: "FINISH (no-transport backend — build+PR handoff, NOT a ship gate):",
	},
	// Sub-anchors for header-less segments (template-built prose; prefix match).
	{
		id: "base-flow",
		text: "You are working on a Linear issue. Follow these steps:",
	},
	{ id: "ask-nonblocking", text: "Prefer independent implementation." },
	{
		id: "lead-inbox",
		text: "Your Lead may send you instructions during your session.",
	},
	{
		id: "stage-reporting",
		text: "Report your pipeline stage at each major transition",
	},
	{ id: "resume-directive", text: "## RESUME — this issue was interrupted" },
	{
		id: "three-stage-design",
		text: "You are the DESIGN phase of a three-stage pipeline",
	},
	{
		id: "three-stage-implement",
		text: "You are the IMPLEMENT phase of a three-stage pipeline",
	},
	{
		id: "three-stage-qa",
		text: "You are the QA phase of a three-stage pipeline",
	},
];
// Anchors that segment but are NOT expected as literal double-quoted strings in
// Blueprint.ts (markdown / template-literal headers) — excluded from the
// double-quote source scan. review-*-gate are dynamic (`${cpName.toUpperCase()}
// GATE:`); the `##`-prefixed anchors don't start with a capital so the scan
// regex never matches them anyway.
const SOURCE_SCAN_EXEMPT = new Set([
	"agent-role",
	"baseline-rules",
	"resume-directive",
	"review-design-gate",
	"review-code-gate",
]);

// ---------------------------------------------------------------------------
// Fakes (mirror Blueprint.fly205-doc-flow.test.ts, without vitest)
// ---------------------------------------------------------------------------
function makeHydrator(labels) {
	return new PreHydrator(async (id) => ({
		title: `Issue ${id} title`,
		description: `Description for ${id}`,
		labels: labels ?? [],
	}));
}
const gitChecker = {
	assertCleanTree: async () => {},
	captureBaseline: async () => "abc123",
	check: async () => ({
		hasNewCommits: true,
		commitCount: 1,
		filesChanged: 3,
		commitMessages: ["feat: implement feature"],
	}),
};
const shell = { execFile: async () => ({ stdout: "", exitCode: 0 }) };
// Fake worktree manager (codex-tmux requires one; harmless for claude scenarios).
function makeWorktreeManager(idx) {
	const wt = `/tmp/fly1260-inventory-${idx}/worktrees/fake`;
	return {
		expectedWorktree: (_root, projectName, issueId) => ({
			path: wt,
			branch: `flywheel-${issueId}`,
			projectName,
			issueId,
		}),
		isRegistered: async () => false,
		readWorktreeGeneration: async () => "",
		removeIfExists: async () => {},
		create: async ({ mainRepoPath, projectName, issueId }) => ({
			projectName,
			issueId,
			worktreePath: wt,
			branch: `flywheel-${issueId}`,
			mainRepoPath,
			generation: "gen-1",
		}),
	};
}

function makeCaptureAdapter() {
	const calls = [];
	return {
		adapter: {
			type: "mock",
			supportsStreaming: false,
			checkEnvironment: async () => ({ healthy: true, message: "mock" }),
			execute: async (ctx) => {
				calls.push(ctx);
				return {
					success: true,
					sessionId: "sess-uuid",
					tmuxWindow: "flywheel:@42",
					durationMs: 5,
				};
			},
		},
		calls,
	};
}

const FULL_CHECKPOINTS = {
	brainstorm: {
		enabled: true,
		timeout_ms: 86_400_000,
		timeout_behavior: "fail-close",
	},
	question: {
		enabled: true,
		timeout_ms: 86_400_000,
		timeout_behavior: "fail-open",
	},
	approve_to_ship: {
		enabled: true,
		timeout_ms: 86_400_000,
		timeout_behavior: "fail-close",
	},
	review_design: { enabled: true },
	review_code: { enabled: true },
};
const DOC_FLOW = { enabled: true, default_department: "engineering" };
const QA_CTX = {
	parentExecutionId: "parent-exec-0000",
	prHeadSha: "ed9823622f55a382910c2002df3f325b0e017f80",
	prNumber: 584,
	branch: "flywheel-FLY-1240",
	parentIssueIdentifier: "FLY-1240",
	parentIssueUrl: "https://linear.app/geoforge3d/issue/FLY-1240/x",
};

/**
 * Context matrix. Each scenario = one Blueprint.run capture.
 * `env` entries are set for the duration of that run only.
 */
const SCENARIOS = [
	{
		name: "S01-minimal-no-lead-no-gates",
		note: "基线：无 Lead、无 checkpoint、无 doc-flow（6-step base flow + preamble + ledger + completion）",
		ctor: {},
		ctx: {},
	},
	{
		name: "S02-prod-generic-claude",
		note: "生产形态（本 issue 同款）：Lead + 全 checkpoint + doc-flow full + shipped generic 角色文件，claude 腿",
		ctor: {
			checkpoints: FULL_CHECKPOINTS,
			docFlow: DOC_FLOW,
			dispatcher: true,
		},
		ctx: {
			leadId: "flywheel-eng-lead",
			docTier: "full",
			issueUrl: "https://linear.app/geoforge3d/issue/FLY-1260/x",
			issueLabels: ["flywheel"],
		},
	},
	{
		name: "S03-prod-generic-codex",
		note: "同 S02 但 codex 腿（runnerBackend=codex-tmux 的 vendor 变体文本）",
		ctor: {
			checkpoints: FULL_CHECKPOINTS,
			docFlow: DOC_FLOW,
			dispatcher: true,
		},
		ctx: {
			leadId: "flywheel-eng-lead",
			docTier: "full",
			issueUrl: "https://linear.app/geoforge3d/issue/FLY-1260/x",
			issueLabels: ["flywheel"],
			runnerBackend: "codex-tmux",
		},
	},
	{
		name: "S04-doc-tier-plan-only",
		note: "doc-flow plan_only 档",
		ctor: {
			checkpoints: FULL_CHECKPOINTS,
			docFlow: DOC_FLOW,
			dispatcher: true,
		},
		ctx: { leadId: "flywheel-eng-lead", docTier: "plan_only", issueLabels: [] },
	},
	{
		name: "S05-doc-tier-none",
		note: "doc-flow none 档",
		ctor: {
			checkpoints: FULL_CHECKPOINTS,
			docFlow: DOC_FLOW,
			dispatcher: true,
		},
		ctx: { leadId: "flywheel-eng-lead", docTier: "none", issueLabels: [] },
	},
	{
		name: "S06-auto-qa-mode",
		// FLY-1260 R2 (Codex code review MEDIUM): AutoQaCoordinator dispatches with
		// `agentName: this.qaAgentName` (default "qa") → dispatchByName("qa"), NOT the
		// 15KB generic. This harness's empty-config dispatcher resolves that to the
		// SHIPPED qa-executor.md fallback (6,149 B) — the value for a project that
		// declares no qa agent. flywheel DOES declare agents.qa → a 3,330 B project
		// file, which the real Bridge (config loaded, project checkout at cwd) would
		// use, giving a runner ~2.8 KB smaller. Either way it is NOT the 15KB generic;
		// the auto-QA contract chain is the point (see inventory.md §1.4).
		note: "Auto-QA runner（qaContext + sessionRole=qa + agentName=qa → shipped qa-executor 兜底角色 6,149 B；flywheel 声明的项目 qa 为 3,330 B）：独立验证契约链",
		ctor: {
			checkpoints: FULL_CHECKPOINTS,
			docFlow: DOC_FLOW,
			dispatcher: true,
		},
		ctx: {
			leadId: "flywheel-eng-lead",
			sessionRole: "qa",
			agentName: "qa",
			qaContext: QA_CTX,
			issueLabels: [],
		},
	},
	{
		name: "S07-three-stage-design",
		note: "三段式 design phase（sessionRole=design + shareParentBranch）",
		ctor: {
			checkpoints: FULL_CHECKPOINTS,
			docFlow: DOC_FLOW,
			dispatcher: true,
		},
		ctx: {
			leadId: "flywheel-eng-lead",
			sessionRole: "design",
			shareParentBranch: true,
			docTier: "full",
			issueLabels: [],
		},
	},
	{
		name: "S08-three-stage-implement",
		note: "三段式 implement phase",
		ctor: {
			checkpoints: FULL_CHECKPOINTS,
			docFlow: DOC_FLOW,
			dispatcher: true,
		},
		ctx: {
			leadId: "flywheel-eng-lead",
			sessionRole: "implement",
			shareParentBranch: true,
			issueLabels: [],
		},
	},
	{
		name: "S09-three-stage-implement-fixround",
		note: "三段式 implement QA-fix round（phaseFixContext）",
		ctor: {
			checkpoints: FULL_CHECKPOINTS,
			docFlow: DOC_FLOW,
			dispatcher: true,
		},
		ctx: {
			leadId: "flywheel-eng-lead",
			sessionRole: "implement",
			shareParentBranch: true,
			phaseFixContext: { round: 1, qaSummary: "QA found X" },
			issueLabels: [],
		},
	},
	{
		name: "S10-three-stage-qa-phase",
		note: "三段式 QA phase（sessionRole=qa + shareParentBranch、无 qaContext——qaContext 会切到 auto-QA 路径）",
		ctor: {
			checkpoints: FULL_CHECKPOINTS,
			docFlow: DOC_FLOW,
			dispatcher: true,
		},
		ctx: {
			leadId: "flywheel-eng-lead",
			sessionRole: "qa",
			shareParentBranch: true,
			issueLabels: [],
		},
	},
	{
		name: "S11-retry",
		note: "重试派发（retryContext 注入的上下文块）",
		ctor: {
			checkpoints: FULL_CHECKPOINTS,
			docFlow: DOC_FLOW,
			dispatcher: true,
		},
		ctx: {
			leadId: "flywheel-eng-lead",
			retryContext: {
				predecessorExecutionId: "prior-exec-0000",
				previousError: "previous run failed",
				attempt: 2,
				reason: "retry after failure",
			},
			issueLabels: [],
		},
	},
	{
		name: "S12-resume",
		// FLY-1260 R2 (Codex code review LOW): the earlier note claimed "前段 gate
		// 抑制" but the capture keeps brainstorm/question/approve/review gates — only
		// the onboard PIPELINE PREAMBLE is suppressed (resumeMode.suppressOnboardBrainstorm).
		note: "FLY-795 restart-resume（RESUME 指令置顶；仅抑制 onboard preamble，gate 块仍在）",
		ctor: {
			checkpoints: FULL_CHECKPOINTS,
			docFlow: DOC_FLOW,
			dispatcher: true,
		},
		ctx: {
			leadId: "flywheel-eng-lead",
			progressResume: {
				progressPath: "engineering/doc/FLY-1260-x/progress.md",
				priorExecutionId: "prior-exec-0000",
				resumeKind: "restart",
				effectiveStage: "implement",
			},
			issueLabels: [],
		},
	},
	{
		name: "S13-pr-handoff-no-transport",
		note: "FLY-493 no-transport 后端（runnerTransportMode=none → pr_handoff 终态流程）",
		ctor: {
			checkpoints: FULL_CHECKPOINTS,
			docFlow: DOC_FLOW,
			dispatcher: true,
		},
		ctx: {
			leadId: "flywheel-eng-lead",
			runnerTransportMode: "none",
			issueLabels: [],
		},
	},
	{
		name: "S14-founder-ux-gate",
		note: "FLY-598 founder-UX gate（config mode=on + env flag）",
		ctor: {
			checkpoints: FULL_CHECKPOINTS,
			docFlow: DOC_FLOW,
			dispatcher: true,
			founderUx: { mode: "designer" },
		},
		ctx: { leadId: "flywheel-eng-lead", issueLabels: [] },
		env: { FLYWHEEL_FOUNDER_UX_GATE_ENABLED: "1" },
	},
	// FLY-1260 R2 (Codex code review HIGH): added gate-coverage variants so the
	// fail-closed claim rests on more than the default matrix.
	{
		name: "S15-three-stage-design-keepalive-off",
		note: "三段式 design phase，keepalive kill-switch OFF（FLYWHEEL_THREE_STAGE_KEEPALIVE=0 → 无 keepalive park 块）",
		ctor: {
			checkpoints: FULL_CHECKPOINTS,
			docFlow: DOC_FLOW,
			dispatcher: true,
		},
		ctx: {
			leadId: "flywheel-eng-lead",
			sessionRole: "design",
			shareParentBranch: true,
			docTier: "full",
			issueLabels: [],
		},
		env: { FLYWHEEL_THREE_STAGE_KEEPALIVE: "0" },
	},
	{
		name: "S16-no-land-fallback",
		note: "无 SkillInjector 成功 + 无 worktree → canLand=false → 4 步 no-land base-flow（生产 fallback 分支）",
		ctor: {
			checkpoints: FULL_CHECKPOINTS,
			docFlow: DOC_FLOW,
			dispatcher: true,
			noSkillInject: true,
			noWorktree: true,
		},
		ctx: {
			leadId: "flywheel-eng-lead",
			docTier: "full",
			issueUrl: "https://linear.app/geoforge3d/issue/FLY-1260/x",
			issueLabels: ["flywheel"],
		},
	},
];

// ---------------------------------------------------------------------------
async function capture(scenario, idx) {
	const { adapter, calls } = makeCaptureAdapter();
	const dispatcher = scenario.ctor.dispatcher
		? new AgentDispatcher({}, undefined, REPO)
		: undefined;
	const blueprint = new Blueprint(
		makeHydrator(scenario.ctx.issueLabels),
		gitChecker,
		() => adapter,
		shell,
		scenario.ctor.noWorktree ? undefined : makeWorktreeManager(idx), // worktreeManager
		// FLY-1260 R2 (Codex code review HIGH): production (run-infra.ts) passes a real
		// SkillInjector whose .inject() succeeds even for a non-git root → Blueprint sets
		// skillInjectionSucceeded=true → canLand=true → the 6-step LAND base-flow (my own
		// production prompt confirms it). A `undefined` skillInjector forced the legacy
		// no-land 4-step branch. A successful no-op stub mirrors the production land path.
		// `noSkillInject` scenarios exercise the no-land fallback explicitly.
		scenario.ctor.noSkillInject ? undefined : { inject: async () => {} }, // skillInjector
		undefined, // evidenceCollector
		undefined, // skillsConfig (flywheel declares no land_command → flywheel-land skill variant)
		undefined, // decisionLayer
		undefined, // eventEmitter
		dispatcher,
		scenario.ctor.checkpoints,
		REPO, // flywheelRepoRoot
		scenario.ctor.docFlow,
		scenario.ctor.founderUx,
	);
	const saved = {};
	for (const [k, v] of Object.entries(scenario.env ?? {})) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	try {
		fs.mkdirSync(`/tmp/fly1260-inventory-${idx}/worktrees/fake`, {
			recursive: true,
		});
		const node = { id: `FLY-9${String(idx).padStart(2, "0")}`, blockedBy: [] };
		const ctx = {
			teamName: "eng",
			runnerName: "claude",
			projectName: "flywheel",
			executionId: `inv-exec-${idx}`,
			...scenario.ctx,
		};
		const res = await blueprint.run(node, `/tmp/fly1260-inventory-${idx}`, ctx);
		if (calls.length === 0) {
			console.error(
				`${scenario.name}: run result =`,
				JSON.stringify(res, null, 1).slice(0, 800),
			);
		}
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
	if (calls.length === 0)
		throw new Error(`${scenario.name}: adapter never called`);
	return calls[0].appendSystemPrompt ?? "";
}

function segment(prompt) {
	const hits = [];
	for (const a of ANCHORS) {
		let from = 0;
		for (;;) {
			const i = prompt.indexOf(a.text, from);
			if (i === -1) break;
			hits.push({ id: a.id, index: i });
			from = i + a.text.length;
		}
	}
	hits.sort((x, y) => x.index - y.index);
	const blocks = [];
	if (hits.length === 0 || hits[0].index > 0) {
		blocks.push({
			id: "(head)",
			start: 0,
			end: hits[0]?.index ?? prompt.length,
		});
	}
	for (let i = 0; i < hits.length; i++) {
		const start = hits[i].index;
		const end = i + 1 < hits.length ? hits[i + 1].index : prompt.length;
		blocks.push({ id: hits[i].id, start, end });
	}
	return blocks.map((b) => {
		const text = prompt.slice(b.start, b.end);
		return {
			block: b.id,
			utf8Bytes: Buffer.byteLength(text, "utf8"),
			unicodeChars: [...text].length,
			sha256: createHash("sha256").update(text).digest("hex").slice(0, 16),
		};
	});
}

// ---------------------------------------------------------------------------
// Source reconciliation: every ALL-CAPS quoted anchor in Blueprint.ts must be
// in ANCHORS, and every ANCHORS.text (non-exempt) must exist in source.
// ---------------------------------------------------------------------------
const blueprintSrcPath = path.join(
	REPO,
	"packages/edge-worker/src/Blueprint.ts",
);
const blueprintSrc = fs.readFileSync(blueprintSrcPath, "utf8");
const scanRe = /"([A-Z][A-Z0-9 -]{8,}[^"\n]*)"/g;
const sourceAnchors = new Set();
for (const m of blueprintSrc.matchAll(scanRe)) {
	// Only treat as a block anchor when it is a section header: ALL-CAPS lead-in
	// AND ends with a colon (every Blueprint block header follows this shape).
	if (/[:：]$/.test(m[1])) sourceAnchors.add(m[1]);
}
const declared = new Set(
	ANCHORS.filter((a) => !SOURCE_SCAN_EXEMPT.has(a.id)).map((a) => a.text),
);
const missingFromRegistry = [...sourceAnchors].filter((s) => !declared.has(s));
const missingFromSource = [...declared].filter(
	(s) => !blueprintSrc.includes(s),
);
if (missingFromRegistry.length > 0) {
	console.error("FAIL: source declares block anchors not in registry:");
	for (const s of missingFromRegistry) console.error(`  - ${s}`);
	process.exit(1);
}
if (missingFromSource.length > 0) {
	console.error("FAIL: registry anchors missing from source:");
	for (const s of missingFromSource) console.error(`  - ${s}`);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Capture-driven orphan gate (FLY-1260 R2, Codex code review HIGH-1).
//
// The double-quote source scan above cannot see template-literal or markdown
// block headers (`${cpName.toUpperCase()} GATE:`, `## QA Fix Round`, ...), so on
// its own the coverage gate was fail-OPEN: a real block could be silently folded
// into a neighbour. This gate closes that hole against the ACTUAL captured text:
// every Blueprint-emitted header line in every captured prompt must map to a
// registered anchor, or the run fails. It is bounded by the matrix (it only sees
// captured scenarios) but makes "a block present in a captured scenario that is
// not registered" a hard failure.
//
// A header is Blueprint-emitted unless it lives inside the EXACT injected role
// file text. R2 (Codex code review HIGH) hardens two earlier weaknesses:
//   (1) The old exclusion was "between `## Agent Role` and `## Baseline Rules`",
//       which also swallows Blueprint's own `## Domain Config` / `## Environment
//       Translation` wrappers (they live in that span). Now we exclude the
//       EXACT role-file text (`agentContent.slice(0,40_000)`, matching
//       Blueprint.ts), so any Blueprint wrapper header around it IS checked.
//   (2) The old prefix match was two-way (`a.startsWith(b) || b.startsWith(a)`),
//       which would accept an unknown SHORTER header (`## Environment`). Now
//       exact match for fixed anchors, and one-way `header.startsWith(prefix)`
//       only for the small set of genuinely-variable-suffix anchors.
// HEADER_RE catches Blueprint's two header styles: any `## ` markdown H2 (so a
// new mixed-case block head like `## Domain Config` is caught), and ALL-CAPS
// colon-terminated lead-ins. The gate is bounded by the matrix — it only proves
// captured scenarios have no unregistered header; see the scenario list for the
// variants exercised (land / no-land, keepalive-off, codex, qa, resume, retry, ...).
const HEADER_RE = /^(?:##\s+\S.*|[A-Z][A-Z0-9 _\-/()]{5,}[^\n]*[:：])$/;
const PREFIX_ANCHOR_IDS = new Set([
	"qa-fix-round",
	"keepalive",
	"retry-context",
	// The RESUME directive header carries an issue-specific suffix ("...; a prior
	// runner left real progress on THIS branch."). The one-way match surfaced this;
	// R1's two-way match had accidentally accepted it as a prefix.
	"resume-directive",
]);
const EXACT_ANCHORS = new Set(
	ANCHORS.filter((a) => !PREFIX_ANCHOR_IDS.has(a.id)).map((a) => a.text),
);
const PREFIX_ANCHORS = ANCHORS.filter((a) => PREFIX_ANCHOR_IDS.has(a.id)).map(
	(a) => a.text,
);
function isRegistered(header) {
	if (EXACT_ANCHORS.has(header)) return true;
	return PREFIX_ANCHORS.some((p) => header.startsWith(p));
}
// Exact role-file text spans (matches Blueprint's `agentContent.slice(0,40_000)`).
const ROLE_TEXTS = [
	fs.readFileSync(path.join(REPO, "agents/generic-executor.md"), "utf8"),
	fs.readFileSync(path.join(REPO, "agents/qa-executor.md"), "utf8"),
].map((t) => t.slice(0, 40_000));
function blueprintOrphanHeaders(prompt) {
	// Find whichever role file text is embedded, exclude exactly its byte span.
	let roleStart = -1;
	let roleEnd = -1;
	for (const rt of ROLE_TEXTS) {
		const i = prompt.indexOf(rt);
		if (i !== -1) {
			roleStart = i;
			roleEnd = i + rt.length;
			break;
		}
	}
	const orphans = [];
	let off = 0;
	for (const line of prompt.split("\n")) {
		const t = line.trim();
		if (HEADER_RE.test(t)) {
			// Role-file-internal iff the whole line sits inside the exact role text.
			const lineEnd = off + line.length;
			const inRoleFile =
				roleStart >= 0 && off >= roleStart && lineEnd <= roleEnd;
			if (!inRoleFile && !isRegistered(t)) orphans.push(t);
		}
		off += line.length + 1; // +1 for the split "\n"
	}
	return [...new Set(orphans)];
}

// ---------------------------------------------------------------------------
// Run the matrix
// ---------------------------------------------------------------------------
const results = [];
const seenAnchorIds = new Set();
const orphanFailures = [];
for (let i = 0; i < SCENARIOS.length; i++) {
	const sc = SCENARIOS[i];
	const prompt = await capture(sc, i + 1);
	const blocks = segment(prompt);
	for (const b of blocks) seenAnchorIds.add(b.block);
	const orphans = blueprintOrphanHeaders(prompt);
	if (orphans.length > 0) orphanFailures.push({ scenario: sc.name, orphans });
	results.push({
		scenario: sc.name,
		note: sc.note,
		totalUtf8Bytes: Buffer.byteLength(prompt, "utf8"),
		totalUnicodeChars: [...prompt].length,
		blocks,
	});
	console.log(
		`${sc.name}: ${Buffer.byteLength(prompt, "utf8")} bytes, ${blocks.length} blocks`,
	);
}

// Fail-closed: any Blueprint-emitted header not covered by a registered anchor.
if (orphanFailures.length > 0) {
	console.error(
		"FAIL: captured Blueprint headers with no registered anchor (fold/miss risk):",
	);
	for (const f of orphanFailures) {
		for (const o of f.orphans)
			console.error(`  - [${f.scenario}] ${JSON.stringify(o)}`);
	}
	process.exit(1);
}

// Coverage gate: every registered anchor must be captured by ≥1 scenario.
const uncaptured = ANCHORS.filter((a) => !seenAnchorIds.has(a.id));
if (uncaptured.length > 0) {
	console.error(
		"FAIL: registered anchors never captured by the context matrix:",
	);
	for (const a of uncaptured) console.error(`  - ${a.id}: ${a.text}`);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Static assets: agent role files, lead-rules (raw + per-role assembled), skills
// ---------------------------------------------------------------------------
function measureFile(p) {
	const buf = fs.readFileSync(p);
	const text = buf.toString("utf8");
	return {
		utf8Bytes: buf.length,
		unicodeChars: [...text].length,
		sha256: createHash("sha256").update(buf).digest("hex").slice(0, 16),
	};
}

const agentFiles = [
	"agents/generic-executor.md",
	"agents/qa-executor.md",
	...fs
		.readdirSync(path.join(REPO, ".flywheel/agents"), { recursive: true })
		.filter((f) => String(f).endsWith(".md"))
		.map((f) => path.join(".flywheel/agents", String(f))),
].map((rel) => ({ file: rel, ...measureFile(path.join(REPO, rel)) }));

const leadRulesDir = path.join(REPO, "packages/teamlead/lead-rules-base");
const leadRuleFiles = fs
	.readdirSync(leadRulesDir)
	.filter((f) => f.endsWith(".md"))
	.map((f) => ({ file: f, ...measureFile(path.join(leadRulesDir, f)) }));

// Per-role bundle sizing. The shipped `compute_lead_rule_bundle` resolves the
// FILE LIST for a role; it does not concatenate. FLY-1260 R2 (Codex code review
// LOW): report BOTH the raw file-byte sum AND the real runtime-assembled size
// (each file trimmed, joined with "\n\n"), so the manifest cannot claim
// separators are modeled when the raw sum doesn't model them.
const bundleScript = path.join(
	REPO,
	"packages/teamlead/scripts/lead-rules-bundle.sh",
);
function assembledFor(role) {
	const out = execFileSync("bash", [
		"-c",
		`source "${bundleScript}" && compute_lead_rule_bundle "${role}" "${leadRulesDir}" flywheel-comm 0`,
	]).toString("utf8");
	const files = out.split("\n").filter(Boolean);
	let rawBytes = 0;
	let rawChars = 0;
	const texts = [];
	for (const f of files) {
		const buf = fs.readFileSync(f);
		rawBytes += buf.length;
		rawChars += [...buf.toString("utf8")].length;
		texts.push(buf.toString("utf8").trim());
	}
	const assembled = texts.join("\n\n");
	return {
		role,
		files: files.map((f) => path.basename(f)),
		rawSumUtf8Bytes: rawBytes,
		rawSumUnicodeChars: rawChars,
		assembledUtf8Bytes: Buffer.byteLength(assembled, "utf8"),
		assembledUnicodeChars: [...assembled].length,
	};
}
const leadBundles = ["companion", "cos", "dept"].map(assembledFor);

// Skills: reproducibility unit = lock snapshot (22 names + per-skill folder hash).
const lockPath = path.join(process.env.HOME, ".agents/.skill-lock.json");
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const managed = Object.entries(lock.skills ?? {})
	.filter(([, v]) => v.source === "xrliAnnie/flywheel-skills")
	.map(([name, v]) => {
		const skillMd = path.join(
			process.env.HOME,
			".agents/skills",
			name,
			"SKILL.md",
		);
		const text = fs.readFileSync(skillMd, "utf8");
		const fm = text.match(/^---\n([\s\S]*?)\n---/);
		const desc = fm
			? (fm[1].match(/^description:\s*([\s\S]*?)(?=\n\w+:|$)/m)?.[1] ?? "")
			: "";
		return {
			skill: name,
			skillFolderHash: v.skillFolderHash ?? null,
			descriptionUtf8Bytes: Buffer.byteLength(desc.trim(), "utf8"),
			bodyUtf8Bytes: Buffer.byteLength(text, "utf8"),
			bodyUnicodeChars: [...text].length,
		};
	})
	.sort((a, b) => b.bodyUtf8Bytes - a.bodyUtf8Bytes);

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------
const git = (args) =>
	execFileSync("git", args, { cwd: REPO }).toString().trim();
// FLY-1260 R2 (Codex code review MEDIUM): provenance must let two byte-different
// runs be distinguished. Record the FULL effective ctor config (not just its
// keys — the checkpoint timeouts/behaviors, doc-flow, founder-ux mode all affect
// bytes), the per-scenario env, the toolchain, and content hashes binding the
// data file + every measured asset. Also record the prompt-affecting env
// inherited from the process so a keep-alive/bridge flag leak is visible.
// FLY-1260 R2 (Codex code review MEDIUM): use the env names Blueprint actually
// reads. resolveBridgeUrl() reads TEAMLEAD_URL/HOST/PORT (NOT FLYWHEEL_BRIDGE_URL);
// the resume ledger reads FLYWHEEL_PROGRESS_RESUME; keep-alive reads
// FLYWHEEL_THREE_STAGE_KEEPALIVE; founder-ux reads FLYWHEEL_FOUNDER_UX_GATE_ENABLED.
const PROMPT_AFFECTING_ENV = [
	"FLYWHEEL_FOUNDER_UX_GATE_ENABLED",
	"FLYWHEEL_THREE_STAGE_KEEPALIVE",
	"FLYWHEEL_PROGRESS_RESUME",
	"TEAMLEAD_URL",
	"TEAMLEAD_HOST",
	"TEAMLEAD_PORT",
	"TEAMLEAD_INGEST_TOKEN",
	"FLYWHEEL_COMM_BACKEND",
	"FLYWHEEL_DISABLE_CHROME",
];
const inheritedEnv = {};
for (const k of PROMPT_AFFECTING_ENV) {
	// Record the actual value for prompt-affecting toggles (safe: they are hosts/
	// flags, not secrets); redact the ingest token to presence-only.
	if (!(k in process.env)) inheritedEnv[k] = null;
	else if (k === "TEAMLEAD_INGEST_TOKEN") inheritedEnv[k] = "<set>";
	else inheritedEnv[k] = process.env[k];
}
const dataObject = {
	scenarios: results,
	agentFiles,
	leadRuleFiles,
	leadBundles,
	skills: managed,
};
const dataJson = JSON.stringify(dataObject, null, "\t");
let tsxVersion = null;
try {
	tsxVersion = JSON.parse(
		fs.readFileSync(path.join(REPO, "node_modules/tsx/package.json"), "utf8"),
	).version;
} catch {}
const manifest = {
	generatedAt: new Date().toISOString(),
	units: {
		utf8Bytes: "Buffer.byteLength(text,'utf8')",
		unicodeChars: "[...text].length (code points)",
		note: "互斥 context 不加总（见 inventory.md）。lead-rules 报 rawSum（文件字节和，不含拼接分隔）与 assembled（trim+『\\n\\n』拼接的真实常驻）两列。",
	},
	repoHeadSha: git(["rev-parse", "HEAD"]),
	blueprintFileSha: git([
		"hash-object",
		"packages/edge-worker/src/Blueprint.ts",
	]),
	// FLY-1260 R2 (Codex code review MEDIUM): the measurement algorithm lives in
	// this script — bind its content so a changed harness is visible in provenance.
	harnessSha256: createHash("sha256")
		.update(fs.readFileSync(fileURLToPath(import.meta.url)))
		.digest("hex"),
	// The checkout root. Blueprint embeds an ABSOLUTE commCliPath derived from it,
	// so per-block sha256 in inventory-data.json are checkout-path-sensitive; two
	// checkouts at different paths produce identical BYTE COUNTS but different
	// hashes. Recorded so that path-sensitivity is explicit, not a silent mismatch.
	repoRoot: REPO,
	toolchain: {
		node: process.version,
		tsx: tsxVersion,
		platform: `${process.platform}-${process.arch}`,
	},
	// Content bindings: any change to a measured asset shows here. (We intentionally
	// do NOT self-hash inventory-data.json: the repo lint step reformats it after
	// this script writes it, which would invalidate a byte-level self-hash. The
	// per-asset hashes below are the provenance binding — they cover every measured
	// input and are stable across formatting.)
	assetHashes: {
		agentFiles: agentFiles.map((a) => ({ file: a.file, sha256: a.sha256 })),
		leadRuleFiles: leadRuleFiles.map((f) => ({
			file: f.file,
			sha256: f.sha256,
		})),
		skills: managed.map((s) => ({
			skill: s.skill,
			skillFolderHash: s.skillFolderHash,
		})),
	},
	anchors: ANCHORS,
	// FULL effective config per scenario (values, not just keys) + resolved env.
	scenarios: SCENARIOS.map((s) => ({
		name: s.name,
		note: s.note,
		ctx: s.ctx,
		ctor: s.ctor, // full FULL_CHECKPOINTS / DOC_FLOW / founderUx values
		env: s.env ?? {},
	})),
	inheritedPromptEnv: inheritedEnv,
	skillLockSource: "xrliAnnie/flywheel-skills",
	skillCount: managed.length,
};
// dataJson is serialized above so manifest.dataSha256 binds these exact bytes.
fs.writeFileSync(path.join(HERE, "inventory-data.json"), dataJson);
fs.writeFileSync(
	path.join(HERE, "inventory-manifest.json"),
	JSON.stringify(manifest, null, "\t"),
);
console.log(
	`\nOK: ${results.length} scenarios captured, all ${ANCHORS.length} anchors covered.`,
);
console.log(`Wrote inventory-data.json + inventory-manifest.json`);
