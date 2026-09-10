import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import vm from "node:vm";

const workflow = JSON.parse(
	execFileSync(
		"python3",
		[
			"-c",
			"import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))",
			new URL(
				"../../../.github/workflows/payload-activation.yml",
				import.meta.url,
			).pathname,
		],
		{ encoding: "utf8" },
	),
);
const steps = workflow.jobs.activate.steps;
const env = {
	CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
	CLOUDFLARE_API_TOKEN: "fake-control",
	FW_R2_ACCESS_KEY_ID: "fake-access",
	FW_R2_SECRET_ACCESS_KEY: "fake-secret",
	FW_CLEANUP_TOKEN: "c".repeat(64),
	FW_BETA_PUBLISH_TOKEN: "b".repeat(64),
	FW_CUSTOMER_RELEASE_TOKEN: "d".repeat(64),
};

async function run(name, overrides = {}) {
	const step = steps.find((s) => s.name === name);
	assert.ok(step, `missing activation step: ${name}`);
	assert.equal(step.if, "inputs.mode == 'infra'");
	const source = step.run
		.match(/<<'JS'\n([\s\S]+)\nJS/)[1]
		.replace(/^import .*;\n/gm, "");
	const output = [];
	const context = {
		JSON,
		assert,
		createHash,
		readFileSync,
		isDeepStrictEqual,
		URL,
		process: {
			env: { ...env },
			exit: (code) => {
				throw new Error(`exit ${code}`);
			},
		},
		console: { log: (s) => output.push(s), error: (s) => output.push(s) },
		fetch: async () => {
			throw new Error("unmocked network forbidden");
		},
		execFileSync: () => {
			throw new Error("unmocked child forbidden");
		},
		...overrides,
	};
	await vm.runInNewContext(`(async () => {${source}\n})()`, context);
	return output;
}

test("activation validates bucket binding, signer credentials and distinct cleanup capability before deploy", async () => {
	await run("Validate B2 deployment inputs");
	for (const patch of [
		{ FW_R2_SECRET_ACCESS_KEY: "" },
		{ CLOUDFLARE_ACCOUNT_ID: "evil.test" },
		{ FW_CLEANUP_TOKEN: env.FW_BETA_PUBLISH_TOKEN },
		{ FW_CLEANUP_TOKEN: "" },
	]) {
		await assert.rejects(
			run("Validate B2 deployment inputs", {
				process: {
					env: { ...env, ...patch },
					exit: () => {
						throw new Error("refused");
					},
				},
			}),
		);
	}
	await assert.rejects(
		run("Validate B2 deployment inputs", {
			readFileSync: () =>
				'binding = "PAYLOADS"\nbucket_name = "other"\nFW_R2_BUCKET = "flywheel-payloads"',
		}),
	);
});

test("private R2 audit rejects public access, dangerous/unknown lifecycle and unreadable API before native rule writes", async () => {
	const native = JSON.parse(
		readFileSync(new URL("../r2-lifecycle.json", import.meta.url)),
	);
	for (const fault of [null, "managed", "custom", "lifecycle", "response"]) {
		let applied = false;
		const calls = [];
		const fetch = async (url) => {
			calls.push(url);
			const result = url.endsWith("/domains/managed")
				? { enabled: fault === "managed" }
				: url.endsWith("/domains/custom")
					? { domains: fault === "custom" ? [{ enabled: true }] : [] }
					: fault === "lifecycle"
						? {
								rules: [
									{ id: "unknown", enabled: true, deleteObjectsTransition: {} },
								],
							}
						: applied
							? native
							: { rules: [] };
			return {
				ok: fault !== "response",
				json: async () => ({ success: true, result }),
			};
		};
		const action = run("Verify private R2 and apply reviewed lifecycle", {
			fetch,
			execFileSync: (command, args) => {
				assert.equal(command, "pnpm");
				assert.ok(args.includes("lifecycle") && args.includes("set"));
				assert.ok(
					args.includes("--force"),
					"unattended apply must not cancel at Wrangler confirmation",
				);
				applied = true;
			},
		});
		if (fault) {
			await assert.rejects(action);
			assert.equal(applied, false);
		} else {
			await action;
			assert.equal(applied, true);
			assert.equal(calls.length, 4);
		}
	}
});

test("signer secrets and cleanup hash use stdin, with no plaintext cleanup in Worker or output", async () => {
	const writes = [];
	const output = await run("Stage B2 Worker secrets", {
		execFileSync: (command, args, options) => {
			assert.equal(command, "pnpm");
			assert.ok(args.includes("put"));
			writes.push({ name: args[4], input: options.input });
		},
	});
	assert.deepEqual(
		writes.map((w) => w.name),
		[
			"FW_R2_ACCESS_KEY_ID",
			"FW_R2_SECRET_ACCESS_KEY",
			"FW_CLEANUP_TOKEN_SHA256",
		],
	);
	assert.equal(
		writes[2].input,
		createHash("sha256").update(env.FW_CLEANUP_TOKEN).digest("hex"),
	);
	assert.equal(output.join("").includes(env.FW_R2_SECRET_ACCESS_KEY), false);
	assert.equal(output.join("").includes(env.FW_CLEANUP_TOKEN), false);
});

test("scheduled preflight distinguishes not activated from cleanup success and rejects unsafe endpoints", async () => {
	const cleanup = JSON.parse(
		execFileSync(
			"python3",
			[
				"-c",
				"import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))",
				new URL(
					"../../../.github/workflows/payload-cleanup.yml",
					import.meta.url,
				).pathname,
			],
			{ encoding: "utf8" },
		),
	);
	const source = cleanup.jobs.cleanup.steps[0].run
		.match(/<<'JS'\n([\s\S]+)\nJS/)[1]
		.replace(/^import .*;\n/gm, "");
	for (const [endpoint, token, expected] of [
		["", "", "skip"],
		["https://endpoint.test", "", "skip"],
		["https://endpoint.test", "fixture", "true"],
		["http://endpoint.test", "fixture", "reject"],
		["https://user:pass@endpoint.test", "fixture", "reject"],
		["https://endpoint.test?key=fixture", "fixture", "reject"],
	]) {
		const output = {};
		const execute = () =>
			vm.runInNewContext(source, {
				URL,
				console: { error() {} },
				appendFileSync: (file, text) => {
					output[file] = (output[file] || "") + text;
				},
				process: {
					env: {
						FW_ENDPOINT: endpoint,
						FW_CLEANUP_TOKEN: token,
						GITHUB_OUTPUT: "output",
						GITHUB_STEP_SUMMARY: "summary",
					},
					exit: () => {
						throw new Error("refused");
					},
				},
			});
		if (expected === "reject") assert.throws(execute);
		else {
			execute();
			assert.equal(
				output.output,
				`activated=${expected === "skip" ? "false" : "true"}\n`,
			);
			if (expected === "skip")
				assert.match(output.summary, /no cleanup success evidence/);
		}
	}
});
