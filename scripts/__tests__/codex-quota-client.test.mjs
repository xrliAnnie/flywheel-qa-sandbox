import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyQuotaTail, runReview } from "../lib/codex-quota-client.mjs";

const quota = '{"type":"error","error":{"code":"usageLimitExceeded"}}';
test("only confirmed bounded quota errors are recognized", () => {
	assert.equal(classifyQuotaTail(quota), "usageLimitExceeded");
	for (const text of [
		"429 Too Many Requests",
		'{"type":"error","code":"rateLimitExceeded"}',
		`prefix ${quota}`,
		`${quota} injected`,
		'{"type":"item.completed","text":"usageLimitExceeded"}',
		"x".repeat(4096) + quota,
	])
		assert.equal(classifyQuotaTail(text), undefined);
	assert.equal(
		classifyQuotaTail("You've hit your usage limit. Try again later."),
		"usageLimited",
	);
});
function harness({
	wait = 0,
	results = [
		{ code: 1, tail: quota },
		{ code: 0, tail: "ok" },
	],
	failed = false,
} = {}) {
	let now = 0,
		waited = 0,
		binds = 0;
	const calls = [],
		spool = [];
	return {
		calls,
		spool,
		deps: {
			now: () => now,
			sleep: async (ms) => {
				now += ms;
				waited += ms;
			},
			bind: async () => ({
				binding: { bindingId: `b-${++binds}`, generation: binds },
				state: binds === 1 && wait ? "paused" : "ready",
				generation: binds,
			}),
			status: async () => ({
				state: failed ? "probe_failed" : waited < wait ? "paused" : "ready",
				generation: 2,
			}),
			observe: async (signal) => {
				assert.deepEqual(spool.at(-1), signal);
				calls.push("observe");
			},
			spool: async (signal) => {
				spool.push(signal);
			},
			ack: async () => {},
			execute: async (budget) => {
				calls.push(budget);
				const result = results.shift();
				now += result?.elapsed ?? 0;
				return result;
			},
			abandon: async () => {},
		},
	};
}
test("1500 seconds waiting preserves full 1800 execution budget", async () => {
	const h = harness({
		wait: 1500000,
		results: [{ code: 0, tail: "ok", elapsed: 1200000 }],
	});
	assert.equal(await runReview(h.deps), 0);
	assert.deepEqual(h.calls, [1800]);
});
test("wait expiry is 75 and spawns zero", async () => {
	const h = harness({ wait: 1801000 });
	assert.equal(await runReview(h.deps), 75);
	assert.deepEqual(h.calls, []);
});
test("quota observed only after durable spool then retries once with fresh full budget", async () => {
	const h = harness();
	assert.equal(await runReview(h.deps), 0);
	assert.deepEqual(h.calls, [1800, "observe", 1800]);
	assert.equal(h.spool.length, 1);
});
test("second quota gets no third budget", async () => {
	const h = harness({
		results: [
			{ code: 1, tail: quota },
			{ code: 1, tail: quota },
		],
	});
	assert.equal(await runReview(h.deps), 75);
	assert.deepEqual(h.calls, [1800, "observe", 1800, "observe"]);
});
test("probe failure never retries and real execution timeout stays 124", async () => {
	const h = harness({ failed: true });
	assert.equal(await runReview(h.deps), 75);
	assert.deepEqual(h.calls, [1800, "observe"]);
	const timed = harness({ results: [{ code: 124, tail: "timeout" }] });
	assert.equal(await runReview(timed.deps), 124);
	assert.deepEqual(timed.calls, [1800]);
});

test("installed flattened wrapper reports digest-only quota and helper-only updates publish a new release", async () => {
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const cp = await import("node:child_process");
	const http = await import("node:http");
	const { fileURLToPath, pathToFileURL } = await import("node:url");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "fly2465-quota-release-")),
		repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
		source = path.join(root, "source"),
		home = path.join(root, "home");
	const files = [
		"scripts/install-codex-guard.sh",
		"scripts/codex-with-fallback.sh",
		"scripts/lib/codex-guard.sh",
		"scripts/lib/codex-quota-client.mjs",
		"scripts/lib/kill-ledger.sh",
		"scripts/lib/kill-ledger-append.mjs",
		"packages/claude-runner/bin/flywheel-codex-profile.mjs",
		"packages/claude-runner/bin/codex-account-core.mjs",
		"packages/claude-runner/bin/codex-account-core.d.mts",
		"packages/claude-runner/bin/codex-account-install.mjs",
		"packages/claude-runner/bin/codex-account-install.d.mts",
		"packages/claude-runner/agents/codex-account-registry.json",
	];
	for (const file of files) {
		const dest = path.join(source, file);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.copyFileSync(path.join(repo, file), dest);
	}
	fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
	fs.writeFileSync(path.join(home, ".codex", "auth.json"), "auth-canary-one", {
		mode: 0o600,
	});
	const env = {
		HOME: home,
		PATH: process.env.PATH,
		FLYWHEEL_NODE_BIN: process.execPath,
	};
	const install = () =>
		cp.execFileSync(
			"/bin/bash",
			[path.join(source, "scripts/install-codex-guard.sh")],
			{ env, stdio: "pipe" },
		);
	let server;
	try {
		install();
		const current = path.join(home, ".flywheel/libexec/codex-guard/current");
		const first = fs.realpathSync(current);
		assert.ok(fs.existsSync(path.join(current, "codex-quota-client.mjs")));
		assert.ok(fs.existsSync(path.join(current, "codex-account-install.mjs")));
		fs.appendFileSync(
			path.join(source, "scripts/lib/codex-quota-client.mjs"),
			"\nexport const fixtureVersion=2;\n",
		);
		install();
		assert.notEqual(fs.realpathSync(current), first);
		assert.equal(
			(
				await import(
					pathToFileURL(path.join(current, "codex-quota-client.mjs")).href
				)
			).fixtureVersion,
			2,
		);
		const requests = [];
		let binds = 0;
		let rejectObserve = false;
		let driftOnBind = false;
		server = http.createServer(async (req, res) => {
			let body = "";
			for await (const chunk of req) body += chunk;
			requests.push({
				url: req.url,
				body,
				authorization: req.headers.authorization,
			});
			res.setHeader("Content-Type", "application/json");
			if (req.url === "/api/codex/quota/bind") {
				const parsed = JSON.parse(body);
				assert.match(parsed.authDigest, /^[a-f0-9]{64}$/);
				assert.equal(parsed.model, "gpt-6-astra");
				if (driftOnBind)
					fs.writeFileSync(
						path.join(home, ".codex", "auth.json"),
						"drift-canary",
						{ mode: 0o600 },
					);
				const generation = ++binds;
				res.end(
					JSON.stringify({
						state: "ready",
						generation,
						binding: {
							bindingId: `binding-${generation}`,
							executionId: "exec-fixture",
							purpose: "review",
							generation,
						},
					}),
				);
			} else if (req.url === "/api/codex/quota/observe") {
				if (rejectObserve) {
					rejectObserve = false;
					res.statusCode = 503;
					res.end("{}");
					return;
				}
				fs.writeFileSync(
					path.join(home, ".codex", "auth.json"),
					"auth-canary-two",
					{ mode: 0o600 },
				);
				res.end('{"accepted":true}');
			} else res.end('{"state":"ready","generation":2}');
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin);
		fs.writeFileSync(
			path.join(bin, "codex"),
			`#!/bin/bash\nif [[ ! -f "$HOME/first" ]]; then touch "$HOME/first"; printf '%s\\n' '${quota}'; exit 1; fi\nprintf 'ok\\n'\n`,
			{ mode: 0o755 },
		);
		const run = () =>
			new Promise((resolve, reject) => {
				const child = cp.spawn(
					"/bin/bash",
					[
						path.join(current, "codex-with-fallback.sh"),
						"exec",
						"--json",
						"-m",
						"gpt-6-astra",
						"-",
					],
					{
						env: {
							...env,
							PATH: `${bin}:${env.PATH}`,
							FLYWHEEL_EXEC_ID: "exec-fixture",
							FLYWHEEL_PROJECT_NAME: "fixture",
							FLYWHEEL_BRIDGE_URL: `http://127.0.0.1:${server.address().port}`,
							FLYWHEEL_INGEST_TOKEN: "ingest-fixture",
							FLYWHEEL_CODEX_GUARD_STATE_DIR: path.join(root, "guard"),
						},
						stdio: ["ignore", "pipe", "pipe"],
					},
				);
				let text = "";
				child.stdout.on("data", (c) => {
					text += c;
				});
				child.stderr.on("data", (c) => {
					text += c;
				});
				child.on("error", reject);
				child.on("exit", (code) => resolve({ code, text }));
			});
		const output = await run();
		assert.equal(output.code, 0, output.text);
		assert.equal(binds, 2);
		assert.equal(requests.filter((r) => r.url.endsWith("/observe")).length, 1);
		assert.ok(!JSON.stringify(requests).includes("auth-canary"));
		assert.ok(
			requests.every((r) => r.authorization === "Bearer ingest-fixture"),
		);

		fs.unlinkSync(path.join(home, "first"));
		rejectObserve = true;
		const failedReport = await run();
		assert.equal(failedReport.code, 75);
		const spoolDir = path.join(home, ".flywheel/codex-quota/spool");
		assert.equal(
			fs.readdirSync(spoolDir).filter((n) => n.endsWith(".json")).length,
			1,
		);
		rejectObserve = true;
		const bindingsBeforeReplay = binds;
		const unavailableReplay = await run();
		assert.equal(unavailableReplay.code, 0, unavailableReplay.text);
		assert.match(
			unavailableReplay.text,
			/CODEX_QUOTA_API_UNAVAILABLE_LOCAL_FALLBACK/,
		);
		assert.equal(binds, bindingsBeforeReplay);
		assert.equal(
			fs.readdirSync(spoolDir).filter((n) => n.endsWith(".json")).length,
			1,
		);
		requests.length = 0;
		const replay = await run();
		assert.equal(replay.code, 0, replay.text);
		assert.equal(requests[0].url, "/api/codex/quota/observe");
		assert.equal(
			fs.readdirSync(spoolDir).filter((n) => n.endsWith(".json")).length,
			0,
		);

		driftOnBind = true;
		fs.unlinkSync(path.join(home, "first"));
		const drift = await run();
		assert.equal(drift.code, 75);
		assert.equal(fs.existsSync(path.join(home, "first")), false);
		const prior = fs.realpathSync(current);
		fs.unlinkSync(path.join(source, "scripts/lib/codex-quota-client.mjs"));
		assert.throws(install);
		assert.equal(fs.realpathSync(current), prior);
	} finally {
		await new Promise((resolve) =>
			server ? server.close(resolve) : resolve(),
		);
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("only an aged wait uses WAIT_EXPIRED; probe and retry failures stay distinct", async () => {
	for (const [opts, marker] of [
		[{ wait: 1801000 }, "CODEX_QUOTA_WAIT_EXPIRED"],
		[{ failed: true }, "CODEX_QUOTA_PROBE_FAILED"],
		[
			{
				results: [
					{ code: 1, tail: quota },
					{ code: 1, tail: quota },
				],
			},
			"CODEX_QUOTA_RETRY_EXHAUSTED",
		],
	]) {
		const h = harness(opts),
			seen = [];
		h.deps.marker = (value) => seen.push(value);
		assert.equal(await runReview(h.deps), 75);
		assert.deepEqual(seen, [marker]);
	}
});

test("Codex JSON error with the confirmed usage-cap message is classified", () => {
	assert.equal(
		classifyQuotaTail(
			JSON.stringify({
				type: "error",
				message: "You've hit your usage limit. Try again later.",
			}),
		),
		"usageLimited",
	);
	assert.equal(
		classifyQuotaTail(
			JSON.stringify({ type: "error", message: "429 network capacity" }),
		),
		undefined,
	);
});

test("a newly paused rebound generation waits within the same quota budget", async () => {
	const h = harness();
	let binds = 0,
		status = 0;
	h.deps.bind = async () => ({
		binding: { bindingId: `b-${++binds}`, generation: binds },
		state: binds === 2 ? "paused" : "ready",
		generation: binds,
	});
	h.deps.status = async () => {
		status++;
		return { state: "ready", generation: 2 };
	};
	assert.equal(await runReview(h.deps), 0);
	assert.equal(status, 3); // Includes the original-binding permit check before retry exec.
});
test("effective explicit review model is bounded and ambiguous configuration is rejected", async () => {
	const { explicitReviewModel } = await import("../lib/codex-quota-client.mjs");
	assert.equal(
		explicitReviewModel(["exec", "-m", "gpt-6-astra", "prompt"]),
		"gpt-6-astra",
	);
	assert.equal(
		explicitReviewModel(["--model=gpt-6", "exec", "prompt"]),
		"gpt-6",
	);
	for (const args of [
		["exec", "prompt"],
		["exec", "-m", "../auth"],
		["exec", "-m", "gpt-6", "--model", "gpt-5"],
		["exec", "-m", "gpt-6", "-c", 'model="other"'],
	])
		assert.throws(() => explicitReviewModel(args));
});
test("old review waiter is acknowledged only after the fresh retry executes", async () => {
	const h = harness();
	h.deps.resumed = async (id) => h.calls.push(`resumed:${id}`);
	assert.equal(await runReview(h.deps), 0);
	assert.deepEqual(h.calls, [1800, "observe", 1800, "resumed:b-1"]);
});
test("manual generation change during rebind cannot authorize a review retry", async () => {
	const h = harness();
	let binds = 0,
		statuses = 0;
	h.deps.bind = async () => {
		const generation = ++binds === 1 ? 1 : 3;
		return {
			binding: { bindingId: `b-${generation}`, generation },
			state: "ready",
			generation,
		};
	};
	h.deps.status = async () =>
		++statuses === 1
			? { state: "ready", generation: 2 }
			: { state: "paused", generation: 3 };
	assert.equal(await runReview(h.deps), 75);
	assert.deepEqual(h.calls, [1800, "observe"]);
	assert.equal(binds, 2);
});
test("a ready permit for a different generation cannot authorize a review retry", async () => {
	const h = harness();
	let statuses = 0;
	h.deps.status = async () => ({
		state: "ready",
		generation: ++statuses === 1 ? 2 : 3,
	});
	assert.equal(await runReview(h.deps), 75);
	assert.deepEqual(h.calls, [1800, "observe"]);
});
test("runner-pane non-review shapes preserve the original local wrapper lane", async () => {
	const fs = await import("node:fs"),
		os = await import("node:os"),
		path = await import("node:path"),
		cp = await import("node:child_process");
	const { fileURLToPath } = await import("node:url");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "fly2465-local-lane-"));
	try {
		const bin = path.join(root, "bin"),
			home = path.join(root, "home"),
			capture = path.join(root, "args.json");
		fs.mkdirSync(bin);
		fs.mkdirSync(home);
		fs.writeFileSync(
			path.join(bin, "codex"),
			`#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2)));console.log('LOCAL_LANE_OK');`,
			{ mode: 0o700 },
		);
		const wrapper = path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			"../codex-with-fallback.sh",
		);
		const base = {
			HOME: home,
			PATH: `${bin}:${process.env.PATH}`,
			FLYWHEEL_NODE_BIN: process.execPath,
			FLYWHEEL_EXEC_ID: "runner-exec",
			FLYWHEEL_PROJECT_NAME: "fixture",
			FLYWHEEL_INGEST_TOKEN: "fixture-token",
			FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:1",
			FLYWHEEL_CODEX_GUARD_STATE_DIR: path.join(root, "guard"),
		};
		const cases = [
			{
				args: [
					"exec",
					"--full-auto",
					"--config",
					"model_reasoning_effort=high",
					"review this",
				],
			},
			{
				args: [
					"exec",
					"--json",
					"-o",
					path.join(root, "result"),
					"-C",
					root,
					"-s",
					"read-only",
					"-",
				],
			},
			...[
				"FLYWHEEL_PROJECT_NAME",
				"FLYWHEEL_INGEST_TOKEN",
				"FLYWHEEL_BRIDGE_URL",
			].map((name) => ({
				args: ["exec", "-m", "gpt-6-astra", "review this"],
				missing: name,
			})),
		];
		for (const item of cases) {
			const env = { ...base };
			if (item.missing) delete env[item.missing];
			const result = cp.spawnSync("/bin/bash", [wrapper, ...item.args], {
				env,
				encoding: "utf8",
				timeout: 10000,
			});
			assert.equal(
				result.status,
				0,
				`${JSON.stringify(item)}: ${result.stderr}`,
			);
			assert.match(result.stdout, /LOCAL_LANE_OK/);
			assert.deepEqual(JSON.parse(fs.readFileSync(capture, "utf8")), item.args);
			assert.ok(
				!fs.existsSync(path.join(home, ".flywheel", "codex-quota", "spool")),
			);
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("unreachable enrollment API falls back once with original local exit and argv", async () => {
	const fs = await import("node:fs"),
		os = await import("node:os"),
		path = await import("node:path"),
		cp = await import("node:child_process");
	const { fileURLToPath } = await import("node:url");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "fly2465-api-fallback-"));
	try {
		const home = path.join(root, "home"),
			bin = path.join(root, "bin"),
			capture = path.join(root, "args.json");
		fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
		fs.mkdirSync(bin);
		fs.writeFileSync(path.join(home, ".codex", "auth.json"), "{}");
		fs.writeFileSync(
			path.join(bin, "codex"),
			`#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2)));console.log('LOCAL_API_FALLBACK');process.exit(42);`,
			{ mode: 0o700 },
		);
		const wrapper = path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			"../codex-with-fallback.sh",
		);
		const args = ["exec", "-m", "gpt-6-astra", "fixture"];
		const result = cp.spawnSync("/bin/bash", [wrapper, ...args], {
			env: {
				HOME: home,
				PATH: `${bin}:${process.env.PATH}`,
				FLYWHEEL_NODE_BIN: process.execPath,
				FLYWHEEL_EXEC_ID: "fixture-exec",
				FLYWHEEL_PROJECT_NAME: "fixture",
				FLYWHEEL_INGEST_TOKEN: "fixture-token",
				FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:1",
				FLYWHEEL_CODEX_GUARD_STATE_DIR: path.join(root, "guard"),
			},
			encoding: "utf8",
			timeout: 15000,
		});
		assert.equal(result.status, 42, result.stderr);
		assert.match(result.stdout, /LOCAL_API_FALLBACK/);
		assert.match(result.stderr, /CODEX_QUOTA_API_UNAVAILABLE_LOCAL_FALLBACK/);
		assert.deepEqual(JSON.parse(fs.readFileSync(capture, "utf8")), args);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
