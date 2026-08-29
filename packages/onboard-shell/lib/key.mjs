// FLY-1062 PR2 · license key handling — the secret red line lives here.
//
// A key NEVER reaches argv/history/journal/logs. Acquisition order:
//   1. an already-stored 0600 ~/.flywheel/.env value (reuse);
//   2. a hidden TTY read (echo off);
//   3. env injection FLYWHEEL_LICENSE_KEY — ONLY when the explicit double
//      switch FLYWHEEL_ALLOW_LICENSE_KEY_ENV=1 is set (tests/CI; never
//      documented to customers — Codex R4#2).
// After the key is known it is stripped from the env so no child process
// (npm, the exec'd onboard.sh, …) can read it.
import fs from "node:fs";
import path from "node:path";

const KEY_VAR = "FLYWHEEL_LICENSE_KEY";
const ENV_ALLOW = "FLYWHEEL_ALLOW_LICENSE_KEY_ENV";

// parseEnvFile <text> → Map of KEY=value (bare or `export KEY=value`).
export function parseEnvFile(text) {
	const out = new Map();
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
		if (!m) continue;
		let val = m[2];
		if (
			(val.startsWith('"') && val.endsWith('"')) ||
			(val.startsWith("'") && val.endsWith("'"))
		) {
			val = val.slice(1, -1);
		}
		out.set(m[1], val);
	}
	return out;
}

// storedKey <envFile> → the key persisted in .env, or null.
export function storedKey(envFile) {
	try {
		return parseEnvFile(fs.readFileSync(envFile, "utf8")).get(KEY_VAR) || null;
	} catch {
		return null;
	}
}

// keyFromEnv <env> → the env-injected key IFF the double switch is on; else
// returns {key:null, rejected:bool} — rejected=true means a key was present
// but the switch was off (surface MSG.keyRejectedEnv, do not use it).
export function keyFromEnv(env = process.env) {
	const present = typeof env[KEY_VAR] === "string" && env[KEY_VAR].length > 0;
	if (!present) return { key: null, rejected: false };
	if (env[ENV_ALLOW] === "1") return { key: env[KEY_VAR], rejected: false };
	return { key: null, rejected: true };
}

// hiddenPrompt <promptText> → Promise<string>. Reads one line from the TTY
// with echo OFF (the key never appears on screen or in scrollback). Falls
// back to a plain read only when stdin is not a TTY (still never echoes our
// own text of the key).
export function hiddenPrompt(
	promptText,
	{ input = process.stdin, output = process.stdout } = {},
) {
	return new Promise((resolve, reject) => {
		output.write(promptText);
		const isTTY = input.isTTY;
		let buf = "";
		const onData = (chunk) => {
			const s = chunk.toString("utf8");
			for (const ch of s) {
				if (ch === "\n" || ch === "\r") {
					cleanup();
					output.write("\n");
					resolve(buf);
					return;
				}
				if (ch === "") {
					cleanup();
					reject(new Error("interrupted"));
					return;
				}
				if (ch === "" || ch === "\b") {
					buf = buf.slice(0, -1);
					continue;
				}
				buf += ch;
			}
		};
		// EOF (non-TTY input, e.g. a piped/empty stdin) → resolve whatever was
		// read (empty ⇒ the caller treats it as "no key" and refuses to install).
		// Without this the read hangs and the process silently exits 0.
		const onEnd = () => {
			cleanup();
			output.write("\n");
			resolve(buf);
		};
		const cleanup = () => {
			input.removeListener("data", onData);
			input.removeListener("end", onEnd);
			if (isTTY && input.setRawMode) input.setRawMode(false);
			input.pause();
		};
		if (isTTY && input.setRawMode) input.setRawMode(true);
		input.resume();
		input.on("data", onData);
		input.on("end", onEnd);
	});
}

// persistKey <envFile> <key> — atomically upsert the key into a 0600 .env,
// preserving other lines. tmp-write + rename; refuses a symlink target.
export function persistKey(envFile, key) {
	const dir = path.dirname(envFile);
	fs.mkdirSync(dir, { recursive: true });
	let lines = [];
	try {
		const st = fs.lstatSync(envFile);
		if (st.isSymbolicLink())
			throw new Error(`refusing symlink env file: ${envFile}`);
		lines = fs.readFileSync(envFile, "utf8").split("\n");
	} catch (e) {
		if (e.code !== "ENOENT" && !/refusing symlink/.test(e.message)) throw e;
		if (/refusing symlink/.test(e.message)) throw e;
	}
	const re = new RegExp(`^(?:export\\s+)?${KEY_VAR}=`);
	const kept = lines.filter((l) => l.trim() && !re.test(l.trim()));
	kept.push(`${KEY_VAR}=${key}`);
	const tmp = `${envFile}.tmp.${process.pid}`;
	fs.writeFileSync(tmp, `${kept.join("\n")}\n`, { mode: 0o600 });
	fs.chmodSync(tmp, 0o600);
	fs.renameSync(tmp, envFile);
	fs.chmodSync(envFile, 0o600);
}

// stripKeyFromEnv <env> — remove the key + the allow switch so no child
// process inherits them (Codex R4#2). Mutates and returns the same object.
export function stripKeyFromEnv(env = process.env) {
	delete env[KEY_VAR];
	delete env[ENV_ALLOW];
	return env;
}

export const KEY_ENV_VAR = KEY_VAR;
export const KEY_ENV_ALLOW = ENV_ALLOW;
