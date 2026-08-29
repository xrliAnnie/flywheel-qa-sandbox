#!/usr/bin/env node
/**
 * FLY-182 Track A — dead-team mailbox directory GC.
 *
 * Flywheel's permanent Leads never `TeamDelete`, so `~/.claude/teams/*` (each
 * holding an unbounded `inboxes/*.json`) accumulates dead team directories
 * (old sprints, finished worker teams). Stock claude-code GCs these via
 * `TeamDelete → rm -rf`; we never call it.
 *
 * SAFETY (Codex design review R1#1 HIGH + R2#3 — team-lead deleted a live agent
 * by mistake the same day this was written):
 * - **Report-only by default.** Prints every life/death signal per team; never
 *   deletes. The human reviews and decides.
 * - **`--apply` requires an explicit `--team <name>`.** There is NO "delete all
 *   candidates" batch mode.
 * - **Fail-closed on EVERY probe.** If any liveness probe (process / tmux /
 *   config / mtime) errors or is unavailable, the verdict is `unknown` and
 *   deletion is ABORTED — never "probe failed ⇒ assume dead".
 * - **Multiple positive death signals required:** not a configured Lead team,
 *   AND no `claude --team-name <team>` process, AND no live tmux pane referenced
 *   by the team config, AND newest mtime older than `--stale-days` (default 7).
 * - **Backup before delete:** `tar czf <backupDir>/<team>.tar.gz` then `rm -rf`.
 * - **No periodic / boot auto-delete** (FLY-129). This is a manual ops tool.
 *
 * Usage:
 *   node scripts/mailbox-gc.mjs                       # report-only (default)
 *   node scripts/mailbox-gc.mjs --stale-days 14       # report with custom age
 *   node scripts/mailbox-gc.mjs --apply --team <name> # delete ONE dead team
 */

import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_STALE_DAYS = 7;
const DAY_MS = 86_400_000;

// ----------------------------------------------------------------------------
// Pure classifier (exported for tests — takes injected probe RESULTS)
// ----------------------------------------------------------------------------

/**
 * @typedef {{ ok: boolean, value?: any, error?: string }} Probe
 * @typedef {{ mtime: Probe, process: Probe, tmux: Probe, config: Probe }} Probes
 */

/**
 * Decide whether a team directory is dead, alive, or unknown.
 *
 * @param {object} a
 * @param {string} a.teamName
 * @param {boolean} a.isLeadTeam   true → configured Lead team (always protected)
 * @param {number} a.staleDays
 * @param {number} a.now           epoch ms
 * @param {Probes} a.probes        probe results (ok:false ⇒ fail-closed)
 * @returns {{ team: string, verdict: "dead"|"alive"|"unknown", reasons: string[], signals: object }}
 */
export function classifyTeam({ teamName, isLeadTeam, staleDays, now, probes }) {
	const signals = {};

	if (isLeadTeam) {
		return {
			team: teamName,
			verdict: "alive",
			reasons: ["configured Lead team (protected — never GC'd)"],
			signals: { isLeadTeam: true },
		};
	}

	// Fail-closed: ANY probe error/unavailable → unknown, never deletable.
	for (const name of /** @type {const} */ ([
		"mtime",
		"process",
		"tmux",
		"config",
	])) {
		const p = probes?.[name];
		if (!p || p.ok !== true) {
			return {
				team: teamName,
				verdict: "unknown",
				reasons: [
					`probe '${name}' failed/unavailable (${p?.error ?? "no result"}) → fail-closed, not deletable`,
				],
				signals,
			};
		}
	}

	const ageMs = now - probes.mtime.value;
	const ageDays = ageMs / DAY_MS;
	const staleMs = staleDays * DAY_MS;
	const processRunning = probes.process.value === true;
	const hasTmuxPane = probes.tmux.value === true;
	const hasLiveMembers = probes.config.value === true;

	signals.ageDays = Number(ageDays.toFixed(2));
	signals.processRunning = processRunning;
	signals.hasLiveTmuxPane = hasTmuxPane;
	signals.hasLiveMembers = hasLiveMembers;

	const dead =
		ageMs >= staleMs &&
		processRunning === false &&
		hasTmuxPane === false &&
		hasLiveMembers === false;

	if (dead) {
		return {
			team: teamName,
			verdict: "dead",
			reasons: [
				`stale ${ageDays.toFixed(1)}d ≥ ${staleDays}d`,
				"no `claude --team-name` process",
				"no live tmux pane referenced by config",
				"no live members in config",
			],
			signals,
		};
	}

	const reasons = [];
	if (ageMs < staleMs)
		reasons.push(`recent activity (${ageDays.toFixed(1)}d < ${staleDays}d)`);
	if (processRunning)
		reasons.push("`claude --team-name <team>` process running");
	if (hasTmuxPane) reasons.push("config references a live tmux pane");
	if (hasLiveMembers) reasons.push("config has live members");
	return { team: teamName, verdict: "alive", reasons, signals };
}

// ----------------------------------------------------------------------------
// Real probes (CLI side — wired with system access; each fail-closed)
// ----------------------------------------------------------------------------

/** Newest mtime (ms) among the team dir + its immediate files/inboxes. */
async function probeMtime(teamDir) {
	try {
		let newest = 0;
		const walk = async (dir) => {
			const entries = await readdir(dir, { withFileTypes: true });
			for (const e of entries) {
				const full = join(dir, e.name);
				if (e.isDirectory()) {
					await walk(full);
				} else {
					const s = await stat(full);
					if (s.mtimeMs > newest) newest = s.mtimeMs;
				}
			}
		};
		const top = await stat(teamDir);
		newest = top.mtimeMs;
		await walk(teamDir);
		return { ok: true, value: newest };
	} catch (err) {
		return { ok: false, error: String(err?.message ?? err) };
	}
}

/** Is there a running `claude ... --team-name <team>` process? Fail-closed. */
async function probeProcess(teamName) {
	try {
		// pgrep -fl matches the full command line. Exit 0 = match(es) found.
		const { stdout } = await execFileAsync("pgrep", ["-fl", "claude"]);
		const running = stdout
			.split("\n")
			.some(
				(line) =>
					line.includes(`--team-name ${teamName}`) ||
					line.includes(`--team-name=${teamName}`),
			);
		return { ok: true, value: running };
	} catch (err) {
		// pgrep exits 1 when NO process matched "claude" — that's a valid
		// "nothing running" answer, not a probe failure.
		if (err && err.code === 1 && !err.stderr) {
			return { ok: true, value: false };
		}
		// Anything else (pgrep missing, permission denied, "cannot get process
		// list") → fail-closed.
		return { ok: false, error: String(err?.stderr || err?.message || err) };
	}
}

/** Live tmux pane ids (set). Fail-closed when tmux is unavailable. */
async function probeLivePaneIds() {
	try {
		const { stdout } = await execFileAsync("tmux", [
			"list-panes",
			"-a",
			"-F",
			"#{pane_id}",
		]);
		return {
			ok: true,
			value: new Set(
				stdout
					.split("\n")
					.map((s) => s.trim())
					.filter(Boolean),
			),
		};
	} catch (err) {
		// tmux exits non-zero with "no server running" when nothing is up. We
		// CANNOT distinguish "no panes" from "tmux broken" reliably, so treat
		// any tmux error as fail-closed (do not delete when we can't verify).
		return { ok: false, error: String(err?.stderr || err?.message || err) };
	}
}

/**
 * tmux probe: does the team config reference ANY live tmux pane?
 * Needs the live pane-id set; fail-closed if that is unavailable.
 */
async function probeTmux(teamDir, livePaneIdsProbe) {
	if (!livePaneIdsProbe.ok) {
		return { ok: false, error: `tmux unavailable: ${livePaneIdsProbe.error}` };
	}
	const cfg = await readConfigMembers(teamDir);
	if (!cfg.ok) return { ok: false, error: cfg.error };
	const live = livePaneIdsProbe.value;
	const has = cfg.members.some(
		(m) =>
			typeof m.tmuxPaneId === "string" &&
			m.tmuxPaneId.length > 0 &&
			live.has(m.tmuxPaneId),
	);
	return { ok: true, value: has };
}

/**
 * config probe: does the config list members that map to live tmux panes?
 * Mirrors probeTmux's member×pane check but framed as "live members".
 */
async function probeConfig(teamDir, livePaneIdsProbe) {
	if (!livePaneIdsProbe.ok) {
		return {
			ok: false,
			error: `cannot verify members: ${livePaneIdsProbe.error}`,
		};
	}
	const cfg = await readConfigMembers(teamDir);
	if (!cfg.ok) return { ok: false, error: cfg.error };
	const live = livePaneIdsProbe.value;
	const hasLive = cfg.members.some(
		(m) =>
			typeof m.tmuxPaneId === "string" &&
			m.tmuxPaneId.length > 0 &&
			live.has(m.tmuxPaneId),
	);
	return { ok: true, value: hasLive };
}

/** Read team config members. Missing file → ok with []. Parse error → fail-closed. */
async function readConfigMembers(teamDir) {
	const cfgPath = join(teamDir, "config.json");
	try {
		const raw = await readFile(cfgPath, "utf-8");
		const parsed = JSON.parse(raw);
		const members = Array.isArray(parsed?.members) ? parsed.members : [];
		return { ok: true, members };
	} catch (err) {
		if (err && err.code === "ENOENT") return { ok: true, members: [] };
		return {
			ok: false,
			error: `config parse failed: ${String(err?.message ?? err)}`,
		};
	}
}

// ----------------------------------------------------------------------------
// Lead-team name resolution (from projects.json)
// ----------------------------------------------------------------------------

/** Set of configured Lead team names (lead agentIds) — protected from GC. */
export async function loadLeadTeamNames(projectsPath) {
	try {
		const raw = await readFile(projectsPath, "utf-8");
		const parsed = JSON.parse(raw);
		const names = new Set();
		for (const project of Array.isArray(parsed) ? parsed : []) {
			for (const lead of project?.leads ?? []) {
				if (lead?.agentId) names.add(String(lead.agentId));
			}
		}
		return names;
	} catch {
		// If projects.json can't be read, treat NO team as a lead team would be
		// unsafe → instead return null so the caller can fail-closed (abort).
		return null;
	}
}

// ----------------------------------------------------------------------------
// Orchestration
// ----------------------------------------------------------------------------

async function gatherProbes(teamDir, teamName) {
	const livePaneIds = await probeLivePaneIds();
	const [mtime, process_, tmux, config] = await Promise.all([
		probeMtime(teamDir),
		probeProcess(teamName),
		probeTmux(teamDir, livePaneIds),
		probeConfig(teamDir, livePaneIds),
	]);
	return { mtime, process: process_, tmux, config };
}

async function dirSizeBytes(dir) {
	let total = 0;
	const walk = async (d) => {
		const entries = await readdir(d, { withFileTypes: true });
		for (const e of entries) {
			const full = join(d, e.name);
			if (e.isDirectory()) await walk(full);
			else {
				const s = await stat(full);
				total += s.size;
			}
		}
	};
	try {
		await walk(dir);
	} catch {
		/* best-effort */
	}
	return total;
}

function fmtKB(bytes) {
	return `${(bytes / 1024).toFixed(1)}KB`;
}

async function runReport({ teamsDir, leadTeamNames, staleDays, now, log }) {
	let teams;
	try {
		teams = (await readdir(teamsDir, { withFileTypes: true }))
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
	} catch (err) {
		log(`ERROR: cannot read teams dir ${teamsDir}: ${err?.message ?? err}`);
		return { dead: [], alive: [], unknown: [] };
	}
	const buckets = { dead: [], alive: [], unknown: [] };
	for (const teamName of teams.sort()) {
		const teamDir = join(teamsDir, teamName);
		const probes = await gatherProbes(teamDir, teamName);
		const verdict = classifyTeam({
			teamName,
			isLeadTeam: leadTeamNames.has(teamName),
			staleDays,
			now,
			probes,
		});
		const size = await dirSizeBytes(teamDir);
		buckets[verdict.verdict].push({ ...verdict, size });
	}
	log(`\n=== mailbox-gc report (stale-days=${staleDays}) ===`);
	for (const kind of ["dead", "unknown", "alive"]) {
		log(`\n--- ${kind.toUpperCase()} (${buckets[kind].length}) ---`);
		for (const t of buckets[kind]) {
			log(`  ${t.team}  [${fmtKB(t.size)}]  ${t.reasons.join("; ")}`);
		}
	}
	if (buckets.dead.length > 0) {
		log(
			`\nTo delete a confirmed-dead team: node scripts/mailbox-gc.mjs --apply --team <name>`,
		);
	}
	return buckets;
}

/**
 * Validate a `--team` argument is a SINGLE safe directory component before it
 * ever reaches `join()`, `tar`, or `rm` (Codex code review R1 HIGH).
 * Rejects empty, `.`/`..`, path separators, NUL, and leading `-` (which `tar`
 * / `rm` would parse as an option). Returns false on anything suspicious.
 */
export function isSafeTeamName(name) {
	return (
		typeof name === "string" &&
		name.length > 0 &&
		name !== "." &&
		name !== ".." &&
		!name.startsWith("-") &&
		!name.includes("/") &&
		!name.includes("\\") &&
		!name.includes("\0")
	);
}

async function runApply({
	teamsDir,
	teamName,
	leadTeamNames,
	staleDays,
	now,
	backupDir,
	log,
}) {
	// Codex R1 HIGH: validate the untrusted --team name BEFORE it touches
	// join()/tar/rm. Path traversal ('../x' escaping ~/.claude/teams) and
	// leading-'-' option-injection into tar/rm are both blocked here.
	if (!isSafeTeamName(teamName)) {
		log(
			`ABORT: invalid --team '${teamName}' — must be a single safe directory name (no '/', '\\', '..', leading '-').`,
		);
		return { deleted: false, reason: "invalid-team-name" };
	}
	// Stronger guard: the team MUST be an actual direct child directory of
	// teamsDir (defense in depth beyond the string check). Fail-closed if the
	// listing itself errors.
	let children;
	try {
		children = await readdir(teamsDir, { withFileTypes: true });
	} catch (err) {
		log(`ABORT: cannot list teams dir ${teamsDir}: ${err?.message ?? err}`);
		return { deleted: false, reason: "teamsdir-unreadable" };
	}
	if (!children.some((e) => e.isDirectory() && e.name === teamName)) {
		log(
			`ABORT: '${teamName}' is not a direct child team directory of ${teamsDir}.`,
		);
		return { deleted: false, reason: "not-a-child" };
	}

	const teamDir = join(teamsDir, teamName);
	try {
		await stat(teamDir);
	} catch {
		log(`ERROR: team dir not found: ${teamDir}`);
		return { deleted: false, reason: "not-found" };
	}
	const probes = await gatherProbes(teamDir, teamName);
	const verdict = classifyTeam({
		teamName,
		isLeadTeam: leadTeamNames.has(teamName),
		staleDays,
		now,
		probes,
	});
	if (verdict.verdict !== "dead") {
		log(
			`ABORT: team '${teamName}' verdict=${verdict.verdict} (not 'dead'): ${verdict.reasons.join("; ")}`,
		);
		log("Refusing to delete — fail-closed.");
		return { deleted: false, reason: verdict.verdict };
	}
	// Backup then delete.
	await mkdir(backupDir, { recursive: true });
	const tarball = join(backupDir, `${teamName}.tar.gz`);
	log(`Backing up ${teamDir} → ${tarball} ...`);
	// `--` terminates option parsing so a team name can never be read as a
	// tar/rm flag (defense in depth alongside isSafeTeamName).
	await execFileAsync("tar", ["czf", tarball, "-C", teamsDir, "--", teamName]);
	log(`Deleting ${teamDir} ...`);
	await execFileAsync("rm", ["-rf", "--", teamDir]);
	log(`DONE: deleted dead team '${teamName}' (backup at ${tarball}).`);
	return { deleted: true, backup: tarball };
}

function parseArgs(argv) {
	const args = { apply: false, team: null, staleDays: DEFAULT_STALE_DAYS };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--apply") args.apply = true;
		else if (a === "--team") args.team = argv[++i] ?? null;
		else if (a === "--stale-days") {
			const n = Number(argv[++i]);
			if (Number.isFinite(n) && n > 0) args.staleDays = n;
		}
	}
	return args;
}

async function main() {
	const log = (m) => console.log(m);
	const args = parseArgs(process.argv.slice(2));
	const teamsDir = join(homedir(), ".claude", "teams");
	const projectsPath =
		process.env.FLYWHEEL_PROJECTS_FILE ??
		join(homedir(), ".flywheel", "projects.json");
	const now = Date.now();

	const leadTeamNames = await loadLeadTeamNames(projectsPath);
	if (leadTeamNames === null) {
		log(
			`ABORT: cannot read projects.json at ${projectsPath} — cannot identify protected Lead teams. Fail-closed.`,
		);
		process.exit(2);
	}

	if (args.apply) {
		if (!args.team) {
			log("ERROR: --apply requires --team <name> (no batch delete). Aborting.");
			process.exit(2);
		}
		const backupDir = join(
			homedir(),
			".flywheel",
			"backups",
			"team-gc",
			String(now),
		);
		const res = await runApply({
			teamsDir,
			teamName: args.team,
			leadTeamNames,
			staleDays: args.staleDays,
			now,
			backupDir,
			log,
		});
		process.exit(res.deleted ? 0 : 1);
	}

	await runReport({
		teamsDir,
		leadTeamNames,
		staleDays: args.staleDays,
		now,
		log,
	});
}

// Only run main() when invoked directly (not when imported by tests).
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main().catch((err) => {
		console.error(`mailbox-gc failed: ${err?.stack ?? err}`);
		process.exit(1);
	});
}
