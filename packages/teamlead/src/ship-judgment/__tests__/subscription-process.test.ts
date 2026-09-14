import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSubscriptionProcess } from "../subscription-process.js";

describe("bounded subscription process", () => {
	it("sends private input on stdin, isolates cwd/environment, and returns only after exit", async () => {
		const root = mkdtempSync(join(tmpdir(), "judgment-cli-"));
		const bin = join(root, "fake-claude");
		try {
			writeFileSync(
				bin,
				`#!${process.execPath}\nlet input=''; process.stdin.on('data',x=>input+=x); process.stdin.on('end',()=>console.log(JSON.stringify({input,args:process.argv.slice(2),files:require('fs').readdirSync(process.cwd()),user:process.env.USER,login:process.env.LOGNAME,secret:process.env.BRIDGE_TOKEN,api:process.env.ANTHROPIC_API_KEY})));`,
				{ mode: 0o700 },
			);
			const result = await runSubscriptionProcess({
				bin,
				input: "private source",
				model: "fixture",
				effort: "high",
				systemPrompt: "fixed",
				env: {
					...process.env,
					CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth",
					USER: "fixture-user",
					LOGNAME: "fixture-login",
					BRIDGE_TOKEN: "private",
					ANTHROPIC_API_KEY: "paid",
				},
			});
			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error(result.reason);
			const output = JSON.parse(result.stdout);
			expect(output.input).toBe("private source");
			expect(output.args).not.toContain("private source");
			expect(output.args).toContain("--safe-mode");
			expect(output.files).toEqual([]);
			expect(output.user).toBe("fixture-user");
			expect(output.login).toBe("fixture-login");
			expect(output.args[output.args.indexOf("--setting-sources") + 1]).toBe(
				"user",
			);
			expect(output.secret).toBeUndefined();
			expect(output.api).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("kills a TERM-resistant process after abort, rejects overflow, and never retries missing executables", async () => {
		const root = mkdtempSync(join(tmpdir(), "judgment-cli-"));
		const bin = join(root, "fake-claude");
		const ready = join(root, "ready");
		const controller = new AbortController();
		try {
			writeFileSync(
				bin,
				`#!${process.execPath}\nprocess.on('SIGTERM',()=>{}); require('fs').writeFileSync(${JSON.stringify(ready)},String(process.pid)); setInterval(()=>{},100);`,
				{ mode: 0o700 },
			);
			const pending = runSubscriptionProcess({
				env: {
					PATH: process.env.PATH,
					CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth",
				},
				bin,
				input: "",
				model: "fixture",
				effort: "high",
				systemPrompt: "fixed",
				signal: controller.signal,
				timeoutMs: 4000,
				killGraceMs: 30,
			});
			const started = Date.now();
			while (!existsSync(ready) && Date.now() - started < 3000)
				await new Promise((resolve) => setTimeout(resolve, 10));
			controller.abort();
			const result = await pending;
			expect(existsSync(ready)).toBe(true);
			const pid = Number(readFileSync(ready, "utf8"));
			expect(() => process.kill(pid, 0)).toThrow();
			expect(result).toMatchObject({
				ok: false,
				reason: "model_aborted",
				spawned: true,
			});
			writeFileSync(
				bin,
				`#!${process.execPath}\nprocess.stdout.write('x'.repeat(65537));`,
				{ mode: 0o700 },
			);
			expect(
				await runSubscriptionProcess({
					env: {
						PATH: process.env.PATH,
						CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth",
					},
					bin,
					input: "",
					model: "fixture",
					effort: "high",
					systemPrompt: "fixed",
				}),
			).toMatchObject({ ok: false, reason: "output_budget_exceeded" });
			expect(
				await runSubscriptionProcess({
					env: {
						PATH: process.env.PATH,
						CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth",
					},
					bin: join(root, "absent"),
					input: "",
					model: "fixture",
					effort: "high",
					systemPrompt: "fixed",
				}),
			).toMatchObject({ ok: false, reason: "spawn_failed", spawned: false });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

it("A/B user language, thinking, env and global instructions cannot change the isolated child configuration", async () => {
	const { mkdirSync } = await import("node:fs");
	const root = mkdtempSync(join(tmpdir(), "judgment-config-ab-"));
	const config = join(root, "user-config"),
		bin = join(root, "fake-claude");
	mkdirSync(config);
	writeFileSync(
		join(config, ".credentials.json"),
		JSON.stringify({
			claudeAiOauth: {
				accessToken: "fixture-oauth",
				refreshToken: "fixture-refresh",
				expiresAt: 9999999999999,
				scopes: ["user:inference"],
			},
		}),
		{ mode: 0o600 },
	);
	writeFileSync(join(config, "CLAUDE.md"), "ALWAYS SAY POLLUTED");
	writeFileSync(
		bin,
		`#!${process.execPath}\nconst fs=require('fs'),p=require('path');let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{const a=process.argv.slice(2);const dir=process.env.CLAUDE_CONFIG_DIR;const f=p.join(dir,'settings.json');const user=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{};const fixed=JSON.parse(a[a.indexOf('--settings')+1]);console.log(JSON.stringify({language:fixed.language??user.language,thinking:fixed.alwaysThinkingEnabled??user.alwaysThinkingEnabled,effort:fixed.effortLevel??user.effortLevel,settingsEnv:fixed.env??user.env,dirFiles:fs.readdirSync(dir),cwd:process.cwd(),home:process.env.HOME,dir,instruction:fs.existsSync(p.join(dir,'CLAUDE.md')),leaked:process.env.POLLUTED}));});`,
		{ mode: 0o700 },
	);
	try {
		const outputs = [];
		for (const language of ["english", "chinese"]) {
			writeFileSync(
				join(config, "settings.json"),
				JSON.stringify({
					language,
					alwaysThinkingEnabled: false,
					effortLevel: "low",
					env: { MAX_THINKING_TOKENS: "1", POLLUTED: language },
				}),
			);
			const result = await runSubscriptionProcess({
				bin,
				input: "frozen",
				model: "fixture",
				effort: "high",
				systemPrompt: "fixed",
				env: {
					PATH: process.env.PATH,
					HOME: root,
					USER: "fixture",
					LOGNAME: "fixture",
					CLAUDE_CONFIG_DIR: config,
					POLLUTED: language,
				},
			});
			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error(result.reason);
			const output = JSON.parse(result.stdout);
			outputs.push(output);
		}
		expect(outputs.map(({ cwd, home, dir, ...value }) => value)[0]).toEqual(
			outputs.map(({ cwd, home, dir, ...value }) => value)[1],
		);
		for (const output of outputs) {
			expect(output.language).toBe("english");
			expect(output.thinking).toBe(true);
			expect(output.effort).toBe("high");
			expect(output.settingsEnv.MAX_THINKING_TOKENS).not.toBe("1");
			expect(output.dirFiles).toEqual([".credentials.json"]);
			expect(output.instruction).toBe(false);
			expect(output.leaked).toBeUndefined();
			expect(output.home).not.toBe(root);
			expect(output.dir).not.toBe(config);
			expect(existsSync(output.dir)).toBe(false);
			expect(existsSync(output.cwd)).toBe(false);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
