import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type KillPathClassification =
	| "runner-affecting-mutation"
	| "service-mutation"
	| "signal-0-probe"
	| "qa-only"
	| "out-of-scope";

export interface KillPathInventoryEntry {
	key: string;
	path: string;
	code: string;
	classification: KillPathClassification;
}

const SOURCE_EXTENSIONS = new Set([
	".bash",
	".cjs",
	".js",
	".mjs",
	".py",
	".sh",
	".ts",
	".zsh",
]);

function extension(path: string): string {
	const dot = path.lastIndexOf(".");
	return dot >= 0 ? path.slice(dot) : "";
}

function candidateFiles(root: string): string[] {
	const files: string[] = [];
	const visit = (path: string): void => {
		const stat = statSync(path);
		if (stat.isDirectory()) {
			const name = path.slice(path.lastIndexOf("/") + 1);
			if (name === "node_modules" || name === "dist" || name === ".git") {
				return;
			}
			for (const child of readdirSync(path).sort()) visit(resolve(path, child));
			return;
		}
		if (SOURCE_EXTENSIONS.has(extension(path))) files.push(path);
	};
	visit(root);
	return files;
}

function normalizedCode(line: string): string {
	return line.trim().replace(/\s+/g, " ");
}

function isKillPath(code: string): boolean {
	if (
		!code ||
		code.startsWith("//") ||
		code.startsWith("/*") ||
		code.startsWith("*") ||
		code.startsWith("#")
	) {
		return false;
	}
	return (
		/\b(?:process|os)\.kill\s*\(/.test(code) ||
		/\b[\w?.]+\.kill\s*\(/.test(code) ||
		/["']kill-(?:window|session)["']/.test(code) ||
		/\bkill\s+(?:-[A-Za-z0-9]+|-s\s+[A-Za-z0-9]+)/.test(code) ||
		/\bxargs\s+kill\b/.test(code)
	);
}

function classify(path: string, code: string): KillPathClassification {
	if (
		/(?:^|\/)(?:__tests__|test|tests)(?:\/|$)|(?:^|\/)(?:qa|test|e2e|smoke|spike|r4)[-_/.]/i.test(
			path,
		)
	) {
		return "qa-only";
	}
	if (/[\w?.]+\.kill\([^,]+,\s*(?:0|["']0["'])\)|\bkill\s+-0\b/.test(code)) {
		return "signal-0-probe";
	}
	// Human-reviewed exclusions inside otherwise runner-facing modules. These
	// are bounded helper/view processes or injected test seams, not mutations of
	// the runner daemon/window named by A3.
	if (
		path === "packages/claude-runner/src/wait-aware-exec.ts" ||
		(path === "packages/claude-runner/src/codex-runner-tui-window.ts" &&
			(/child\.kill\(/.test(code) ||
				code.startsWith(": exec(") ||
				code.startsWith("return exec("))) ||
		(path === "packages/claude-runner/src/codex-daemon-runtime.ts" &&
			(code.startsWith("const killPid =") || code === "child.kill(signal);")) ||
		path === "packages/teamlead/src/bridge/terminal-tab-reaper.ts" ||
		path === "packages/teamlead/src/bridge/viewer-session-reaper.ts" ||
		(path === "packages/claude-runner/src/TmuxAdapter.ts" &&
			code.startsWith('execFileFn("tmux"'))
	) {
		return "out-of-scope";
	}
	if (
		path.startsWith("packages/claude-runner/src/") ||
		/^packages\/edge-worker\/src\/(?:Blueprint|TmuxAdapter|worktree-process-reaper)\.ts$/.test(
			path,
		) ||
		/^packages\/teamlead\/src\/bridge\/(?:codex-runner-orphan-reaper|mcp-descendant-reaper|tmux-lookup|post-merge|terminal-tab-reaper|viewer-session-reaper|runner-teardown|close-runner|crash-reaper|stale-blocker-guard)\.ts$/.test(
			path,
		) ||
		path === "scripts/hooks/runner-stop-notify.sh" ||
		path === "scripts/lib/codex-guard.sh" ||
		path === "packages/teamlead/scripts/lib/reap-orphan-adapters.sh"
	) {
		return "runner-affecting-mutation";
	}
	if (path === "scripts/restart-services.sh") return "service-mutation";
	return "out-of-scope";
}

export function scanKillPathInventory(
	repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
): KillPathInventoryEntry[] {
	const hits: Omit<KillPathInventoryEntry, "key">[] = [];
	for (const root of [
		resolve(repoRoot, "packages"),
		resolve(repoRoot, "scripts"),
	]) {
		for (const file of candidateFiles(root)) {
			const path = relative(repoRoot, file).replaceAll("\\", "/");
			for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
				const code = normalizedCode(line);
				if (!isKillPath(code)) continue;
				hits.push({ path, code, classification: classify(path, code) });
			}
		}
	}
	const occurrences = new Map<string, number>();
	return hits
		.map((hit) => {
			const base = `${hit.path}:${hit.code}`;
			const occurrence = (occurrences.get(base) ?? 0) + 1;
			occurrences.set(base, occurrence);
			return { key: `${base}#${occurrence}`, ...hit };
		})
		.sort((a, b) => a.key.localeCompare(b.key));
}
