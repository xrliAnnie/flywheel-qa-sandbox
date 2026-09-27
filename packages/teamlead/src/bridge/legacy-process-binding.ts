import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
} from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	discoverLegacyClaudeProcessBinding,
	resolveExecutionLaunchExecutable,
} from "flywheel-claude-runner";
import type { StateStore } from "../StateStore.js";
import type { ExecutionBodySampleControl } from "./execution-body-liveness.js";

interface LegacyBindingOptions {
	isEnabled(): boolean;
	stateRoot?: string;
	now?: () => number;
	resolveCwd?: (path: string) => Promise<string>;
	resolveExecutable?: () => Promise<string>;
	discover?: typeof discoverLegacyClaudeProcessBinding;
}
function readManifest(root: string, executionId: string) {
	const directory = join(root, executionId);
	const parent = lstatSync(directory);
	if (!parent.isDirectory() || parent.isSymbolicLink())
		throw new Error("legacy_manifest_unavailable");
	const fd = openSync(
		join(directory, "session.json"),
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const before = fstatSync(fd);
		if (!before.isFile() || before.size > 65536)
			throw new Error("legacy_manifest_unavailable");
		const buffer = Buffer.alloc(65537);
		const count = readSync(fd, buffer, 0, buffer.length, 0);
		const after = fstatSync(fd);
		if (
			count > 65536 ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs
		)
			throw new Error("legacy_manifest_unavailable");
		const value: unknown = JSON.parse(
			buffer.subarray(0, count).toString("utf8"),
		);
		if (!value || typeof value !== "object")
			throw new Error("legacy_manifest_unavailable");
		const m = value as Record<string, unknown>;
		if (
			m.schemaVersion !== 1 ||
			m.executionId !== executionId ||
			m.vendor !== "claude" ||
			typeof m.sessionId !== "string" ||
			!/^[a-fA-F0-9-]{36}$/.test(m.sessionId) ||
			typeof m.cwd !== "string" ||
			!m.cwd.startsWith("/") ||
			m.cwd.length > 4096 ||
			/\p{Cc}/u.test(m.cwd)
		)
			throw new Error("legacy_manifest_unavailable");
		return { sessionId: m.sessionId, cwd: m.cwd };
	} finally {
		closeSync(fd);
	}
}

/** Backfills identity, never a liveness verdict. This runs inside the common
 * observer's existing bounded workers; there is no second sampler or death cache.
 * Unknown records remain visible in the existing durable session event ledger. */
export function createLegacyProcessBindingPreparer(
	store: StateStore,
	options: LegacyBindingOptions,
) {
	const now = options.now ?? Date.now;
	const root =
		options.stateRoot ??
		(process.env.FLYWHEEL_CLAUDE_SESSION_DIR?.trim() ||
			join(homedir(), ".flywheel", "state", "claude-sessions"));
	const active = new Map<
		string,
		{ pending: Promise<void>; cancel: AbortController }
	>();
	const enabled = () => {
		try {
			return options.isEnabled() === true;
		} catch {
			return false;
		}
	};
	function context(id: string) {
		const session = store.getSession(id);
		if (session?.adapter_type !== "claude-tmux" || !session.worktree_path)
			return undefined;
		const activation = store.resolveCurrentWorkflowActivation(id);
		if (
			activation.kind === "ambiguous" ||
			(activation.kind === "none" && store.getWorkflowActor(id))
		)
			return undefined;
		return {
			executionId: id,
			issueId: session.issue_id,
			projectName: session.project_name,
			activationId:
				activation.kind === "current" ? activation.binding.activation_id : null,
			generation: store.getWorkflowExecutionProcessBody(id)?.generation ?? 1,
			lifecycleRevision: session.lifecycle_revision ?? 0,
			cwd: session.worktree_path,
		};
	}
	async function run(id: string, signal: AbortSignal, budget: number) {
		if (!enabled() || signal.aborted || store.executionProcessOwners.get(id))
			return;
		const initial = context(id);
		const session = store.getSession(id);
		if (session?.adapter_type !== "claude-tmux") return;
		const contextKey = JSON.stringify(
			initial ?? [id, session.lifecycle_revision, session.worktree_path],
		);
		const digest = createHash("sha256").update(contextKey).digest("hex");
		const report = (status: "adopted" | "unknown", reason: string) => {
			try {
				store.insertEvent({
					event_id: `legacy_process_binding:${id}:${digest}:${status}:${reason}`,
					execution_id: id,
					issue_id: session.issue_id,
					project_name: session.project_name,
					event_type: "runner_process_binding",
					source: "bridge.execution-body",
					payload: {
						status,
						reason,
						generation: initial?.generation,
						activationId: initial?.activationId,
					},
				});
			} catch {
				/* Reporting cannot authorize adoption or death. */
			}
		};
		if (!initial) {
			report("unknown", "legacy_context_unavailable");
			return;
		}
		const deadline = now() + budget;
		try {
			const manifest = readManifest(root, id);
			const resolveCwd = options.resolveCwd ?? realpath;
			const cwd = await resolveCwd(initial.cwd);
			if ((await resolveCwd(manifest.cwd)) !== cwd) {
				report("unknown", "legacy_cwd_changed");
				return;
			}
			const executable = await (
				options.resolveExecutable ??
				(async () =>
					(await resolveExecutionLaunchExecutable("claude")).executable)
			)();
			if (!enabled() || signal.aborted || now() >= deadline) return;
			const observedAtMs = now();
			const binding = await (
				options.discover ?? discoverLegacyClaudeProcessBinding
			)(
				{
					executionId: id,
					nativeSessionId: manifest.sessionId,
					cwd,
					executable,
				},
				{ signal, deadlineMs: deadline - now() },
			);
			if (!binding) {
				report("unknown", "legacy_process_not_unique");
				return;
			}
			if (
				binding.legacyExecutionId !== id ||
				binding.nativeSessionId !== manifest.sessionId ||
				binding.cwd !== cwd ||
				binding.executable !== executable
			) {
				report("unknown", "legacy_binding_mismatch");
				return;
			}
			const current = () =>
				enabled() &&
				!signal.aborted &&
				now() < deadline &&
				JSON.stringify(context(id)) === contextKey;
			for (let attempt = 0; attempt < 3; attempt++) {
				// File/OS work remains outside the final synchronous SQLite CAS.
				if (
					JSON.stringify(readManifest(root, id)) !== JSON.stringify(manifest) ||
					!current()
				)
					return;
				const result = store.executionProcessOwners.adoptLegacyBinding({
					...initial,
					ownerToken: randomUUID(),
					binding,
					nowMs: now(),
					observedAtMs,
					expiresAtMs: deadline,
					isCurrent: current,
				});
				if (result.ok) {
					report("adopted", "legacy_process_verified");
					return;
				}
				if (result.reason !== "lease_held" || attempt === 2) {
					report("unknown", result.reason);
					return;
				}
				await new Promise((resolve) =>
					setTimeout(resolve, attempt === 0 ? 25 : 75),
				);
			}
		} catch {
			report("unknown", "legacy_binding_unavailable");
		}
	}
	return (
		executionId: string,
		control: ExecutionBodySampleControl = {},
	): Promise<void> => {
		if (
			!/^[A-Za-z0-9_-]{1,256}$/.test(executionId) ||
			!enabled() ||
			control.signal?.aborted
		)
			return Promise.resolve();
		const budget = Math.min(5000, control.deadlineMs ?? 5000);
		if (!Number.isFinite(budget) || budget <= 0) return Promise.resolve();
		let entry = active.get(executionId);
		if (!entry) {
			const cancel = new AbortController();
			const pending = run(executionId, cancel.signal, budget).finally(() => {
				if (active.get(executionId)?.pending === pending)
					active.delete(executionId);
			});
			entry = { pending, cancel };
			active.set(executionId, entry);
		}
		const cancel = () => entry.cancel.abort();
		const timer = setTimeout(cancel, budget);
		control.signal?.addEventListener("abort", cancel, { once: true });
		if (control.signal?.aborted) cancel();
		return entry.pending.finally(() => {
			clearTimeout(timer);
			control.signal?.removeEventListener("abort", cancel);
		});
	};
}
