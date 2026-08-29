/**
 * FLY-286 PR-3: `flywheel-comm xhs-analysis <subcommand>` — the skill's CLI into
 * the analysis/review/feedback data layer. JSON on stdout; validation → stderr
 * + exit 2 (mirrors `xhs-state`).
 *
 *   write-run  --file <run.json>
 *   deliver    --file <run.json> --owner <RUN_KEY> [--base-url <url>]
 *   read-feedback   (--report-token <t> | --project <p> --collection <c> --run-token <r>)
 *   mark-feedback-consumed (--report-token <t> | --project <p> --collection <c> --run-token <r>)
 *                   --op-id <id> --result <text> --owner <o>
 *
 * Common: --state-dir overrides the default (else FLYWHEEL_XHS_STATE_DIR / ~).
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
	createLocalAnalysisStore,
	createLocalFeedbackStore,
	XIAOHONGSHU_FEEDBACK_SCHEMA_VERSION,
	type XiaohongshuAnalysisRun,
	type XiaohongshuFeedbackFile,
} from "../xiaohongshu-analysis-store.js";
import {
	deliverReviewArtifacts,
	validateBaseUrl,
} from "../xiaohongshu-review-delivery.js";
import {
	type ReviewLocator,
	readLocator,
	writeLocator,
} from "../xiaohongshu-review-locator.js";
import {
	defaultStateDir,
	readState,
	recordAnalysisDelivered,
	withCollectionLock,
	writeState,
} from "../xiaohongshu-state.js";

const SAFE_REPORT_TOKEN = /^[A-Za-z0-9._-]{1,128}$/;
const POST_STATUSES = new Set([
	"analyzed",
	"created",
	"candidate",
	"no_action",
]);
const MEDIA_KINDS = new Set(["text", "image", "video"]);

function emit(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}
function fail(msg: string): never {
	process.stderr.write(`xhs-analysis: ${msg}\n`);
	process.exit(2);
}

function readJsonFile(file: string): unknown {
	let raw: string;
	try {
		raw = readFileSync(file, "utf-8");
	} catch (err) {
		fail(
			`cannot read --file ${JSON.stringify(file)}: ${(err as Error).message}`,
		);
	}
	try {
		return JSON.parse(raw);
	} catch (err) {
		fail(`--file is not valid JSON: ${(err as Error).message}`);
	}
}

function str(o: Record<string, unknown>, k: string, where: string): string {
	const v = o[k];
	if (typeof v !== "string" || v.trim() === "")
		fail(`${where}.${k} must be a non-empty string`);
	return v;
}

const SAFE_SEG = /^[A-Za-z0-9._-]+$/;
/** A string field that is ALSO a safe path segment (codex code R1#2): reject at
 *  the CLI boundary so an unsafe id can't reach (and crash) the fs store. */
function safeSeg(o: Record<string, unknown>, k: string, where: string): string {
	const v = o[k];
	if (typeof v !== "string" || !SAFE_SEG.test(v))
		fail(`${where}.${k} must match ${SAFE_SEG} (got ${JSON.stringify(v)})`);
	return v;
}
/** A required FINITE numeric field (codex code R1#2: don't coerce "bad" → 0). */
function numField(
	o: Record<string, unknown>,
	k: string,
	where: string,
): number {
	const v = o[k];
	if (typeof v !== "number" || !Number.isFinite(v))
		fail(`${where}.${k} must be a finite number`);
	return v;
}
/** Validate an explicit --project/--collection/--run-token arg (R1#3). */
function safeArg(v: string | undefined, name: string): string {
	if (typeof v !== "string" || !SAFE_SEG.test(v))
		fail(`${name} is missing or malformed (must match ${SAFE_SEG})`);
	return v;
}

/**
 * Validate + NORMALIZE a run to ONLY the known schema fields (codex R1#6): this
 * both validates types/enums and guarantees no stray/raw-byte-like fields get
 * persisted (anything outside the schema is dropped).
 */
function normalizeAnalysisRun(input: unknown): XiaohongshuAnalysisRun {
	if (input == null || typeof input !== "object" || Array.isArray(input))
		fail("run must be a JSON object");
	const o = input as Record<string, unknown>;
	if (o.schemaVersion !== 1) fail("run.schemaVersion must be 1");
	if (!Array.isArray(o.posts)) fail("run.posts must be an array");
	const sw = o.sourceWindow as Record<string, unknown> | undefined;
	if (sw == null || typeof sw !== "object")
		fail("run.sourceWindow must be an object");
	const sm = o.summary as Record<string, unknown> | undefined;
	if (sm == null || typeof sm !== "object")
		fail("run.summary must be an object");
	const posts = (o.posts as unknown[]).map((p, i) => {
		const where = `run.posts[${i}]`;
		if (p == null || typeof p !== "object" || Array.isArray(p))
			fail(`${where} must be an object`);
		const po = p as Record<string, unknown>;
		if (!POST_STATUSES.has(po.status as string))
			fail(`${where}.status must be one of ${[...POST_STATUSES].join(", ")}`);
		if (
			!Array.isArray(po.mediaKinds) ||
			(po.mediaKinds as unknown[]).some((m) => !MEDIA_KINDS.has(m as string))
		)
			fail(`${where}.mediaKinds must be an array of text|image|video`);
		const j = po.judgment as Record<string, unknown> | undefined;
		if (j == null || typeof j.useful !== "boolean")
			fail(`${where}.judgment.useful must be a boolean`);
		const norm: XiaohongshuAnalysisRun["posts"][number] = {
			noteId: str(po, "noteId", where),
			title: typeof po.title === "string" ? po.title : "",
			url: typeof po.url === "string" ? po.url : "",
			mediaKinds:
				po.mediaKinds as XiaohongshuAnalysisRun["posts"][number]["mediaKinds"],
			summary: typeof po.summary === "string" ? po.summary : "",
			judgment: {
				useful: j.useful,
				reason: typeof j.reason === "string" ? j.reason : "",
			},
			status: po.status as XiaohongshuAnalysisRun["posts"][number]["status"],
		};
		if (po.candidateIssue && typeof po.candidateIssue === "object") {
			const ci = po.candidateIssue as Record<string, unknown>;
			norm.candidateIssue = {
				title: typeof ci.title === "string" ? ci.title : "",
				body: typeof ci.body === "string" ? ci.body : "",
			};
		}
		if (po.createdIssue && typeof po.createdIssue === "object") {
			const ci = po.createdIssue as Record<string, unknown>;
			norm.createdIssue = {
				issueId: str(ci, "issueId", `${where}.createdIssue`),
				opId: str(ci, "opId", `${where}.createdIssue`),
				state: typeof ci.state === "string" ? ci.state : "",
			};
		}
		return norm;
	});
	return {
		schemaVersion: 1,
		// runToken/project/collectionId are state-file path segments → safe-seg
		// validate at the CLI boundary (R1#2), not delegate the crash to the store.
		runToken: safeSeg(o, "runToken", "run"),
		execId: str(o, "execId", "run"),
		project: safeSeg(o, "project", "run"),
		collectionId: safeSeg(o, "collectionId", "run"),
		collectionLabel: str(o, "collectionLabel", "run"),
		generatedAt: str(o, "generatedAt", "run"),
		sourceWindow: {
			fetched: numField(sw, "fetched", "run.sourceWindow"),
			total: numField(sw, "total", "run.sourceWindow"),
			capped: sw.capped === true,
		},
		posts,
		summary: {
			analyzed: numField(sm, "analyzed", "run.summary"),
			created: numField(sm, "created", "run.summary"),
			candidates: numField(sm, "candidates", "run.summary"),
			skipped: numField(sm, "skipped", "run.summary"),
		},
		review: null,
	};
}

/** Resolve --report-token (via locator) OR explicit --project/--collection/--run-token. */
function resolveTarget(
	stateDir: string,
	values: Record<string, string | undefined>,
): { project: string; collectionId: string; runToken: string } | null {
	const reportToken = values["report-token"];
	if (reportToken) {
		if (!SAFE_REPORT_TOKEN.test(reportToken))
			fail("--report-token is malformed");
		const loc: ReviewLocator | null = readLocator(stateDir, reportToken);
		if (!loc) return null;
		return {
			project: loc.project,
			collectionId: loc.collectionId,
			runToken: loc.runToken,
		};
	}
	if (!values.project && !values.collection && !values["run-token"])
		fail("provide --report-token, OR --project + --collection + --run-token");
	// Safe-segment validate the explicit args (R1#3) before any store access.
	return {
		project: safeArg(values.project, "--project"),
		collectionId: safeArg(values.collection, "--collection"),
		runToken: safeArg(values["run-token"], "--run-token"),
	};
}

export async function xhsAnalysis(argv: string[]): Promise<number> {
	const sub = argv[0];
	const { values } = parseArgs({
		args: argv.slice(1),
		options: {
			file: { type: "string" },
			"state-dir": { type: "string" },
			"base-url": { type: "string" },
			owner: { type: "string" },
			project: { type: "string" },
			collection: { type: "string" },
			"run-token": { type: "string" },
			"report-token": { type: "string" },
			"op-id": { type: "string" },
			result: { type: "string" },
		},
		allowPositionals: false,
	});
	const stateDir = values["state-dir"]?.trim() || defaultStateDir();

	switch (sub) {
		case "write-run": {
			if (!values.file) fail("--file is required");
			const run = normalizeAnalysisRun(readJsonFile(values.file));
			createLocalAnalysisStore(stateDir).writeRun(run);
			emit({ ok: true, runToken: run.runToken });
			return 0;
		}

		case "deliver": {
			if (!values.file) fail("--file is required");
			const owner = values.owner;
			if (!owner) fail("--owner is required (delivery mutates fenced state)");
			const run = normalizeAnalysisRun(readJsonFile(values.file));
			const baseUrl =
				values["base-url"]?.trim() || process.env.FLYWHEEL_BRIDGE_URL;
			if (!baseUrl) fail("--base-url or $FLYWHEEL_BRIDGE_URL is required");
			// Validate base URL BEFORE the lock so a bad URL is a controlled exit 2,
			// not an uncaught throw from inside deliverReviewArtifacts (codex R1#3).
			try {
				validateBaseUrl(baseUrl);
			} catch (err) {
				fail((err as Error).message);
			}
			const analysis = createLocalAnalysisStore(stateDir);
			// ONE critical section (codex R4#2): fence BEFORE any write, then
			// artifacts (locator-first + run) + state update, emit only on success.
			const out = await withCollectionLock(
				stateDir,
				run.project,
				run.collectionId,
				() => {
					const cur = readState(stateDir, run.project, run.collectionId);
					if (!cur.lease || cur.lease.owner !== owner) {
						return { fenced: true as const, heldBy: cur.lease?.owner ?? null };
					}
					const art = deliverReviewArtifacts({
						writeRun: (r) => analysis.writeRun(r),
						writeLocator: (loc) => writeLocator(stateDir, loc),
						run,
						baseUrl,
						randomToken: () => randomBytes(16).toString("hex"),
						now: () => new Date().toISOString(),
					});
					writeState(
						stateDir,
						recordAnalysisDelivered(cur, {
							runToken: run.runToken,
							reportToken: art.reportToken,
						}),
					);
					return {
						fenced: false as const,
						reportToken: art.reportToken,
						url: art.url,
					};
				},
				{ owner },
			);
			if (out.fenced) {
				emit({ ok: false, reason: "not_lease_owner", heldBy: out.heldBy });
				return 2;
			}
			emit({ reportToken: out.reportToken, url: out.url });
			return 0;
		}

		case "read-feedback": {
			const target = resolveTarget(stateDir, values);
			if (!target) {
				emit(null);
				return 0;
			}
			const fb = createLocalFeedbackStore(stateDir).readFeedback(
				target.project,
				target.collectionId,
				target.runToken,
			);
			emit(fb ?? null);
			return 0;
		}

		case "mark-feedback-consumed": {
			const opId = values["op-id"];
			const owner = values.owner;
			if (!opId) fail("--op-id is required");
			if (!owner) fail("--owner is required");
			const target = resolveTarget(stateDir, values);
			if (!target) fail("unknown report/run target");
			const result = values.result ?? "";
			const feedback = createLocalFeedbackStore(stateDir);
			const out = await withCollectionLock(
				stateDir,
				target.project,
				target.collectionId,
				() => {
					const cur = readState(stateDir, target.project, target.collectionId);
					if (!cur.lease || cur.lease.owner !== owner) {
						return { fenced: true as const, heldBy: cur.lease?.owner ?? null };
					}
					const existing =
						feedback.readFeedback(
							target.project,
							target.collectionId,
							target.runToken,
						) ??
						({
							schemaVersion: XIAOHONGSHU_FEEDBACK_SCHEMA_VERSION,
							runToken: target.runToken,
							comments: [],
							actions: [],
							consumedActions: [],
						} satisfies XiaohongshuFeedbackFile);
					const already = existing.consumedActions.some((c) => c.opId === opId);
					const merged: XiaohongshuFeedbackFile = already
						? existing
						: {
								...existing,
								consumedActions: [
									...existing.consumedActions,
									{ opId, at: new Date().toISOString(), result },
								],
							};
					feedback.writeFeedback(target.project, target.collectionId, merged);
					return { fenced: false as const };
				},
				{ owner },
			);
			if (out.fenced) {
				emit({ ok: false, reason: "not_lease_owner", heldBy: out.heldBy });
				return 2;
			}
			emit({ ok: true, opId });
			return 0;
		}

		default:
			fail(`unknown subcommand "${sub}"`);
	}
}
