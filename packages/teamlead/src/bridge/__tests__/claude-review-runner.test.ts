import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	buildClaudeReviewArgv,
	type ClaudeReviewSpawner,
	defaultClaudeReviewSpawner,
	parseClaudeReviewOutput,
	runClaudeReviewRound,
} from "../claude-review-runner.js";

// ── FLY-1188 §7.2 — Claude reviewer subprocess ──────────────────────────

describe("buildClaudeReviewArgv", () => {
	it("round 1 uses --session-id, rerounds use --resume; every round carries the prompt", () => {
		const fresh = buildClaudeReviewArgv({
			prompt: "review this",
			sessionId: "uuid-1",
			resume: false,
		});
		expect(fresh.slice(0, -2)).toEqual([
			"-p",
			"review this",
			"--session-id",
			"uuid-1",
			"--output-format",
			"json",
			"--model",
			"claude-opus-5",
			// FLY-1224 (T13 ②, Annie's directive): the cross-family Claude
			// reviewer defaults to Opus + effort xhigh.
			// FLY-1467: the default Opus reviewer binds to Opus 5.
			"--effort",
			"xhigh",
		]);
		expect(fresh.at(-2)).toBe("--settings");
		expect(JSON.parse(fresh.at(-1) as string).enabledPlugins).toMatchObject({
			"discord@flywheel-plugins": false,
			"discord@claude-plugins-official": false,
		});
		const reround = buildClaudeReviewArgv({
			prompt: "round 2 delta",
			sessionId: "uuid-1",
			resume: true,
			model: "fable",
		});
		expect(reround.slice(0, 4)).toEqual([
			"-p",
			"round 2 delta",
			"--resume",
			"uuid-1",
		]);
		expect(reround).toContain("claude-fable-5-1");
		expect(reround.filter((arg) => arg === "--settings")).toHaveLength(1);
	});

	it("rejects an unresolvable reviewer model before spawn", () => {
		expect(() =>
			buildClaudeReviewArgv({
				prompt: "p",
				sessionId: "u",
				resume: false,
				model: "claude-not-a-model",
			}),
		).toThrow(/unknown model/i);
	});

	// FLY-1650 (Codex R2 HIGH): this is a third launch path that appends
	// --effort independently of the model, and its default is the very tier
	// Opus 4.6 lacks. Naming 4.6 here is reachable today — it carries the
	// runner surface — so the default alone would emit an upstream 400.
	it("FLY-1650: drops the xhigh default for a model that does not support it", () => {
		const argv = buildClaudeReviewArgv({
			prompt: "p",
			sessionId: "u",
			resume: false,
			model: "opus-4-6",
		});
		expect(argv).toContain("claude-opus-4-6");
		expect(argv).not.toContain("--effort");
	});

	it("FLY-1650: keeps a supported effort for the same model", () => {
		const argv = buildClaudeReviewArgv({
			prompt: "p",
			sessionId: "u",
			resume: false,
			model: "opus-4-6",
			effort: "high",
		});
		expect(argv[argv.indexOf("--effort") + 1]).toBe("high");
	});

	it("FLY-1224: an explicit effort overrides the xhigh default", () => {
		const argv = buildClaudeReviewArgv({
			prompt: "p",
			sessionId: "u",
			resume: false,
			effort: "medium",
		});
		const idx = argv.indexOf("--effort");
		expect(idx).toBeGreaterThan(-1);
		expect(argv[idx + 1]).toBe("medium");
		expect(argv).not.toContain("xhigh");
	});
});

describe("parseClaudeReviewOutput", () => {
	const verdictJson = JSON.stringify({
		verdict: "APPROVED",
		findings: [],
		reviewedHeadSha: "A".repeat(40),
	});
	const successEnvelope = (result: string) =>
		JSON.stringify({
			type: "result",
			subtype: "success",
			is_error: false,
			api_error_status: null,
			result,
		});

	it("FLY-2291: bounds trailing repair to one missing outer brace", () => {
		const complete = parseClaudeReviewOutput(
			'{"verdict":"APPROVED","reviewedHeadSha":null,"findings":[]}',
		);
		expect(complete).toMatchObject({
			verdict: "APPROVED",
			repairedTrailingBrace: false,
		});

		const missingOuterBrace = parseClaudeReviewOutput(
			'{"verdict":"APPROVED","reviewedHeadSha":null,"findings":[]',
		);
		expect(missingOuterBrace).toMatchObject({
			verdict: "APPROVED",
			findings: [],
			repairedTrailingBrace: true,
		});

		const missingArrayAndOuterBrace = parseClaudeReviewOutput(
			'{"verdict":"APPROVED","findings":["complete"',
		);
		expect(missingArrayAndOuterBrace).toBeNull();

		const genuinelyTruncated = parseClaudeReviewOutput(
			'{"verdict":"APPROVED","findings":[{"title":"half',
		);
		expect(genuinelyTruncated).toBeNull();

		const fencedTruncated = parseClaudeReviewOutput(
			'```json\n{"verdict":"APPROVED","findings":[]\n```',
		);
		expect(fencedTruncated).toBeNull();

		for (const incomplete of [
			'{"verdict":"APPROVED","findings":[],"reviewedHeadSha":"abc"',
			'{"verdict":"APPROVED","findings":[],"score":1',
			'{"verdict":"APPROVED","findings":[],',
			'{"verdict":"APPROVED","findings":[]:',
		]) {
			expect(parseClaudeReviewOutput(incomplete), incomplete).toBeNull();
		}
	});

	it("FLY-2291: replays the FLY-2269 reviewer outputs through the real CLI envelope", () => {
		const expected = [
			[
				"fly2269-r1-reviewer-raw.txt",
				"CHANGES_REQUESTED",
				false,
				8,
				"9fe6949b460f0ca6a0a65e022f31293f237e7f3a4c825d3e472b7f6f6b1b6627",
			],
			[
				"fly2269-r2-reviewer-raw.txt",
				"CHANGES_REQUESTED",
				true,
				6,
				"86752ee3b7e8b813f4968f129dbedeb36a755879745c49330dca22a179098480",
			],
			[
				"fly2269-r3-reviewer-raw.txt",
				"CHANGES_REQUESTED",
				true,
				6,
				"9b53df8c18471ee835fdc0d3a183a3600ecc31a2e13a7b06d229e42c7ba5cd38",
			],
			[
				"fly2269-r4-reviewer-raw.txt",
				"CHANGES_REQUESTED",
				true,
				5,
				"4f4b4d178512d0ce5712560133befc365914b47862647d4029b0e717fce600d9",
			],
			[
				"fly2269-r5-reviewer-raw.txt",
				"APPROVED",
				true,
				2,
				"19ce779dd53cb6330116eeed049fe0b37834986db63f29bbab435dbb6c32f9bc",
			],
		] as const;

		for (const [
			fixture,
			verdict,
			repairedTrailingBrace,
			findings,
			hash,
		] of expected) {
			const assistantText = readFileSync(
				new URL(`./fixtures/${fixture}`, import.meta.url),
				"utf8",
			);
			expect(
				createHash("sha256").update(assistantText).digest("hex"),
				fixture,
			).toBe(hash);
			const parsed = parseClaudeReviewOutput(successEnvelope(assistantText));
			expect(parsed, fixture).toMatchObject({
				verdict,
				repairedTrailingBrace,
			});
			expect(parsed?.findings, fixture).toHaveLength(findings);
		}
	});

	it("unwraps the --output-format json envelope and lowercases the head sha", () => {
		const envelope = JSON.stringify({
			type: "result",
			subtype: "success",
			result: verdictJson,
		});
		const parsed = parseClaudeReviewOutput(envelope);
		expect(parsed?.verdict).toBe("APPROVED");
		expect(parsed?.reviewedHeadSha).toBe("a".repeat(40));
	});

	it("accepts a bare verdict object and a fenced one", () => {
		expect(parseClaudeReviewOutput(verdictJson)?.verdict).toBe("APPROVED");
		expect(
			parseClaudeReviewOutput(
				`Here is my review:\n\`\`\`json\n${verdictJson}\n\`\`\`\n`,
			)?.verdict,
		).toBe("APPROVED");
	});

	it("replays the FLY-1225 R2 no_verdict output and keeps R1 as a control", () => {
		const expectedSha = "5f4c1165055fe901c43965af2109ec0df5b05635";
		for (const fixture of [
			"fly1225-r1-review-output.txt",
			"fly1225-r2-review-output.txt",
		]) {
			const assistantText = readFileSync(
				new URL(`./fixtures/${fixture}`, import.meta.url),
				"utf8",
			);
			const parsed = parseClaudeReviewOutput(
				JSON.stringify({
					type: "result",
					subtype: "success",
					is_error: false,
					result: assistantText,
				}),
			);
			expect(parsed, fixture).toMatchObject({
				verdict: "APPROVED",
				findings: [],
				reviewedHeadSha: expectedSha,
			});
		}
	});

	it("takes the last valid verdict object despite prose braces and unrelated fences", () => {
		const early = JSON.stringify({ verdict: "APPROVED", findings: [] });
		const final = JSON.stringify({
			verdict: "CHANGES_REQUESTED",
			findings: [{ detail: "shape {p,m}" }],
		});
		const text =
			`The lone { character breaks the outer scan.\n` +
			`An early example is ${early}.\n` +
			"```ts\nconst unrelated = { nested: true };\n```\n" +
			`\`\`\`json\n${final}\n\`\`\``;
		const parsed = parseClaudeReviewOutput(text);
		expect(parsed?.verdict).toBe("CHANGES_REQUESTED");
		expect(parsed?.findings).toEqual([{ detail: "shape {p,m}" }]);
	});

	it("ignores an unrelated code fence before a non-fenced final verdict", () => {
		const final = JSON.stringify({
			verdict: "APPROVED",
			findings: [],
		});
		const text =
			"```ts\nconst unrelated = { nested: true };\n```\n" +
			`Final decision:\n${final}`;
		expect(parseClaudeReviewOutput(text)?.verdict).toBe("APPROVED");
	});

	it("keeps strict fail-close boundaries while accepting a top-level bare verdict", () => {
		const nestedVerdict = {
			payload: { verdict: "APPROVED", findings: [] },
		};
		expect(
			parseClaudeReviewOutput(
				JSON.stringify({
					type: "result",
					subtype: "error_max_turns",
					is_error: true,
					result: nestedVerdict,
				}),
			),
		).toBeNull();
		expect(
			parseClaudeReviewOutput(
				JSON.stringify({ result: nestedVerdict.payload }),
			),
		).toBeNull();
		expect(parseClaudeReviewOutput(JSON.stringify(nestedVerdict))).toBeNull();
		expect(
			parseClaudeReviewOutput(
				JSON.stringify({ verdict: "APPROVED", findings: [] }),
			)?.verdict,
		).toBe("APPROVED");
	});

	it("CHANGES_REQUESTED with stable-id and ruling-dispute findings round-trips", () => {
		const out = JSON.stringify({
			verdict: "changes_requested",
			findings: [
				{
					id: "auth-bug",
					disputesRuling: "settled-auth",
					severity: "HIGH",
					file: "a.ts",
					title: "bug",
				},
			],
			reviewedHeadSha: null,
		});
		const parsed = parseClaudeReviewOutput(out);
		expect(parsed?.verdict).toBe("CHANGES_REQUESTED");
		expect(parsed?.findings).toHaveLength(1);
		expect(parsed?.findings[0]).toMatchObject({
			id: "auth-bug",
			disputesRuling: "settled-auth",
		});
		expect(parsed?.reviewedHeadSha).toBeNull();
	});

	it("R12 HIGH: ERROR envelopes never yield a verdict, even with verdict-shaped text", () => {
		// is_error: true
		expect(
			parseClaudeReviewOutput(
				JSON.stringify({
					type: "result",
					subtype: "success",
					is_error: true,
					result: verdictJson,
				}),
			),
		).toBeNull();
		// non-success subtype (e.g. error_during_execution)
		expect(
			parseClaudeReviewOutput(
				JSON.stringify({
					type: "result",
					subtype: "error_during_execution",
					result: verdictJson,
				}),
			),
		).toBeNull();
	});

	it("refusal text / malformed JSON / unknown verdict → null (fail-close)", () => {
		expect(parseClaudeReviewOutput("I cannot review this.")).toBeNull();
		expect(parseClaudeReviewOutput('{"verdict": "MAYBE"}')).toBeNull();
		expect(parseClaudeReviewOutput('{"verdict": ')).toBeNull();
		expect(parseClaudeReviewOutput("")).toBeNull();
		// envelope whose result carries no verdict object
		expect(
			parseClaudeReviewOutput(
				JSON.stringify({ type: "result", result: "looks fine to me!" }),
			),
		).toBeNull();
	});
});

describe("runClaudeReviewRound (stubbed spawner)", () => {
	const base = {
		prompt: "p",
		sessionId: "s",
		resume: false,
		cwd: "/tmp",
	};

	function stub(result: {
		code: number | null;
		stdout: string;
		stderr?: string;
		timedOut?: boolean;
		overflowed?: boolean;
		spawnError?: string | null;
	}): ClaudeReviewSpawner {
		return async () => ({
			code: result.code,
			stdout: result.stdout,
			stderr: result.stderr ?? "",
			timedOut: result.timedOut ?? false,
			overflowed: result.overflowed ?? false,
			spawnError: result.spawnError ?? null,
		});
	}

	it("verdict path", async () => {
		const out = await runClaudeReviewRound(base, {
			spawner: stub({
				code: 0,
				stdout: JSON.stringify({ verdict: "APPROVED", findings: [] }),
			}),
			logger: () => {},
		});
		expect(out.kind).toBe("verdict");
		if (out.kind === "verdict") expect(out.verdict).toBe("APPROVED");
	});

	it("HIGH-5: washes the Bridge's third-party creds from the reviewer env, keeps Claude auth", async () => {
		let capturedEnv: NodeJS.ProcessEnv | undefined;
		const capture: ClaudeReviewSpawner = async (opts) => {
			capturedEnv = opts.env;
			return {
				code: 0,
				stdout: JSON.stringify({ verdict: "APPROVED", findings: [] }),
				timedOut: false,
				overflowed: false,
				spawnError: null,
			};
		};
		await runClaudeReviewRound(
			{
				...base,
				env: {
					DISCORD_BOT_TOKEN: "d",
					LINEAR_API_KEY: "l",
					ANTHROPIC_API_KEY: "a",
					CLAUDE_CONFIG_DIR: "/cfg",
					PATH: "/usr/bin",
				},
			},
			{ spawner: capture, logger: () => {} },
		);
		expect(capturedEnv?.DISCORD_BOT_TOKEN).toBeUndefined();
		expect(capturedEnv?.LINEAR_API_KEY).toBeUndefined();
		expect(capturedEnv?.ANTHROPIC_API_KEY).toBeUndefined();
		expect(capturedEnv?.CLAUDE_CONFIG_DIR).toBe("/cfg"); // Claude auth survives
		expect(capturedEnv?.PATH).toBe("/usr/bin");
	});

	it("timeout → failed/timeout (never a verdict)", async () => {
		const out = await runClaudeReviewRound(base, {
			spawner: stub({
				code: null,
				stdout: "",
				stderr: "timeout diagnostic",
				timedOut: true,
			}),
			logger: () => {},
		});
		expect(out).toMatchObject({
			kind: "failed",
			reason: "timeout",
			timedOut: true,
			stderrTail: "timeout diagnostic",
		});
	});

	it("spawn error → failed/spawn_error", async () => {
		const out = await runClaudeReviewRound(base, {
			spawner: stub({
				code: 127,
				stdout: "",
				stderr: "spawn diagnostic",
				spawnError: "ENOENT",
			}),
			logger: () => {},
		});
		expect(out).toMatchObject({
			kind: "failed",
			reason: "spawn_error",
			stderrTail: "spawn diagnostic",
		});
	});

	it("nonzero exit keeps the stdout and stderr tails", async () => {
		const stdout = `discard-me-${"x".repeat(5000)}-stdout-tail`;
		const out = await runClaudeReviewRound(base, {
			spawner: stub({
				code: 1,
				stdout,
				stderr: `${"y".repeat(2500)}-stderr-tail`,
			}),
			logger: () => {},
		});
		expect(out).toMatchObject({
			kind: "failed",
			reason: "nonzero_exit",
		});
		if (out.kind === "failed") {
			expect(out.raw).not.toContain("discard-me");
			expect(out.raw).toHaveLength(4000);
			expect(out.raw).toContain("stdout-tail");
			expect(out.stderrTail).toHaveLength(2000);
			expect(out.stderrTail).toContain("stderr-tail");
		}
	});

	it("clean exit without a parseable verdict → failed/no_verdict (fail-close)", async () => {
		const out = await runClaudeReviewRound(base, {
			spawner: stub({
				code: 0,
				stdout: `${"x".repeat(5000)}-final-verdict-was-here`,
				stderr: "parse diagnostic",
			}),
			logger: () => {},
		});
		expect(out).toMatchObject({
			kind: "failed",
			reason: "no_verdict",
			stderrTail: "parse diagnostic",
		});
		if (out.kind === "failed") {
			expect(out.raw).toHaveLength(4000);
			expect(out.raw).toContain("final-verdict-was-here");
		}
	});

	it("stdout overflow → failed/stdout_overflow", async () => {
		const out = await runClaudeReviewRound(base, {
			spawner: stub({
				code: null,
				stdout: "x",
				stderr: "overflow diagnostic",
				overflowed: true,
			}),
			logger: () => {},
		});
		expect(out).toMatchObject({
			kind: "failed",
			reason: "stdout_overflow",
			stderrTail: "overflow diagnostic",
		});
	});
});

describe("defaultClaudeReviewSpawner (real subprocess)", () => {
	const dir = mkdtempSync(join(tmpdir(), "fly1188-review-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("closes stdin (a stdin-reading child exits instead of hanging) and captures stdout", async () => {
		// `cat` exits only when stdin is closed — proves the -p hang guard.
		const res = await defaultClaudeReviewSpawner({
			binary: "/bin/sh",
			argv: ["-c", "cat; echo done"],
			cwd: dir,
			env: process.env,
			timeoutMs: 10_000,
			maxStdoutBytes: 1024,
		});
		expect(res.timedOut).toBe(false);
		expect(res.code).toBe(0);
		expect(res.stdout).toContain("done");
	});

	it("captures bounded stderr continuously and retains its tail", async () => {
		const res = await defaultClaudeReviewSpawner({
			binary: process.execPath,
			argv: [
				"-e",
				'process.stderr.write("discard-me-" + "x".repeat(20_000) + "-stderr-tail")',
			],
			cwd: dir,
			env: process.env,
			timeoutMs: 10_000,
			maxStdoutBytes: 1024,
		});
		expect(res.code).toBe(0);
		expect(res.stderr).not.toContain("discard-me");
		expect(Buffer.byteLength(res.stderr)).toBeLessThanOrEqual(16 * 1024);
		expect(res.stderr).toContain("stderr-tail");
	});

	it("timeout kills the WHOLE process tree (detached group)", async () => {
		const res = await defaultClaudeReviewSpawner({
			binary: "/bin/sh",
			argv: ["-c", "(sleep 60 &); sleep 60"],
			cwd: dir,
			env: process.env,
			timeoutMs: 500,
			maxStdoutBytes: 1024,
		});
		expect(res.timedOut).toBe(true);
	});

	it("missing binary → spawnError, no throw", async () => {
		const res = await defaultClaudeReviewSpawner({
			binary: join(dir, "definitely-not-a-binary"),
			argv: [],
			cwd: dir,
			env: process.env,
			timeoutMs: 5_000,
			maxStdoutBytes: 1024,
		});
		expect(res.spawnError).not.toBeNull();
		expect(res.code).toBe(127);
	});
});

describe("R13 HIGH-4 — envelope must match the REAL success schema", () => {
	const verdict = JSON.stringify({ verdict: "APPROVED", findings: [] });
	it("type:error / api_error_status / missing subtype envelopes → null", () => {
		expect(
			parseClaudeReviewOutput(
				JSON.stringify({ type: "error", subtype: "success", result: verdict }),
			),
		).toBeNull();
		expect(
			parseClaudeReviewOutput(
				JSON.stringify({
					type: "result",
					subtype: "success",
					api_error_status: 500,
					result: verdict,
				}),
			),
		).toBeNull();
		expect(
			parseClaudeReviewOutput(
				JSON.stringify({ type: "result", result: verdict }), // no subtype
			),
		).toBeNull();
	});
	it("R14: api_error_status null (classifier-runner precedent) is NOT an error", () => {
		expect(
			parseClaudeReviewOutput(
				JSON.stringify({
					type: "result",
					subtype: "success",
					api_error_status: null,
					result: verdict,
				}),
			)?.verdict,
		).toBe("APPROVED");
	});

	it("exact success envelope still parses; bare verdict unaffected", () => {
		expect(
			parseClaudeReviewOutput(
				JSON.stringify({ type: "result", subtype: "success", result: verdict }),
			)?.verdict,
		).toBe("APPROVED");
		expect(parseClaudeReviewOutput(verdict)?.verdict).toBe("APPROVED");
	});
});
