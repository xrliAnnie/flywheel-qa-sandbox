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
 *   3. spawn `proofshot start --run <dev_cmd> --port <port> --output <dir>`.
 *   4. spawn `proofshot exec screenshot step-ui.png` once.
 *   5. spawn `proofshot stop`.
 *   6. discover + categorize artifacts in <dir>.
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
import { mkdirSync } from "node:fs";
import { isAbsolute } from "node:path";
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
	/** Discovery options (test seam). */
	discoverOptions?: DiscoverOptions;
	/** Inject a runner for unit tests. Default: real execFileSync. */
	runProofShot?: (
		args: string[],
		opts?: { input?: string; cwd?: string; env?: NodeJS.ProcessEnv },
	) => void;
	/** Inject a port probe (test seam). */
	findPort?: (preferredPort: number) => number | null;
	/** Inject a notify caller (test seam). */
	runNotify?: (manifestPath: string) => void;
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
	// FLY-188: when the caller requests an agent-browser profile (or stream
	// port), wrap the runner so every `proofshot` subprocess inherits the
	// AGENT_BROWSER_* env (ProofShot spawns `agent-browser`, which reads it).
	// No override → use the runner as-is (opts stay undefined, byte-compatible
	// with prior behavior).
	const proofShotEnv = buildProofShotEnv(args);
	const runProofShot: (
		a: string[],
		opts?: { input?: string; cwd?: string; env?: NodeJS.ProcessEnv },
	) => void = proofShotEnv
		? (a, opts = {}) => baseRunProofShot(a, { ...opts, env: proofShotEnv })
		: baseRunProofShot;
	const findPort = args.findPort ?? defaultFindPort;
	const runNotify = args.runNotify ?? defaultRunNotify;
	const preferredPort = args.preferredPort ?? DEFAULT_PORT_RANGE_START;

	const outputDir = expandTilde(args.output);
	mkdirSync(outputDir, { recursive: true });

	let lock: AcquiredLock | undefined;
	let modelServer: LocalModelServerHandle | undefined;
	try {
		lock = await acquireProofShotLockWithRetry();

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
			outputDir,
			description: args.description,
			startServer:
				args.kind === "3d"
					? async (modelPath) => {
							modelServer = await startLocalModelServer(modelPath);
							return modelServer;
						}
					: undefined,
		});

		runProofShot(proofShotArgs);

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
					runProofShot(["exec", "open", angleUrl]);
				}
				// `NN-` prefix keeps each shot's filename unique even when
				// `sanitizeFilename` collapses two angle strings to the same
				// safe form (Codex R3 LOW). NN is the 0-based index zero-
				// padded to 2 chars — supports up to 100 angles per capture.
				const indexPrefix = String(i).padStart(2, "0");
				const safeAngle = sanitizeFilename(angle);
				runProofShot([
					"exec",
					"screenshot",
					`angle-${indexPrefix}-${safeAngle}.png`,
				]);
			}
		} else {
			runProofShot(["exec", "screenshot", "step-ui.png"]);
		}

		runProofShot(["stop"]);

		const files: ArtifactFile[] = discoverArtifacts(
			outputDir,
			args.discoverOptions,
		);
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
		// undefined → execFileSync inherits process.env (byte-compatible).
		env: opts.env,
	});
}

/**
 * FLY-188: build the env overlay handed to the `proofshot` subprocess (which
 * spawns `agent-browser`). Returns `undefined` when nothing needs overriding
 * so the runner is invoked exactly as before (no env opt at all).
 */
function buildProofShotEnv(
	args: VisualCaptureArgs,
): NodeJS.ProcessEnv | undefined {
	const overrides: Record<string, string> = {};
	if (args.agentBrowserProfile) {
		overrides.AGENT_BROWSER_PROFILE = args.agentBrowserProfile;
	}
	if (args.agentBrowserStreamPort != null) {
		overrides.AGENT_BROWSER_STREAM_PORT = String(args.agentBrowserStreamPort);
	}
	if (Object.keys(overrides).length === 0) return undefined;
	return { ...process.env, ...overrides };
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
