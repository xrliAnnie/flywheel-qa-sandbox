/**
 * FLY-245 F-b — McpInventoryWatcher: collects the app-server's MCP startup
 * notifications and enforces the Phase A2 inventory assertion at runtime
 * (plan §3.2/§3.4, release condition ④).
 *
 * The runtime feeds every JSON-RPC notification in; the watcher records which
 * MCP servers report READY (and which report failure). Before a write-capable
 * Lead's thread starts, `waitForExact` must resolve: every allowlisted server
 * (= exactly the flywheel gateway) ready, and NOTHING ELSE observed. An extra
 * server (an injected Chrome / unknown connector), a failed required server, or
 * a timeout all throw → the Lead fail-closes.
 *
 * Notification shape parsing is deliberately defensive (`mcpServer/
 * startupStatus/updated` with name/status under a couple of plausible keys) —
 * the exact production shape is pinned by the Phase F real-machine QA; an
 * unparsable shape simply never marks a server ready, which fails CLOSED at
 * the timeout.
 */

import { assertMcpInventory } from "./buildCodexLeadMcpArgv.js";

const READY_STATUSES = new Set([
	"ready",
	"running",
	"connected",
	"ok",
	"started",
]);
const FAILED_STATUSES = new Set(["failed", "error", "crashed", "exited"]);

/** Pull tool names out of an unknown advertisement payload — defensively, the
 * same discipline as server-status parsing. Accepts either a `tools: [...]`
 * array of `{name}`/string entries or a single `{name}`/`{tool}` shape. An
 * unparsable shape yields nothing (→ the ⑧ assertion fails closed on empty). */
function extractToolNames(params: unknown): string[] {
	const p = (params ?? {}) as Record<string, unknown>;
	const out: string[] = [];
	const pushFrom = (entry: unknown) => {
		if (typeof entry === "string") {
			if (entry) out.push(entry);
			return;
		}
		if (entry && typeof entry === "object") {
			const e = entry as Record<string, unknown>;
			const n =
				(typeof e.name === "string" && e.name) ||
				(typeof e.tool === "string" && e.tool) ||
				undefined;
			if (n) out.push(n);
		}
	};
	if (Array.isArray(p.tools)) for (const t of p.tools) pushFrom(t);
	else if (p.tool !== undefined) pushFrom(p.tool);
	else if (typeof p.name === "string") pushFrom(p.name);
	return out;
}

export class McpInventoryWatcher {
	private readonly ready = new Set<string>();
	private readonly failed = new Map<string, string>();
	private readonly observed = new Set<string>();
	/** §3.5/⑧: model-callable tool names advertised at startup (HIGH-1). */
	private readonly tools = new Set<string>();

	/** Feed one JSON-RPC notification (the runtime forwards all of them). */
	record(method: string, params: unknown): void {
		// ⑧ tool-surface collection: any notification that carries tool
		// advertisements (`*/tools/*`, `*/listTools`, or a `tools` array payload).
		if (/tool/i.test(method)) {
			for (const t of extractToolNames(params)) this.tools.add(t);
		}
		if (!/mcp/i.test(method) || !/(startup|status)/i.test(method)) return;
		const p = (params ?? {}) as Record<string, unknown>;
		const inner =
			p.server && typeof p.server === "object"
				? (p.server as Record<string, unknown>)
				: p;
		const name =
			(typeof inner.name === "string" && inner.name) ||
			(typeof inner.serverName === "string" && inner.serverName) ||
			(typeof p.name === "string" && p.name) ||
			undefined;
		if (!name) return;
		const status = String(
			inner.status ?? inner.state ?? p.status ?? "",
		).toLowerCase();
		this.observed.add(name);
		if (READY_STATUSES.has(status)) {
			this.ready.add(name);
			this.failed.delete(name);
		} else if (FAILED_STATUSES.has(status)) {
			this.failed.set(name, status);
			this.ready.delete(name);
		}
	}

	/** Snapshot of every server name seen in any state. */
	observedServers(): string[] {
		return [...this.observed];
	}

	/** Snapshot of every model-callable tool name advertised (⑧ / HIGH-1). */
	observedTools(): string[] {
		return [...this.tools];
	}

	/**
	 * Resolve once EVERY allowlisted server is READY — then HARD-ASSERT the
	 * observed inventory equals the allowlist exactly (A2). Throws on: a failed
	 * required server, any extra observed server, or the timeout (fail-closed —
	 * an unconfirmed gateway must never unlock a write-capable Lead).
	 */
	async waitForExact(
		allowlist: readonly string[],
		timeoutMs: number,
		pollMs = 100,
	): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			for (const name of allowlist) {
				const failure = this.failed.get(name);
				if (failure) {
					throw new Error(
						`FLY-245 MCP inventory: required server "${name}" reported "${failure}" (fail-closed)`,
					);
				}
			}
			const extra = [...this.observed].filter((n) => !allowlist.includes(n));
			if (extra.length > 0) {
				throw new Error(
					`FLY-245 MCP inventory: unexpected server(s) observed [${extra.sort().join(", ")}] — only [${allowlist.join(", ")}] is allowed (fail-closed)`,
				);
			}
			if (allowlist.every((n) => this.ready.has(n))) {
				assertMcpInventory([...this.observed], allowlist);
				return;
			}
			if (Date.now() >= deadline) {
				throw new Error(
					`FLY-245 MCP inventory: timed out after ${timeoutMs}ms waiting for [${allowlist.join(", ")}] to be ready (observed ready: [${[...this.ready].join(", ")}]) — fail-closed`,
				);
			}
			await new Promise((r) => setTimeout(r, pollMs));
		}
	}
}
