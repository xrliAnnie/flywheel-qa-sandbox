import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { REQUIRED_RAW_ARTIFACTS } from "../lib/voice-soak/constants.mjs";
import {
	authoritativeDurationMs,
	checkRoundIntegrity,
	evidenceProblems,
	readJsonlStrict,
	recomputeVerdict,
	summarize,
} from "../qa-voice-soak-report.mjs";

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

function writeFile(root, relative, contents) {
	const path = join(root, relative);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents);
	return path;
}

/**
 * A minimal bundle that passes every check, so each test can break exactly one
 * thing and see whether the verifier notices.
 */
function buildBundle(overrides = {}) {
	const root = mkdtempSync(join(tmpdir(), "fly2383-bundle-"));
	const t0MonoMs = 1_000;
	const t1MonoMs = t0MonoMs + 1_800_000;
	const t0WallMs = Date.parse("2026-09-07T00:00:00.000Z");

	const frames = [];
	for (let at = t0MonoMs; at < t1MonoMs; at += 20) {
		frames.push({
			seq: frames.length,
			atMonoMs: at,
			audioClass: "silence",
			energy: 0,
			tonalRatio: 0,
		});
	}

	const receipts = [];
	for (let index = 0; index < 60; index += 1) {
		const rawStatus = {
			execution_id: "runner-1",
			status: "executing",
			session_status: "running",
		};
		receipts.push({
			atMonoMs: index * 30_000,
			atWallMs: t0WallMs + index * 30_000,
			executionId: "runner-1",
			executing: true,
			candidates: 1,
			excludedExecutionIds: ["self"],
			rawList: [
				{
					execution_id: "runner-1",
					status: "running",
					project_name: "flywheel",
				},
				{ execution_id: "self", status: "running", project_name: "flywheel" },
			],
			rawStatus,
			...(overrides.receipt?.(index) ?? {}),
		});
	}

	const events = [
		{
			ts: new Date(t0WallMs + 5_000).toISOString(),
			kind: "realtime_transcript",
			role: "user",
			transcriptId: "u1",
			generation: 1,
			text: "口令 123456",
		},
		{
			ts: new Date(t0WallMs + 9_000).toISOString(),
			kind: "realtime_transcript",
			role: "assistant",
			transcriptId: "a1",
			generation: 1,
			text: "口令是 1 2 3 4 5 6",
		},
	];

	overrides.events?.(events);

	const framesText = `${frames.map((f) => JSON.stringify(f)).join("\n")}\n`;
	const receiptsText = `${receipts.map((r) => JSON.stringify(r)).join("\n")}\n`;
	const eventsText = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;

	writeFile(root, "frames.jsonl", framesText);
	writeFile(root, "bridge-receipts.jsonl", receiptsText);
	writeFile(root, "session/state/voice-evidence/events.jsonl", eventsText);

	const manifest = {
		runId: "test-run",
		arm: "A (bed on, default)",
		verdict: "VALID",
		verdictReasons: [],
		timing: { t0WallMs, t0MonoMs, t1MonoMs, monotonicDurationMs: 1_800_000 },
		provenance: {},
		artifacts: {
			"frames.jsonl": sha256(Buffer.from(framesText)),
			"bridge-receipts.jsonl": sha256(Buffer.from(receiptsText)),
			"session/state/voice-evidence/events.jsonl": sha256(
				Buffer.from(eventsText),
			),
		},
		threeConditions: {
			conditions: {
				realAgentTurnDuringVoice: true,
				halfHourScale: true,
				realOrchestrationInFlight: true,
			},
			allSatisfied: true,
		},
		turns: [
			{
				roundId: 1,
				kind: "plain",
				arm: "on",
				nonce: "123456",
				playbackStartedAtMonoMs: t0MonoMs + 2_000,
				playbackEndedAtMonoMs: t0MonoMs + 6_000,
				playbackCompleted: true,
			},
		],
		audio: {
			classSeconds: { voice: 0, bed: 0, silence: 1800, unknown: 0 },
			secondBucketHoles: [],
			totalFrames: frames.length,
			downlinkOpusPacketsPerMinute: [],
			decoderErrors: [],
		},
		cleanupErrors: [],
	};
	overrides.manifest?.(manifest, root);
	writeFile(root, "manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
	return root;
}

/** Re-stamp the manifest hash so a tampered bundle is not caught by hashing alone. */
function restampArtifact(root, relative) {
	const manifestPath = join(root, "manifest.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	manifest.artifacts[relative] = sha256(readFileSync(join(root, relative)));
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

test("a clean bundle produces no evidence problems", () => {
	const root = buildBundle();
	const problems = evidenceProblems([summarize(root)]);
	assert.deepEqual(problems, []);
});

test("a status body for a runner the raw list does not select is rejected", () => {
	// The forgery carries a correct hash: only re-deriving the selection catches it.
	const root = buildBundle({
		receipt: (index) =>
			index === 0
				? {
						rawList: [
							{ execution_id: "someone-else", status: "running" },
							{ execution_id: "self", status: "running" },
						],
					}
				: {},
	});
	restampArtifact(root, "bridge-receipts.jsonl");
	const summary = summarize(root);
	assert.ok(summary.bridgeDisagreements.length > 0);
	assert.match(summary.bridgeDisagreements[0].error, /raw list selects/);
	assert.ok(evidenceProblems([summary]).some((p) => /disagree/.test(p)));
});

test("receipts claiming executing with no candidate are rejected", () => {
	const root = buildBundle({
		receipt: () => ({ rawList: [{ execution_id: "self", status: "running" }] }),
	});
	restampArtifact(root, "bridge-receipts.jsonl");
	const summary = summarize(root);
	assert.ok(summary.bridgeDisagreements.length > 0);
	assert.match(summary.bridgeDisagreements[0].error, /no candidate re-selects/);
});

test("a receipt with no raw list cannot be re-derived and is rejected", () => {
	const root = buildBundle({ receipt: () => ({ rawList: undefined }) });
	restampArtifact(root, "bridge-receipts.jsonl");
	const summary = summarize(root);
	assert.ok(summary.bridgeDisagreements.length > 0);
	assert.match(summary.bridgeDisagreements[0].error, /no rawList/);
});

test("a manifest claiming orchestration its receipts deny is refused", () => {
	// Every sample says not-executing, but the manifest still claims all three
	// conditions. The recomputation must contradict it and block the appendix.
	const root = buildBundle({
		receipt: () => ({
			executing: false,
			rawStatus: {
				execution_id: "runner-1",
				status: "waiting",
				session_status: "running",
			},
		}),
	});
	restampArtifact(root, "bridge-receipts.jsonl");
	const summary = summarize(root);
	assert.equal(
		summary.threeConditionsRecomputed.realOrchestrationInFlight,
		false,
	);
	assert.equal(summary.manifestDrift.clean, false);
	assert.ok(
		summary.manifestDrift.differences.some((d) =>
			d.field.startsWith("threeConditions"),
		),
	);
	assert.ok(evidenceProblems([summary]).length > 0);
});

test("a manifest that simply omits a required artifact does not verify", () => {
	const root = buildBundle({
		manifest: (manifest) => {
			delete manifest.artifacts["bridge-receipts.jsonl"];
		},
	});
	const summary = summarize(root);
	assert.equal(summary.artifactVerification.allMatch, false);
	assert.equal(
		summary.artifactVerification.results["bridge-receipts.jsonl"],
		"not_listed_in_manifest",
	);
	assert.ok(
		evidenceProblems([summary]).some((p) => /hashes do not verify/.test(p)),
	);
});

test("the required artifact set is fixed, not taken from the manifest", () => {
	assert.deepEqual(REQUIRED_RAW_ARTIFACTS, [
		"frames.jsonl",
		"bridge-receipts.jsonl",
		"session/state/voice-evidence/events.jsonl",
	]);
});

test("the window is measured from T0/T1, not from the aggregate that summarises them", () => {
	// A fifteen-minute run relabelled as half an hour by editing one derived
	// field, with every raw byte untouched.
	const root = buildBundle({
		manifest: (manifest) => {
			manifest.timing.t1MonoMs = manifest.timing.t0MonoMs + 901_423;
			manifest.timing.monotonicDurationMs = 1_800_000;
		},
	});
	const summary = summarize(root);
	assert.equal(summary.authoritativeDurationMs, 901_423);
	assert.equal(summary.threeConditionsRecomputed.halfHourScale, false);
	assert.equal(summary.manifestDrift.clean, false);
	assert.ok(
		summary.manifestDrift.differences.some(
			(d) => d.field === "timing.monotonicDurationMs",
		),
	);
	assert.ok(evidenceProblems([summary]).length > 0);
});

test("a manifest with no usable clock readings cannot be summarised at all", () => {
	const root = buildBundle({
		manifest: (manifest) => {
			manifest.timing.t1MonoMs = null;
		},
	});
	assert.throws(() => summarize(root), /no finite T0\/T1/);
	assert.throws(
		() => authoritativeDurationMs({ timing: { t0MonoMs: 10, t1MonoMs: 5 } }),
		/T1 precedes T0/,
	);
});

test("flipping a rejected run's verdict to VALID does not make it valid", () => {
	// The shape of the real discarded arm B: 11.2% of its seconds unobserved.
	// Only the verdict is edited; the frames still say what they said.
	const verdict = recomputeVerdict(
		{ cleanupErrors: [], provenance: { cli: [] } },
		101,
		901_875,
	);
	assert.equal(verdict.verdict, "INVALID");
	assert.ok(verdict.reasons.includes("excessive_holes:101"));
	assert.ok(verdict.holeShare > 0.1);

	// And a run that asked to be a main run is held to the half-hour floor.
	const short = recomputeVerdict(
		{ cleanupErrors: [], provenance: { cli: ["--require-min-duration"] } },
		0,
		900_000,
	);
	assert.ok(short.reasons.includes("below_min_duration"));

	// A control arm that never claimed half an hour is not failed for it.
	const control = recomputeVerdict(
		{ cleanupErrors: [], provenance: { cli: ["--bed", "off"] } },
		0,
		900_000,
	);
	assert.equal(control.verdict, "VALID");
});

test("ambiguous or missing transcript generations block the report", () => {
	// Two generations in one stream: which one belongs to this round is no longer
	// answerable, and answering anyway is how a foreign transcript gets claimed.
	const multi = buildBundle({
		manifest: () => {},
		events: (events) => {
			events[1].generation = 2;
		},
	});
	const multiSummary = summarize(multi);
	assert.equal(multiSummary.generationEvidence.usable, false);
	assert.match(multiSummary.generationEvidence.reason, /ambiguous/);
	assert.equal(multiSummary.turns.completed, 0);
	assert.ok(
		evidenceProblems([multiSummary]).some((p) => /generations are/.test(p)),
	);

	// A null generation on the matching transcript is equally unusable.
	const missing = buildBundle({
		events: (events) => {
			events[0].generation = null;
		},
	});
	const missingSummary = summarize(missing);
	assert.equal(missingSummary.generationEvidence.usable, false);
	assert.ok(evidenceProblems([missingSummary]).length > 0);
	// The uplink result is filtered too, not just the assistant echo.
	for (const round of missingSummary.probes.rounds) {
		assert.equal(round.heardByRaya, false);
	}
	for (const round of multiSummary.turns.rounds) {
		assert.equal(round.turnCompleted, false);
	}
});

test("a duplicated round cannot manufacture an extra hit", () => {
	// The cheapest possible forgery: copy a successful round. No frame changes,
	// no new transcripts — just one more entry in the list.
	const root = buildBundle({
		manifest: (manifest) => {
			manifest.turns.push({ ...manifest.turns[0] });
		},
	});
	const summary = summarize(root);
	assert.equal(summary.roundIntegrity.clean, false);
	assert.ok(evidenceProblems([summary]).some((p) => /duplicate/.test(p)));

	// Both identifiers are checked, so renumbering the copy does not help.
	assert.equal(
		checkRoundIntegrity({
			turns: [
				{ roundId: 1, nonce: "111111" },
				{ roundId: 2, nonce: "111111" },
			],
		}).clean,
		false,
	);
	assert.equal(
		checkRoundIntegrity({
			turns: [
				{ roundId: 1, nonce: "111111" },
				{ roundId: 2, nonce: "222222" },
			],
		}).clean,
		true,
	);
});

test("failures the raw artifacts cannot express still reach the rebuilt verdict", () => {
	// A run whose voice process died early, or whose downlink stalled, is not
	// VALID no matter how tidy its frames look.
	for (const [flag, reason] of [
		["childExitedEarly", "child_exited_early"],
		["downlinkStalled", "downlink_stalled"],
	]) {
		const verdict = recomputeVerdict(
			{
				cleanupErrors: [],
				provenance: { cli: [] },
				failures: { [flag]: true },
			},
			0,
			1_800_000,
		);
		assert.equal(verdict.verdict, "INVALID");
		assert.ok(verdict.reasons.includes(reason));
	}
	const instrument = recomputeVerdict(
		{
			cleanupErrors: [],
			provenance: { cli: [] },
			failures: { instrumentFail: "bed_present_in_off_arm" },
		},
		0,
		1_800_000,
	);
	assert.ok(instrument.reasons.includes("instrument_fail"));
});

test("a malformed record anywhere but the final line refuses to parse", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2383-jsonl-"));
	writeFile(root, "mid.jsonl", '{"a":1}\nnot json\n{"a":3}\n');
	assert.throws(
		() => readJsonlStrict(join(root, "mid.jsonl"), "frames"),
		/malformed record at line 2/,
	);

	// Only a torn final write is forgiven.
	writeFile(root, "torn.jsonl", '{"a":1}\n{"a":2}\n{"a":3');
	assert.equal(
		readJsonlStrict(join(root, "torn.jsonl"), "frames").rows.length,
		2,
	);
});
