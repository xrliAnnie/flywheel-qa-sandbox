import assert from "node:assert/strict";
import test from "node:test";

import { buildVoiceProcessEnv } from "../qa/fly2655-voice-room.mjs";
import {
	FLY2799_BINARY_SHA256,
	FLY2799_BINARY_VERSION,
	FLY2799_CONTRACT_SHA,
	runHarness,
	summarizeRunEvidence,
	validateAuthorizedManifest,
} from "../qa/fly2799-codex-container.mjs";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const HEAD = "a".repeat(40);
const CONFIG = "c".repeat(64);

function run(persona, slot) {
	return {
		persona,
		slotDir: `/tmp/flywheel-test-slot-${slot}`,
		projectName: persona === "raya" ? "raya" : "flywheel",
		leadId: persona === "raya" ? "raya" : "flywheel-product-lead",
		leadModel: persona === "raya" ? "astra" : "opus[1m]",
		topic: `FLY-2799 ${persona} authorized QA`,
		holdSeconds: 60,
		verdictPath: `/tmp/flywheel-test-slot-${slot}/fly2799-${persona}-verdict.json`,
	};
}

function manifest() {
	return {
		schemaVersion: 1,
		kind: "fly2799-authorized-test-room",
		issueId: "FLY-2799",
		contractSha: FLY2799_CONTRACT_SHA,
		authorizedBy: "flywheel-eng-lead",
		authorizedAt: "2026-09-23T11:00:00.000Z",
		expiresAt: "2026-09-23T13:00:00.000Z",
		expectedHead: HEAD,
		productionRoutingChangeAuthorized: false,
		gates: {
			g1: { status: "closed", receiptId: "g1-receipt" },
			g2: { status: "closed", receiptId: "g2-receipt" },
		},
		engine: {
			backendId: "codex-realtime",
			binaryPath: "/opt/flywheel/codex-0.156.1/codex",
			binaryVersion: FLY2799_BINARY_VERSION,
			binarySha256: FLY2799_BINARY_SHA256,
			realtimeVersion: "v2",
			model: "gpt-realtime-2.1",
			configDigest: CONFIG,
			capabilities: {
				verbatim: false,
				attribution: false,
				bargeIn: false,
			},
		},
		runs: [run("raya", 27991), run("honey-lemon", 27992)],
		receiptPath: "/tmp/fly2799/receipt.json",
	};
}

function verdict(runValue, sessionId) {
	return {
		schemaVersion: 1,
		issueId: "FLY-2799",
		sessionId,
		persona: runValue.persona,
		evaluatorUserId: "founder-user",
		heardAssistantAudio: true,
		identityFactCount: 2,
		currentWorkObserved: true,
		pendingDecisionObserved: true,
		externalAudioAnswered: true,
		activeSpeakObserved: true,
		controlCadenceObserved: true,
		interruptResult: "not-testable",
		actionHandoff: {
			requested: false,
			targetLeadId: runValue.leadId,
			deliveryId: null,
			state: "blocked",
			reason: "attribution_false",
		},
		notes: "Capability-closed negative control observed.",
	};
}

function evidence(sessionId, threadId) {
	return {
		events: [
			{
				kind: "codex_voice_container_opened",
				sessionId,
				threadId,
				binaryDigest: FLY2799_BINARY_SHA256,
				configDigest: CONFIG,
				contextDigest: "d".repeat(64),
			},
			{
				kind: "codex_speak_receipt",
				outcome: "completed",
				transport: "submitted",
				contentProof: "transcript_equivalent",
			},
			{
				kind: "codex_voice_container_closed",
				sessionId,
				threadId,
			},
		],
		transcript: [
			{ role: "user", final: true, text: "fixture question" },
			{ role: "assistant", final: true, text: "fixture answer" },
		],
		minuteJobs: [
			{
				state: "delivered",
				deliveryId: `chat:lead:voice-minutes-${sessionId}`,
				payload: { sessionId },
			},
		],
	};
}

test("authorization manifest is exact, short-lived, gate-closed, and production-off", () => {
	assert.equal(validateAuthorizedManifest(manifest(), NOW).runs.length, 2);
	for (const mutate of [
		(value) => {
			value.gates.g1.status = "open";
		},
		(value) => {
			value.productionRoutingChangeAuthorized = true;
		},
		(value) => {
			value.engine.capabilities.attribution = true;
		},
		(value) => {
			value.runs[1].leadModel = "astra";
		},
		(value) => {
			value.expiresAt = "2026-09-25T13:00:00.000Z";
		},
	]) {
		const value = manifest();
		mutate(value);
		assert.throws(() => validateAuthorizedManifest(value, NOW));
	}
});

test("test-slot env selects the pinned backend only through an explicit pair", () => {
	const base = {
		slotDir: "/tmp/flywheel-test-slot-27991",
		repoRoot: "/work/flywheel",
		bridgeUrl: "http://127.0.0.1:9202",
		apiToken: "slot-master",
		botTokenEnv: "TEST_BOT_TOKEN_27991",
		botToken: "test-bot-secret",
		openAiApiKey: "realtime-secret",
		projectsPath: "/tmp/flywheel-test-slot-27991/projects.json",
		projectsJson: '[{"projectName":"raya"}]',
		projectName: "raya",
		buildSha: HEAD,
		voiceHostPath: "/tmp/flywheel-test-slot-27991/voice-host.json",
		meetingNotesPath: "/tmp/flywheel-test-slot-27991/meeting-notes.yaml",
		baseEnv: { HOME: "/Users/qa", PATH: "/usr/bin" },
	};
	const untouched = buildVoiceProcessEnv(base);
	assert.equal(untouched.FLYWHEEL_VOICE_BACKEND, undefined);
	assert.equal(untouched.FLYWHEEL_CODEX_BIN, undefined);
	const selected = buildVoiceProcessEnv({
		...base,
		backendId: "codex-realtime",
		codexBin: "/opt/flywheel/codex-0.156.1/codex",
	});
	assert.equal(selected.FLYWHEEL_VOICE_BACKEND, "codex-realtime");
	assert.equal(
		selected.FLYWHEEL_CODEX_BIN,
		"/opt/flywheel/codex-0.156.1/codex",
	);
	assert.throws(
		() => buildVoiceProcessEnv({ ...base, backendId: "codex-realtime" }),
		/voice_codex_binary_absolute_required/,
	);
});

test("two real-room shapes close before evidence collection and remain incomplete while capabilities are false", async () => {
	const calls = [];
	const value = manifest();
	const receipt = await runHarness(value, {
		now: () => NOW,
		inspectBinary: async () => ({
			version: FLY2799_BINARY_VERSION,
			sha256: FLY2799_BINARY_SHA256,
			realtimeFeatureEnabled: true,
		}),
		repositoryState: async () => ({ head: HEAD, dirty: false }),
		assertRunTopology: async (runValue) => {
			calls.push([runValue.persona, "topology"]);
		},
		roomCommand: async (command, runValue, _manifest, sessionId) => {
			calls.push([runValue.persona, command, sessionId ?? null]);
			return command === "start"
				? {
						sessionId: `${runValue.persona}-session`,
						evidencePath: `${runValue.slotDir}/events.jsonl`,
					}
				: { status: command.toUpperCase() };
		},
		waitForVerdict: async (runValue, started) => {
			calls.push([runValue.persona, "verdict"]);
			return verdict(runValue, started.sessionId);
		},
		collectEvidence: async (runValue, started) => {
			calls.push([runValue.persona, "collect"]);
			return evidence(started.sessionId, `${runValue.persona}-thread`);
		},
	});
	assert.equal(receipt.status, "INCOMPLETE_CAPABILITY_GATES");
	assert.equal(receipt.runs.length, 2);
	assert.ok(
		receipt.runs.every(
			(row) => row.automatedEvidencePassed && row.humanEvidencePassed,
		),
	);
	for (const runValue of value.runs) {
		const names = calls
			.filter(([persona]) => persona === runValue.persona)
			.map(([, name]) => name);
		assert.ok(names.indexOf("stop") < names.indexOf("collect"));
	}
});

test("missing proof or a cleanup ambiguity cannot produce passing evidence", () => {
	const value = manifest();
	const runValue = value.runs[0];
	const sessionId = "raya-session";
	const observed = evidence(sessionId, "raya-thread");
	observed.events = observed.events.filter(
		(event) => event.kind !== "codex_speak_receipt",
	);
	observed.events.push({ kind: "codex_voice_cleanup_pending" });
	const summary = summarizeRunEvidence({
		run: runValue,
		manifest: value,
		started: { sessionId },
		verdict: verdict(runValue, sessionId),
		evidence: observed,
	});
	assert.equal(summary.automatedEvidencePassed, false);
});
