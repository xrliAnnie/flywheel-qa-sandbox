import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
	fixtureManifest,
	makeDeps,
	payloadKeyOf,
	seedBucketForManifest,
	TOKENS,
} from "../../packages/payload-endpoint/__tests__/harness.mjs";
import { handleRequest } from "../../packages/payload-endpoint/src/handler.mjs";
import { deriveVetoBinding } from "../../packages/payload-endpoint/src/manifest.mjs";
import { runAutoRelease } from "../release/payload-auto-release.mjs";

const executor = "executor-test-secret",
	writer = "writer-test-secret";
function setup(fault) {
	const ctx = makeDeps({
		tokens: {
			...TOKENS,
			autoReleaseExecutor: executor,
			releaseDecision: writer,
		},
	});
	ctx.deps.releaseControl = {
		projectId: "flywheel",
		audience: "test-endpoint",
		activationEpoch: 7,
		mode: "canary",
		enabled: true,
	};
	ctx.deps.releaseDecisionRequired = true;
	const m = fixtureManifest({ withRelease: false }),
		bytes = Buffer.from("actual immutable prepared payload");
	const sha = createHash("sha256").update(bytes).digest("hex");
	m.releaseOps.candidate = {
		kind: "release",
		state: "prepared",
		ver: "1.55.0",
		betaVersion: "1.55.0-beta.1",
		sourceCommit: "c".repeat(40),
		sha256: sha,
		objectKey: payloadKeyOf("1.55.0", sha),
		createdAt: "2026-07-01T00:00:00.000Z",
	};
	seedBucketForManifest(ctx.bucket, m);
	ctx.bucket.seed(
		m.releaseOps.candidate.objectKey,
		fault === "corrupt" ? Buffer.from("corrupt") : bytes,
		{ sha256: sha, ver: "1.55.0" },
	);
	const binding = deriveVetoBinding(m, "candidate");
	const input = {
		cycleId: "cycle-1",
		releaseId: "candidate",
		bindingDigest: createHash("sha256")
			.update(JSON.stringify(binding))
			.digest("hex"),
	};
	const calls = [],
		receipts = [];
	let attempt;
	let wrotePermit = false;
	const fetchImpl = async (url, options) => {
		const pathname = new URL(url).pathname;
		calls.push([options.method, pathname]);
		assert.equal(options.redirect, "error");
		assert.ok(options.signal);
		assert.equal(options.headers.authorization, `Bearer ${executor}`);
		const request = new Request(url, options);
		if (pathname === "/admin/release-attempts" && options.method === "POST") {
			const response = await handleRequest(request, ctx.deps);
			attempt = await response.clone().json();
			if (fault === "lost-create") throw Error(executor);
			return response;
		}
		if (pathname.endsWith("/execute"))
			assert.equal(receipts.length, 1, "attempt receipt must precede execute");
		if (
			pathname === `/admin/release-attempts/${attempt?.attemptId}` &&
			!wrotePermit &&
			fault !== "no-permit"
		) {
			wrotePermit = true;
			const permit = {
				...attempt,
				decisionId: "decision-1",
				action: "commit",
				trigger: "silence_auto",
				actor: "system",
				verdictId: "verdict-1",
				evidenceRevision: 1,
				claimedAt: ctx.clock.now().getTime(),
				notAfter: ctx.clock.now().getTime() + 30000,
			};
			if (fault === "manual-permit")
				Object.assign(permit, {
					trigger: "founder_go",
					actor: "founder-1",
					manualRequestId: "manual-request-1",
					readiness: { state: "green", reasons: [] },
				});

			const r = await handleRequest(
				new Request(`https://endpoint.test${pathname}/permit`, {
					method: "PUT",
					headers: { authorization: `Bearer ${writer}` },
					body: JSON.stringify(permit),
				}),
				ctx.deps,
			);
			assert.equal(r.status, 201, await r.clone().text());
		}
		if (fault === "execute-unreachable" && pathname.endsWith("/execute"))
			throw Error(executor);
		const response = await handleRequest(request, ctx.deps);
		if (fault === "lost-execute" && pathname.endsWith("/execute"))
			throw Error(executor);
		return response;
	};
	const options = {
		endpoint: "https://endpoint.test",
		token: executor,
		input,
		fetchImpl,
		now: () => ctx.clock.now().getTime(),
		sleep: async (ms) => ctx.clock.tick(ms),
		waitMs: 3000,
		onAttempt: async (value) => receipts.push(value),
	};
	return {
		...ctx,
		m,
		calls,
		receipts,
		options,
		input,
		getAttempt: () => attempt,
	};
}
test("executor verifies bytes then uses only the narrow control plane and records attempt before execute", async () => {
	const c = setup();
	const result = await runAutoRelease(c.options);
	assert.equal(result.kind, "published");
	assert.equal(c.receipts.length, 1);
	assert.equal(
		c.calls.filter(([m, p]) => m === "POST" && p === "/admin/release-attempts")
			.length,
		1,
	);
	assert.equal(c.calls.filter(([, p]) => p.endsWith("/execute")).length, 1);
	assert.equal(
		c.calls.some(([m, p]) => m === "POST" && p === "/admin/manifest"),
		false,
	);
	const m = await (await c.bucket.get("manifest.json")).json();
	assert.equal(m.releaseOps.candidate.state, "committed");
});
for (const fault of ["corrupt", "binding", "clock"])
	test(`executor rejects ${fault} before ready attempt`, async () => {
		const c = setup(fault);
		if (fault === "binding") c.options.input.bindingDigest = "a".repeat(64);
		if (fault === "clock")
			c.options.now = () => c.clock.now().getTime() + 10000;
		await assert.rejects(runAutoRelease(c.options));
		assert.equal(
			c.calls.some(([, p]) => p === "/admin/release-attempts"),
			false,
		);
	});
test("lost execute reply resolves from same attempt and never sends execute twice", async () => {
	const c = setup("lost-execute");
	assert.equal((await runAutoRelease(c.options)).kind, "published");
	assert.equal(c.calls.filter(([, p]) => p.endsWith("/execute")).length, 1);
	assert.equal(
		c.calls.filter(([, p]) => p === "/admin/release-attempts").length,
		1,
	);
});
test("unreachable execute stays unknown with durable attempt and no blind retry", async () => {
	const c = setup("execute-unreachable");
	const result = await runAutoRelease(c.options);
	assert.equal(result.kind, "unknown");
	assert.equal(result.attemptId, c.getAttempt().attemptId);
	assert.equal(c.calls.filter(([, p]) => p.endsWith("/execute")).length, 1);
});
test("ambiguous attempt creation never creates another attempt", async () => {
	const c = setup("lost-create");
	const result = await runAutoRelease(c.options);
	assert.equal(result.kind, "unknown");
	assert.equal(result.phase, "attempt_create");
	assert.equal(
		c.calls.filter(([, p]) => p === "/admin/release-attempts").length,
		1,
	);
});
test("no permit times out without manifest action", async () => {
	const c = setup("no-permit");
	const result = await runAutoRelease(c.options);
	assert.equal(result.kind, "awaiting_permit");
	assert.equal(
		c.calls.some(([, p]) => p.endsWith("/execute")),
		false,
	);
});
test("resume reads a saved attempt and published fact without downloading or reexecuting", async () => {
	const c = setup();
	await runAutoRelease(c.options);
	c.calls.length = 0;
	const result = await runAutoRelease({
		...c.options,
		input: { ...c.input, attemptId: c.getAttempt().attemptId },
	});
	assert.equal(result.kind, "published");
	assert.ok(
		c.calls.every(
			([method, path]) =>
				method === "GET" && path.startsWith("/admin/release-attempts/"),
		),
	);
});
for (const endpoint of [
	"http://evil.test",
	"https://user:secret@evil.test",
	"https://evil.test?token=x",
	"https://evil.test/path",
	"file:///tmp/key",
])
	test(`reject unsafe endpoint ${endpoint}`, async () => {
		const c = setup();
		await assert.rejects(runAutoRelease({ ...c.options, endpoint }));
		assert.equal(c.calls.length, 0);
	});
test("saved attempt callback failure prevents executing an unrecorded attempt", async () => {
	const c = setup();
	await assert.rejects(
		runAutoRelease({
			...c.options,
			onAttempt: async () => {
				throw Error("disk full");
			},
		}),
	);
	assert.equal(
		c.calls.some(([, p]) => p.endsWith("/execute")),
		false,
	);
});

for (const entry of ["auto", "manual"])
	test(`${entry} CLI writes a durable recovery receipt and emits no credential over real HTTP`, async () => {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const http = await import("node:http");
		const fs = await import("node:fs");
		const os = await import("node:os");
		const path = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		const c = setup(entry === "manual" ? "manual-permit" : undefined);
		c.clock.set(new Date().toISOString());
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-auto-cli-"));
		const receipt = path.join(dir, "attempt.jsonl");
		const server = http.createServer(async (req, res) => {
			try {
				const parts = [];
				for await (const part of req) parts.push(part);
				const body = Buffer.concat(parts);
				// Record that the real CLI has durably saved its attempt before any execute.
				if (req.url.endsWith("/execute")) {
					const lines = fs.readFileSync(receipt, "utf8").trim().split("\n");
					assert.equal(lines.length, 1);
					c.receipts.push(JSON.parse(lines[0]));
				}
				const response = await c.options.fetchImpl(
					`http://127.0.0.1${req.url}`,
					{
						method: req.method,
						headers: { authorization: req.headers.authorization },
						redirect: "error",
						signal: AbortSignal.timeout(10000),
						...(body.length ? { body } : {}),
					},
				);
				res.writeHead(response.status, Object.fromEntries(response.headers));
				res.end(Buffer.from(await response.arrayBuffer()));
			} catch {
				res.writeHead(503);
				res.end("{}");
			}
		});
		await new Promise((r) => server.listen(0, "127.0.0.1", r));
		try {
			const { stdout, stderr } = await promisify(execFile)(
				process.execPath,
				[
					fileURLToPath(
						new URL(
							entry === "manual"
								? "../release/payload-promote.mjs"
								: "../release/payload-auto-release.mjs",
							import.meta.url,
						),
					),
					...(entry === "manual"
						? ["commit", "--expected-sha256", c.m.releaseOps.candidate.sha256]
						: []),
					"--cycle-id",
					c.input.cycleId,
					"--release-id",
					c.input.releaseId,
					"--binding-digest",
					c.input.bindingDigest,
				],
				{
					env: {
						...process.env,
						FW_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
						FW_AUTO_RELEASE_EXECUTOR_TOKEN: executor,
						FW_AUTO_RELEASE_RECEIPT_FILE: receipt,
						GITHUB_OUTPUT: "",
					},
					timeout: 15000,
				},
			);
			assert.equal(JSON.parse(stdout).kind, "published");
			assert.equal(
				(stdout + stderr + fs.readFileSync(receipt, "utf8")).includes(executor),
				false,
			);
			assert.equal(fs.statSync(receipt).mode & 0o777, 0o600);
		} finally {
			server.closeAllConnections();
			await new Promise((r) => server.close(r));
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

test("manual decision mode rejects an auto permit before execute", async () => {
	const c = setup();
	await assert.rejects(
		runAutoRelease({ ...c.options, requireManualDecision: true }),
	);
	assert.equal(
		c.calls.some(([, p]) => p.endsWith("/execute")),
		false,
	);
});
test("an explicit expected hash cannot be overridden by the binding digest", async () => {
	const c = setup();
	await assert.rejects(
		runAutoRelease({
			...c.options,
			input: { ...c.input, expectedSha256: "f".repeat(64) },
		}),
	);
	assert.equal(
		c.calls.some(([, p]) => p === "/admin/release-attempts"),
		false,
	);
});

test("fence recovery requires an existing attempt before any network call", async () => {
	const c = setup();
	await assert.rejects(
		runAutoRelease({ ...c.options, input: { ...c.input, operation: "fence" } }),
	);
	assert.equal(c.calls.length, 0);
});
for (const fault of ["unstarted", "unknown", "lost-fence"])
	test(`exact fence recovery handles ${fault} without recreating or executing publication`, async () => {
		const c = setup(fault === "unstarted" ? "execute-unreachable" : undefined);
		const put = c.bucket.put.bind(c.bucket);
		if (fault !== "unstarted")
			c.bucket.put = async (key, ...args) => {
				if (key === "manifest.json")
					throw new Error("ambiguous manifest write");
				return put(key, ...args);
			};
		assert.equal((await runAutoRelease(c.options)).kind, "unknown");
		c.bucket.put = put;
		const a = c.getAttempt();
		const r = await handleRequest(
			new Request(
				`https://endpoint.test/admin/release-attempts/${a.attemptId}/fence-intent`,
				{
					method: "PUT",
					headers: { authorization: `Bearer ${writer}` },
					body: JSON.stringify({
						decisionId: "decision-1",
						nonce: a.nonce,
						baseEtag: a.baseEtag,
						fullBinding: a.fullBinding,
						reason: "release_intervention",
					}),
				},
			),
			c.deps,
		);
		assert.equal(r.status, 201);
		const start = c.calls.length;
		const recovered = await runAutoRelease({
			...c.options,
			input: { ...c.input, attemptId: a.attemptId, operation: "fence" },
			fetchImpl: async (url, options) => {
				const response = await c.options.fetchImpl(url, options);
				if (fault === "lost-fence" && new URL(url).pathname.endsWith("/fence"))
					throw new Error("lost fence response");
				return response;
			},
		});
		assert.equal(recovered.kind, "fenced");
		const calls = c.calls.slice(start);
		assert.equal(calls.filter(([m]) => m === "POST").length, 1);
		assert.ok(calls.some(([, p]) => p.endsWith("/fence")));
		assert.ok(
			!calls.some(
				([, p]) => p.endsWith("/execute") || p === "/admin/release-attempts",
			),
		);
		assert.equal(
			(await (await c.bucket.get("manifest.json")).json()).releaseOps.candidate
				.state,
			"abandoned",
		);
	});

test("fence without Bridge intent stays unresolved and never falls back to commit", async () => {
	const c = setup("execute-unreachable");
	await runAutoRelease(c.options);
	const before = c.calls.length;
	const result = await runAutoRelease({
		...c.options,
		input: {
			...c.input,
			attemptId: c.getAttempt().attemptId,
			operation: "fence",
		},
	});
	assert.equal(result.kind, "unknown");
	assert.ok(!c.calls.slice(before).some(([, p]) => p.endsWith("/execute")));
	assert.equal(
		(await (await c.bucket.get("manifest.json")).json()).releaseOps.candidate
			.state,
		"prepared",
	);
});
