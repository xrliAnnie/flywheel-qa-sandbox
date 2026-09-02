import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { codexSessionStateDir } from "./codex-daemon-runtime.js";
import { codexHomeDir } from "./codex-home.js";

export type CodexRolloutMtimeProbe =
	| { kind: "found"; mtimeMs: number }
	| { kind: "absent" | "unknown" };

/** Read-only rollout progress sensor paired with the daemon socket probe. */
export function probeCodexRolloutMtime(
	executionId: string,
	env: NodeJS.ProcessEnv = process.env,
): CodexRolloutMtimeProbe {
	if (!executionId || /[/\\\0\r\n]/.test(executionId)) {
		return { kind: "unknown" };
	}
	const statePath = join(
		codexSessionStateDir(executionId, env),
		"session.json",
	);
	if (!existsSync(statePath)) return { kind: "absent" };
	let threadId: string;
	try {
		const parsed = JSON.parse(readFileSync(statePath, "utf8")) as {
			threadId?: unknown;
		};
		if (
			typeof parsed.threadId !== "string" ||
			!parsed.threadId ||
			/[/\\\0\r\n]/.test(parsed.threadId)
		) {
			return { kind: "unknown" };
		}
		threadId = parsed.threadId;
	} catch {
		return { kind: "unknown" };
	}

	const root = join(codexHomeDir(executionId, env), "sessions");
	if (!existsSync(root)) return { kind: "absent" };
	let newest: number | undefined;
	const pending = [root];
	try {
		while (pending.length > 0) {
			const dir = pending.pop();
			if (!dir) continue;
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) {
					pending.push(path);
				} else if (entry.isFile() && entry.name.includes(threadId)) {
					const mtimeMs = statSync(path).mtimeMs;
					if (newest === undefined || mtimeMs > newest) newest = mtimeMs;
				}
			}
		}
	} catch {
		return { kind: "unknown" };
	}
	return newest === undefined
		? { kind: "absent" }
		: { kind: "found", mtimeMs: newest };
}
