import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { KillPathInventoryEntry } from "./kill-path-inventory.js";
import { scanKillPathInventory } from "./kill-path-inventory.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

type MutationDisposition =
	| "boundary"
	| "no_target_refusal"
	| "boot_fenced_plain_tmux"
	| "bounded_child";

interface MutationRegistration {
	path: string;
	callFragment: string;
	disposition: MutationDisposition;
}

const MUTATION_REGISTRY: readonly MutationRegistration[] = [
	{
		path: "packages/claude-runner/src/TmuxAdapter.ts",
		callFragment: 'source: "tmux_adapter"',
		disposition: "boundary",
	},
	{
		path: "packages/claude-runner/src/codex-daemon-runtime.ts",
		callFragment: 'reason: "daemon_child_signal_fallback"',
		disposition: "boundary",
	},
	{
		path: "packages/claude-runner/src/codex-daemon-runtime.ts",
		callFragment: '"daemon_group_signal"',
		disposition: "boundary",
	},
	{
		path: "packages/claude-runner/src/codex-runner-tui-window.ts",
		callFragment: "mutationResult = await exec(",
		disposition: "boundary",
	},
	{
		path: "packages/claude-runner/src/codex-runner-tui-window.ts",
		callFragment: 'reason: "runner_tui_close"',
		disposition: "boundary",
	},
	{
		path: "packages/edge-worker/src/Blueprint.ts",
		callFragment: 'reason: "runner_blueprint_cleanup"',
		disposition: "boundary",
	},
	{
		path: "packages/edge-worker/src/worktree-process-reaper.ts",
		callFragment: 'reason: "worktree_owner_reap"',
		disposition: "boundary",
	},
	{
		path: "packages/edge-worker/src/worktree-process-reaper.ts",
		callFragment: 'reason: "worktree_owner_group_reap"',
		disposition: "boundary",
	},
	{
		path: "packages/teamlead/src/bridge/codex-runner-orphan-reaper.ts",
		callFragment: 'reason: "proven_orphan_app_server"',
		disposition: "boundary",
	},
	{
		path: "packages/teamlead/src/bridge/mcp-descendant-reaper.ts",
		callFragment: 'reason: "runner_mcp_descendant_reap"',
		disposition: "boundary",
	},
	{
		path: "packages/teamlead/src/bridge/mcp-descendant-reaper.ts",
		callFragment: 'reason: "periodic_orphan_pass"',
		disposition: "no_target_refusal",
	},
	{
		path: "packages/teamlead/src/bridge/tmux-lookup.ts",
		callFragment: 'reason: "uncommitted_workflow_window_cleanup"',
		disposition: "boundary",
	},
	{
		path: "packages/teamlead/src/bridge/tmux-lookup.ts",
		callFragment: 'reason: "runner_window_close"',
		disposition: "boundary",
	},
	{
		path: "packages/claude-runner/src/TmuxAdapter.ts",
		callFragment: 'process.kill(-child.pid, "SIGKILL")',
		disposition: "bounded_child",
	},
	{
		path: "packages/teamlead/src/bridge/terminal-tab-reaper.ts",
		callFragment: "Slot safety is boot-fenced",
		disposition: "boot_fenced_plain_tmux",
	},
	{
		path: "packages/teamlead/src/bridge/viewer-session-reaper.ts",
		callFragment: "Slot safety is boot-fenced",
		disposition: "boot_fenced_plain_tmux",
	},
];

interface AuditedCallSite {
	path: string;
	callee: string;
	start: number;
	end: number;
	mutateStart?: number;
	block: string;
}

function productionTypeScriptFiles(): string[] {
	const files: string[] = [];
	const visit = (absolute: string): void => {
		const stat = statSync(absolute);
		if (stat.isDirectory()) {
			const name = absolute.slice(absolute.lastIndexOf("/") + 1);
			if (
				["dist", "node_modules", "test", "tests", "__tests__"].includes(name)
			) {
				return;
			}
			for (const child of readdirSync(absolute).sort()) {
				visit(resolve(absolute, child));
			}
			return;
		}
		if (absolute.endsWith(".ts") && !absolute.endsWith(".test.ts")) {
			files.push(absolute);
		}
	};
	visit(resolve(REPO_ROOT, "packages"));
	return files;
}

function closingParen(source: string, open: number): number {
	let depth = 0;
	let quote: '"' | "'" | "`" | null = null;
	let lineComment = false;
	let blockComment = false;
	for (let index = open; index < source.length; index++) {
		const char = source[index];
		const next = source[index + 1];
		if (lineComment) {
			if (char === "\n") lineComment = false;
			continue;
		}
		if (blockComment) {
			if (char === "*" && next === "/") {
				blockComment = false;
				index++;
			}
			continue;
		}
		if (quote) {
			if (char === "\\") index++;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === "/" && next === "/") {
			lineComment = true;
			index++;
			continue;
		}
		if (char === "/" && next === "*") {
			blockComment = true;
			index++;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			quote = char;
			continue;
		}
		if (char === "(") depth++;
		else if (char === ")" && --depth === 0) return index;
	}
	throw new Error("unterminated audited signal call");
}

function scanAuditedCalls(): AuditedCallSite[] {
	const sites: AuditedCallSite[] = [];
	const callPattern =
		/\b((?:this\.)?(?:auditedSignal|auditedSignalAsync|recordBoundaryRefusal|auditSignal))\s*\(/g;
	for (const absolute of productionTypeScriptFiles()) {
		const path = relative(REPO_ROOT, absolute).replaceAll("\\", "/");
		if (path === "packages/claude-runner/src/kill-ledger.ts") continue;
		const source = readFileSync(absolute, "utf8");
		for (const match of source.matchAll(callPattern)) {
			const start = match.index;
			const open = source.indexOf("(", start);
			const end = closingParen(source, open);
			const block = source.slice(start, end + 1);
			const mutateOffset = block.indexOf("mutate:");
			sites.push({
				path,
				callee: match[1] ?? "",
				start,
				end,
				...(mutateOffset >= 0 ? { mutateStart: start + mutateOffset } : {}),
				block,
			});
		}
	}
	return sites;
}

function normalize(code: string): string {
	return code.trim().replace(/\s+/g, " ");
}

function inventoryEntryOffset(entry: KillPathInventoryEntry): number {
	const source = readFileSync(resolve(REPO_ROOT, entry.path), "utf8");
	const wantedOccurrence = Number(entry.key.match(/#(\d+)$/)?.[1] ?? "1");
	let occurrence = 0;
	let offset = 0;
	for (const line of source.split(/(?<=\n)/)) {
		if (normalize(line) === entry.code && ++occurrence === wantedOccurrence) {
			return offset + Math.max(0, line.search(/\S/));
		}
		offset += line.length;
	}
	throw new Error(`inventory entry disappeared: ${entry.key}`);
}

describe("FLY-2211 kill-path inventory", () => {
	it("classifies every mechanical kill-path hit in production roots", () => {
		const expected = JSON.parse(
			readFileSync(
				new URL("./fixtures/kill-path-inventory.json", import.meta.url),
				"utf8",
			),
		) as KillPathInventoryEntry[];
		expect(scanKillPathInventory()).toEqual(expected);
		expect(
			expected.some(
				(entry) => entry.classification === "runner-affecting-mutation",
			),
		).toBe(true);
		expect(
			expected.some((entry) => entry.classification === "signal-0-probe"),
		).toBe(true);
		expect(expected.some((entry) => entry.classification === "qa-only")).toBe(
			true,
		);
	}, 15_000);

	it("keeps every runner-affecting mechanical mutation inside the audited choke point or bounded-child exception", () => {
		const calls = scanAuditedCalls();
		const runnerMutations = scanKillPathInventory().filter(
			(entry) => entry.classification === "runner-affecting-mutation",
		);
		const uncovered = runnerMutations.filter((entry) => {
			if (
				entry.path === "packages/claude-runner/src/kill-ledger.ts" &&
				entry.code.includes("process.kill(target")
			) {
				return false;
			}
			if (
				entry.path === "packages/claude-runner/src/TmuxAdapter.ts" &&
				(entry.code === 'child.kill("SIGKILL");' ||
					entry.code === 'process.kill(-child.pid, "SIGKILL");')
			) {
				return false;
			}
			const offset = inventoryEntryOffset(entry);
			return !calls.some(
				(call) =>
					call.path === entry.path &&
					call.mutateStart !== undefined &&
					offset >= call.mutateStart &&
					offset <= call.end,
			);
		});
		expect(uncovered.map((entry) => entry.key)).toEqual([]);
	}, 15_000);

	it("registers every logical audited caller exactly once with boundary and env evidence", () => {
		const calls = scanAuditedCalls();
		const auditedRegistry = MUTATION_REGISTRY.filter(
			(entry) =>
				entry.disposition === "boundary" ||
				entry.disposition === "no_target_refusal",
		);
		for (const call of calls) {
			const registrations = auditedRegistry.filter(
				(entry) =>
					entry.path === call.path && call.block.includes(entry.callFragment),
			);
			expect(registrations, `${call.path}:${call.callee}`).toHaveLength(1);
			const registration = registrations[0];
			expect(call.block, `${call.path}:${registration?.callFragment}`).toMatch(
				/\benv\s*(?::|[,}])/,
			);
			if (registration?.disposition === "boundary") {
				expect(call.block, `${call.path}:${registration.callFragment}`).toMatch(
					/\bboundary\b/,
				);
			}
		}
		for (const registration of auditedRegistry) {
			expect(
				calls.filter(
					(call) =>
						call.path === registration.path &&
						call.block.includes(registration.callFragment),
				),
				`${registration.path}:${registration.callFragment}`,
			).toHaveLength(1);
		}
	});

	it("registers the explicit rescue session socket as a confined consumer", () => {
		const source = readFileSync(
			resolve(
				REPO_ROOT,
				"packages/claude-runner/src/codex-runner-tui-window.ts",
			),
			"utf8",
		);
		expect(source).toContain("const socket = tmuxSocketPath();");
		expect(source).toContain('process.env.TMUX_TMPDIR || "/tmp"');
		const contract = JSON.parse(
			readFileSync(
				resolve(REPO_ROOT, "scripts/lib/qa-slot-env-contract.json"),
				"utf8",
			),
		);
		expect(
			contract.find((entry: { name: string }) => entry.name === "TMUX_TMPDIR"),
		).toMatchObject({
			boot: "mustBeUnderRoot",
			confinedConsumers: [
				"codex-runner-tui-window.defaultEnsureSessionAsync (explicit -S via tmuxSocketPath)",
			],
		});
		expect(
			contract.find(
				(entry: { name: string }) =>
					entry.name === "FLYWHEEL_TMUX_SOCKET_OVERRIDE",
			),
		).toMatchObject({ disposition: "clear", boot: "mustBeAbsent" });
	});

	it("pins boot-fenced plain tmux and exact spawned-child exceptions", () => {
		for (const registration of MUTATION_REGISTRY.filter(
			(entry) =>
				entry.disposition === "boot_fenced_plain_tmux" ||
				entry.disposition === "bounded_child",
		)) {
			const source = readFileSync(
				resolve(REPO_ROOT, registration.path),
				"utf8",
			);
			expect(source).toContain(registration.callFragment);
		}
		const tmuxAdapter = readFileSync(
			resolve(REPO_ROOT, "packages/claude-runner/src/TmuxAdapter.ts"),
			"utf8",
		);
		expect(tmuxAdapter).toMatch(
			/const child = spawn\(cmd, args,[\s\S]+detached: process\.platform !== "win32"[\s\S]+if \(!exitSeen && child\.pid[\s\S]+process\.kill\(-child\.pid, "SIGKILL"\)[\s\S]+child\.kill\("SIGKILL"\)/,
		);
	});
});
