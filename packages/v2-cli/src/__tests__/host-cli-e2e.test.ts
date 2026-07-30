import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeEngineDb } from "flywheel-v2-engine";
import { readProcessStartIdentity, signHostRequest } from "flywheel-v2-host";
import {
	advanceDatabaseAuthorityStateTx,
	armCutoverAuthority,
	Kernel,
	migrateDatabase,
	publishLiveCutoverAuthority,
	publishMigrationCompleteMarker,
	seedPreCutoverAuthority,
} from "flywheel-v2-kernel";
import { afterEach, describe, expect, it } from "vitest";

const HOST_CLI = fileURLToPath(
	new URL("../../../v2-host/dist/cli.js", import.meta.url),
);
const AGENT_CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const WINDOW = "e2e-window";
const EPOCH = 7;
const HOST_EPOCH = "host-epoch-e2e";

interface Fixture {
	dir: string;
	dbPath: string;
	markerPath: string;
	authorityPath: string;
	armedPath: string;
	socketPath: string;
	secretPath: string;
	proofRoot: string;
	effectsPath: string;
	credentialPath: string;
	secret: Buffer;
}

function createFixture(): Fixture {
	const dir = mkdtempSync(join(tmpdir(), "flywheel-v2-host-e2e-"));
	chmodSync(dir, 0o700);
	const dbPath = join(dir, "flywheel-v2.db");
	const markerPath = join(dir, "migration-complete.json");
	const authorityPath = join(dir, "authority.json");
	const armedPath = join(dir, "armed.json");
	const socketPath = join(dir, "host.sock");
	const secretPath = join(dir, "host.secret");
	const proofRoot = join(dir, "sessions");
	const effectsPath = join(dir, "effects.json");
	// Codex R3 HIGH-2: the pull credential lives in a 0600 file, never in argv.
	const credentialPath = join(dir, "delivery-credential.json");
	mkdirSync(proofRoot, { mode: 0o700 });
	const secret = randomBytes(32);
	writeFileSync(secretPath, secret, { mode: 0o600 });
	writeFileSync(
		effectsPath,
		JSON.stringify([
			{
				kind: "event",
				eventKind: "e2e.proposal",
				payload: "{}",
			},
		]),
		{ mode: 0o600 },
	);
	seedPreCutoverAuthority({
		authorityPath,
		armedPath,
		windowId: WINDOW,
		epoch: EPOCH,
		nowIso: "2026-07-28T00:00:00.000Z",
	});
	armCutoverAuthority({
		authorityPath,
		armedPath,
		windowId: WINDOW,
		epoch: EPOCH,
		nowIso: "2026-07-28T00:01:00.000Z",
	});
	migrateDatabase({ path: dbPath });
	const kernel = Kernel.open({ path: dbPath });
	initializeEngineDb(kernel);
	kernel.write("e2e.cutover-meta", (tx) => {
		tx.run(
			`INSERT INTO meta(key,value,updated_at)
			 VALUES ('cutover_window_id',@window,@now)
			 ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
			{
				window: WINDOW,
				now: "2026-07-28T00:00:00.000Z",
			},
		);
		tx.run(
			`INSERT INTO meta(key,value,updated_at)
			 VALUES ('cutover_epoch',@epoch,@now)
			 ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
			{
				epoch: String(EPOCH),
				now: "2026-07-28T00:00:00.000Z",
			},
		);
	});
	kernel.close();
	chmodSync(dbPath, 0o600);
	publishMigrationCompleteMarker({
		dbPath,
		markerPath,
		authorityPath,
		armedPath,
		expectedWindowId: WINDOW,
		expectedEpoch: EPOCH,
		nowIso: "2026-07-28T00:02:00.000Z",
	});
	const liveKernel = Kernel.open({ path: dbPath });
	liveKernel.write("e2e.publish-live", (tx) => {
		advanceDatabaseAuthorityStateTx(tx, {
			expected: "cutover",
			next: "live",
			nowIso: "2026-07-28T00:02:01.000Z",
		});
	});
	liveKernel.close();
	publishLiveCutoverAuthority({
		authorityPath,
		armedPath,
		windowId: WINDOW,
		epoch: EPOCH,
		nowIso: "2026-07-28T00:02:02.000Z",
	});
	return {
		dir,
		dbPath,
		markerPath,
		authorityPath,
		armedPath,
		socketPath,
		secretPath,
		proofRoot,
		effectsPath,
		credentialPath,
		secret,
	};
}

function hostArgs(fixture: Fixture): string[] {
	return [
		HOST_CLI,
		"--db",
		fixture.dbPath,
		"--marker",
		fixture.markerPath,
		"--authority",
		fixture.authorityPath,
		"--armed",
		fixture.armedPath,
		"--window",
		WINDOW,
		"--epoch",
		String(EPOCH),
		"--socket",
		fixture.socketPath,
		"--secret",
		fixture.secretPath,
		"--session-proof-root",
		fixture.proofRoot,
		"--host-epoch",
		HOST_EPOCH,
	];
}

async function startHost(fixture: Fixture): Promise<ChildProcess> {
	const child = spawn(process.execPath, hostArgs(fixture), {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr?.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const deadline = Date.now() + 10_000;
	while (
		!stdout.includes("\n") &&
		child.exitCode === null &&
		Date.now() < deadline
	) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	if (child.exitCode !== null || !stdout.includes('"status":"ready"')) {
		throw new Error(
			`host failed to start: exit=${child.exitCode} stdout=${stdout} stderr=${stderr}`,
		);
	}
	return child;
}

async function stopChild(
	child: ChildProcess,
	signal: NodeJS.Signals,
): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill(signal);
	await new Promise<void>((resolve) => {
		const timeout = setTimeout(resolve, 5_000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolve();
		});
	});
}

function runCli(fixture: Fixture, args: string[]): unknown {
	return JSON.parse(
		execFileSync(
			process.execPath,
			[
				AGENT_CLI,
				...args,
				"--socket",
				fixture.socketPath,
				"--secret",
				fixture.secretPath,
			],
			{ encoding: "utf8" },
		),
	) as unknown;
}

function registerLead(
	fixture: Fixture,
	agentProcess: ChildProcess,
	pidStart: string,
): unknown {
	return runCli(fixture, [
		"register-lead",
		"--agent",
		"lead-e2e",
		"--instance",
		"instance-e2e",
		"--host-epoch",
		HOST_EPOCH,
		"--session-id",
		"session-e2e",
		"--session-proof-root",
		fixture.proofRoot,
		"--pid",
		String(agentProcess.pid),
		"--pid-start",
		pidStart,
		"--delivery-credential-out",
		fixture.credentialPath,
	]);
}

async function sendSubmitAndDropResponse(
	fixture: Fixture,
	payload: unknown,
): Promise<void> {
	const request = signHostRequest(
		{
			v: 1,
			id: randomBytes(16).toString("hex"),
			nonce: randomBytes(16).toString("hex"),
			action: "submit_proposal",
			payload,
		},
		fixture.secret,
	);
	await new Promise<void>((resolve, reject) => {
		const socket = createConnection(fixture.socketPath);
		socket.once("connect", () => {
			socket.write(`${JSON.stringify(request)}\n`, () => {
				socket.destroy();
				resolve();
			});
		});
		socket.once("error", reject);
	});
}

async function waitForApplied(fixture: Fixture): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const kernel = Kernel.open({ path: fixture.dbPath });
		const state = kernel.read(
			(tx) =>
				tx.get<{ state: string }>(
					"SELECT state FROM mailbox WHERE source_id='source-e2e'",
				)?.state,
		);
		kernel.close();
		if (state === "applied") return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("mailbox did not become applied");
}

describe("real host process + real agent CLI + unix socket", () => {
	let fixture: Fixture | undefined;
	let host: ChildProcess | undefined;
	let agentProcess: ChildProcess | undefined;

	afterEach(async () => {
		if (host) await stopChild(host, "SIGKILL");
		if (agentProcess) await stopChild(agentProcess, "SIGKILL");
		if (fixture) rmSync(fixture.dir, { recursive: true, force: true });
		host = undefined;
		agentProcess = undefined;
		fixture = undefined;
		delete process.env.FLYWHEEL_V2_TEST_PROCESS_START_EVIDENCE;
	});

	it("settles after a lost response, reattaches after host crash, and returns the durable receipt on retry", async () => {
		fixture = createFixture();
		agentProcess = spawn(process.execPath, [
			"-e",
			"setInterval(() => {}, 1000)",
		]);
		process.env.FLYWHEEL_V2_TEST_PROCESS_START_EVIDENCE = JSON.stringify({
			[String(agentProcess.pid)]: "test-process-start-e2e",
		});
		const pidStart = readProcessStartIdentity(agentProcess.pid as number);
		if (!pidStart) throw new Error("failed to observe agent process start");
		host = await startHost(fixture);

		expect(registerLead(fixture, agentProcess, pidStart)).toMatchObject({
			kind: "lead",
			agentId: "lead-e2e",
			generation: 1,
		});
		expect(
			runCli(fixture, [
				"enqueue",
				"--source-kind",
				"discord",
				"--source-id",
				"source-e2e",
				"--payload",
				'{"text":"hello"}',
				"--to-agent",
				"lead-e2e",
				"--kind",
				"instruction",
				"--retention",
				"business",
			]),
		).toMatchObject({ status: "enqueued" });
		const delivery = runCli(fixture, [
			"next",
			"--agent",
			"lead-e2e",
			"--delivery-credential-file",
			fixture.credentialPath,
		]) as {
			message: { messageUid: string };
			handle: { attemptUid: string };
			authorization: { capabilityId: string; token: string };
		};
		const submitPayload = {
			agentId: "lead-e2e",
			attemptUid: delivery.handle.attemptUid,
			messageUid: delivery.message.messageUid,
			effects: JSON.parse(readFileSync(fixture.effectsPath, "utf8")) as unknown,
			authorization: delivery.authorization,
		};

		await sendSubmitAndDropResponse(fixture, submitPayload);
		await waitForApplied(fixture);
		await stopChild(host, "SIGKILL");
		host = await startHost(fixture);
		expect(registerLead(fixture, agentProcess, pidStart)).toMatchObject({
			generation: 1,
		});

		expect(
			runCli(fixture, [
				"submit",
				"--agent",
				"lead-e2e",
				"--attempt",
				delivery.handle.attemptUid,
				"--message",
				delivery.message.messageUid,
				"--capability-id",
				delivery.authorization.capabilityId,
				"--token",
				delivery.authorization.token,
				"--effects-file",
				fixture.effectsPath,
			]),
		).toMatchObject({ status: "succeeded" });

		writeFileSync(
			fixture.effectsPath,
			JSON.stringify([
				{
					kind: "event",
					eventKind: "different.proposal",
					payload: "{}",
				},
			]),
		);
		expect(() =>
			runCli(fixture as Fixture, [
				"submit",
				"--agent",
				"lead-e2e",
				"--attempt",
				delivery.handle.attemptUid,
				"--message",
				delivery.message.messageUid,
				"--capability-id",
				delivery.authorization.capabilityId,
				"--token",
				delivery.authorization.token,
				"--effects-file",
				(fixture as Fixture).effectsPath,
			]),
		).toThrow();
	});

	it("fails closed when machine cutover authority changes after host startup", async () => {
		fixture = createFixture();
		host = await startHost(fixture);
		expect(runCli(fixture, ["health"])).toMatchObject({ status: "ok" });

		writeFileSync(fixture.authorityPath, "{}\n", { mode: 0o600 });

		expect(() => runCli(fixture as Fixture, ["health"])).toThrow(
			/cutover authority fail closed/i,
		);
	});

	it("provisions an unknown Discord recipient before the Lead registers", async () => {
		fixture = createFixture();
		host = await startHost(fixture);

		expect(
			runCli(fixture, [
				"enqueue",
				"--source-kind",
				"discord",
				"--source-id",
				"discord-before-register",
				"--payload",
				"hello",
				"--to-agent",
				"lead-unregistered",
				"--kind",
				"instruction",
				"--retention",
				"business",
			]),
		).toMatchObject({ status: "enqueued" });

		const kernel = Kernel.open({ path: fixture.dbPath });
		expect(
			kernel.read((tx) =>
				tx.get<{ kind: string; generation: number }>(
					"SELECT kind,generation FROM agents WHERE agent_id='lead-unregistered'",
				),
			),
		).toEqual({ kind: "lead", generation: 0 });
		kernel.close();
	});
});
