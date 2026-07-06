/**
 * GEO-151 ProofShot — `handleProofShotAutoTrigger`.
 *
 * Wires `stage_changed` events to a Runner-side `flywheel-comm visual-capture`
 * instruction via the mailbox transport (FLY-142 prod default). Tracks per-run
 * state in `session_params.proofshot.runs[dedupKey]` so duplicate triggers
 * are suppressed and Runner/Bridge crashes recover via TTL.
 *
 * Sister to `handleCodexAutoTrigger` in event-route.ts. Both run side-by-side
 * inside the `stage_changed` switch; ProofShot has its own `capture_stages`
 * filter (from project config), so they don't fight over which stages trigger.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CommDB } from "flywheel-comm/db";
import {
	DEFAULT_PROOFSHOT_CAPTURE_STAGES,
	type ProofShotConfig,
} from "flywheel-config";
import type { LeadConfig } from "../ProjectConfig.js";
import { type ProjectEntry, resolveLeadForIssue } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import { commDbPathForProject } from "./commdb-path.js";
import { resolveCommBackend } from "./plugin.js";
import {
	getLastArtifact,
	getProofShotParams,
	markProofShotRunFailed,
	patchSessionParams,
} from "./proofshot-session.js";

/**
 * TTL for stale `pending`/`running` ProofShot runs (30 min). If a capture
 * gets stuck (Runner crash, mailbox write succeeded but Runner never read it,
 * notify never fired), the next stage_changed event for the same dedupKey
 * older than TTL is allowed to retry with `attempt = prior.attempt + 1`.
 *
 * 30min picks a window longer than any realistic real capture (~5 min worst
 * case for 3D with HTTP server bootstrap + 4 angles) but short enough that
 * stuck runs don't permanently block Annie from re-triggering by re-running
 * the test stage.
 */
export const PROOFSHOT_TTL_MS = 30 * 60 * 1000;

/** Minimal event shape consumed by the handler (avoids depending on event-route IngestEvent). */
export interface ProofShotTriggerEvent {
	execution_id: string;
	issue_id: string;
	project_name: string;
}

/** Effective param bundle the renderer needs to build the instruction markdown. */
export interface RenderProofShotInstructionArgs {
	stage: string;
	cfg: ProofShotConfig;
	captureKind: "ui" | "3d";
	attempt: number;
	dedupKey: string;
	execId: string;
	issueId: string;
	projectName: string;
	visionEnabled: boolean;
	outputDir: string;
	/** Only set when captureKind="3d" — `last_artifact.model_path` from session_params. */
	modelPath?: string;
	/** ProofShotConfig.model_viewer_url (only used for 3D). */
	modelViewerUrl?: string;
	/** ProofShotConfig.model_capture_angles (only used for 3D). */
	angles?: readonly string[];
}

/**
 * Render the markdown instruction the Runner receives via mailbox. Split out
 * of the handler so tests can assert templated content without re-running the
 * full handler.
 *
 * Important contract:
 * - `--dedup-key` and `--attempt` flags are REQUIRED in the visual-capture
 *   command line so the wrapper can echo them back into `manifest.json` and
 *   notify event payload (correlation, R6#1 / R7#4).
 * - Step 2 (Runner Read) is omitted when `visionEnabled=false` (e.g., issue
 *   labelled `no-vision` per AC16).
 * - Step 3 always shows `flywheel-comm notify --paths-from <manifest>`;
 *   wrapper writes `manifest.json` regardless of `--notify` flag.
 */
export function renderProofShotInstruction(
	args: RenderProofShotInstructionArgs,
): string {
	const {
		stage,
		cfg,
		captureKind,
		attempt,
		dedupKey,
		visionEnabled,
		outputDir,
		modelPath,
		modelViewerUrl,
		angles,
	} = args;

	// Codex R1 HIGH#1: --stage is REQUIRED by visual-capture validateArgs;
	// UI mode additionally REQUIRES --dev-command. Without these the Runner
	// instruction would fail validation immediately and Stage A auto-trigger
	// would never reach manifest/notify.
	const captureLines: string[] = [
		"flywheel-comm visual-capture \\",
		`  --kind ${captureKind} \\`,
		`  --stage ${stage} \\`,
		`  --description "${describeStage(stage, captureKind, attempt)}" \\`,
		`  --output "${outputDir}" \\`,
		`  --dedup-key "${dedupKey}" \\`,
		`  --attempt ${attempt}`,
	];
	if (captureKind === "ui") {
		const devCmd = cfg.dev_command ?? "pnpm dev";
		const last = captureLines.pop();
		captureLines.push(`${last} \\`);
		captureLines.push(`  --dev-command "${devCmd}"`);
	} else {
		// captureKind === "3d"
		const last = captureLines.pop();
		captureLines.push(`${last} \\`);
		captureLines.push(
			`  --model-path "${modelPath ?? ""}" --model-viewer-url "${modelViewerUrl ?? ""}" --angles "${(angles ?? []).join(",")}"`,
		);
	}

	const captureBlock = captureLines.join("\n");

	const v1Note =
		captureKind === "3d"
			? `3D 模式会启 local HTTP server 服务 model 目录, ProofShot 加载 \`http://127.0.0.1:<port>/<basename(model)>\` 并按 ${(angles ?? []).join("/")} 角度截图。`
			: `UI 模式会启 dev server (\`${cfg.dev_command ?? "pnpm dev"}\`) 并按 description 截操作流程。`;

	const visionStep = visionEnabled
		? "2. 对每个 selected path 跑 Read tool (multimodal 自动解析). 如果发现 UI bug, 回去 Edit 修, 然后重跑此流程 (新一轮 attempt). 如果 UI OK, 进 step 3 投递."
		: "2. (V1 vision 已被 label no-vision 关闭, 跳过 Read 步骤. 直接进 step 3.)";

	return [
		`你触发了 ProofShot 视觉验证 (stage=${stage}, kind=${captureKind}, attempt=${attempt}, dedup_key=${dedupKey}).`,
		"",
		"按顺序跑:",
		"",
		"1. 跑 visual-capture 命令 (capture + select; --notify default FALSE, V1 self-vision 先做):",
		"```bash",
		captureBlock,
		"```",
		v1Note,
		"命令 stdout 输出 JSON: `{selected, dropped, manifest_path, totalTokens, dedup_key, attempt}`. Manifest.json 持久化 dedup_key/attempt/execId/issue_id/project_name (correlation fields).",
		"",
		visionStep,
		"",
		"3. 投递 artifact 给 Lead (Annie Discord 端看到截图):",
		"```bash",
		"flywheel-comm notify --paths-from <manifest_path-from-step-1>",
		"```",
		"notify 从 manifest 读 dedup_key/attempt/execId/issue_id/project_name. POST /events artifact_emitted; Bridge handler 把图片走 Lead → Discord MCP reply.",
	].join("\n");
}

function describeStage(
	stage: string,
	captureKind: "ui" | "3d",
	attempt: number,
): string {
	const suffix = attempt > 1 ? ` retry ${attempt}` : "";
	return `auto-trigger ${stage} ${captureKind}${suffix}`;
}

/**
 * Build a unique dedup key for `(execId, stage, captureKind)`. The handler
 * uses this as both the `session_params.proofshot.runs` map key and the
 * `payload.metadata.dedupKey` on the mailbox message.
 */
export function buildProofShotDedupKey(
	execId: string,
	stage: string,
	captureKind: "ui" | "3d",
): string {
	return `${execId}|${stage}|${captureKind}`;
}

/**
 * Bridge stage_changed handler. Idempotent + restart-safe via per-run state
 * machine in `session_params.proofshot.runs[dedupKey]`. Failures are logged
 * + non-fatal; the parent stage transition still succeeds.
 *
 * Backend selection via `resolveCommBackend()`:
 * - `mailbox` (default) → `MailboxTransport.writeVerified()` with real
 *   payload shape `{leadName, recipient, payload: MailboxPayload}`. Idempotency
 *   key goes in `payload.metadata.flywheelId`.
 * - `commdb` (rollback) → `CommDB.insertInstruction('bridge', execId, content)`.
 *
 * State transitions:
 * - Pre-write: writes `{state: 'pending', attempt, updatedAt: now, lastError: null}`
 *   to runs[dedupKey]. If a prior run with same dedupKey is `completed`, return
 *   immediately (AC14 dedup). If `pending`/`running` and updatedAt within TTL,
 *   return (active capture in flight). Otherwise (stale, failed, or absent),
 *   advance attempt and retry.
 * - Write failure → `markProofShotRunFailed(execId, dedupKey, err.message)`
 *   transitions to `failed` so subsequent stage_changed can retry.
 * - Write success → state stays `pending`; `handleArtifactEvent` (A6) advances
 *   to `completed` when the artifact is delivered to the Lead.
 */
export async function handleProofShotAutoTrigger(
	store: StateStore,
	projects: ProjectEntry[],
	event: ProofShotTriggerEvent,
	stage: string,
): Promise<void> {
	const session = store.getSession(event.execution_id);
	if (!session) return;

	const params = store.getSessionParams(event.execution_id);
	const proofParams = getProofShotParams(params);
	const cfg = proofParams.config;
	if (!cfg?.enabled) return; // AC16 kill switch (default DEFAULT_PROOFSHOT_CONFIG has enabled=false)

	const captureStages = cfg.capture_stages ?? DEFAULT_PROOFSHOT_CAPTURE_STAGES;
	if (!captureStages.includes(stage)) return; // AC4 — stage filter

	const labels = store.getSessionLabels(event.execution_id) ?? [];
	const lastArtifact = getLastArtifact(params);
	const isGeoForge3D = event.project_name === "GeoForge3D";
	const captureKind: "ui" | "3d" =
		isGeoForge3D && lastArtifact.model_path ? "3d" : "ui";
	const dedupKey = buildProofShotDedupKey(
		event.execution_id,
		stage,
		captureKind,
	);

	// Structured state machine with TTL stale recovery.
	const runs = proofParams.runs ?? {};
	const prev = runs[dedupKey];
	const now = Date.now();
	if (prev) {
		if (prev.state === "completed") return; // AC14 dedup
		if (
			(prev.state === "pending" || prev.state === "running") &&
			now - prev.updatedAt < PROOFSHOT_TTL_MS
		) {
			return; // active capture in flight
		}
		// else: stale pending/running OR failed → fall through and retry
	}

	const attempt = (prev?.attempt ?? 0) + 1;
	// Pre-write: mark pending BEFORE actually writing the mailbox/CommDB
	// instruction. If the write fails, we transition to 'failed' so the next
	// stage_changed can retry; never leave the slot empty mid-write.
	patchSessionParams(store, event.execution_id, (cur) => {
		const curProofs = getProofShotParams(cur);
		const curRuns = curProofs.runs ?? {};
		return {
			...cur,
			proofshot: {
				...curProofs,
				runs: {
					...curRuns,
					[dedupKey]: {
						state: "pending",
						dedupKey,
						attempt,
						updatedAt: now,
						lastError: null,
					},
				},
			},
		};
	});

	// Resolve lead (throws on unknown project — wrap try/catch).
	let lead: LeadConfig;
	try {
		({ lead } = resolveLeadForIssue(projects, event.project_name, labels));
	} catch (err) {
		markProofShotRunFailed(
			store,
			event.execution_id,
			dedupKey,
			`resolveLeadForIssue: ${errMessage(err)}`,
		);
		return;
	}

	const visionEnabled =
		cfg.vision_default !== false && !labels.includes("no-vision");
	const outputDir = `~/.flywheel/screens/${event.execution_id}/${randomUUID()}`;
	const instructionMd = renderProofShotInstruction({
		stage,
		cfg,
		captureKind,
		attempt,
		dedupKey,
		execId: event.execution_id,
		issueId: event.issue_id,
		projectName: event.project_name,
		visionEnabled,
		outputDir,
		modelPath: captureKind === "3d" ? lastArtifact.model_path : undefined,
		modelViewerUrl: cfg.model_viewer_url,
		angles: captureKind === "3d" ? cfg.model_capture_angles : undefined,
	});

	const backend = resolveCommBackend(); // normalize 'mailbox' | 'commdb'
	const recipient = `runner-${event.execution_id.slice(0, 8)}`;
	const flywheelId = `proofshot-${dedupKey}-${attempt}`;

	try {
		if (backend === "mailbox") {
			// FLY-142 prod default: mailbox transport. Real payload shape is
			// MailboxPayload = {from, to, content, metadata}. Idempotency lives
			// in metadata.flywheelId (R4#1 — NOT a top-level field).
			const { AgentTeamTransportFactory } = await import(
				"flywheel-agent-team-transport"
			);
			const { MailboxTransport } = await import(
				"../mailbox/MailboxTransport.js"
			);
			const transport = new MailboxTransport(
				AgentTeamTransportFactory.fromEnv(),
			);
			await transport.writeVerified({
				leadName: lead.agentId,
				recipient,
				payload: {
					from: "bridge",
					to: recipient,
					content: instructionMd,
					metadata: {
						flywheelId,
						execId: event.execution_id,
						eventType: "proofshot_auto_trigger",
						stage,
						captureKind,
						attempt,
						dedupKey,
					},
				},
			});
		} else {
			// commdb rollback path — real signature is
			// insertInstruction(fromAgent, execId, content).
			const dbPath = commDbPathForProject(event.project_name);
			mkdirSync(dirname(dbPath), { recursive: true });
			const commDb = new CommDB(dbPath);
			try {
				commDb.insertInstruction("bridge", event.execution_id, instructionMd);
			} finally {
				commDb.close();
			}
		}
		console.log(
			`[proofshot-trigger] queued ${captureKind} capture for ${event.execution_id} ` +
				`(stage=${stage}, attempt=${attempt}, dedupKey=${dedupKey}, backend=${backend})`,
		);
	} catch (err) {
		markProofShotRunFailed(
			store,
			event.execution_id,
			dedupKey,
			`${backend} write failed: ${errMessage(err)}`,
		);
	}
	// Success → state stays 'pending'. handleArtifactEvent (A6) advances to
	// 'completed' when the artifact event reaches the Lead. TTL bounds the
	// stuck window.
}

function errMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	try {
		return JSON.stringify(err);
	} catch {
		return String(err);
	}
}
