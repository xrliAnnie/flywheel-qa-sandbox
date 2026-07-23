import assert from "node:assert/strict";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runWorkKindCutoverCli } from "../workkind-cutover.mjs";

function captureIo() {
	const stdout = [];
	const stderr = [];
	return {
		stdout,
		stderr,
		io: {
			stdout: (line) => stdout.push(line),
			stderr: (line) => stderr.push(line),
		},
	};
}

const canonical = {
	version: 1,
	activationId: "FLY-1436",
	operationId: "fly-1436-activate-test",
	kind: "activate",
	project: "flywheel",
	actor: "system:fly-1436-cutover",
	before: [{ taskCategory: "*", templateId: "tpl_eng_heavy" }],
	after: [{ taskCategory: "*", templateId: "tpl_generic" }],
	snapshotHash: "a".repeat(64),
	expected: {
		templateDispatch: true,
		generalizedTemplates: true,
		workKind: true,
		prBAssetsReady: true,
		deployedSha: "b".repeat(40),
		assetsDigest: "c".repeat(64),
	},
};

const snapshot = {
	version: 1,
	activationId: "FLY-1436",
	sourceOperationId: "fly-1436-activate-test",
	project: "flywheel",
	bindings: [{ taskCategory: "*", templateId: "tpl_eng_heavy" }],
};

function response(status, body) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	};
}

test("fails closed when TEAMLEAD_API_TOKEN is absent and never calls the Bridge", async () => {
	let called = false;
	const capture = captureIo();
	const code = await runWorkKindCutoverCli(["stage", "activate"], {
		env: {},
		fetchImpl: async () => {
			called = true;
			throw new Error("unexpected");
		},
		stateRoot: mkdtempSync(join(tmpdir(), "fly1436-cli-")),
		now: () => "2026-07-22T00:00:00.000Z",
		io: capture.io,
	});
	assert.equal(code, 2);
	assert.equal(called, false);
	assert.match(capture.stderr.join("\n"), /TEAMLEAD_API_TOKEN/);
});

test("stage activate sends only server-authorized inputs and atomically records a private stage plus state", async () => {
	const stateRoot = mkdtempSync(join(tmpdir(), "fly1436-cli-"));
	const capture = captureIo();
	let request;
	const code = await runWorkKindCutoverCli(
		["stage", "activate", "--operation-id", canonical.operationId],
		{
			env: {
				TEAMLEAD_API_TOKEN: "master-token",
				FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876",
			},
			fetchImpl: async (url, init) => {
				request = { url, init };
				return response(200, {
					ok: true,
					canonical,
					snapshot,
					confirmToken: "one-time-token",
				});
			},
			stateRoot,
			now: () => "2026-07-22T00:00:00.000Z",
			io: capture.io,
		},
	);
	assert.equal(code, 0);
	assert.equal(
		request.url,
		"http://127.0.0.1:9876/api/workflow/cutovers/FLY-1436/stage",
	);
	assert.equal(request.init.headers.authorization, "Bearer master-token");
	assert.deepEqual(JSON.parse(request.init.body), {
		kind: "activate",
		operationId: canonical.operationId,
	});

	const result = JSON.parse(capture.stdout.at(-1));
	assert.equal(statSync(result.stagePath).mode & 0o777, 0o600);
	assert.equal(statSync(result.snapshotPath).mode & 0o777, 0o600);
	assert.deepEqual(JSON.parse(readFileSync(result.stagePath, "utf8")), {
		canonical,
		confirmToken: "one-time-token",
	});
	assert.deepEqual(
		JSON.parse(readFileSync(join(stateRoot, "FLY-1436.json"), "utf8")),
		{
			phase: "staged_activate",
			mergeSha: canonical.expected.deployedSha,
			operationId: canonical.operationId,
			activationOperationId: canonical.operationId,
			snapshotPath: result.snapshotPath,
			snapshotHash: canonical.snapshotHash,
			updatedAt: "2026-07-22T00:00:00.000Z",
		},
	);
});

test("a custom stage output preserves the caller-owned directory mode", async () => {
	const stateRoot = mkdtempSync(join(tmpdir(), "fly1436-cli-"));
	chmodSync(stateRoot, 0o755);
	const outputDirectory = join(stateRoot, "shared-evidence");
	mkdirSync(outputDirectory, { mode: 0o755 });
	chmodSync(outputDirectory, 0o755);
	const output = join(outputDirectory, "stage.json");
	const capture = captureIo();
	const code = await runWorkKindCutoverCli(
		["stage", "activate", "--output", output],
		{
			env: { TEAMLEAD_API_TOKEN: "master-token" },
			fetchImpl: async () =>
				response(200, {
					ok: true,
					canonical,
					snapshot,
					confirmToken: "one-time-token",
				}),
			stateRoot,
			io: capture.io,
		},
	);
	assert.equal(code, 0);
	assert.equal(statSync(stateRoot).mode & 0o777, 0o700);
	assert.equal(statSync(outputDirectory).mode & 0o777, 0o755);
	assert.equal(statSync(output).mode & 0o777, 0o600);
});

test("stage restore preserves activation breadcrumbs in the navigation state", async () => {
	const stateRoot = mkdtempSync(join(tmpdir(), "fly1436-cli-"));
	const capture = captureIo();
	const restoreCanonical = {
		...canonical,
		operationId: "fly-1436-restore-test",
		kind: "restore",
		sourceOperationId: canonical.operationId,
		before: canonical.after,
		after: canonical.before,
	};
	delete restoreCanonical.expected;
	const fetchImpl = async (_url, init) => {
		const body = JSON.parse(init.body);
		return body.kind === "activate"
			? response(200, {
					ok: true,
					canonical,
					snapshot,
					confirmToken: "activate-token",
				})
			: response(200, {
					ok: true,
					canonical: restoreCanonical,
					confirmToken: "restore-token",
				});
	};
	assert.equal(
		await runWorkKindCutoverCli(["stage", "activate"], {
			env: { TEAMLEAD_API_TOKEN: "master-token" },
			fetchImpl,
			stateRoot,
			io: capture.io,
		}),
		0,
	);
	const activationResult = JSON.parse(capture.stdout.at(-1));
	assert.equal(
		await runWorkKindCutoverCli(
			[
				"stage",
				"restore",
				"--source-operation-id",
				canonical.operationId,
				"--snapshot",
				activationResult.snapshotPath,
			],
			{
				env: { TEAMLEAD_API_TOKEN: "master-token" },
				fetchImpl,
				stateRoot,
				io: capture.io,
			},
		),
		0,
	);
	const state = JSON.parse(
		readFileSync(join(stateRoot, "FLY-1436.json"), "utf8"),
	);
	assert.equal(state.phase, "staged_restore");
	assert.equal(state.mergeSha, canonical.expected.deployedSha);
	assert.equal(state.operationId, restoreCanonical.operationId);
	assert.equal(state.activationOperationId, canonical.operationId);
	assert.equal(state.snapshotPath, activationResult.snapshotPath);
});

test("apply sends the private staged capability and records the durable receipt phase", async () => {
	const stateRoot = mkdtempSync(join(tmpdir(), "fly1436-cli-"));
	const capture = captureIo();
	const stagePath = join(stateRoot, "activate-stage.json");
	writeFileSync(
		stagePath,
		`${JSON.stringify({ canonical, confirmToken: "one-time-token" })}\n`,
		{ mode: 0o600 },
	);
	let body;
	const code = await runWorkKindCutoverCli(["apply", "--input", stagePath], {
		env: {
			TEAMLEAD_API_TOKEN: "master-token",
			FLYWHEEL_BRIDGE_URL: "http://localhost:9876/",
		},
		fetchImpl: async (_url, init) => {
			body = JSON.parse(init.body);
			return response(200, {
				ok: true,
				status: "committed",
				receipt: { operationId: canonical.operationId },
			});
		},
		stateRoot,
		now: () => "2026-07-22T00:01:00.000Z",
		io: capture.io,
	});
	assert.equal(code, 0);
	assert.deepEqual(body, {
		canonical,
		confirmToken: "one-time-token",
	});
	const state = JSON.parse(
		readFileSync(join(stateRoot, "FLY-1436.json"), "utf8"),
	);
	assert.equal(state.phase, "activated");
	assert.equal(state.operationId, canonical.operationId);
	assert.equal(state.snapshotHash, canonical.snapshotHash);
});
