/**
 * FLY-247 WI-4: Fleet evidence collection + Dashboard payload.
 *
 * Plan: doc/engineer/plan/new/v1.40.0-FLY-247-fleet-config-dashboard.md
 * (§2.4 two-axis observed model, §2.5 three-layer display, R6#5 single
 * evidence owner, R8#4 single derived decision function).
 *
 * Architecture:
 *  - `ConfigSnapshotProvider` — hot-reloads ONLY the fleet fields
 *    (leads[].{model,backend}) onto the boot topology every refresh; any
 *    structural change → restart-required + last-known-good (R3#4).
 *  - `collectFleetSnapshot()` — async, dependency-injected; the SINGLE
 *    owner of observed probes for Bridge consumers (R6#5). One batched
 *    tmux query per refresh. Probe failures → indeterminate, never a
 *    confirmed verdict (R4#1).
 *  - `deriveDecision()` — the ONE function mapping (desired, management,
 *    runtime) → {presentation, paneWatch}, consumed by both Dashboard and
 *    the pane alert path so the two can never disagree (R8#4).
 *  - `FleetPoller` — 30s cadence with overlap guard; SSE's 2s payload
 *    reuses the latest snapshot (F9).
 */

import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { withSyncOpMarker } from "flywheel-claude-runner";
import {
	type CarrierEvidenceEntry,
	processAliveWithStart as defaultProcessAliveWithStart,
	readCarrierRuntimeAssertion,
	writeCarrierAuthorizationEvidenceSnapshot,
} from "flywheel-comm/lead-lease";
import { deriveLeadSocketPath } from "../lead-address.js";
import {
	DEFAULT_LEAD_BACKEND,
	effectiveLeadBackend,
	type LeadBackendId,
} from "../lead-backends/lead-backend.js";
import type { LeadConfig, ProjectEntry } from "../ProjectConfig.js";

// ── Types ───────────────────────────────────────────────────────────────

export type FleetManagement =
	| "standard-confirmed"
	| "external-confirmed"
	| "indeterminate";
export type FleetRuntime =
	| "claude-confirmed"
	| "no-claude-confirmed"
	| "indeterminate";
export type FleetPresentation =
	| "ONLINE"
	| "DOWN"
	| "PARTIAL"
	| "DEGRADED"
	| "EXTERNAL"
	| "CONFLICT"
	| "CONFLICT-CARRIER";

export interface FleetLeadState {
	project: string;
	leadId: string;
	/** Exact key: `${project}-${leadId}` — the launchd/manifest identity. */
	key: string;
	companion: boolean;
	canSpawnRunners: boolean;
	configured: {
		model: string | null;
		/** FLY-671: desired effort, or null = default (no override). */
		effort: string | null;
		backend: LeadBackendId;
		/** FLY-1680: absent and explicit v2 are equivalent for Claude Leads. */
		carrier: "v2" | "none";
		source: "explicit" | "legacy" | "default";
	};
	carrier: {
		manifestExists: boolean;
		plistExists: boolean;
		manifestModel: string | null;
		manifestBackend: string | null;
		plistModel: string | null;
		/** FLY-671: effort carriers (manifest field + plist FLYWHEEL_LEAD_EFFORT). */
		manifestEffort: string | null;
		plistEffort: string | null;
		plistCarrier: "v2" | "unknown";
	};
	observed: {
		management: FleetManagement;
		runtime: FleetRuntime;
		collectedAt: string;
		degradationReasons: string[];
	};
	/** Derived via deriveDecision() — never interpreted ad hoc (R8#4). */
	presentation: FleetPresentation;
	/** Same single decision function feeds the pane alert path. */
	paneWatch: boolean;
	/**
	 * Drift is only computed for alignable standard-managed leads; codex
	 * external carriers are N/A, not drift (R3#5). FLY-671 adds the effort axis.
	 */
	drift: {
		model: boolean;
		backend: boolean;
		effort: boolean;
		carrier: boolean;
	} | null;
}

export interface FleetSnapshot {
	collectedAt: string;
	configState: ConfigSnapshotState;
	leads: FleetLeadState[];
}

export type ConfigSnapshotState =
	| "live"
	| "env-pinned"
	| "degraded"
	| "restart-required";

// ── Single decision function (R8#4) ─────────────────────────────────────

/**
 * The total presentation/alert table from plan §WI-4. Both the Dashboard
 * and the pane alert path derive from THIS function — never from raw axes.
 *
 * 漏报>误报: only `external-confirmed × no-claude-confirmed` under a codex
 * desire is excluded from the pane alert path; every indeterminate keeps
 * watching. `codex + standard×no-claude` shows a loud CONFLICT-CARRIER but
 * is excluded — the evidence positively says no Claude pane exists, and a
 * pane-text alert aimed at a backend it cannot observe only makes noise.
 */
export function deriveDecision(
	desiredBackend: LeadBackendId,
	management: FleetManagement,
	runtime: FleetRuntime,
): { presentation: FleetPresentation; paneWatch: boolean } {
	if (desiredBackend === "claude-code") {
		if (management === "standard-confirmed") {
			if (runtime === "claude-confirmed")
				return { presentation: "ONLINE", paneWatch: true };
			if (runtime === "no-claude-confirmed")
				return { presentation: "DOWN", paneWatch: true };
			return { presentation: "PARTIAL", paneWatch: true };
		}
		// external/indeterminate management under a claude desire: degraded
		// visibility, keep watching (missed alert worse than a false one).
		return { presentation: "DEGRADED", paneWatch: true };
	}
	// desired codex
	if (runtime === "claude-confirmed") {
		// Includes manual/nohup Claude (R5#1): a live Claude pane under a codex
		// desire is a conflict the operator must resolve — keep watching it.
		return { presentation: "CONFLICT", paneWatch: true };
	}
	if (management === "indeterminate" || runtime === "indeterminate") {
		return { presentation: "DEGRADED", paneWatch: true };
	}
	if (management === "standard-confirmed") {
		// Standard carrier still wired while codex is desired — anomalous.
		return { presentation: "CONFLICT-CARRIER", paneWatch: false };
	}
	return { presentation: "EXTERNAL", paneWatch: false };
}

// ── Probe dependencies (injected; real impls in plugin wiring) ──────────

export interface FleetProbeDeps {
	/** Read a file; throw on error (treated as probe failure → indeterminate). */
	readFile(path: string): string;
	fileExists(path: string): boolean;
	/** kill(pid, 0)-style liveness; false when dead/ESRCH. */
	pidAlive(pid: number): boolean;
	/**
	 * launchctl print for an exact label. `{loaded:false}` = determined-unloaded;
	 * null = probe itself failed (→ indeterminate).
	 */
	launchdPrint(label: string): Promise<{ loaded: boolean; pid: number } | null>;
	/**
	 * ONE batched `tmux list-panes -a` per refresh. null = probe failed.
	 * QA F-2: dead panes (#{pane_dead}==1) must be filtered or flagged — a
	 * SIGTERM'd Claude pane still reports its last command.
	 */
	listPanes(): Promise<Array<{
		windowName: string;
		command: string;
		panePid: number;
		dead: boolean;
	}> | null>;
	/** FLY-1663: query one canonical private tmux server; absent = old probe. */
	listPanesAtSocket?(socketPath: string): Promise<Array<{
		windowName: string;
		command: string;
		panePid: number;
		dead: boolean;
	}> | null>;
	/**
	 * QA F-3: process-tree commands for a pid (self + 2 child levels);
	 * null = probe failure. Healthy production Claude panes report a bare
	 * VERSION NUMBER as pane_current_command, so the tree is the reliable
	 * claude-runtime signal (mirrors the bash process_tree_has_claude).
	 */
	processCommandsOf(pid: number): Promise<string[] | null>;
	homeDir(): string;
	/** Runtime state root; defaults to $HOME/.flywheel. */
	stateDir?(): string;
	now(): Date;
}

const PLIST_PREFIX = "com.flywheel.lead";

function manifestPathFor(stateDir: string, key: string): string {
	return join(stateDir, "manifests", `${key}.json`);
}
function plistPathFor(home: string, key: string): string {
	return join(home, "Library", "LaunchAgents", `${PLIST_PREFIX}.${key}.plist`);
}
function wrapperV2PathFor(stateDir: string): string {
	return join(stateDir, "bin", "flywheel-lead-wrapper-v2.sh");
}

export function classifyLeadPlistCarrier(
	plist: string,
	home: string,
	stateDir = join(home, ".flywheel"),
): "v2" | "unknown" {
	return plist.includes(`<string>${wrapperV2PathFor(stateDir)}</string>`) &&
		!plist.includes("flywheel-codex-lead-wrapper-")
		? "v2"
		: "unknown";
}

// ── Evidence collection (§2.4) ──────────────────────────────────────────

interface CarrierRead {
	manifestExists: boolean;
	plistExists: boolean;
	manifestModel: string | null;
	manifestBackend: string | null;
	manifestPid: number;
	manifestSocketPath: string | null;
	plistModel: string | null;
	/** FLY-671: effort carriers. */
	manifestEffort: string | null;
	plistEffort: string | null;
	plistCarrier: "v2" | "unknown";
	plistOk: boolean; // structural binding: wrapper + canonical manifest + label
	identityOk: boolean; // manifest projectName/leadId bind to this exact key
	probeFailed: boolean;
}

function readCarrier(
	home: string,
	stateDir: string,
	key: string,
	projectName: string,
	leadId: string,
	deps: FleetProbeDeps,
): CarrierRead {
	const out: CarrierRead = {
		manifestExists: false,
		plistExists: false,
		manifestModel: null,
		manifestBackend: null,
		manifestPid: 0,
		manifestSocketPath: null,
		plistModel: null,
		manifestEffort: null,
		plistEffort: null,
		plistCarrier: "unknown",
		plistOk: false,
		identityOk: false,
		probeFailed: false,
	};
	const mPath = manifestPathFor(stateDir, key);
	const pPath = plistPathFor(home, key);
	try {
		out.manifestExists = deps.fileExists(mPath);
		out.plistExists = deps.fileExists(pPath);
	} catch {
		out.probeFailed = true;
		return out;
	}
	if (out.manifestExists) {
		try {
			const m = JSON.parse(deps.readFile(mPath)) as {
				model?: string;
				effort?: string;
				leadBackend?: { backendId?: string };
				pid?: number;
				projectName?: string;
				leadId?: string;
				socketPath?: string;
			};
			// Identity binding (code-review R2-M2): a copied/renamed manifest
			// must not lend standard-managed status to this exact key.
			out.identityOk = m.projectName === projectName && m.leadId === leadId;
			out.manifestModel = typeof m.model === "string" ? m.model : null;
			out.manifestEffort = typeof m.effort === "string" ? m.effort : null;
			out.manifestBackend =
				typeof m.leadBackend?.backendId === "string"
					? m.leadBackend.backendId
					: null;
			out.manifestPid = typeof m.pid === "number" ? m.pid : 0;
			out.manifestSocketPath =
				typeof m.socketPath === "string" ? m.socketPath : null;
		} catch {
			out.probeFailed = true;
		}
	}
	if (out.plistExists) {
		try {
			const plist = deps.readFile(pPath);
			// QA F-1: hand-edited production plists put <key>/<string> on separate
			// lines — allow whitespace/newlines between the tags.
			const modelMatch = plist.match(
				/<key>\s*FLYWHEEL_LEAD_MODEL\s*<\/key>\s*<string>([^<]*)<\/string>/,
			);
			out.plistModel = modelMatch?.[1] ?? null;
			// FLY-671: mirror the model regex for the effort carrier.
			const effortMatch = plist.match(
				/<key>\s*FLYWHEEL_LEAD_EFFORT\s*<\/key>\s*<string>([^<]*)<\/string>/,
			);
			out.plistEffort = effortMatch?.[1] ?? null;
			out.plistCarrier = classifyLeadPlistCarrier(plist, home, stateDir);
			out.plistOk =
				out.plistCarrier !== "unknown" &&
				plist.includes(`<string>${mPath}</string>`) &&
				plist.includes(`<string>${PLIST_PREFIX}.${key}</string>`);
			if (out.plistCarrier === "v2") {
				out.identityOk =
					out.identityOk &&
					out.manifestSocketPath ===
						deriveLeadSocketPath(`${projectName}/${leadId}`, stateDir);
			}
		} catch {
			out.probeFailed = true;
		}
	}
	return out;
}

async function observeManagement(
	key: string,
	carrier: CarrierRead,
	deps: FleetProbeDeps,
): Promise<{ management: FleetManagement; reasons: string[] }> {
	const reasons: string[] = [];
	if (carrier.probeFailed) {
		return { management: "indeterminate", reasons: ["carrier-read-failed"] };
	}
	// Bound evidence 1-2 (structural, incl. manifest identity binding R2-M2)
	if (
		!carrier.manifestExists ||
		!carrier.plistExists ||
		!carrier.plistOk ||
		!carrier.identityOk
	) {
		return { management: "external-confirmed", reasons };
	}
	// 3. exact label loaded with PID > 0
	const print = await deps.launchdPrint(`${PLIST_PREFIX}.${key}`);
	if (print === null) {
		return { management: "indeterminate", reasons: ["launchd-probe-failed"] };
	}
	if (!print.loaded || print.pid <= 0) {
		return { management: "external-confirmed", reasons };
	}
	// 4. launchd PID === manifest.pid and alive (manifest.pid alone is NOT
	//    evidence — residual Claude / PID reuse, R7#1)
	if (print.pid !== carrier.manifestPid || !deps.pidAlive(print.pid)) {
		return { management: "external-confirmed", reasons };
	}
	return { management: "standard-confirmed", reasons };
}

async function observeRuntime(
	key: string,
	launchdPid: number,
	panes: Array<{
		windowName: string;
		command: string;
		panePid: number;
		dead: boolean;
	}> | null,
	deps: FleetProbeDeps,
	privateCarrier = false,
): Promise<{ runtime: FleetRuntime; reasons: string[] }> {
	// Axis-1 (QA F-3, aligns with bash): the launchd pid's process tree.
	if (launchdPid > 0 && deps.pidAlive(launchdPid)) {
		const cmds = await deps.processCommandsOf(launchdPid);
		if (cmds === null) {
			return { runtime: "indeterminate", reasons: ["ps-probe-failed"] };
		}
		if (cmds.some((c) => /claude(-lead)?/i.test(c))) {
			return { runtime: "claude-confirmed", reasons: [] };
		}
	}
	if (panes === null) {
		return { runtime: "indeterminate", reasons: ["tmux-probe-failed"] };
	}
	// Axis-2: LIVE panes only (QA F-2 — dead panes still report a command).
	// Window-name match alone is NOT sufficient — FLY-242's Codex observer
	// reuses the exact window name; the pane COMMAND must prove Claude
	// (R8#3) OR the pane PID's process tree must (QA F-3 — healthy Claude
	// panes report a bare version number as their command).
	const matching = panes.filter(
		(p) =>
			!p.dead &&
			(privateCarrier ? p.windowName === "main" : p.windowName.includes(key)),
	);
	for (const p of matching) {
		if (/claude/i.test(p.command)) {
			return { runtime: "claude-confirmed", reasons: [] };
		}
		if (p.panePid > 0) {
			const cmds = await deps.processCommandsOf(p.panePid);
			if (cmds === null) {
				return { runtime: "indeterminate", reasons: ["ps-probe-failed"] };
			}
			if (cmds.some((c) => /claude(-lead)?/i.test(c))) {
				return { runtime: "claude-confirmed", reasons: [] };
			}
		}
	}
	return { runtime: "no-claude-confirmed", reasons: [] };
}

/**
 * Collect the full fleet evidence map. The SINGLE probe owner for Bridge
 * consumers (Dashboard + fleet sensors); the fleet CLI takes its own fresh
 * probes under the restart lock (R7#4 — separate process, never this map).
 */
export async function collectFleetSnapshot(
	projects: ProjectEntry[],
	legacyBackendOf: (project: ProjectEntry) => string | undefined,
	deps: FleetProbeDeps,
	configState: ConfigSnapshotState = "live",
): Promise<FleetSnapshot> {
	const home = deps.homeDir();
	const stateDir = deps.stateDir?.() ?? join(home, ".flywheel");
	const collectedAt = deps.now().toISOString();
	// ONE batched tmux query per refresh (F9/R6#5).
	let panes: Array<{
		windowName: string;
		command: string;
		panePid: number;
		dead: boolean;
	}> | null = null;
	try {
		panes = await deps.listPanes();
	} catch {
		panes = null;
	}

	const leads: FleetLeadState[] = [];
	for (const project of projects) {
		const legacy = legacyBackendOf(project);
		for (const lead of project.leads) {
			const key = `${project.projectName}-${lead.agentId}`;
			const eff = effectiveLeadBackend(lead.backend, legacy);
			let carrier: CarrierRead;
			let management: FleetManagement;
			let reasons: string[] = [];
			let runtime: FleetRuntime;
			try {
				carrier = readCarrier(
					home,
					stateDir,
					key,
					project.projectName,
					lead.agentId,
					deps,
				);
				const m = await observeManagement(key, carrier, deps);
				management = m.management;
				reasons = m.reasons;
				const print = await deps.launchdPrint(`${PLIST_PREFIX}.${key}`);
				const launchdPid = print?.loaded ? print.pid : 0;
				let leadPanes = panes;
				const privateCarrier = carrier.plistCarrier === "v2";
				if (privateCarrier) {
					leadPanes =
						carrier.identityOk && carrier.manifestSocketPath
							? ((await deps.listPanesAtSocket?.(carrier.manifestSocketPath)) ??
								null)
							: [];
				}
				const r = await observeRuntime(
					key,
					launchdPid,
					leadPanes,
					deps,
					privateCarrier,
				);
				runtime = r.runtime;
				reasons = reasons.concat(r.reasons);
			} catch {
				// Per-probe degradation: one broken lead must not sink the table.
				carrier = {
					manifestExists: false,
					plistExists: false,
					manifestModel: null,
					manifestBackend: null,
					manifestPid: 0,
					manifestSocketPath: null,
					plistModel: null,
					manifestEffort: null,
					plistEffort: null,
					plistCarrier: "unknown",
					plistOk: false,
					identityOk: false,
					probeFailed: true,
				};
				management = "indeterminate";
				runtime = "indeterminate";
				reasons = ["probe-crashed"];
			}

			const decision = deriveDecision(eff.backend, management, runtime);
			// Drift only for alignable standard carriers (R3#5): codex external
			// is N/A/EXTERNAL, not drift.
			let drift: {
				model: boolean;
				backend: boolean;
				effort: boolean;
				carrier: boolean;
			} | null = null;
			if (eff.backend === "claude-code" && carrier.manifestExists) {
				const configuredModel = lead.model ?? null;
				const configuredEffort = lead.effort ?? null;
				const configuredCarrier = lead.carrier ?? "v2";
				drift = {
					model:
						configuredModel !== carrier.manifestModel ||
						configuredModel !== carrier.plistModel,
					backend:
						(carrier.manifestBackend ?? DEFAULT_LEAD_BACKEND) !== eff.backend,
					effort:
						configuredEffort !== carrier.manifestEffort ||
						configuredEffort !== carrier.plistEffort,
					carrier: configuredCarrier !== carrier.plistCarrier,
				};
			}

			leads.push({
				project: project.projectName,
				leadId: lead.agentId,
				key,
				companion: lead.companion === true,
				canSpawnRunners: lead.canSpawnRunners !== false,
				configured: {
					model: lead.model ?? null,
					effort: lead.effort ?? null,
					backend: eff.backend,
					carrier: eff.backend === "claude-code" ? "v2" : "none",
					source: eff.source,
				},
				carrier: {
					manifestExists: carrier.manifestExists,
					plistExists: carrier.plistExists,
					manifestModel: carrier.manifestModel,
					manifestBackend: carrier.manifestBackend,
					plistModel: carrier.plistModel,
					manifestEffort: carrier.manifestEffort,
					plistEffort: carrier.plistEffort,
					plistCarrier: carrier.plistCarrier,
				},
				observed: {
					management,
					runtime,
					collectedAt,
					degradationReasons: reasons,
				},
				presentation: decision.presentation,
				paneWatch: decision.paneWatch,
				drift,
			});
		}
	}
	return { collectedAt, configState, leads };
}

// ── Config snapshot provider (R2#4 + R3#4) ──────────────────────────────

export interface ConfigSnapshotProviderDeps {
	loadProjects(): ProjectEntry[];
	/** FLYWHEEL_PROJECTS env mode: no hot reload, explicit pin. */
	envPinned: boolean;
	logger?: (msg: string) => void;
}

/** Non-fleet projection used to detect structural change (R3#4). */
function structuralProjection(projects: ProjectEntry[]): string {
	return JSON.stringify(
		projects.map((p) => ({
			projectName: p.projectName,
			projectRoot: p.projectRoot,
			projectRepo: p.projectRepo ?? null,
			generalChannel: p.generalChannel ?? null,
			memoryAllowedUsers: p.memoryAllowedUsers ?? null,
			leads: p.leads.map((l) => {
				// FLY-671: effort is a HOT fleet field (like model/backend) — exclude
				// it from the structural projection so a projects.json effort edit is
				// a hot overlay, NOT a restart-required structural change.
				const {
					model: _m,
					backend: _b,
					effort: _e,
					modelContextWindow: _w,
					botToken: _t,
					carrier: _c,
					...rest
				} = l;
				return rest;
			}),
		})),
	);
}

/**
 * Boot topology is the baseline; only `model`/`backend` of existing exact
 * keys are overlaid on refresh. Routing/auth/notifier keep consuming the
 * boot objects — partial hot updates of structural fields would split-brain
 * the Bridge process (R3#4). Structural change → restart-required +
 * last-known-good fleet overlay.
 */
export class ConfigSnapshotProvider {
	private state: ConfigSnapshotState;
	private current: ProjectEntry[];
	private readonly bootStructural: string;

	constructor(
		private readonly bootProjects: ProjectEntry[],
		private readonly deps: ConfigSnapshotProviderDeps,
	) {
		this.state = deps.envPinned ? "env-pinned" : "live";
		this.current = bootProjects;
		this.bootStructural = structuralProjection(bootProjects);
	}

	snapshot(): { projects: ProjectEntry[]; state: ConfigSnapshotState } {
		return { projects: this.current, state: this.state };
	}

	/** True when ≥1 lead explicitly configures a fleet field (default-off gate, R1#6). */
	hasExplicitFleetConfig(): boolean {
		return this.current.some((p) =>
			p.leads.some(
				(l) =>
					l.model !== undefined ||
					l.backend !== undefined ||
					l.effort !== undefined ||
					l.modelContextWindow !== undefined,
			),
		);
	}

	refresh(): void {
		if (this.deps.envPinned) {
			this.state = "env-pinned";
			return;
		}
		let fresh: ProjectEntry[];
		try {
			fresh = this.deps.loadProjects();
		} catch (err) {
			this.state = "degraded";
			this.deps.logger?.(
				`[ConfigSnapshotProvider] parse/validation failed — keeping last-known-good: ${(err as Error).message}`,
			);
			return;
		}
		if (structuralProjection(fresh) !== this.bootStructural) {
			this.state = "restart-required";
			this.deps.logger?.(
				"[ConfigSnapshotProvider] structural change detected — fleet overlay frozen at last-known-good; restart the Bridge to adopt it",
			);
			return;
		}
		// Fleet-field overlay onto boot objects (model/backend/effort move — FLY-671).
		const freshByKey = new Map<string, LeadConfig>();
		for (const p of fresh) {
			for (const l of p.leads)
				freshByKey.set(`${p.projectName}-${l.agentId}`, l);
		}
		this.current = this.bootProjects.map((p) => ({
			...p,
			leads: p.leads.map((l) => {
				const f = freshByKey.get(`${p.projectName}-${l.agentId}`);
				if (!f) return l;
				const next: LeadConfig = { ...l };
				if (f.model !== undefined) next.model = f.model;
				else delete next.model;
				if (f.backend !== undefined) next.backend = f.backend;
				else delete next.backend;
				if (f.effort !== undefined) next.effort = f.effort;
				else delete next.effort;
				if (f.modelContextWindow !== undefined)
					next.modelContextWindow = f.modelContextWindow;
				else delete next.modelContextWindow;
				return next;
			}),
		}));
		this.state = "live";
	}
}

/** Production loader for the provider (reads ~/.flywheel/projects.json via loadProjects semantics). */
export function defaultLegacyBackendOf(
	project: ProjectEntry,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	try {
		const content = readFileSync(
			join(project.projectRoot, ".flywheel", "config.yaml"),
			"utf8",
		);
		const m = content.match(
			/^roles:\s*$[\s\S]*?^\s{2}lead:\s*$[\s\S]*?^\s{4}backend:\s*"?([\w-]+)"?/m,
		);
		if (m?.[1]) return m[1];
	} catch {
		// fall through to env
	}
	return env.FLYWHEEL_LEAD_BACKEND || undefined;
}

// ── Poller (30s, overlap guard, staleness) ──────────────────────────────

export interface FleetPollerOptions {
	intervalMs?: number;
	stalenessMs?: number;
	provider: ConfigSnapshotProvider;
	legacyBackendOf: (project: ProjectEntry) => string | undefined;
	deps: FleetProbeDeps;
	logger?: (msg: string) => void;
	/** FLY-1309: opt-in production wiring for the carrier evidence writer. */
	carrierEnv?: NodeJS.ProcessEnv;
	processAliveWithStart?: (pid: number, lstart: string) => boolean;
}

/**
 * Aggregate generation-bound runtime assertions into one fresh authorization
 * snapshot. Assertion wall-clock age is intentionally not an expiry signal:
 * pid+lstart liveness is the generation boundary. A future timestamp is still
 * rejected as malformed evidence.
 */
export function materializeCarrierAuthorizationEvidence(input: {
	projects: ProjectEntry[];
	legacyBackendOf: (project: ProjectEntry) => string | undefined;
	env: NodeJS.ProcessEnv;
	collectedAt: string;
	processAliveWithStart?: (pid: number, lstart: string) => boolean;
}): void {
	const collectedAtMs = Date.parse(input.collectedAt);
	if (!Number.isFinite(collectedAtMs)) {
		throw new Error("carrier evidence collectedAt is invalid");
	}
	const isAlive = input.processAliveWithStart ?? defaultProcessAliveWithStart;
	const leads: Record<string, CarrierEvidenceEntry> = {};
	for (const project of input.projects) {
		const legacyBackend = input.legacyBackendOf(project);
		for (const lead of project.leads) {
			if (
				effectiveLeadBackend(lead.backend, legacyBackend).backend !==
				"codex-app-server"
			) {
				continue;
			}
			const leadKey = `${project.projectName}-${lead.agentId}`;
			const assertion = readCarrierRuntimeAssertion(input.env, leadKey);
			if (!assertion) continue;
			const publishedAtMs = Date.parse(assertion.publishedAt);
			if (
				!Number.isFinite(publishedAtMs) ||
				publishedAtMs > collectedAtMs + 5_000 ||
				!isAlive(assertion.pid, assertion.lstart)
			) {
				continue;
			}
			leads[leadKey] = {
				leadKey,
				backend: "codex-app-server",
				identityDigest: assertion.identityDigest,
				pid: assertion.pid,
				lstart: assertion.lstart,
				instanceDigest: assertion.instanceDigest,
			};
		}
	}
	writeCarrierAuthorizationEvidenceSnapshot({
		env: input.env,
		collectedAt: input.collectedAt,
		leads,
	});
}

export class FleetPoller {
	private timer: ReturnType<typeof setInterval> | null = null;
	private collecting = false;
	private last: FleetSnapshot | null = null;
	private readonly intervalMs: number;
	private readonly stalenessMs: number;

	constructor(private readonly opts: FleetPollerOptions) {
		this.intervalMs = opts.intervalMs ?? 30_000;
		this.stalenessMs = opts.stalenessMs ?? 3 * (opts.intervalMs ?? 30_000);
	}

	start(): void {
		if (this.timer) return;
		void this.collectOnce();
		this.timer = setInterval(() => void this.collectOnce(), this.intervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	/** Overlap guard: a slow round never stacks on itself (R1#5). */
	async collectOnce(): Promise<void> {
		if (this.collecting) return;
		this.collecting = true;
		try {
			this.opts.provider.refresh();
			const { projects, state } = this.opts.provider.snapshot();
			const snapshot = await collectFleetSnapshot(
				projects,
				this.opts.legacyBackendOf,
				this.opts.deps,
				state,
			);
			const carrierEnv = this.opts.carrierEnv;
			if (carrierEnv) {
				withSyncOpMarker("fleet-poller:carrier-process-probe", () =>
					materializeCarrierAuthorizationEvidence({
						projects,
						legacyBackendOf: this.opts.legacyBackendOf,
						env: carrierEnv,
						collectedAt: snapshot.collectedAt,
						...(this.opts.processAliveWithStart
							? {
									processAliveWithStart: this.opts.processAliveWithStart,
								}
							: {}),
					}),
				);
			}
			this.last = snapshot;
		} catch (err) {
			this.opts.logger?.(
				`[FleetPoller] collection failed — keeping previous snapshot: ${(err as Error).message}`,
			);
		} finally {
			this.collecting = false;
		}
	}

	/**
	 * Latest snapshot, or null when never collected / stale. Stale evidence
	 * resolves to "no snapshot" so consumers degrade to indeterminate
	 * (alert inclusion), never to a stale confirmed verdict (R6#5).
	 */
	snapshot(): FleetSnapshot | null {
		if (!this.last) return null;
		const age =
			this.opts.deps.now().getTime() -
			new Date(this.last.collectedAt).getTime();
		if (age > this.stalenessMs) return null;
		return this.last;
	}
}

// ── Production probe deps ───────────────────────────────────────────────

/**
 * Real-system probes for the Bridge poller. Each returns the "probe failed"
 * sentinel (null) instead of throwing on transport errors, so failures
 * degrade to indeterminate (R4#1) rather than false confirmations.
 */
export function buildDefaultFleetProbeDeps(): FleetProbeDeps {
	// R4-M7: command-SPECIFIC negative classification. A clean numeric exit is
	// not inherently a determined negative (it can be permissions, sockets,
	// usage errors) — each probe only accepts its own known-negative marker;
	// every other failure shape is indeterminate (null).
	const execProbe = (
		cmd: string,
		args: string[],
	): Promise<{
		kind: "ok" | "known-negative" | "failure";
		stdout: string;
		stderr: string;
	}> =>
		new Promise((resolve) => {
			execFile(cmd, args, { timeout: 5_000 }, (err, stdout, stderr) => {
				if (!err) {
					resolve({ kind: "ok", stdout: stdout ?? "", stderr: stderr ?? "" });
					return;
				}
				const e = err as NodeJS.ErrnoException & {
					killed?: boolean;
					signal?: string | null;
				};
				const cleanNonZero =
					typeof (e.code as unknown) === "number" && !e.killed && !e.signal;
				resolve({
					kind: cleanNonZero ? "known-negative" : "failure",
					stdout: stdout ?? "",
					stderr: stderr ?? "",
				});
			});
		});
	return {
		readFile: (p) => readFileSync(p, "utf8"),
		fileExists: (p) => {
			// statSync (not existsSync): EACCES/EIO etc. must surface as probe
			// failures (→ indeterminate), not silently read as "absent" and
			// mint a confirmed external verdict (code-review R2-M3).
			try {
				statSync(p);
				return true;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
				throw err;
			}
		},
		pidAlive: (pid) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch (err) {
				return (err as NodeJS.ErrnoException).code === "EPERM";
			}
		},
		launchdPrint: async (label) => {
			const uid = process.getuid?.() ?? 0;
			const r = await execProbe("launchctl", ["print", `gui/${uid}/${label}`]);
			if (r.kind === "ok") {
				const m = r.stdout.match(/pid = (\d+)/);
				return { loaded: true, pid: m ? Number(m[1]) : 0 };
			}
			if (
				r.kind === "known-negative" &&
				/could not find service|no such process/i.test(r.stderr + r.stdout)
			) {
				return { loaded: false, pid: 0 }; // launchctl's determined not-loaded
			}
			return null; // any other failure shape → indeterminate
		},
		listPanes: async () => {
			const r = await execProbe("tmux", [
				"list-panes",
				"-a",
				"-F",
				"#{pane_dead}\t#{window_name}\t#{pane_pid}\t#{pane_current_command}",
			]);
			if (
				r.kind === "known-negative" &&
				/no server running|no current client/i.test(r.stderr + r.stdout)
			) {
				return []; // determined: no tmux server → no panes at all
			}
			if (r.kind !== "ok") return null; // indeterminate
			return r.stdout
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const [dead = "0", windowName = "", panePidRaw = "0", command = ""] =
						line.split("\t");
					return {
						windowName,
						command,
						panePid: Number(panePidRaw) || 0,
						dead: dead === "1",
					};
				});
		},
		listPanesAtSocket: async (socketPath) => {
			const r = await execProbe("tmux", [
				"-S",
				socketPath,
				"list-panes",
				"-a",
				"-F",
				"#{pane_dead}\t#{window_name}\t#{pane_pid}\t#{pane_current_command}",
			]);
			if (
				r.kind === "known-negative" &&
				/no server running|no current client|no such file or directory/i.test(
					r.stderr + r.stdout,
				)
			) {
				return [];
			}
			if (r.kind !== "ok") return null;
			return r.stdout
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const [dead = "0", windowName = "", panePidRaw = "0", command = ""] =
						line.split("\t");
					return {
						windowName,
						command,
						panePid: Number(panePidRaw) || 0,
						dead: dead === "1",
					};
				});
		},
		processCommandsOf: async (pid) => {
			// self + children + grandchildren commands (mirrors bash
			// process_tree_has_claude). ps "no such pid" is a determined
			// empty; transport failures → null.
			const self = await execProbe("ps", ["-o", "command=", "-p", String(pid)]);
			if (self.kind === "failure") return null;
			const out: string[] = self.stdout.split("\n").filter(Boolean);
			const kids = await execProbe("pgrep", ["-P", String(pid)]);
			if (kids.kind === "failure") return null;
			const kidPids = kids.stdout.split("\n").filter(Boolean);
			for (const k of kidPids) {
				const kc = await execProbe("ps", ["-o", "command=", "-p", k]);
				if (kc.kind === "ok")
					out.push(...kc.stdout.split("\n").filter(Boolean));
				const gk = await execProbe("pgrep", ["-P", k]);
				if (gk.kind !== "ok") continue;
				for (const g of gk.stdout.split("\n").filter(Boolean)) {
					const gc = await execProbe("ps", ["-o", "command=", "-p", g]);
					if (gc.kind === "ok")
						out.push(...gc.stdout.split("\n").filter(Boolean));
				}
			}
			return out;
		},
		homeDir: () => homedir(),
		stateDir: () =>
			process.env.FLYWHEEL_STATE_DIR?.trim() || join(homedir(), ".flywheel"),
		now: () => new Date(),
	};
}
