/**
 * FLY-245 Phase B — runtime thread-descriptor assertion (plan §3.4, Codex R1#9).
 *
 * A write-capable Codex Lead's confinement must be VERIFIED at runtime, not
 * assumed: `thread/start` (and `thread/resume`) echo back the effective policy
 * (`approvalPolicy`, `sandbox`, `cwd`, `runtimeWorkspaceRoots`) plus the running
 * `cliVersion`. We read that echo and HARD-ASSERT it against the expected
 * confinement; any mismatch fails the Lead closed (the runtime exits) rather than
 * letting a Codex version bump or a config drift silently widen the sandbox.
 *
 * The policy echo proves config *parsing*, not kernel *enforcement* — so a
 * supported `cliVersion` allowlist is part of the contract: a new Codex binary
 * must pass the real-machine threat matrix before it is allowed to run a
 * write-capable Lead. (MCP / non-MCP action-surface inventory assertions are
 * Phase A2/A3 — they consume the gateway built in Phase C.)
 *
 * Pure + dependency-free → exhaustively unit-tested. The runtime wires this only
 * for a write-capable Lead, which stays fail-closed until Phase F.
 */

/** The subset of a `thread/start`|`thread/resume` result we assert on. */
export interface ThreadDescriptor {
	id: string;
	approvalPolicy?: unknown;
	sandbox?: {
		type?: unknown;
		networkAccess?: unknown;
		writableRoots?: unknown;
	};
	cwd?: unknown;
	runtimeWorkspaceRoots?: unknown;
	cliVersion?: unknown;
}

export interface ConfinementExpectation {
	/** Canonical Lead scratch workspace (the only writable root + the cwd). */
	workspace: string;
	/** Codex CLI versions vetted for write-capable Leads (plan §3.4). */
	cliVersionAllowlist: readonly string[];
}

/**
 * Parse the descriptor fields out of a `thread/start`|`thread/resume` result.
 * The real protocol puts `cwd`/`runtimeWorkspaceRoots`/`approvalPolicy`/`sandbox`
 * at the result top level and `id`/`cliVersion` under `result.thread`. Defensive:
 * unknown shapes leave fields `undefined`, which the assertion then rejects.
 */
export function extractThreadDescriptor(result: unknown): ThreadDescriptor {
	const r = (result ?? {}) as Record<string, unknown>;
	const thread = (r.thread ?? {}) as Record<string, unknown>;
	const id =
		(typeof thread.id === "string" ? thread.id : undefined) ??
		(typeof r.threadId === "string" ? r.threadId : undefined) ??
		(typeof r.id === "string" ? r.id : "");
	const sandbox =
		r.sandbox && typeof r.sandbox === "object"
			? (r.sandbox as ThreadDescriptor["sandbox"])
			: undefined;
	return {
		id,
		approvalPolicy: r.approvalPolicy,
		sandbox,
		cwd: r.cwd,
		runtimeWorkspaceRoots: r.runtimeWorkspaceRoots,
		cliVersion: thread.cliVersion ?? r.cliVersion,
	};
}

/** The unique set of strings in an unknown value, or null if not a string[]. */
function uniqueStringSet(v: unknown): Set<string> | null {
	if (!Array.isArray(v)) return null;
	const out = new Set<string>();
	for (const x of v) {
		if (typeof x !== "string") return null;
		out.add(x);
	}
	return out;
}

/**
 * HARD-ASSERT the descriptor matches the expected write-capable confinement.
 * Throws a descriptive Error on the FIRST violation (the caller fail-closes).
 *
 *   - approvalPolicy === "never"
 *   - sandbox.type === "workspaceWrite" && networkAccess === false
 *   - sandbox.writableRoots is EXACTLY {workspace}
 *   - cwd === workspace
 *   - runtimeWorkspaceRoots is EXACTLY {workspace} (cwd + writableRoots, deduped)
 *   - cliVersion ∈ allowlist
 */
export function assertConfinement(
	d: ThreadDescriptor,
	exp: ConfinementExpectation,
): void {
	const fail = (msg: string): never => {
		throw new Error(`FLY-245 confinement assertion failed: ${msg}`);
	};

	if (d.approvalPolicy !== "never") {
		fail(
			`approvalPolicy must be "never" (got ${JSON.stringify(d.approvalPolicy)})`,
		);
	}
	if (!d.sandbox || typeof d.sandbox !== "object") {
		fail("sandbox policy missing from thread descriptor");
	}
	const sb = d.sandbox as NonNullable<ThreadDescriptor["sandbox"]>;
	if (sb.type !== "workspaceWrite") {
		fail(
			`sandbox.type must be "workspaceWrite" (got ${JSON.stringify(sb.type)})`,
		);
	}
	if (sb.networkAccess !== false) {
		fail(
			`sandbox.networkAccess must be false (got ${JSON.stringify(sb.networkAccess)})`,
		);
	}
	const writable = uniqueStringSet(sb.writableRoots);
	if (!writable || writable.size !== 1 || !writable.has(exp.workspace)) {
		fail(
			`sandbox.writableRoots must be exactly [${exp.workspace}] (got ${JSON.stringify(sb.writableRoots)})`,
		);
	}
	if (d.cwd !== exp.workspace) {
		fail(`cwd must be ${exp.workspace} (got ${JSON.stringify(d.cwd)})`);
	}
	const roots = uniqueStringSet(d.runtimeWorkspaceRoots);
	if (!roots || roots.size !== 1 || !roots.has(exp.workspace)) {
		fail(
			`runtimeWorkspaceRoots must resolve to exactly {${exp.workspace}} (got ${JSON.stringify(d.runtimeWorkspaceRoots)})`,
		);
	}
	if (
		typeof d.cliVersion !== "string" ||
		!exp.cliVersionAllowlist.includes(d.cliVersion)
	) {
		fail(
			`cliVersion ${JSON.stringify(d.cliVersion)} is not in the write-capable allowlist [${exp.cliVersionAllowlist.join(", ")}] — a new Codex version must pass the threat matrix first`,
		);
	}
}
