import {
	chmodSync,
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";

const [mode, root, source, signal, targetKind, rawTarget, execId, reason] =
	process.argv.slice(2);
if (!root || !source || !signal || !targetKind || !rawTarget || !reason) {
	throw new Error("kill ledger append arguments are incomplete");
}
if (!new Set(["pid", "pgid", "tmux-window"]).has(targetKind)) {
	throw new Error(`invalid target kind: ${targetKind}`);
}
const target =
	targetKind === "tmux-window" ? rawTarget : Number.parseInt(rawTarget, 10);
if (
	(targetKind === "tmux-window" && !rawTarget) ||
	(targetKind !== "tmux-window" &&
		(!Number.isSafeInteger(target) || target <= 1))
) {
	throw new Error(`invalid ${targetKind} target: ${rawTarget}`);
}
const ts = process.env.FLYWHEEL_KILL_LEDGER_NOW ?? new Date().toISOString();
const entry = {
	ts,
	source,
	signal,
	targetKind,
	target,
	...(execId ? { execId } : {}),
	reason,
	schemaVersion: 1,
};
const line = `${JSON.stringify(entry)}\n`;
if (mode === "--stdout") {
	process.stdout.write(line);
	process.exit(0);
}
if (mode !== "--append") throw new Error(`invalid append mode: ${mode}`);

mkdirSync(root, { recursive: true, mode: 0o700 });
chmodSync(root, 0o700);
const day = ts.slice(0, 10).replaceAll("-", "");
const fd = openSync(join(root, `${day}.ndjson`), "a", 0o600);
try {
	writeSync(fd, line, undefined, "utf8");
	fsyncSync(fd);
} finally {
	closeSync(fd);
}
