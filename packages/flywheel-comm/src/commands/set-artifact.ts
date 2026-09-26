/**
 * GEO-151 B8 — `flywheel-comm set-artifact` command.
 *
 * Runner-side: after a build pipeline produces a model file (`.glb`, `.gltf`,
 * `.stl`, `.3mf`, `.obj`), the Runner calls this command to register its
 * absolute path with Bridge. Bridge persists it into
 * `session_params.last_artifact.model_path`. When the next `stage_changed=test`
 * fires, `handleProofShotAutoTrigger` sees this field on GeoForge3D and
 * dispatches a 3D capture (instead of UI).
 *
 * Why explicit registration instead of workdir scanning? The Codex R3 review
 * caught that scanning a worktree for build outputs is unreliable — older
 * `.glb` from a prior run can match before the new one finishes writing, and
 * the same source files (`.stl` checked into git) would false-positive on
 * non-GeoForge3D projects. Explicit `set-artifact` makes the contract
 * one-step: Runner builds, Runner registers, Bridge knows.
 *
 * Wire shape: POST /events with `event_type='last_artifact_set'` and payload
 * `{model_path: <absPath>}`. Identity (execId/issueId/projectName) resolved
 * via the same CLI/manifest/env fallback chain as `notify` (Runner CLI flag
 * → FLYWHEEL_* env).
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

const VALID_MODEL_EXTENSIONS = new Set([
	".glb",
	".gltf",
	".stl",
	".3mf",
	".obj",
]);

export interface SetArtifactArgs {
	modelPath: string;
	execId?: string;
	issueId?: string;
	projectName?: string;
	bridgeUrl?: string;
	ingestToken?: string;
	/** Test seam. */
	fetchFn?: typeof fetch;
}

export interface SetArtifactResult {
	exitCode: 0 | 2;
	posted: boolean;
	resolvedPath: string;
}

export async function setArtifact(
	args: SetArtifactArgs,
): Promise<SetArtifactResult> {
	const fetchImpl = args.fetchFn ?? fetch;

	// 1. Validate model_path
	if (!isAbsolute(args.modelPath)) {
		throw new Error(
			`set-artifact: --model-path must be absolute (got: ${args.modelPath})`,
		);
	}
	if (!existsSync(args.modelPath)) {
		throw new Error(`set-artifact: model file not found: ${args.modelPath}`);
	}
	const stat = statSync(args.modelPath);
	if (!stat.isFile()) {
		throw new Error(
			`set-artifact: model path is not a regular file: ${args.modelPath}`,
		);
	}
	const ext = args.modelPath
		.toLowerCase()
		.slice(args.modelPath.lastIndexOf("."));
	if (!VALID_MODEL_EXTENSIONS.has(ext)) {
		throw new Error(
			`set-artifact: unsupported model extension "${ext}" — valid: ${[...VALID_MODEL_EXTENSIONS].join(", ")}`,
		);
	}

	// 2. Resolve identity (CLI > FLYWHEEL_* env, fail-closed).
	const execId = args.execId ?? process.env.FLYWHEEL_EXEC_ID;
	const issueId = args.issueId ?? process.env.FLYWHEEL_ISSUE_ID;
	const projectName = args.projectName ?? process.env.FLYWHEEL_PROJECT_NAME;
	if (!execId || !issueId || !projectName) {
		throw new Error(
			`set-artifact: missing identity — execId=${execId ?? "(unset)"} issueId=${issueId ?? "(unset)"} projectName=${projectName ?? "(unset)"}. Provide via CLI flag or FLYWHEEL_* env.`,
		);
	}

	const bridgeUrl = args.bridgeUrl ?? process.env.FLYWHEEL_BRIDGE_URL;
	if (!bridgeUrl) {
		throw new Error(
			"set-artifact: FLYWHEEL_BRIDGE_URL missing — set env or pass --bridge-url",
		);
	}

	// 3. POST /events
	const eventBody = {
		event_id: randomUuid(),
		execution_id: execId,
		issue_id: issueId,
		project_name: projectName,
		event_type: "last_artifact_set",
		source: "flywheel-comm",
		payload: { model_path: args.modelPath },
	};
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	const token = args.ingestToken ?? process.env.FLYWHEEL_INGEST_TOKEN;
	if (token) headers.Authorization = `Bearer ${token}`;

	const url = `${bridgeUrl.replace(/\/+$/, "")}/events`;
	try {
		const res = await fetchImpl(url, {
			method: "POST",
			headers,
			body: JSON.stringify(eventBody),
		});
		if (!res.ok) {
			console.error(
				`set-artifact: POST ${url} returned ${res.status} ${res.statusText}`,
			);
			return { exitCode: 2, posted: false, resolvedPath: args.modelPath };
		}
		console.log(
			`set-artifact: registered ${args.modelPath} for execId=${execId}`,
		);
		return { exitCode: 0, posted: true, resolvedPath: args.modelPath };
	} catch (err) {
		console.error(
			`set-artifact: POST ${url} threw: ${err instanceof Error ? err.message : String(err)}`,
		);
		return { exitCode: 2, posted: false, resolvedPath: args.modelPath };
	}
}

function randomUuid(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (c?.randomUUID) return c.randomUUID();
	return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
