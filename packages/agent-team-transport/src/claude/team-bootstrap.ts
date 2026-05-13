/**
 * Claude-specific team file mutation (create / addMember / removeMember).
 *
 * Per plan v1.27.1 §A team-bootstrap (Codex r1 high #4 + r2 medium #5 + r3
 * medium #3):
 *
 * - Lives inside the adapter package (NOT in `edge-worker`) so vendor neutrality
 *   discipline is preserved upstream.
 * - Uses claude-code's actual `TeamFile` schema (matches
 *   `/Users/xiaorongli/Dev/claude-code/src/utils/swarm/teamHelpers.ts:64-90`)
 *   including `createdAt` (number unix ms) and required member fields
 *   `joinedAt`, `tmuxPaneId`, `cwd`, `subscriptions`.
 * - All mutations wrapped in `proper-lockfile` to serialize concurrent
 *   add/remove from multiple Lead daemons.
 * - claude-code's `TeamCreateTool` only exposes `spawnTeam` / `cleanup` —
 *   add/remove are flywheel-implemented internal helpers.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { getClaudeTeamConfigPath, getClaudeTeamsDir } from "../path-helpers.js";
import { ensureFileExists } from "./ClaudeMailboxCodec.js";

const LOCK_OPTIONS = {
	retries: { retries: 10, minTimeout: 5, maxTimeout: 100 },
} as const;

// ============================================================================
// TeamFile schema — matches claude-code teamHelpers.ts:64-90
// ============================================================================

export type BackendType = "tmux" | "managed-process" | "default" | string;

export type PermissionMode =
	| "default"
	| "acceptEdits"
	| "bypassPermissions"
	| "plan";

export interface TeamAllowedPath {
	path: string;
	toolName: string;
	addedBy: string;
	addedAt: number;
}

export interface TeamMember {
	agentId: string;
	name: string;
	agentType?: string;
	model?: string;
	prompt?: string;
	color?: string;
	planModeRequired?: boolean;
	joinedAt: number; // unix ms — REQUIRED per stock schema
	tmuxPaneId: string; // REQUIRED — placeholder OK if pane not yet allocated
	cwd: string; // REQUIRED — defaults to process.cwd()
	subscriptions: string[]; // REQUIRED — empty array OK
	worktreePath?: string;
	sessionId?: string;
	backendType?: BackendType;
	isActive?: boolean;
	mode?: PermissionMode;
}

export interface TeamFile {
	name: string;
	description?: string;
	createdAt: number; // unix ms — REQUIRED per stock schema
	leadAgentId: string;
	leadSessionId?: string;
	hiddenPaneIds?: string[];
	teamAllowedPaths?: TeamAllowedPath[];
	members: TeamMember[];
}

// ============================================================================
// Path helpers (re-exports for callers)
// ============================================================================

export function getTeamFilePath(teamName: string): string {
	return getClaudeTeamConfigPath(sanitizeName(teamName));
}

export function getTeamDir(teamName: string): string {
	const sanitized = sanitizeName(teamName);
	return `${getClaudeTeamsDir()}/${sanitized}`;
}

/** Stock claude-code sanitization (teamHelpers.ts:100-102). */
export function sanitizeName(name: string): string {
	return name.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
}

// ============================================================================
// Read / write under lock
// ============================================================================

export async function readTeamFile(teamName: string): Promise<TeamFile | null> {
	const path = getTeamFilePath(teamName);
	try {
		const content = await readFile(path, "utf-8");
		return JSON.parse(content) as TeamFile;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

interface MutateArgs {
	teamName: string;
	mutate: (existing: TeamFile | null) => TeamFile;
}

/**
 * In-process queue per lockfile path — proper-lockfile rejects intra-process
 * re-entry with ELOCKED immediately (see ClaudeMailboxCodec for full
 * explanation). We serialize same-process callers here, then proper-lockfile
 * handles cross-process serialization (e.g. multiple Lead daemons).
 */
const intraProcessQueues = new Map<string, Promise<unknown>>();

function withIntraProcessQueue<T>(
	lockfilePath: string,
	fn: () => Promise<T>,
): Promise<T> {
	const previous = intraProcessQueues.get(lockfilePath) ?? Promise.resolve();
	const next = previous.then(fn, fn).finally(() => {
		if (intraProcessQueues.get(lockfilePath) === current) {
			intraProcessQueues.delete(lockfilePath);
		}
	});
	const current: Promise<T> = next;
	intraProcessQueues.set(lockfilePath, current);
	return current;
}

async function mutateTeamFileUnderLock(args: MutateArgs): Promise<TeamFile> {
	const path = getTeamFilePath(args.teamName);
	await mkdir(dirname(path), { recursive: true });
	await ensureFileExists(path, ""); // proper-lockfile requires existing file

	const lockPath = `${path}.lock`;

	return withIntraProcessQueue(lockPath, async () => {
		const release = await lockfile.lock(path, {
			lockfilePath: lockPath,
			...LOCK_OPTIONS,
		});

		try {
			// Re-read inside lock to get fresh state.
			let existing: TeamFile | null;
			try {
				const content = await readFile(path, "utf-8");
				existing =
					content.length > 0 ? (JSON.parse(content) as TeamFile) : null;
			} catch {
				existing = null;
			}

			const next = args.mutate(existing);
			validateTeamFile(next);

			const serialized = JSON.stringify(next, null, 2);
			// Atomic temp + rename within the locked critical section.
			const tempPath = `${path}.tmp.${process.pid}.${Date.now()}.${Math.random()
				.toString(36)
				.slice(2, 8)}`;
			await writeFile(tempPath, serialized, "utf-8");
			await rename(tempPath, path);
			return next;
		} finally {
			await release();
		}
	});
}

// ============================================================================
// Public API
// ============================================================================

export interface EnsureTeamArgs {
	teamName: string;
	leadName: string;
	leadSessionId?: string;
	description?: string;
}

/**
 * Ensure a team file exists with the given lead. Idempotent: if a file
 * already exists with the same lead, returns it unchanged. If the lead
 * differs, throws to prevent silent overwrite.
 */
export async function ensureTeam(args: EnsureTeamArgs): Promise<TeamFile> {
	const sanitizedName = sanitizeName(args.teamName);
	const leadAgentId = `${args.leadName}@${sanitizedName}`;

	return mutateTeamFileUnderLock({
		teamName: args.teamName,
		mutate: (existing) => {
			if (existing) {
				if (existing.leadAgentId !== leadAgentId) {
					throw new Error(
						`Team ${sanitizedName} already exists with leadAgentId=${existing.leadAgentId}, cannot reassign to ${leadAgentId}`,
					);
				}
				// Refresh leadSessionId if provided.
				return args.leadSessionId
					? { ...existing, leadSessionId: args.leadSessionId }
					: existing;
			}
			const fresh: TeamFile = {
				name: sanitizedName,
				createdAt: Date.now(),
				leadAgentId,
				...(args.leadSessionId !== undefined && {
					leadSessionId: args.leadSessionId,
				}),
				...(args.description !== undefined && {
					description: args.description,
				}),
				members: [],
			};
			return fresh;
		},
	});
}

export interface AddMemberArgs {
	teamName: string;
	memberName: string;
	tmuxPaneId?: string;
	cwd?: string;
	subscriptions?: string[];
	color?: string;
	model?: string;
	agentType?: string;
	worktreePath?: string;
	sessionId?: string;
	backendType?: BackendType;
}

/**
 * Add a member to the team. Idempotent by member name (re-add updates
 * fields). All required stock-schema fields are populated with sane
 * defaults if caller doesn't provide them.
 */
export async function addMember(args: AddMemberArgs): Promise<TeamFile> {
	const sanitizedTeam = sanitizeName(args.teamName);
	return mutateTeamFileUnderLock({
		teamName: args.teamName,
		mutate: (existing) => {
			if (!existing) {
				throw new Error(
					`Cannot add member to non-existent team ${sanitizedTeam}; call ensureTeam() first`,
				);
			}
			const newMember: TeamMember = {
				name: args.memberName,
				agentId: `${args.memberName}@${sanitizedTeam}`,
				joinedAt: Date.now(),
				tmuxPaneId: args.tmuxPaneId ?? "pending",
				cwd: args.cwd ?? process.cwd(),
				subscriptions: args.subscriptions ?? [],
				...(args.color !== undefined && { color: args.color }),
				...(args.model !== undefined && { model: args.model }),
				...(args.agentType !== undefined && { agentType: args.agentType }),
				...(args.worktreePath !== undefined && {
					worktreePath: args.worktreePath,
				}),
				...(args.sessionId !== undefined && { sessionId: args.sessionId }),
				...(args.backendType !== undefined && {
					backendType: args.backendType,
				}),
			};

			const others = existing.members.filter((m) => m.name !== args.memberName);
			return { ...existing, members: [...others, newMember] };
		},
	});
}

export interface RemoveMemberArgs {
	teamName: string;
	memberName: string;
}

/**
 * Remove a member by name. Idempotent: removing a non-existent member is
 * a no-op (returns team unchanged).
 */
export async function removeMember(args: RemoveMemberArgs): Promise<TeamFile> {
	return mutateTeamFileUnderLock({
		teamName: args.teamName,
		mutate: (existing) => {
			if (!existing) {
				throw new Error(
					`Cannot remove member from non-existent team ${args.teamName}`,
				);
			}
			const next = existing.members.filter((m) => m.name !== args.memberName);
			return { ...existing, members: next };
		},
	});
}

// ============================================================================
// Schema validation — guards against accidentally writing invalid TeamFile
// ============================================================================

function validateTeamFile(teamFile: TeamFile): void {
	if (typeof teamFile.name !== "string" || teamFile.name.length === 0) {
		throw new Error("TeamFile.name must be non-empty string");
	}
	if (typeof teamFile.createdAt !== "number" || teamFile.createdAt <= 0) {
		throw new Error(
			"TeamFile.createdAt must be unix-ms number (Codex r2 medium #5)",
		);
	}
	if (
		typeof teamFile.leadAgentId !== "string" ||
		teamFile.leadAgentId.length === 0
	) {
		throw new Error("TeamFile.leadAgentId must be non-empty string");
	}
	if (!Array.isArray(teamFile.members)) {
		throw new Error("TeamFile.members must be array");
	}
	for (const m of teamFile.members) {
		if (typeof m.name !== "string" || m.name.length === 0) {
			throw new Error("TeamMember.name must be non-empty string");
		}
		if (typeof m.agentId !== "string" || m.agentId.length === 0) {
			throw new Error("TeamMember.agentId must be non-empty string");
		}
		if (typeof m.joinedAt !== "number" || m.joinedAt <= 0) {
			throw new Error(
				`TeamMember.joinedAt must be unix-ms number (member: ${m.name}) — Codex r3 medium #3`,
			);
		}
		if (typeof m.tmuxPaneId !== "string") {
			throw new Error(
				`TeamMember.tmuxPaneId must be string (member: ${m.name}) — Codex r3 medium #3`,
			);
		}
		if (typeof m.cwd !== "string") {
			throw new Error(
				`TeamMember.cwd must be string (member: ${m.name}) — Codex r3 medium #3`,
			);
		}
		if (!Array.isArray(m.subscriptions)) {
			throw new Error(
				`TeamMember.subscriptions must be array (member: ${m.name}) — Codex r3 medium #3`,
			);
		}
	}
}
