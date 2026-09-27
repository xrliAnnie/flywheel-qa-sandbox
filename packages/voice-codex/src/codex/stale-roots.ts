import { execFile } from "node:child_process";
import { lstat, readdir, rm } from "node:fs/promises";
import { join, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Paths of every `n` record in `lsof -d cwd -Fn` output. */
export function parseLsofCwds(output: string): string[] {
	return output
		.split("\n")
		.filter((line) => line.startsWith("n") && line.length > 1)
		.map((line) => line.slice(1));
}

/** Every process's working directory, or undefined when lsof cannot say. */
export async function listProcessCwds(): Promise<string[] | undefined> {
	try {
		const { stdout } = await execFileAsync("lsof", ["-d", "cwd", "-Fn"], {
			timeout: 10_000,
			maxBuffer: 16 * 1024 * 1024,
		});
		return parseLsofCwds(stdout);
	} catch {
		return undefined;
	}
}

/**
 * FLY-2885 T7: container roots a previous daemon left behind. Run once the
 * voice lock is held and before any session opens, so no other daemon and no
 * container of this one can own them. A parent killed with SIGKILL takes its
 * WebRTC leg with it and the app-server exits on stdin EOF within its own
 * bounded shutdown, so at most a directory is left. A root some process still
 * works in — or whose use cannot be verified — is kept; nothing is killed.
 */
export async function sweepStaleCodexContainers(
	containersRoot: string,
	deps: {
		listCwds(): Promise<string[] | undefined>;
		evidence(record: Record<string, unknown>): void;
	},
): Promise<void> {
	let names: string[];
	try {
		names = await readdir(containersRoot);
	} catch {
		return;
	}
	const candidates: string[] = [];
	for (const name of names) {
		if (!name.startsWith("container-")) continue;
		const root = join(containersRoot, name);
		try {
			const metadata = await lstat(root);
			if (metadata.isDirectory() && !metadata.isSymbolicLink())
				candidates.push(root);
		} catch {
			// Gone already.
		}
	}
	if (candidates.length === 0) return;
	const cwds = await deps.listCwds();
	for (const root of candidates) {
		if (cwds === undefined) {
			deps.evidence({ kind: "codex_voice_stale_root_unverified", root });
			continue;
		}
		if (cwds.some((cwd) => cwd === root || cwd.startsWith(`${root}${sep}`))) {
			deps.evidence({ kind: "codex_voice_stale_root_busy", root });
			continue;
		}
		// rm removes links themselves, never what they point to.
		await rm(root, { recursive: true, force: true });
		deps.evidence({ kind: "codex_voice_stale_root_removed", root });
	}
}
