import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

function inspect(path) {
	let stat;
	try {
		stat = lstatSync(path);
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
	if (!stat.isFile() || stat.isSymbolicLink())
		throw new Error("room info must be regular file");
	const bytes = readFileSync(path),
		after = lstatSync(path);
	if (
		stat.ino !== after.ino ||
		stat.mtimeMs !== after.mtimeMs ||
		stat.size !== after.size
	)
		throw new Error("room info changed during read");
	return {
		sha256: createHash("sha256").update(bytes).digest("hex"),
		mode: stat.mode & 0o777,
		inode: stat.ino,
		mtimeMs: stat.mtimeMs,
	};
}
export function roomInfoCheck({ slotDir, phase, identity }) {
	try {
		if (
			!isAbsolute(slotDir) ||
			![
				"hide-precheck",
				"hide-postcheck",
				"restore-precheck",
				"restore-postcheck",
			].includes(phase)
		)
			throw new Error("invalid room-info request");
		const original = inspect(join(slotDir, "room-info.json")),
			hidden = inspect(join(slotDir, "room-info.json.drill-hidden"));
		const expectsOriginal = ["hide-precheck", "restore-postcheck"].includes(
			phase,
		);
		const current = expectsOriginal ? original : hidden;
		if (!current || (expectsOriginal ? hidden : original))
			throw new Error("room-info names conflict or missing");
		if (phase !== "hide-precheck" && !isDeepStrictEqual(current, identity))
			throw new Error("room-info identity mismatch");
		return { status: "pass", phase, identity: current };
	} catch (error) {
		return { status: "fail", reason: error.message };
	}
}
