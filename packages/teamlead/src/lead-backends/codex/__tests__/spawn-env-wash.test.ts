/**
 * FLY-245 Phase E — REAL-PROCESS proof that `spawnCodexAppServer` washes action
 * secrets out of the app-server's environment (plan §6 item 1, Codex R1#3).
 * A stub "codex" script dumps its env; the test asserts no TOKEN / SECRET /
 * KEY key survives — for read-only companions too (the wash is unconditional,
 * which is why the FLY-224 reverse-compat sentinel is now "behavior-equivalent
 * plus one env-washing layer" rather than byte-identical, plan §7.1).
 */
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { spawnCodexAppServer } from "../codex-lead-runtime.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fly245-spawn-wash-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

it("spawned app-server env carries NO action secrets but keeps CODEX_HOME + plain vars", async () => {
	const envDump = join(dir, "env.json");
	const stub = join(dir, "codex-stub.sh");
	writeFileSync(
		stub,
		`#!/bin/sh\nnode -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.env))' "${envDump}"\n`,
	);
	chmodSync(stub, 0o755);

	const transport = spawnCodexAppServer({
		codexBin: stub,
		mcpArgv: [],
		codexHome: join(dir, "codex-home"),
		baseEnv: {
			PATH: process.env.PATH,
			DISCORD_BOT_TOKEN: "leak-me-not",
			FLYWHEEL_API_TOKEN: "leak-me-not-2",
			OPENAI_API_KEY: "leak-me-not-3",
			SOME_SECRET: "leak-me-not-4",
			FLYWHEEL_LEAD_ID: "product-lead",
		},
	});
	await new Promise<void>((res, rej) => {
		const t = setTimeout(() => rej(new Error("stub did not exit")), 5000);
		transport.onExit(() => {
			clearTimeout(t);
			res();
		});
	});

	const childEnv = JSON.parse(readFileSync(envDump, "utf8")) as Record<
		string,
		string
	>;
	const leaked = Object.keys(childEnv).filter((k) =>
		/TOKEN|SECRET|KEY/i.test(k),
	);
	expect(leaked).toEqual([]);
	expect(childEnv.CODEX_HOME).toBe(join(dir, "codex-home"));
	expect(childEnv.FLYWHEEL_LEAD_ID).toBe("product-lead");
	// and no secret VALUE survived under any name
	const values = Object.values(childEnv).join("\n");
	expect(values).not.toContain("leak-me-not");
});
