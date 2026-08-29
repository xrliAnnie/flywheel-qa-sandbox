#!/usr/bin/env node
/**
 * FLY-1165 deliverable 1: one-off SAFE sweep of done-but-unarchived issue
 * threads in a Lead chat channel (#flywheel-engineer backlog).
 *
 * Safety design (Codex-approved plan under engineering/doc/FLY-1165-done-thread-archive-reconcile/):
 * - READS teamlead.db strictly read-only (sqlite3 CLI, -readonly). ALL writes
 *   go through the RUNNING Bridge's existing endpoints — StateStore is sql.js;
 *   direct file writes get clobbered by the next in-process save() (FLY-663).
 * - Per-issue FRESH Linear lookup (issue(id:) single query) — never a cached
 *   list (cached protect-sets got polluted; issue hard constraint).
 * - Liveness veto is fail-closed: any live tmux window for the issue, or any
 *   probe/lookup error, skips the thread. Terminal-status session rows can
 *   still own a live process (HeartbeatService precedent) — they veto too.
 * - Default DRY-RUN; pass --execute to act. Every archive is spaced.
 *
 * env: FLYWHEEL_BRIDGE_URL (default http://localhost:9876)
 *      TEAMLEAD_API_TOKEN  (required for --execute)
 *      LINEAR_API_KEY      (required)
 *      FLYWHEEL_STATE_DIR  (default ~/.flywheel)
 * args: [--execute] [--channel <id>] [--project <name>] [--lead <id>]
 *       [--spacing-ms <n>] [--db <path>] [--report <path>]
 */

import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Statuses the FSM can finalize to `completed` via close-runner done=true
// (FLY-638 FINALIZE_DONE_SOURCE_STATES). blocked/failed rows are left alone —
// they are terminal-ish and do not block the archive itself.
export const FINALIZABLE_STATUSES = new Set([
	"running",
	"awaiting_review",
	"approved_to_ship",
	"design_done",
]);

const DONE_STATE_TYPES = new Set(["completed", "canceled"]);

/**
 * Pure decision function — the safety core. Input carries ALL session rows
 * for the issue (any status, both issue_id/issue_identifier aliases), each
 * annotated with liveness (true | false | "error").
 *
 * Returns { action: "archive"|"skip", reason, finalizeExecIds }.
 */
export function decideThreadAction({ linear, sessions }) {
	if (!linear || linear.error) {
		return { action: "skip", reason: "unresolved", finalizeExecIds: [] };
	}
	if (!DONE_STATE_TYPES.has(linear.stateType)) {
		return { action: "skip", reason: "active_in_linear", finalizeExecIds: [] };
	}
	// Fail-closed liveness veto: anything not provably dead counts as live.
	if (sessions.some((s) => s.live !== false)) {
		return { action: "skip", reason: "live_session", finalizeExecIds: [] };
	}
	const finalizeExecIds = sessions
		.filter((s) => FINALIZABLE_STATUSES.has(s.status))
		.map((s) => s.execution_id);
	return { action: "archive", reason: "done_in_linear", finalizeExecIds };
}

const SKIP_REASON_TO_CATEGORY = {
	live_session: "skipped_live_session",
	active_in_linear: "skipped_active",
	unresolved: "unresolved",
};

/** Gather facts for one thread row through injected read seams. */
export async function gatherThreadFacts(row, io) {
	const linear = await io.fetchLinear(row.issue_id);
	const sessionRows = (await io.listSessions(row.issue_id)) ?? [];
	// Window names are issue-scoped, so liveness is probed per issue and
	// applied to every session row — conservative direction (more veto).
	let live = false;
	if (sessionRows.length > 0) {
		live = await io.probeTmux(row.issue_id);
	}
	const sessions = sessionRows.map((s) => ({ ...s, live }));
	return { linear, sessions };
}

/**
 * Main-loop orchestration for ONE thread. `io` is fully injected:
 * { fetchLinear, listSessions, probeTmux, closeRunner, archiveThread, record }.
 * Obeys decideThreadAction; any finalize failure downgrades the whole thread
 * to a skip this round (fail-closed — never archive over a husk we could not
 * finalize).
 */
export async function processThread(row, io) {
	const facts = await gatherThreadFacts(row, io);
	const decision = decideThreadAction(facts);

	if (decision.action === "skip") {
		io.record(SKIP_REASON_TO_CATEGORY[decision.reason], row, {
			linear: facts.linear,
		});
		return { outcome: decision.reason };
	}

	for (const execId of decision.finalizeExecIds) {
		let result;
		try {
			result = await io.closeRunner(execId, row);
		} catch (err) {
			result = { closed: false, error: String(err) };
		}
		const ok =
			result && (result.closed === true || result.alreadyGone === true);
		if (!ok) {
			io.record("husk_finalize_failed", row, {
				executionId: execId,
				response: result,
			});
			return { outcome: "husk_finalize_failed" };
		}
		io.record("husk_finalized", row, { executionId: execId });
	}

	// Red line #6 (Codex R1 #1): the closeRunner awaits above are a TOCTOU
	// window — a run started mid-finalize must win. Re-gather (fresh sessions
	// + fresh probe + fresh Linear) and re-decide before ANY PATCH.
	//
	// Known + accepted (Codex R2, design-approved shape): the close-runner
	// ENDPOINT itself runs the FLY-369 archive cascade before returning (it is
	// wired with archive deps — research.md §1.1; that is production close
	// semantics, identical to any Lead-driven `close_runner done=true`). That
	// in-Bridge PATCH is protected by the cascade's OWN no-other-active-runner
	// guard and by the sink's archive-once; the residual guard→PATCH window is
	// the pre-existing FLY-369 one, not widened here, and Discord
	// auto-unarchive self-heals it (plan risk table). This re-veto governs the
	// SCRIPT's own archive call — the only PATCH this tool controls.
	if (decision.finalizeExecIds.length > 0) {
		const recheck = decideThreadAction(await gatherThreadFacts(row, io));
		if (recheck.action === "skip") {
			io.record(SKIP_REASON_TO_CATEGORY[recheck.reason], row, {
				detail: "post-finalize re-veto",
			});
			return { outcome: recheck.reason };
		}
	}

	let archiveResult;
	try {
		archiveResult = await io.archiveThread(row);
	} catch (err) {
		archiveResult = { archived: false, error: String(err) };
	}
	if (
		archiveResult &&
		(archiveResult.archived === true ||
			archiveResult.reason === "already_archived")
	) {
		io.record("archived", row, { reason: archiveResult.reason });
		return { outcome: "archived" };
	}
	io.record("archive_failed", row, { response: archiveResult });
	return { outcome: "archive_failed" };
}

// ---------------------------------------------------------------------------
// Real IO (only exercised when run as a script)
// ---------------------------------------------------------------------------

function assertSafeSqlToken(value, label) {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) {
		throw new Error(`${label} contains unexpected characters: ${value}`);
	}
	return value;
}

async function sqliteJson(dbPath, sql) {
	const { stdout } = await execFileAsync(
		"sqlite3",
		["-readonly", "-json", dbPath, sql],
		{ timeout: 15_000, maxBuffer: 16 * 1024 * 1024 },
	);
	const trimmed = stdout.trim();
	return trimmed ? JSON.parse(trimmed) : [];
}

async function fetchLinearIssue(linearApiKey, issueKey) {
	const query = `query IssueByIdentifier($id: String!) {
		issue(id: $id) { id identifier title state { name type } }
	}`;
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 10_000);
		const res = await fetch("https://api.linear.app/graphql", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: linearApiKey,
			},
			body: JSON.stringify({ query, variables: { id: issueKey } }),
			signal: controller.signal,
		}).finally(() => clearTimeout(timer));
		if (!res.ok) return { error: true, detail: `http_${res.status}` };
		const payload = await res.json();
		if (payload.errors?.length) {
			const msg = payload.errors.map((e) => e.message).join("; ");
			if (/entity not found|could not be found/i.test(msg)) return null;
			return { error: true, detail: msg };
		}
		const node = payload.data?.issue;
		if (!node) return null;
		return {
			id: node.id,
			identifier: node.identifier,
			title: node.title,
			stateName: node.state?.name,
			stateType: node.state?.type,
		};
	} catch (err) {
		return { error: true, detail: String(err) };
	}
}

async function probeTmuxForIssue(issueKey) {
	try {
		const { stdout } = await execFileAsync(
			"tmux",
			["list-windows", "-a", "-F", "#{session_name}:#{window_name}"],
			{ timeout: 10_000 },
		);
		return stdout.includes(issueKey);
	} catch (err) {
		const text = `${err.stderr ?? ""}${err.message ?? ""}`;
		// A missing tmux server means no window can be alive.
		if (/no server running|error connecting to/i.test(text)) return false;
		return "error";
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
	const args = {
		execute: false,
		channel: "1516209714097291335",
		project: "flywheel",
		lead: "flywheel-eng-lead",
		spacingMs: 1200,
		db: null,
		report: null,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--execute") args.execute = true;
		else if (a === "--channel") args.channel = argv[++i];
		else if (a === "--project") args.project = argv[++i];
		else if (a === "--lead") args.lead = argv[++i];
		else if (a === "--spacing-ms") args.spacingMs = Number(argv[++i]);
		else if (a === "--db") args.db = argv[++i];
		else if (a === "--report") args.report = argv[++i];
		else throw new Error(`Unknown argument: ${a}`);
	}
	return args;
}

function renderReport({ mode, channel, categories, startedAt }) {
	const lines = [
		"# FLY-1165 deliverable 1 — done-thread sweep report",
		"",
		`- Mode: ${mode}`,
		`- Channel: ${channel}`,
		`- Started: ${startedAt}`,
		`- Finished: ${new Date().toISOString()}`,
		"",
	];
	const order = [
		"archived",
		"would_archive",
		"skipped_active",
		"skipped_live_session",
		"unresolved",
		"husk_finalized",
		"would_finalize",
		"husk_finalize_failed",
		"archive_failed",
		"failed",
	];
	lines.push("## Summary", "");
	for (const cat of order) {
		const entries = categories[cat] ?? [];
		if (entries.length === 0 && !["archived", "skipped_active"].includes(cat))
			continue;
		lines.push(`- **${cat}**: ${entries.length}`);
	}
	lines.push("");
	for (const cat of order) {
		const entries = categories[cat] ?? [];
		if (entries.length === 0) continue;
		lines.push(`## ${cat} (${entries.length})`, "");
		for (const e of entries) {
			const title = e.title ? ` — ${e.title}` : "";
			const detail = e.detail ? ` (${e.detail})` : "";
			lines.push(`- ${e.issueId}${title} [thread ${e.threadId}]${detail}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const bridgeUrl = (
		process.env.FLYWHEEL_BRIDGE_URL ?? "http://localhost:9876"
	).replace(/\/$/, "");
	const apiToken = process.env.TEAMLEAD_API_TOKEN;
	const linearApiKey = process.env.LINEAR_API_KEY;
	const stateDir =
		process.env.FLYWHEEL_STATE_DIR ?? path.join(homedir(), ".flywheel");
	const dbPath = args.db ?? path.join(stateDir, "teamlead.db");

	if (!linearApiKey) {
		console.error("LINEAR_API_KEY is required (fresh per-issue lookups).");
		process.exit(1);
	}
	if (args.execute && !apiToken) {
		console.error("TEAMLEAD_API_TOKEN is required for --execute.");
		process.exit(1);
	}
	assertSafeSqlToken(args.channel, "--channel");

	const mode = args.execute ? "EXECUTE" : "DRY-RUN";
	const startedAt = new Date().toISOString();
	console.log(
		`[fly1165-sweep] ${mode} against ${dbPath} (bridge ${bridgeUrl})`,
	);

	// 1) Candidates — strictly read-only.
	const candidates = await sqliteJson(
		dbPath,
		`SELECT thread_id, channel_id, issue_id FROM chat_threads
		 WHERE channel_id = '${args.channel}'
		   AND (archived_at IS NULL OR archived_at = '')
		   AND discord_missing_at IS NULL
		   AND issue_id LIKE 'FLY-%'
		 ORDER BY created_at`,
	);
	console.log(`[fly1165-sweep] ${candidates.length} candidate thread(s)`);

	const categories = {};
	const record = (category, row, detail = {}) => {
		if (!categories[category]) categories[category] = [];
		categories[category].push({
			issueId: row.issue_id,
			threadId: row.thread_id,
			title: row.title ?? detail.linear?.title ?? "",
			detail:
				typeof detail === "object" && detail !== null && detail.response
					? JSON.stringify(detail.response)
					: (detail.detail ?? ""),
		});
		console.log(`[fly1165-sweep]   ${row.issue_id} → ${category}`);
	};

	const readIo = {
		fetchLinear: (issueKey) => fetchLinearIssue(linearApiKey, issueKey),
		listSessions: async (issueKey) => {
			assertSafeSqlToken(issueKey, "issue key");
			return sqliteJson(
				dbPath,
				`SELECT execution_id, status FROM sessions
				 WHERE issue_id = '${issueKey}' OR issue_identifier = '${issueKey}'`,
			);
		},
		probeTmux: probeTmuxForIssue,
	};

	const writeIo = {
		closeRunner: async (execId, row) => {
			const res = await fetch(
				`${bridgeUrl}/api/sessions/${encodeURIComponent(execId)}/close-runner`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${apiToken}`,
					},
					body: JSON.stringify({
						leadId: args.lead,
						reason: `FLY-1165 stale husk finalize (issue ${row.issue_id} Done, tmux gone)`,
						done: true,
					}),
				},
			);
			const body = await res.json().catch(() => ({}));
			return { httpStatus: res.status, ...body };
		},
		archiveThread: async (row) => {
			const res = await fetch(`${bridgeUrl}/api/chat-threads/archive`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiToken}`,
				},
				body: JSON.stringify({
					issueIdentifier: row.issue_id,
					channelId: args.channel,
					leadId: args.lead,
					projectName: args.project,
				}),
			});
			const body = await res.json().catch(() => ({}));
			return { httpStatus: res.status, ...body };
		},
	};

	for (const row of candidates) {
		try {
			if (!/^[A-Za-z0-9-]+$/.test(row.issue_id)) {
				record("failed", row, { detail: "unsafe issue key, skipped" });
				continue;
			}
			if (args.execute) {
				const io = {
					...writeIo,
					fetchLinear: async (key) => {
						const linear = await readIo.fetchLinear(key);
						if (linear && !linear.error) row.title = linear.title ?? "";
						return linear;
					},
					// FRESH DB query on EVERY gather (Codex R1 #1): the
					// post-finalize re-veto must see sessions that appeared during
					// the closeRunner awaits — a captured snapshot would hide them.
					listSessions: (key) => readIo.listSessions(key),
					probeTmux: readIo.probeTmux,
					record,
				};
				const out = await processThread(row, io);
				if (out.outcome === "archived") {
					await sleep(args.spacingMs);
				}
			} else {
				// Dry-run: gather + decide only; NEVER touch write endpoints.
				const sessionRows = await readIo.listSessions(row.issue_id);
				const facts = await gatherThreadFacts(row, {
					fetchLinear: readIo.fetchLinear,
					listSessions: () => sessionRows,
					probeTmux: readIo.probeTmux,
				});
				const decision = decideThreadAction(facts);
				row.title = facts.linear?.title ?? "";
				if (decision.action === "skip") {
					record(SKIP_REASON_TO_CATEGORY[decision.reason], row, {
						linear: facts.linear,
					});
				} else {
					for (const execId of decision.finalizeExecIds) {
						record("would_finalize", row, { detail: execId });
					}
					record("would_archive", row, { linear: facts.linear });
				}
			}
		} catch (err) {
			record("failed", row, { detail: String(err) });
		}
	}

	const reportPath =
		args.report ??
		path.join(
			process.cwd(),
			"engineering/doc/FLY-1165-done-thread-archive-reconcile",
			args.execute ? "deliverable1-report.md" : "deliverable1-dryrun.md",
		);
	writeFileSync(
		reportPath,
		renderReport({ mode, channel: args.channel, categories, startedAt }),
	);
	console.log(`[fly1165-sweep] report written to ${reportPath}`);

	const summary = Object.entries(categories)
		.map(([k, v]) => `${k}=${v.length}`)
		.join(" ");
	console.log(`[fly1165-sweep] done: ${summary || "no candidates"}`);
}

const isMain =
	process.argv[1] &&
	import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
	main().catch((err) => {
		console.error(`[fly1165-sweep] fatal: ${err.stack ?? err}`);
		process.exit(1);
	});
}
