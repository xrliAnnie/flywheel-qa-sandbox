import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leadModelWritableRoot } from "./permission-profile.js";

const invalid = () => new Error("runtime_directories_invalid");
/** Activation scratch only: never creates/removes a Git worktree or user source.
 * Close after worker/broker/artifact store; only these exact mkdtemp roots are owned. */
export function createLeadRuntimeDirectories(options: {
	projectRoot: string;
	deploymentRoot: string;
	assertCurrent(): void;
}) {
	const owned: Array<{ path: string; dev: number; ino: number }> = [];
	const pins: Array<{ path: string; dev: number; ino: number }> = [];
	let closed = false;
	function directory(path: string) {
		const stat = lstatSync(path);
		if (
			realpathSync(path) !== path ||
			!stat.isDirectory() ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o022) !== 0
		)
			throw invalid();
		return { path, dev: stat.dev, ino: stat.ino };
	}
	function close() {
		if (closed) return;
		closed = true;
		let failed = false;
		for (const entry of [...owned].reverse()) {
			try {
				const now = directory(entry.path);
				if (now.dev !== entry.dev || now.ino !== entry.ino) throw invalid();
				rmSync(entry.path, { recursive: true, force: true });
			} catch {
				failed = true;
			}
		}
		if (failed) throw invalid();
	}
	const current = () => {
		if (closed) throw invalid();
		options.assertCurrent();
		for (const entry of pins) {
			const now = directory(entry.path);
			if (now.dev !== entry.dev || now.ino !== entry.ino) throw invalid();
		}
	};
	try {
		options.assertCurrent();
		pins.push(
			directory(options.projectRoot),
			directory(options.deploymentRoot),
		);
		const writableRoot = leadModelWritableRoot(options);
		if (writableRoot !== options.projectRoot) {
			try {
				mkdirSync(writableRoot, { mode: 0o700 });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
		}
		pins.push(directory(writableRoot));
		const workspaceRoot = mkdtempSync(join(writableRoot, ".lead-runtime-"));
		owned.push(directory(workspaceRoot));
		pins.push(directory(workspaceRoot));
		const controlRoot = mkdtempSync(join(realpathSync(tmpdir()), "flv2-"));
		owned.push(directory(controlRoot));
		pins.push(directory(controlRoot));
		if (
			controlRoot === writableRoot ||
			controlRoot.startsWith(`${writableRoot}/`)
		)
			throw invalid();
		const artifactRoot = join(workspaceRoot, "artifacts"),
			modelTempRoot = join(workspaceRoot, "tmp"),
			activationRoot = join(controlRoot, "a"),
			qaParentRoot = join(controlRoot, "qa");
		for (const path of [
			artifactRoot,
			modelTempRoot,
			activationRoot,
			qaParentRoot,
		]) {
			mkdirSync(path, { mode: 0o700 });
			pins.push(directory(path));
		}
		current();
		return Object.freeze({
			workspaceRoot,
			artifactRoot,
			modelTempRoot,
			activationRoot,
			qaParentRoot,
			assertCurrent: current,
			close,
		});
	} catch {
		try {
			close();
		} catch {}
		throw invalid();
	}
}
