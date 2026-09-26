import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdtempSync,
	openSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { PATROL_SNAPSHOT_EXECUTION_TIMEOUT_MS } from "../lead-capabilities/patrol-timeouts.js";
import { ROOT_CAUSE_DEADLINE_MS } from "../patrol-root-causes.js";

export const PATROL_HELPER_SOURCES = [
	"scripts/lead-patrol-snapshot.sh",
	"scripts/lead-patrol-github-facts.mjs",
	"scripts/lib/bounded-run.sh",
	"scripts/flywheel-snapshot-control.mjs",
	"scripts/flywheel-node-dwell-control.mjs",
	"scripts/lib/agent-visibility.sh",
] as const;
export const PATROL_SNAPSHOT_TIMEOUT_MS = PATROL_SNAPSHOT_EXECUTION_TIMEOUT_MS;
const invalid = () => new Error("patrol_snapshot_unverified");
const digest = (data: Buffer) =>
	createHash("sha256").update(data).digest("hex");
function bytes(path: string, limit: number, privateFile = false) {
	if (realpathSync(path) !== path) throw invalid();
	const fd = openSync(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const before = fstatSync(fd);
		if (
			!before.isFile() ||
			before.nlink !== 1 ||
			before.uid !== process.getuid?.() ||
			before.size > limit ||
			(before.mode & (privateFile ? 0o077 : 0o022)) !== 0
		)
			throw invalid();
		const buffer = Buffer.alloc(limit + 1),
			count = readSync(fd, buffer, 0, buffer.length, 0),
			after = fstatSync(fd);
		if (
			count !== before.size ||
			count > limit ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs
		)
			throw invalid();
		return buffer.subarray(0, count);
	} finally {
		closeSync(fd);
	}
}
/** Capture only the fixed deployed helper/rule bytes; execution rechecks these pins. */
export function pinLeadPatrolSources(deploymentRoot: string) {
	const rule = join(
		deploymentRoot,
		"packages/teamlead/lead-rules-base/runbooks/patrol-v1.md",
	);
	return {
		helperPins: Object.freeze(
			Object.fromEntries(
				PATROL_HELPER_SOURCES.map((name) => [
					name,
					digest(bytes(join(deploymentRoot, name), 1024 * 1024)),
				]),
			),
		),
		source: Object.freeze({
			path: rule,
			sha256: digest(bytes(rule, 1024 * 1024)),
		}),
	};
}

/** Bridge-owned read helper execution. Canonical scope is checked by the caller;
 * no model-selected executable, environment, arguments, credential or write flag. */
export async function executeLeadPatrolSnapshot(options: {
	deploymentRoot: string;
	helperPins: Readonly<Record<string, string>>;
	nodePath: string;
	tmuxSocketPath?: string;
	stateDir: string;
	stateDbPath: string;
	commDbPath: string;
	projectsPath: string;
	activationRoot: string;
	projectName: string;
	leadId: string;
	tickId: string;
	githubFacts: unknown;
	/**
	 * FLY-2914: trusted parent collection of STEP 6 root-cause lines. It runs
	 * beside the helper (inside the same execution budget); the helper reads the
	 * private scratch file and never receives a Linear credential.
	 */
	rootCauses?: () => Promise<{ v: 1; lines: string[] }>;
	secrets: readonly string[];
	signal: AbortSignal;
	assertCurrent(): Promise<void>;
}) {
	const safeKey = (value: string) =>
		/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
	if (
		!safeKey(options.projectName) ||
		!safeKey(options.leadId) ||
		!/^(?:NA|[0-9]{1,16})$/.test(options.tickId)
	)
		throw invalid();
	for (const path of [
		options.stateDir,
		options.stateDbPath,
		options.commDbPath,
		options.projectsPath,
		options.activationRoot,
		options.deploymentRoot,
		options.nodePath,
	])
		if (!isAbsolute(path) || /[\0\r\n]/.test(path)) throw invalid();
	function directory(path: string, privateDirectory = false) {
		const stat = lstatSync(path);
		if (
			realpathSync(path) !== path ||
			!stat.isDirectory() ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & (privateDirectory ? 0o077 : 0o022)) !== 0
		)
			throw invalid();
	}
	const verify = async () => {
		options.signal.throwIfAborted();
		await options.assertCurrent();
		options.signal.throwIfAborted();
		directory(options.deploymentRoot);
		directory(options.stateDir);
		directory(options.activationRoot, true);
		if (Object.keys(options.helperPins).length !== PATROL_HELPER_SOURCES.length)
			throw invalid();
		for (const name of PATROL_HELPER_SOURCES)
			if (
				digest(bytes(join(options.deploymentRoot, name), 1024 * 1024)) !==
				options.helperPins[name]
			)
				throw invalid();
	};
	await verify();
	if (options.tmuxSocketPath !== undefined) {
		const path = options.tmuxSocketPath;
		if (!isAbsolute(path) || /[\0\r\n]/.test(path)) throw invalid();
		directory(dirname(path), true);
		const stat = lstatSync(path);
		if (
			realpathSync(path) !== path ||
			!stat.isSocket() ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o007) !== 0
		)
			throw invalid();
	}
	if (
		basename(options.nodePath) !== "node" ||
		realpathSync(options.nodePath) !== options.nodePath ||
		!lstatSync(options.nodePath).isFile()
	)
		throw invalid();
	const json = JSON.stringify(options.githubFacts);
	if (
		typeof json !== "string" ||
		Buffer.byteLength(json) > 131072 ||
		options.secrets.some((s) => s.length > 0 && json.includes(s))
	)
		throw invalid();
	const scratch = mkdtempSync(join(options.activationRoot, "patrol-"));
	let scratchOpen = true;
	try {
		const factsPath = join(scratch, "github.json");
		writeFileSync(factsPath, json, { mode: 0o600, flag: "wx" });
		const rootCausePath = join(scratch, "root-causes.json");
		if (options.rootCauses) {
			const unavailable = {
				v: 1,
				lines: [
					`ROOT_CAUSE_REVIEW status=unavailable parent=FLY-2072 observed_at=${new Date().toISOString()} token=parent_collection_failed`,
					"UNAVAILABLE_CAUSE step=6 class=transient token=root_cause_source_unavailable",
				],
			};
			let timer: ReturnType<typeof setTimeout> | undefined;
			void Promise.race([
				options.rootCauses(),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(
						() => reject(new Error("root_cause_timeout")),
						ROOT_CAUSE_DEADLINE_MS + 2_000,
					);
				}),
			])
				.catch(() => unavailable)
				.then((facts) => {
					if (timer) clearTimeout(timer);
					let text = JSON.stringify(facts);
					if (options.secrets.some((s) => s.length > 0 && text.includes(s)))
						text = JSON.stringify(unavailable);
					if (!scratchOpen) return;
					try {
						writeFileSync(`${rootCausePath}.part`, text, {
							mode: 0o600,
							flag: "wx",
						});
						renameSync(`${rootCausePath}.part`, rootCausePath);
					} catch {}
				});
		}
		await verify();
		const stdout = await new Promise<Buffer>((resolve, reject) => {
			const child = spawn(
				"/bin/bash",
				[
					join(options.deploymentRoot, PATROL_HELPER_SOURCES[0]),
					"--project",
					options.projectName,
					"--lead",
					options.leadId,
					"--tick-seq",
					options.tickId,
					"--github-facts",
					factsPath,
					...(options.rootCauses ? ["--root-cause-facts", rootCausePath] : []),
					...(options.tmuxSocketPath
						? ["--tmux-socket", options.tmuxSocketPath]
						: []),
				],
				{
					cwd: scratch,
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
					env: {
						PATH: `${dirname(options.nodePath)}:/usr/bin:/bin:/opt/homebrew/bin`,
						HOME: scratch,
						TMPDIR: scratch,
						TMUX_TMPDIR: scratch,
						LC_ALL: "C",
						FLYWHEEL_STATE_DIR: options.stateDir,
						FLYWHEEL_STATE_DB_PATH: options.stateDbPath,
						FLYWHEEL_PROJECTS_FILE: options.projectsPath,
						FLYWHEEL_COMM_DB: options.commDbPath,
						GIT_CONFIG_NOSYSTEM: "1",
						GIT_CONFIG_GLOBAL: "/dev/null",
						GIT_OPTIONAL_LOCKS: "0",
					},
				},
			);
			let failure = false,
				size = 0,
				stderrSize = 0;
			const chunks: Buffer[] = [];
			const abort = () => {
				failure = true;
				if (child.pid)
					try {
						process.kill(-child.pid, "SIGKILL");
					} catch {}
			};
			const timer = setTimeout(abort, PATROL_SNAPSHOT_TIMEOUT_MS);
			options.signal.addEventListener("abort", abort, { once: true });
			if (options.signal.aborted) abort();
			child.on("error", () => {
				failure = true;
			});
			child.stdout.on("data", (data: Buffer) => {
				size += data.length;
				if (size > 1024 * 1024 + 4096) abort();
				else chunks.push(data);
			});
			child.stderr.on("data", (data: Buffer) => {
				stderrSize += data.length;
				if (stderrSize > 4096) abort();
			});
			child.once("close", (code) => {
				clearTimeout(timer);
				options.signal.removeEventListener("abort", abort);
				if (failure || code !== 0) reject(invalid());
				else resolve(Buffer.concat(chunks));
			});
		});
		await verify();
		const text = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
		if (options.secrets.some((s) => s.length > 0 && text.includes(s)))
			throw invalid();
		const paths = text
			.split("\n")
			.filter((line) => line.startsWith("REPORT_PATH="));
		if (paths.length !== 1) throw invalid();
		const path = paths[0]!.slice("REPORT_PATH=".length);
		const reports = join(options.stateDir, "patrol-reports", options.leadId);
		directory(reports);
		if (
			dirname(path) !== reports ||
			!new RegExp(`^[0-9]{8}T[0-9]{6}Z-tick${options.tickId}\\.md$`).test(
				path.slice(reports.length + 1),
			)
		)
			throw invalid();
		const result = readLeadPatrolReport(options, path);
		if (text !== `${result.text}REPORT_PATH=${path}\n`) throw invalid();
		await verify();
		return result;
	} finally {
		scratchOpen = false;
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** Bridge-only replay reader. The path and expected digest come from durable receipts. */
export function readLeadPatrolReport(
	options: {
		stateDir: string;
		projectName: string;
		leadId: string;
		tickId: string;
		secrets: readonly string[];
	},
	path: string,
	expectedSha256?: string,
) {
	const reports = join(options.stateDir, "patrol-reports", options.leadId);
	const parent = lstatSync(reports);
	if (
		dirname(path) !== reports ||
		realpathSync(reports) !== reports ||
		!parent.isDirectory() ||
		parent.uid !== process.getuid?.() ||
		(parent.mode & 0o022) !== 0 ||
		!/^(?:NA|[0-9]{1,16})$/.test(options.tickId) ||
		!new RegExp(`^[0-9]{8}T[0-9]{6}Z-tick${options.tickId}\\.md$`).test(
			basename(path),
		)
	)
		throw invalid();
	const data = bytes(path, 1024 * 1024, true),
		report = new TextDecoder("utf-8", { fatal: true }).decode(data);
	if (
		!report.startsWith(
			`# Lead Patrol Snapshot\npatrol_schema=2\nproject: ${options.projectName}\nlead: ${options.leadId}\n`,
		)
	)
		throw invalid();
	const steps = Array.from({ length: 6 }, (_, index) => {
		const number = index + 1,
			matches = report
				.split("\n")
				.filter((line) => line.startsWith(`STEP ${number}: `));
		if (matches.length !== 1) throw invalid();
		const status = matches[0]!.slice(`STEP ${number}: `.length);
		if (
			!/^(?:OK(?:-CANDIDATE)?|FINDING(?:-CANDIDATE)?|LEAD-JUDGMENT-REQUIRED|UNAVAILABLE\([^\n]*\))$/.test(
				status,
			)
		)
			throw invalid();
		return {
			step: number,
			status:
				status === "OK"
					? ("healthy" as const)
					: status === "FINDING"
						? ("unhealthy" as const)
						: ("unknown" as const),
		};
	});
	const sha256 = digest(data);
	if (
		(expectedSha256 && expectedSha256 !== sha256) ||
		options.secrets.some((s) => s.length > 0 && report.includes(s))
	)
		throw invalid();
	return { path, text: report, sha256, steps };
}
