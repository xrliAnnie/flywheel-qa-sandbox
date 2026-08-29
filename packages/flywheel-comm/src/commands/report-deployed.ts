/**
 * FLY-727: `flywheel-comm report-deployed` — thin HTTP client that records ONE
 * deployment event (a project/issue that just went live) to the Bridge's
 * `POST /api/deployments/report`, the digest's primary "deployed to live" source.
 *
 * Mirrors the `complete` / `stage` / `publish-report` pattern (posts to Bridge,
 * Bearer TEAMLEAD_API_TOKEN). It does NOT write StateStore directly (package
 * boundary + Bridge single-writer, Codex design review R1 #1).
 *
 * At-least-once (Codex R1 #6 / R2 #1): if the Bridge is unreachable or returns
 * non-2xx, the event is SPOOLED to `~/.flywheel/deployment-events-pending.d/`
 * (atomic write) rather than silently lost. Every invocation opportunistically
 * DRAINS the spool first (idempotent — the Bridge dedups on dedup_key), so a
 * later successful report replays earlier failures. `--drain-only` just drains.
 *
 * Usage:
 *   flywheel-comm report-deployed --project X (--issue FLY-N | --pr N)
 *       [--merge-sha SHA] [--deployed-sha SHA] [--deploy-batch-id ID]
 *       [--source-event-id ID] [--environment production] [--source self-ship]
 *       [--deployed-at "YYYY-MM-DD HH:MM:SS"] [--metadata-json JSON]
 *       [--drain-only]
 *   Each caller MUST supply at least one identity of
 *   merge-sha / deployed-sha / deploy-batch-id / source-event-id.
 */

import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SHA40 = /^[0-9a-f]{40}$/i;

interface Flags {
	[k: string]: string | boolean;
}

function parseFlags(argv: string[]): Flags {
	const flags: Flags = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a || !a.startsWith("--")) continue;
		const key = a.slice(2);
		const next = argv[i + 1];
		if (next && !next.startsWith("--")) {
			flags[key] = next;
			i++;
		} else {
			flags[key] = true;
		}
	}
	return flags;
}

function str(f: Flags, k: string): string | undefined {
	const v = f[k];
	return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

interface ReportPayload {
	projectName: string;
	issueIdentifier?: string;
	prNumber?: number;
	mergeSha?: string;
	deployedSha?: string;
	deployBatchId?: string;
	sourceEventId?: string;
	environment?: string;
	source: string;
	deployedAt?: string;
	metadataJson?: string;
}

function spoolDir(env: NodeJS.ProcessEnv): string {
	return join(
		env.HOME ?? homedir(),
		".flywheel",
		"deployment-events-pending.d",
	);
}

function log(msg: string): void {
	console.error(`[report-deployed] ${msg}`);
}

/** POST one payload to the Bridge. Returns true on 2xx, false otherwise. */
async function post(
	bridgeUrl: string,
	token: string | undefined,
	payload: ReportPayload,
	fetchImpl: typeof fetch,
): Promise<boolean> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	try {
		const res = await fetchImpl(`${bridgeUrl}/api/deployments/report`, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
		});
		return res.ok;
	} catch {
		return false;
	}
}

/** Atomically spool a payload for later drain (at-least-once). */
function spool(
	env: NodeJS.ProcessEnv,
	payload: ReportPayload,
	nowMs: number,
): void {
	const dir = spoolDir(env);
	mkdirSync(dir, { recursive: true });
	const name = `dep-${nowMs}-${Math.floor(Math.random() * 1e6)}.json`;
	const tmp = join(dir, `.${name}.tmp`);
	const final = join(dir, name);
	writeFileSync(tmp, JSON.stringify(payload), "utf8");
	renameSync(tmp, final);
	log(`spooled (Bridge unavailable) → ${final}`);
}

/** Drain spooled payloads; each success deletes its file. Best-effort. */
async function drain(
	env: NodeJS.ProcessEnv,
	bridgeUrl: string,
	token: string | undefined,
	fetchImpl: typeof fetch,
): Promise<void> {
	const dir = spoolDir(env);
	let files: string[];
	try {
		files = readdirSync(dir).filter(
			(f) => f.endsWith(".json") && !f.startsWith("."),
		);
	} catch {
		return; // no spool dir yet
	}
	for (const f of files) {
		const path = join(dir, f);
		let payload: ReportPayload;
		try {
			payload = JSON.parse(readFileSync(path, "utf8")) as ReportPayload;
		} catch {
			log(`skipping unreadable spool file ${f}`);
			continue;
		}
		if (await post(bridgeUrl, token, payload, fetchImpl)) {
			rmSync(path, { force: true });
			log(`drained ${f}`);
		}
	}
}

export interface ReportDeployedDeps {
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	nowMs?: number;
}

/** Returns a process exit code. */
export async function reportDeployed(
	argv: string[],
	deps: ReportDeployedDeps = {},
): Promise<number> {
	const env = deps.env ?? process.env;
	const fetchImpl = deps.fetchImpl ?? fetch;
	const nowMs = deps.nowMs ?? Date.now();
	const flags = parseFlags(argv);

	// The Bridge is always local to whatever machine runs a deploy hook, so default
	// to the canonical local address (the same default daily-digest.sh uses) instead
	// of hard-failing. The self-ship updater (launchd) and restart-services contexts
	// don't export a bridge URL; without this default report-deployed would exit 2
	// (no POST, no spool) and — because the self-ship marker now reports before it
	// acks — the satisfied marker could never clear, wedging the deploy pipeline and
	// paging Annie (QA FLY-739). An explicit FLYWHEEL_BRIDGE_URL / BRIDGE_URL wins;
	// an empty/whitespace value is treated as unset. If even the local Bridge is
	// unreachable (e.g. mid-restart) the event spools for a later drain.
	const envBridgeUrl = (env.FLYWHEEL_BRIDGE_URL ?? env.BRIDGE_URL ?? "").trim();
	const bridgeUrl = (envBridgeUrl || "http://localhost:9876").replace(
		/\/+$/,
		"",
	);
	const token = env.TEAMLEAD_API_TOKEN;

	// Opportunistically drain earlier spooled events first (at-least-once).
	await drain(env, bridgeUrl, token, fetchImpl);
	if (flags["drain-only"]) return 0;

	const projectName = str(flags, "project");
	const source = str(flags, "source") ?? "manual";
	if (!projectName) {
		log("--project is required");
		return 2;
	}
	const issueIdentifier = str(flags, "issue");
	const prRaw = str(flags, "pr");
	const prNumber = prRaw !== undefined ? Number.parseInt(prRaw, 10) : undefined;
	if (!issueIdentifier && (prNumber === undefined || Number.isNaN(prNumber))) {
		log("at least one of --issue / --pr is required");
		return 2;
	}
	const mergeSha = str(flags, "merge-sha")?.toLowerCase();
	const deployedSha = str(flags, "deployed-sha")?.toLowerCase();
	const deployBatchId = str(flags, "deploy-batch-id");
	const sourceEventId = str(flags, "source-event-id");
	if (!mergeSha && !deployedSha && !deployBatchId && !sourceEventId) {
		log(
			"at least one identity of --merge-sha / --deployed-sha / --deploy-batch-id / --source-event-id is required",
		);
		return 2;
	}
	if (mergeSha && !SHA40.test(mergeSha)) {
		log("--merge-sha must be a 40-hex sha");
		return 2;
	}
	if (deployedSha && !SHA40.test(deployedSha)) {
		log("--deployed-sha must be a 40-hex sha");
		return 2;
	}

	const payload: ReportPayload = {
		projectName,
		issueIdentifier,
		prNumber:
			prNumber !== undefined && !Number.isNaN(prNumber) ? prNumber : undefined,
		mergeSha,
		deployedSha,
		deployBatchId,
		sourceEventId,
		environment: str(flags, "environment"),
		source,
		deployedAt: str(flags, "deployed-at"),
		metadataJson: str(flags, "metadata-json"),
	};

	if (await post(bridgeUrl, token, payload, fetchImpl)) {
		log(
			`reported ${projectName} ${issueIdentifier ?? `PR#${prNumber}`} (${source})`,
		);
		return 0;
	}
	// Failed → spool for a later drain (never silently lost).
	spool(env, payload, nowMs);
	return 1;
}
