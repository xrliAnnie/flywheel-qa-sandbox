/**
 * GEO-151 A4 — `flywheel-comm visual-capture` wrapper.
 *
 * Drives `proofshot` CLI to record a UI or 3D capture, selects which
 * artifacts the Runner should Read, writes `manifest.json`, and (only when
 * `--notify`) auto-POSTs `artifact_emitted`. The Runner instruction template
 * (rendered by `handleProofShotAutoTrigger` in teamlead) splits Step 2
 * (Read) from Step 3 (notify) explicitly, so `--notify` defaults to FALSE
 * to preserve the V1 self-vision ordering.
 *
 * Flow (UI mode):
 *   1. acquire atomic mkdir lock so two captures don't share a port.
 *   2. find free port (lsof, fallback 3000-3010).
 *   3. snapshot browser/session ownership, then spawn `proofshot start`.
 *   4. spawn `proofshot exec screenshot step-ui.png` once.
 *   5. stop this recording and close only this capture's browser/pages.
 *   6. discover + categorize artifacts in the validated current session.
 *   7. call selectVisionArtifacts(files, budget).
 *   8. write manifest.json with correlation fields.
 *   9. (if --notify) call `flywheel-comm notify --paths-from <manifest>`.
 *  10. release lock + finally close 3D HTTP server if applicable.
 *  11. stdout JSON `{selected, dropped, manifest_path, totalTokens, dedup_key, attempt}`.
 *
 * Flow (3D mode):
 *   2a. additionally start local HTTP server serving model file.
 *   3. spawn ProofShot pointing at `${model_viewer_url}?model=http://127.0.0.1:<sport>/<basename>`.
 *   4. for each angle: `proofshot exec open <url>?camera=<angle>` then
 *      `proofshot exec screenshot angle-<NN>-<safeAngle>.png` (NN keeps
 *      filenames unique even if sanitization collides two angle strings).
 *   finally close HTTP server.
 *
 * This wrapper is dependency-injected for tests: the `runProofShot` arg is
 * a thin shim around `execFileSync` so tests can stub the entire ProofShot
 * subprocess interaction without touching the real binary.
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	defaultRunAgentBrowser,
	type RunAgentBrowser,
} from "../agent-browser-runner.js";
import {
	type DiscoverOptions,
	discoverArtifacts,
} from "../proofshot/artifact-discovery.js";
import {
	DEFAULT_PORT_RANGE_START,
	findFreePort,
} from "../proofshot/free-port.js";
import {
	type LocalModelServerHandle,
	startLocalModelServer,
} from "../proofshot/local-server.js";
import {
	type AcquiredLock,
	acquireProofShotLockWithRetry,
} from "../proofshot/lock.js";
import { writeCaptureManifest } from "../proofshot/manifest.js";
import {
	type ArtifactFile,
	DEFAULT_PNG_LIMIT,
	type SelectionResult,
	selectVisionArtifacts,
} from "../select-vision-artifacts.js";

export const DEFAULT_VISION_TOKEN_BUDGET = 10_000;

export interface VisualCaptureArgs {
	kind: "ui" | "3d";
	description: string;
	output: string; // absolute or `~/...` (caller expands)
	dedupKey: string;
	attempt: number;
	/** Runner identity — used by manifest + future notify call. */
	execId: string;
	issueId: string;
	projectName: string;
	stage: string;
	/** UI: dev server command (e.g. "pnpm dev"). Required for UI mode. */
	devCommand?: string;
	/** 3D: absolute path to .glb/.gltf/.stl/.3mf file. Required for 3D mode. */
	modelPath?: string;
	/** 3D: viewer URL template (e.g. "https://3dviewer.net"). */
	modelViewerUrl?: string;
	/** 3D: capture angle names (e.g. ["front","side","iso","top"]). */
	angles?: readonly string[];
	/** Vision token budget. Default DEFAULT_VISION_TOKEN_BUDGET (10_000). */
	visionTokenBudget?: number;
	/** PNG limit override. Default DEFAULT_PNG_LIMIT (3). */
	pngLimit?: number;
	/** Preferred port for dev server. Default 3000. */
	preferredPort?: number;
	/** Auto-call `flywheel-comm notify --paths-from <manifest>`. Default FALSE. */
	notify?: boolean;
	/**
	 * FLY-188: agent-browser persistent profile (path or Chrome profile name)
	 * forwarded to ProofShot's underlying `agent-browser` via the
	 * `AGENT_BROWSER_PROFILE` env. Gives the headless capture browser a
	 * reusable login state ("Recipe B") so QA can screenshot logged-in pages
	 * and commit the artifacts. Undefined → ProofShot's default ephemeral
	 * browser (byte-compatible with prior behavior).
	 */
	agentBrowserProfile?: string;
	/**
	 * FLY-188 (deferred feature, env hook only): forward
	 * `AGENT_BROWSER_STREAM_PORT` so a human can watch the capture live via
	 * agent-browser's WebSocket stream. Not deeply wired this iteration —
	 * see `doc/qa/qa-context.md` (stream is a follow-up). Undefined → no stream.
	 */
	agentBrowserStreamPort?: number;
	/** Explicit subprocess environment (test seam). Defaults to process.env. */
	env?: NodeJS.ProcessEnv;
	/** Discovery options (test seam). */
	discoverOptions?: DiscoverOptions;
	/** Inject a runner for unit tests. Default: real execFileSync. */
	runProofShot?: (
		args: string[],
		opts?: { input?: string; cwd?: string; env?: NodeJS.ProcessEnv },
	) => void;
	/** Inject an agent-browser runner for ownership-safe cleanup tests. */
	runAgentBrowser?: RunAgentBrowser;
	/** Inject a port probe (test seam). */
	findPort?: (preferredPort: number) => number | null;
	/** Inject a notify caller (test seam). */
	runNotify?: (manifestPath: string) => void;
	/** Cleanup warning sink. Defaults to stderr. */
	warn?: (message: string) => void;
	/** Inject a clock for tests. */
	now?: () => number;
}

export interface VisualCaptureResult {
	manifestPath: string;
	selection: SelectionResult;
	captureKind: "ui" | "3d";
	devPort?: number;
	modelServerPort?: number;
}

export interface VisualCaptureStdoutJson {
	selected: string[];
	dropped: string[];
	manifest_path: string;
	totalTokens: number;
	dedup_key: string;
	attempt: number;
}

/**
 * Run the capture. Returns the result struct. Throws on hard failures
 * (lock timeout, no free port, ProofShot subprocess error, missing required
 * args for the chosen kind). Always releases the lock + closes the 3D
 * server before returning (or rethrowing).
 */
export async function visualCapture(
	args: VisualCaptureArgs,
): Promise<VisualCaptureResult> {
	validateArgs(args);

	const baseRunProofShot = args.runProofShot ?? defaultRunProofShot;
	const runAgentBrowser = args.runAgentBrowser ?? defaultRunAgentBrowser;
	const runtimeEnv = args.env ?? process.env;
	const proofShotEnv = buildProofShotEnv(args, runtimeEnv);
	const runProofShot: (
		a: string[],
		opts?: { input?: string; cwd?: string; env?: NodeJS.ProcessEnv },
	) => void = (a, opts = {}) =>
		baseRunProofShot(a, { ...opts, env: proofShotEnv });
	const findPort = args.findPort ?? defaultFindPort;
	const runNotify = args.runNotify ?? defaultRunNotify;
	const warn = args.warn ?? ((message: string) => console.error(message));
	const preferredPort = args.preferredPort ?? DEFAULT_PORT_RANGE_START;

	const outputDir = expandTilde(args.output);
	mkdirSync(outputDir, { recursive: true });
	const sessionRoot = join(outputDir, "proofshot-artifacts");
	const sessionStatePath = join(sessionRoot, ".session.json");
	const proofShotConfigPath = join(outputDir, "proofshot.config.json");

	let lock: AcquiredLock | undefined;
	let modelServer: LocalModelServerHandle | undefined;
	let startAttempted = false;
	let startReturned = false;
	let cleanupAttempted = false;
	let sessionStateCreated = false;
	let proofShotConfigCreated = false;
	let currentSessionDir: string | undefined;
	type BrowserOwnership = "owned" | "shared" | "unknown";
	let browserOwnership: BrowserOwnership = "unknown";
	let postTargetPresent = false;
	let ownedTabIds: string[] = [];
	const agentBrowserOpts = { cwd: outputDir, env: proofShotEnv };
	const targetSession = proofShotEnv.AGENT_BROWSER_SESSION?.trim() || "default";
	const readJsonList = (command: string[], key: string): unknown[] => {
		const output = runAgentBrowser(command, agentBrowserOpts);
		if (typeof output !== "string") {
			throw new Error(`${key} list returned non-text output`);
		}
		const value = (JSON.parse(output) as { data?: Record<string, unknown> })
			.data?.[key];
		if (!Array.isArray(value)) {
			throw new Error(`${key} list returned invalid JSON`);
		}
		return value;
	};
	const listSessions = (): string[] => {
		const sessions = readJsonList(["session", "list", "--json"], "sessions");
		if (!sessions.every((session) => typeof session === "string")) {
			throw new Error("sessions list contained a non-string session name");
		}
		return sessions as string[];
	};
	const listTabIds = (strictBaseline = false): string[] => {
		const tabs = readJsonList(["tab", "list", "--json"], "tabs");
		const tabIds: string[] = [];
		for (const tab of tabs) {
			const tabId =
				tab && typeof tab === "object"
					? (tab as { tabId?: unknown }).tabId
					: undefined;
			if (typeof tabId !== "string" || !/^t\d+$/.test(tabId)) {
				if (strictBaseline) {
					throw new Error("tabs list contained an invalid tab id");
				}
				continue;
			}
			tabIds.push(tabId);
		}
		return tabIds;
	};
	let initialMembership: boolean | undefined;
	let immediateMembership: boolean | undefined;
	let tabIdsBefore = new Set<string>();
	const warnProbeFailure = (phase: string, error: unknown) => {
		warn(
			`visual-capture: browser ${phase} probe failed (${error instanceof Error ? error.message : String(error)}) — ownership unknown; preserving browser tabs`,
		);
	};
	const cleanupCapture = () => {
		if (cleanupAttempted) return;
		cleanupAttempted = true;
		if (startReturned && postTargetPresent) {
			try {
				runAgentBrowser(["record", "stop"], agentBrowserOpts);
			} catch (firstError) {
				warn(
					`visual-capture: agent-browser record stop failed; retrying (${firstError instanceof Error ? firstError.message : String(firstError)})`,
				);
				try {
					runAgentBrowser(["record", "stop"], agentBrowserOpts);
				} catch (secondError) {
					warn(
						`visual-capture: agent-browser record stop retry failed (${secondError instanceof Error ? secondError.message : String(secondError)})`,
					);
				}
			}
		}
		let wholeBrowserClosed = false;
		if (browserOwnership === "owned") {
			try {
				runAgentBrowser(["close"], agentBrowserOpts);
				wholeBrowserClosed = true;
			} catch (error) {
				warn(
					`visual-capture: owned browser close failed (${error instanceof Error ? error.message : String(error)}) — falling back to owned tabs`,
				);
			}
		}
		if (browserOwnership !== "unknown" && !wholeBrowserClosed) {
			for (const tabId of ownedTabIds) {
				try {
					runAgentBrowser(["tab", "close", tabId], agentBrowserOpts);
				} catch (error) {
					warn(
						`visual-capture: failed to close owned tab ${tabId} (${error instanceof Error ? error.message : String(error)})`,
					);
				}
			}
		}
		if (sessionStateCreated) {
			try {
				rmSync(sessionStatePath);
			} catch (error) {
				warn(
					`visual-capture: failed to remove current ProofShot session state (${error instanceof Error ? error.message : String(error)})`,
				);
			}
		}
		if (proofShotConfigCreated) {
			try {
				rmSync(proofShotConfigPath);
			} catch (error) {
				warn(
					`visual-capture: failed to remove temporary ProofShot config (${error instanceof Error ? error.message : String(error)})`,
				);
			}
		}
	};
	try {
		lock = await acquireProofShotLockWithRetry();
		mkdirSync(sessionRoot, { recursive: true });
		if (existsSync(sessionStatePath)) {
			throw new Error(
				`visual-capture: pre-existing ProofShot session state at ${sessionStatePath}`,
			);
		}
		const existingSessionDirs = snapshotSessionDirectories(sessionRoot);
		proofShotConfigCreated = ensureProofShotConfig(
			proofShotConfigPath,
			outputDir,
			sessionRoot,
		);
		try {
			initialMembership = listSessions().includes(targetSession);
		} catch (error) {
			warnProbeFailure("initial membership", error);
		}

		const devPort = findPort(preferredPort);
		if (devPort == null) {
			throw new Error(
				`visual-capture: no free port found in range [${preferredPort}, ${preferredPort + 10})`,
			);
		}

		const proofShotArgs = await buildStartArgs({
			kind: args.kind,
			devCommand: args.devCommand,
			modelPath: args.modelPath,
			modelViewerUrl: args.modelViewerUrl,
			port: devPort,
			outputDir: sessionRoot,
			description: args.description,
			startServer:
				args.kind === "3d"
					? async (modelPath) => {
							modelServer = await startLocalModelServer(modelPath);
							return modelServer;
						}
					: undefined,
		});

		try {
			immediateMembership = listSessions().includes(targetSession);
		} catch (error) {
			warnProbeFailure("pre-start membership", error);
		}
		if (
			initialMembership !== undefined &&
			immediateMembership !== undefined &&
			initialMembership === immediateMembership
		) {
			browserOwnership = immediateMembership ? "shared" : "owned";
		} else if (
			initialMembership !== undefined &&
			immediateMembership !== undefined
		) {
			warn(
				"visual-capture: browser membership changed before start — ownership unknown; preserving browser tabs",
			);
		}
		if (browserOwnership === "shared") {
			try {
				tabIdsBefore = new Set(listTabIds(true));
			} catch (error) {
				browserOwnership = "unknown";
				warnProbeFailure("pre-start tab", error);
			}
		}

		startAttempted = true;
		try {
			runProofShot(proofShotArgs, {
				cwd: process.cwd(),
				env: proofShotEnv,
			});
			startReturned = true;
		} finally {
			sessionStateCreated = existsSync(sessionStatePath);
			try {
				postTargetPresent = listSessions().includes(targetSession);
			} catch (error) {
				browserOwnership = "unknown";
				warnProbeFailure("post-start membership", error);
			}
			if (!postTargetPresent) {
				browserOwnership = "unknown";
			} else if (browserOwnership !== "unknown") {
				try {
					ownedTabIds = [
						...new Set(
							listTabIds().filter((tabId) => !tabIdsBefore.has(tabId)),
						),
					];
				} catch (error) {
					if (browserOwnership === "shared") browserOwnership = "unknown";
					warnProbeFailure("post-start tab", error);
				}
			}
		}
		currentSessionDir = readValidatedSessionDirectory(
			sessionStatePath,
			sessionRoot,
			existingSessionDirs,
		);
		const proofShotExecOpts = { cwd: outputDir, env: proofShotEnv };

		// Capture step. Two commands matter (verified against ProofShot v1.3.1
		// README / source — Codex R2 HIGH#1):
		//   - `proofshot exec open <url>`        → navigate (was wrong: navigate)
		//   - `proofshot exec screenshot <file>` → produces PNG (was wrong: snapshot,
		//     which is an a11y-tree pass-through, NOT an image)
		// File names are also kept safe — angle strings come from project
		// config so they could contain slashes / spaces in pathological cases.
		if (args.kind === "3d") {
			const angles = args.angles ?? [];
			const baseModelUrl =
				modelServer && args.modelViewerUrl
					? `${args.modelViewerUrl}?model=${encodeURIComponent(modelServer.url)}`
					: undefined;
			for (let i = 0; i < angles.length; i++) {
				const angle = angles[i]!;
				if (baseModelUrl) {
					const angleUrl = `${baseModelUrl}&camera=${encodeURIComponent(angle)}`;
					runProofShot(["exec", "open", angleUrl], proofShotExecOpts);
				}
				// `NN-` prefix keeps each shot's filename unique even when
				// `sanitizeFilename` collapses two angle strings to the same
				// safe form (Codex R3 LOW). NN is the 0-based index zero-
				// padded to 2 chars — supports up to 100 angles per capture.
				const indexPrefix = String(i).padStart(2, "0");
				const safeAngle = sanitizeFilename(angle);
				runProofShot(
					["exec", "screenshot", `angle-${indexPrefix}-${safeAngle}.png`],
					proofShotExecOpts,
				);
			}
		} else {
			runProofShot(["exec", "screenshot", "step-ui.png"], proofShotExecOpts);
		}

		cleanupCapture();

		const files: ArtifactFile[] = discoverArtifacts(
			currentSessionDir,
			args.discoverOptions,
		);
		if (!files.some((file) => file.kind === "png")) {
			throw new Error(
				"visual-capture: current ProofShot session must contain at least one PNG artifact",
			);
		}
		const selection = selectVisionArtifacts(
			files,
			args.visionTokenBudget ?? DEFAULT_VISION_TOKEN_BUDGET,
			{ pngLimit: args.pngLimit ?? DEFAULT_PNG_LIMIT },
		);

		const manifestPath = writeCaptureManifest({
			outputDir,
			selection,
			captureKind: args.kind,
			execId: args.execId,
			issueId: args.issueId,
			projectName: args.projectName,
			stage: args.stage,
			dedupKey: args.dedupKey,
			attempt: args.attempt,
		});

		if (args.notify) {
			runNotify(manifestPath);
		}

		return {
			manifestPath,
			selection,
			captureKind: args.kind,
			devPort,
			modelServerPort: modelServer?.port,
		};
	} finally {
		if (startAttempted || sessionStateCreated || proofShotConfigCreated) {
			cleanupCapture();
		}
		if (modelServer) {
			try {
				await modelServer.close();
			} catch {
				// best-effort
			}
		}
		if (lock) {
			lock.release();
		}
	}
}

/**
 * Build the `flywheel-comm visual-capture ...` stdout JSON envelope from
 * the result. Kept separate so tests can verify wire field naming.
 */
export function visualCaptureStdout(
	result: VisualCaptureResult,
	args: Pick<VisualCaptureArgs, "dedupKey" | "attempt">,
): VisualCaptureStdoutJson {
	return {
		selected: result.selection.selected.map((f) => f.path),
		dropped: result.selection.dropped.map((f) => f.path),
		manifest_path: result.manifestPath,
		totalTokens: result.selection.totalTokens,
		dedup_key: args.dedupKey,
		attempt: args.attempt,
	};
}

function validateArgs(args: VisualCaptureArgs): void {
	if (!args.execId) throw new Error("visual-capture: --exec-id required");
	if (!args.issueId) throw new Error("visual-capture: --issue-id required");
	if (!args.projectName)
		throw new Error("visual-capture: --project-name required");
	if (!args.stage) throw new Error("visual-capture: --stage required");
	if (!args.dedupKey) throw new Error("visual-capture: --dedup-key required");
	if (!Number.isInteger(args.attempt) || args.attempt < 1) {
		throw new Error("visual-capture: --attempt must be a positive integer");
	}
	if (!args.output || !isAbsolute(expandTilde(args.output))) {
		throw new Error(
			"visual-capture: --output must be an absolute path (after ~ expansion)",
		);
	}
	if (args.kind === "ui" && !args.devCommand) {
		throw new Error("visual-capture: UI mode requires --dev-command");
	}
	if (args.kind === "3d") {
		if (!args.modelPath || !isAbsolute(args.modelPath)) {
			throw new Error("visual-capture: 3D mode requires absolute --model-path");
		}
		if (!args.modelViewerUrl) {
			throw new Error("visual-capture: 3D mode requires --model-viewer-url");
		}
		if (!args.angles || args.angles.length === 0) {
			throw new Error("visual-capture: 3D mode requires non-empty --angles");
		}
	}
}

interface BuildStartArgsParams {
	kind: "ui" | "3d";
	devCommand?: string;
	modelPath?: string;
	modelViewerUrl?: string;
	port: number;
	outputDir: string;
	description: string;
	startServer?: (modelPath: string) => Promise<LocalModelServerHandle>;
}

/**
 * Compose the `proofshot start ...` argv array. Spawns the 3D HTTP server
 * (via `startServer` injection) when needed and stitches the model URL
 * into the viewer URL.
 */
async function buildStartArgs(params: BuildStartArgsParams): Promise<string[]> {
	if (params.kind === "ui") {
		return [
			"start",
			"--run",
			params.devCommand ?? "",
			"--port",
			String(params.port),
			"--output",
			params.outputDir,
			"--description",
			params.description,
		];
	}
	// 3D: spin up the local server, then build the model URL.
	const server = await params.startServer!(params.modelPath!);
	const modelUrl = `${params.modelViewerUrl}?model=${encodeURIComponent(server.url)}`;
	return [
		"start",
		"--url",
		modelUrl,
		"--port",
		String(params.port),
		"--output",
		params.outputDir,
		"--description",
		params.description,
	];
}

function defaultRunProofShot(
	args: string[],
	opts: { input?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): void {
	execFileSync("proofshot", args, {
		stdio: ["pipe", "inherit", "inherit"],
		input: opts.input,
		cwd: opts.cwd,
		// The caller supplies one explicit baseline shared with agent-browser.
		env: opts.env,
	});
}

function snapshotSessionDirectories(sessionRoot: string): Set<string> {
	return new Set(
		readdirSync(sessionRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => resolve(sessionRoot, entry.name)),
	);
}

function ensureProofShotConfig(
	configPath: string,
	outputDir: string,
	sessionRoot: string,
): boolean {
	try {
		writeFileSync(
			configPath,
			`${JSON.stringify({ output: "./proofshot-artifacts" }, null, 2)}\n`,
			{ flag: "wx" },
		);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf8"));
	} catch (error) {
		throw new Error(
			`visual-capture: existing ProofShot config is unreadable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const configuredOutput =
		parsed && typeof parsed === "object"
			? (parsed as { output?: unknown }).output
			: undefined;
	if (
		typeof configuredOutput !== "string" ||
		resolve(outputDir, configuredOutput) !== resolve(sessionRoot)
	) {
		throw new Error(
			`visual-capture: existing ProofShot config must resolve output to ${sessionRoot}`,
		);
	}
	return false;
}

function readValidatedSessionDirectory(
	statePath: string,
	sessionRoot: string,
	existingSessionDirs: ReadonlySet<string>,
): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(statePath, "utf8"));
	} catch (error) {
		throw new Error(
			`visual-capture: ProofShot did not create readable current session state: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const sessionDir =
		parsed && typeof parsed === "object"
			? (parsed as { sessionDir?: unknown }).sessionDir
			: undefined;
	if (typeof sessionDir !== "string" || !isAbsolute(sessionDir)) {
		throw new Error(
			"visual-capture: current ProofShot sessionDir must be an absolute path",
		);
	}
	const resolvedRoot = resolve(sessionRoot);
	const resolvedSessionDir = resolve(sessionDir);
	if (dirname(resolvedSessionDir) !== resolvedRoot) {
		throw new Error(
			"visual-capture: current ProofShot sessionDir must be a direct child of the session root",
		);
	}
	if (existingSessionDirs.has(resolvedSessionDir)) {
		throw new Error(
			"visual-capture: current ProofShot sessionDir existed before this capture",
		);
	}
	let sessionStat: ReturnType<typeof lstatSync>;
	try {
		sessionStat = lstatSync(resolvedSessionDir);
	} catch (error) {
		throw new Error(
			`visual-capture: current ProofShot sessionDir is unreadable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (sessionStat.isSymbolicLink() || !sessionStat.isDirectory()) {
		throw new Error(
			"visual-capture: current ProofShot sessionDir must be a real directory",
		);
	}
	if (
		dirname(realpathSync(resolvedSessionDir)) !== realpathSync(resolvedRoot)
	) {
		throw new Error(
			"visual-capture: current ProofShot sessionDir resolves outside the session root",
		);
	}
	return resolvedSessionDir;
}

/**
 * FLY-188: build the explicit env handed to both ProofShot and direct
 * agent-browser calls so profile, stream, and session selection cannot drift.
 */
function buildProofShotEnv(
	args: VisualCaptureArgs,
	runtimeEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	const overrides: Record<string, string> = {};
	if (args.agentBrowserProfile) {
		overrides.AGENT_BROWSER_PROFILE = args.agentBrowserProfile;
	}
	if (args.agentBrowserStreamPort != null) {
		overrides.AGENT_BROWSER_STREAM_PORT = String(args.agentBrowserStreamPort);
	}
	return { ...runtimeEnv, ...overrides };
}

function defaultFindPort(preferredPort: number): number | null {
	return findFreePort(preferredPort);
}

function defaultRunNotify(manifestPath: string): void {
	execFileSync("flywheel-comm", ["notify", "--paths-from", manifestPath], {
		stdio: "inherit",
	});
}

/**
 * Make an angle string safe for a filename. Strips path separators, hidden
 * file prefix, and any chars outside `[A-Za-z0-9._-]` (replaced with `_`).
 * Empty result → `unknown` so we don't generate `angle-.png`.
 */
function sanitizeFilename(s: string): string {
	const cleaned = s.replace(/^\.+/, "").replace(/[^A-Za-z0-9._-]/g, "_");
	return cleaned.length === 0 ? "unknown" : cleaned;
}

function expandTilde(p: string): string {
	if (p.startsWith("~/") || p === "~") {
		const home = process.env.HOME ?? "";
		return p.replace(/^~/, home);
	}
	return p;
}
