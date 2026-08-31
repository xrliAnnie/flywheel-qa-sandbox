#!/usr/bin/env node
import assert from "node:assert/strict";
import test from "node:test";

import {
	a3QaSessionIsIrreversiblyTerminal,
	buildA3QaTerminationRequest,
	buildDesignFixtureHtml,
	buildGateDeliveryOpenArgs,
	buildGateDeliveryRespondArgs,
	buildGeneralizedStartRequest,
	buildSlotCommEnv,
	buildStubFatalAbortError,
	classifyDurableLaunchDrain,
	classifyStubFatal,
	generalizedEntryAuthorityIsReady,
	generalizedFixtureBranch,
	generalizedFixtureMarker,
	hasOwnedPrMarker,
	nextStubAction,
	parseTmuxTargetIdentity,
	proveOwnedExecutionSet,
	reconcileGeneralizedFixturePrBody,
	reconcileOwnedExecutionSet,
	resolveOwnedPrEvidence,
	resolveVerifiedPrCleanupTarget,
	STUB_FATAL_DIAGNOSIS_EXIT,
	shouldTerminatePriorRun,
	stubFatalAbortDecision,
	terminateQaSessionForA3,
	tmuxObservationIsAlive,
	validateGeneralizedStartResponse,
	validateQaRelease,
	validateQaShipPreconditions,
	validateRoomInfo,
	waitFor,
} from "../lib/qa-generalized-e2e-lib.mjs";

const ROOM = {
	schemaVersion: 1,
	slot: 2,
	mode: "slot",
	generalized: true,
	runnerMode: "stub",
	bridgeUrl: "http://localhost:19872",
	dbPath: "/tmp/slot/teamlead.db",
	flywheelProjectsFile: "/tmp/slot/flywheel-projects.json",
	hostRepo: "/tmp/slot/project-slot-2",
	flywheelRepo: "/tmp/flywheel-under-test",
	buildSha: "a".repeat(40),
	apiTokenPath: "/tmp/slot/state/api-token",
	projectName: "test-slot-2",
	agentId: "flywheel-test-2",
};

test("room contract rejects topology and runner-mode drift", () => {
	assert.deepEqual(validateRoomInfo(ROOM, "stub"), ROOM);
	assert.throws(
		() => validateRoomInfo({ ...ROOM, mode: "roundtable" }, "stub"),
		/generalized slot room/,
	);
	assert.throws(
		() => validateRoomInfo({ ...ROOM, runnerMode: "real" }, "stub"),
		/runnerMode/,
	);
	assert.throws(
		() => validateRoomInfo({ ...ROOM, flywheelRepo: "" }, "stub"),
		/flywheelRepo/,
	);
});

test("slot comm env overrides every ambient or caller registry coordinate", () => {
	const identity = {
		schemaVersion: 1,
		leadId: "flywheel-test-2",
		projectName: "test-slot-2",
		leadKey: "test-slot-2:flywheel-test-2",
		agentTeamName: "flywheel-test-2",
		botUserId: "123456789012345678",
		botTokenEnv: "TEST_SLOT_2_BOT_TOKEN",
		discordStateDir: "/slot/discord",
		backend: "codex-app-server",
		role: "dept",
		projectsDigest: "projects-digest",
		identityDigest: "identity-digest",
	};
	assert.deepEqual(
		buildSlotCommEnv(
			{
				HOME: "/operator",
				FLYWHEEL_COMM_DB: "/ambient/comm.db",
				FLYWHEEL_PROJECTS_FILE: "/ambient/projects.json",
				FLYWHEEL_LEAD_ID: "ambient-lead",
				LEAD_ID: "ambient-lead",
				FLYWHEEL_PROJECT_NAME: "ambient-project",
				PROJECT_NAME: "ambient-project",
				FLYWHEEL_LEAD_KEY: "ambient-key",
				FLYWHEEL_LEAD_ROLE: "cos",
				FLYWHEEL_LEAD_BACKEND: "claude-code",
				DISCORD_STATE_DIR: "/ambient/discord",
				DISCORD_EXPECTED_BOT_USER_ID: "999999999999999999",
				DISCORD_IDENTITY_MODE: "legacy",
				FLYWHEEL_LEAD_IDENTITY_DIGEST: "ambient-identity",
				FLYWHEEL_LEAD_PROJECTS_DIGEST: "ambient-projects",
			},
			"/slot/comm.db",
			"/slot/projects.json",
			identity,
			{
				FLYWHEEL_COMM_DB: "/foreign/comm.db",
				FLYWHEEL_PROJECTS_FILE: "/foreign/projects.json",
				FLYWHEEL_LEAD_ID: "foreign-lead",
				EXTRA: "kept",
			},
		),
		{
			HOME: "/operator",
			FLYWHEEL_COMM_DB: "/slot/comm.db",
			FLYWHEEL_PROJECTS_FILE: "/slot/projects.json",
			FLYWHEEL_LEAD_LEASE_MODE: "off",
			FLYWHEEL_LEAD_ID: "flywheel-test-2",
			LEAD_ID: "flywheel-test-2",
			FLYWHEEL_PROJECT_NAME: "test-slot-2",
			PROJECT_NAME: "test-slot-2",
			FLYWHEEL_LEAD_KEY: "test-slot-2:flywheel-test-2",
			FLYWHEEL_LEAD_ROLE: "dept",
			FLYWHEEL_LEAD_BACKEND: "codex-app-server",
			DISCORD_STATE_DIR: "/slot/discord",
			DISCORD_EXPECTED_BOT_USER_ID: "123456789012345678",
			DISCORD_IDENTITY_MODE: "managed",
			FLYWHEEL_LEAD_IDENTITY_DIGEST: "identity-digest",
			FLYWHEEL_LEAD_PROJECTS_DIGEST: "projects-digest",
			EXTRA: "kept",
		},
	);
	assert.throws(
		() =>
			buildSlotCommEnv({}, "/slot/comm.db", "/slot/projects.json", {
				...identity,
				identityDigest: "",
			}),
		/slot lead identity identity\.identityDigest is required/,
	);
});

test("fixture PR body takeover accepts only the canonical reusable fixture", () => {
	const current =
		"<!-- flywheel-qa-529-generalized run=run-new exec=implement-new -->";
	const canonical = "Deterministic generalized-DAG room drill; do not merge.";
	assert.equal(
		reconcileGeneralizedFixturePrBody(canonical, "run-new", "implement-new"),
		`${current}\n\n${canonical}`,
	);
	assert.equal(
		reconcileGeneralizedFixturePrBody(
			`<!-- flywheel-qa-529-generalized run=run-old exec=implement-old -->\n\n${canonical}`,
			"run-new",
			"implement-new",
		),
		`<!-- flywheel-qa-529-generalized run=run-old exec=implement-old -->\n${current}\n\n${canonical}`,
	);
	assert.equal(
		reconcileGeneralizedFixturePrBody(
			`${current}\n\n${canonical}`,
			"run-new",
			"implement-new",
		),
		`${current}\n\n${canonical}`,
	);
	assert.throws(
		() =>
			reconcileGeneralizedFixturePrBody(
				"A human-authored PR body",
				"run-new",
				"implement-new",
			),
		/not a reusable generalized fixture/,
	);
});

test("generalized fixture marker is canonical, stable, and identity-bound", () => {
	const marker =
		"<!-- flywheel-qa-529-generalized run=run-new exec=implement-new -->";
	assert.equal(generalizedFixtureMarker("run-new", "implement-new"), marker);
	assert.equal(generalizedFixtureMarker("run-new", "implement-new"), marker);
	assert.notEqual(
		generalizedFixtureMarker("run-newer", "implement-new"),
		marker,
	);
	assert.throws(
		() => generalizedFixtureMarker("run/new", "implement-new"),
		/generalized fixture marker identity is invalid/,
	);
});

test("design fixture HTML is stable per execution and unique across runs", () => {
	const first = buildDesignFixtureHtml("FLY-202", "run-one", "design-one");
	const same = buildDesignFixtureHtml("FLY-202", "run-one", "design-one");
	const nextRun = buildDesignFixtureHtml("FLY-202", "run-two", "design-one");
	const nextExecution = buildDesignFixtureHtml(
		"FLY-202",
		"run-one",
		"design-two",
	);
	assert.equal(first, same);
	assert.notEqual(first, nextRun);
	assert.notEqual(first, nextExecution);
	assert.match(
		first,
		/^<!doctype html>\n<!-- flywheel-qa-529-generalized run=run-one exec=design-one -->\n/,
	);
	for (const heading of [
		"一句话",
		"核心流程",
		"数据与结构",
		"取舍",
		"诚实边界",
	]) {
		assert.match(first, new RegExp(`<h2>${heading}</h2>`));
	}
});

test("stub fatal classification recognizes the real collapsed FLY-1404 range", () => {
	const sameSha = "a".repeat(40);
	const otherSha = "b".repeat(40);
	const fatalPrefix =
		"design complete failed: [complete] FLY-1404 founder design HTML is required before phase_design_complete: ";
	const sameRange = classifyStubFatal({
		message: `${fatalPrefix}no committed .html exists under doc/FLY-202-<slug>/ in ${sameSha}..${sameSha}.\nRemediation: create the design HTML.`,
		at: "2026-08-31T00:00:00.000Z",
	});
	assert.equal(sameRange.kind, "collapsed_baseline");
	assert.match(sameRange.remediation, /--issue/);
	assert.match(sameRange.remediation, /qa-sandbox main/);
	assert.match(sameRange.remediation, /FLY-2164/);

	assert.deepEqual(
		classifyStubFatal({
			message: `${fatalPrefix}no committed .html exists under doc/FLY-202-<slug>/ in ${sameSha}..${otherSha}.`,
			at: "2026-08-31T00:00:00.000Z",
		}).kind,
		"stub_fatal",
	);
	assert.equal(classifyStubFatal(null), null);
	assert.equal(classifyStubFatal(undefined), null);
});

test("stub fatal classification never drops malformed fatal state", () => {
	for (const fatal of [{}, { message: 42 }, "corrupt"]) {
		assert.deepEqual(classifyStubFatal(fatal), {
			kind: "stub_fatal",
			malformed: true,
			remediation:
				"Inspect the execution stub-state fatal record and bridge.log.",
		});
	}
	assert.deepEqual(classifyStubFatal({ message: "runner crashed" }), {
		kind: "stub_fatal",
		remediation:
			"Inspect the execution stub-state fatal record and bridge.log.",
	});
});

test("collapsed baseline aborts immediately only for the dead current execution", () => {
	const fatal = {
		message: "collapsed",
		at: "2026-08-31T00:00:00.000Z",
	};
	const base = {
		executionId: "design-current",
		fatal,
		pidAlive: false,
		isCurrentExecution: true,
		kind: "collapsed_baseline",
		nowMs: 1_000,
		priorObservation: null,
	};
	assert.deepEqual(stubFatalAbortDecision(base), {
		abort: true,
		nextObservation: null,
	});
	for (const override of [
		{ fatal: null },
		{ pidAlive: true },
		{ isCurrentExecution: false },
	]) {
		assert.deepEqual(stubFatalAbortDecision({ ...base, ...override }), {
			abort: false,
			nextObservation: null,
		});
	}
});

test("generic stub fatal requires one continuous two-second observation window", () => {
	const fatal = { message: "runner crashed", at: "fatal-one" };
	const decide = (nowMs, priorObservation = null) =>
		stubFatalAbortDecision({
			executionId: "qa-current",
			fatal,
			pidAlive: false,
			isCurrentExecution: true,
			kind: "stub_fatal",
			nowMs,
			priorObservation,
		});
	const opened = decide(10_000);
	assert.deepEqual(opened, {
		abort: false,
		nextObservation: {
			executionId: "qa-current",
			fatalAt: "fatal-one",
			firstObservedAtMs: 10_000,
		},
	});
	for (const elapsed of [500, 1_999]) {
		assert.deepEqual(decide(10_000 + elapsed, opened.nextObservation), opened);
	}
	assert.deepEqual(decide(12_000, opened.nextObservation), {
		abort: true,
		nextObservation: null,
	});
});

test("stub fatal observation resets across recovery, rebinding, and tuple changes", () => {
	const fatal = { message: "runner crashed", at: "shared-fatal-at" };
	const priorObservation = {
		executionId: "qa-old",
		fatalAt: fatal.at,
		firstObservedAtMs: 1_000,
	};
	const base = {
		executionId: "qa-old",
		fatal,
		pidAlive: false,
		isCurrentExecution: true,
		kind: "stub_fatal",
		nowMs: 5_000,
		priorObservation,
	};
	for (const override of [
		{ pidAlive: true },
		{ isCurrentExecution: false },
		{ fatal: null },
	]) {
		const reset = stubFatalAbortDecision({ ...base, ...override });
		assert.deepEqual(reset, {
			abort: false,
			nextObservation: null,
		});
		assert.deepEqual(
			stubFatalAbortDecision({
				...base,
				nowMs: 6_000,
				priorObservation: reset.nextObservation,
			}),
			{
				abort: false,
				nextObservation: {
					executionId: "qa-old",
					fatalAt: fatal.at,
					firstObservedAtMs: 6_000,
				},
			},
		);
	}
	assert.deepEqual(
		stubFatalAbortDecision({ ...base, executionId: "qa-replacement" }),
		{
			abort: false,
			nextObservation: {
				executionId: "qa-replacement",
				fatalAt: fatal.at,
				firstObservedAtMs: 5_000,
			},
		},
	);
	assert.deepEqual(
		stubFatalAbortDecision({
			...base,
			fatal: { ...fatal, at: "new-fatal-at" },
		}),
		{
			abort: false,
			nextObservation: {
				executionId: "qa-old",
				fatalAt: "new-fatal-at",
				firstObservedAtMs: 5_000,
			},
		},
	);
});

test("shared waitFor retries ordinary probe failures but propagates QA diagnostics", async () => {
	let attempts = 0;
	assert.equal(
		await waitFor(
			"ordinary retry",
			() => {
				attempts += 1;
				if (attempts === 1) throw new Error("transient read race");
				return "ready";
			},
			1_100,
		),
		"ready",
	);
	assert.equal(attempts, 2);

	const order = [];
	await assert.rejects(
		() =>
			waitFor(
				"stub fatal",
				() => {
					order.push("evidence-written");
					throw buildStubFatalAbortError({
						step: 2,
						executionId: "design-dead",
						classification: {
							kind: "collapsed_baseline",
							remediation: "choose another --issue",
						},
					});
				},
				1_100,
			),
		(error) => {
			order.push("abort-propagated");
			assert.equal(error.qa529Abort, true);
			assert.equal(error.exitCode, STUB_FATAL_DIAGNOSIS_EXIT);
			return true;
		},
	);
	assert.deepEqual(order, ["evidence-written", "abort-propagated"]);
});

test("stub fatal abort error carries the stable structured driver contract", () => {
	const classification = {
		kind: "stub_fatal",
		remediation: "inspect stub-state and bridge.log",
	};
	const error = buildStubFatalAbortError({
		step: 7,
		executionId: "implement-dead",
		classification,
	});
	assert.equal(error.qa529Abort, true);
	assert.equal(error.exitCode, 21);
	assert.equal(error.step, 7);
	assert.equal(error.executionId, "implement-dead");
	assert.equal(error.classification, classification);
	assert.match(error.message, /stub_fatal/);
	assert.match(error.message, /inspect stub-state and bridge\.log/);
});

test("fixture PR branch is run-scoped instead of colliding with stable issue worktrees", () => {
	assert.equal(
		generalizedFixtureBranch("FLY-202", "run-1234:attempt.1"),
		"qa529-FLY-202-run-1234-attempt.1",
	);
	assert.throws(
		() => generalizedFixtureBranch("FLY-202", "../foreign"),
		/fixture runId is invalid/,
	);
});

test("step 1 accepts only the current workflow_v2 entry authority", () => {
	const gate = { node: "founder_gate" };
	const authority = {
		engine_owned: 1,
		gate_carrier_epoch: 1,
		entry_kind: "workflow_v2",
	};
	assert.equal(generalizedEntryAuthorityIsReady(authority, gate), true);
	assert.equal(
		generalizedEntryAuthorityIsReady(
			{ ...authority, entry_kind: "pipeline_dag_v1" },
			gate,
		),
		false,
	);
	assert.equal(
		generalizedEntryAuthorityIsReady(authority, { node: "implement" }),
		false,
	);
});

test("gate-delivery commands bind the QA actor and question checkpoint", () => {
	assert.deepEqual(
		buildGateDeliveryOpenArgs({
			leadId: "flywheel-test-2",
			qaExecutionId: "qa-exec",
			implementExecutionId: "implement-exec",
		}),
		[
			"gate",
			"question",
			"--lead",
			"flywheel-test-2",
			"--exec-id",
			"qa-exec",
			"--no-block",
			"FLY-1775 529 gate-delivery probe; parked implement implement-exec must not own this question",
		],
	);
	assert.deepEqual(
		buildGateDeliveryRespondArgs({
			questionId: "question-1",
			leadId: "flywheel-test-2",
			qaExecutionId: "qa-exec",
		}),
		[
			"respond",
			"question-1",
			"approve",
			"--lead",
			"flywheel-test-2",
			"--expect-owner",
			"qa-exec",
			"--expect-checkpoint",
			"question",
		],
	);
});

test("cleanup derives its destructive target from the authenticated live PR", () => {
	const stored = {
		repo: "owner/sandbox",
		branch: "fixture",
		expectedHead: "a".repeat(40),
	};
	assert.deepEqual(
		resolveVerifiedPrCleanupTarget(stored, {
			head: {
				sha: "a".repeat(40),
				ref: "fixture",
				repo: { full_name: "owner/sandbox" },
			},
		}),
		{ repo: "owner/sandbox", branch: "fixture", expectedHead: "a".repeat(40) },
	);
	assert.throws(
		() =>
			resolveVerifiedPrCleanupTarget(stored, {
				head: {
					sha: "a".repeat(40),
					ref: "other",
					repo: { full_name: "owner/sandbox" },
				},
			}),
		/identity drift/,
	);
});

test("prior-run convergence terminates live runs and cleans terminal runs", () => {
	assert.equal(shouldTerminatePriorRun("active"), true);
	assert.equal(shouldTerminatePriorRun("held"), true);
	assert.equal(shouldTerminatePriorRun("completed"), false);
	assert.equal(shouldTerminatePriorRun("terminated"), false);
	assert.throws(() => shouldTerminatePriorRun("mystery"), /unsupported/);
});

test("tmux target identity accepts the exact CommDB session:window form", () => {
	assert.deepEqual(parseTmuxTargetIdentity("runner-test-slot-2:@17"), {
		target: "runner-test-slot-2:@17",
		kind: "window",
		id: "@17",
	});
	assert.deepEqual(parseTmuxTargetIdentity("runner-test-slot-2:%9"), {
		target: "runner-test-slot-2:%9",
		kind: "pane",
		id: "%9",
	});
	assert.equal(parseTmuxTargetIdentity("runner-test-slot-2:main"), null);
	assert.equal(
		tmuxObservationIsAlive(
			"runner-test-slot-2:@17",
			"@17|%9|0|implement-exec\n",
			"implement-exec",
		),
		true,
	);
	assert.equal(
		tmuxObservationIsAlive(
			"runner-test-slot-2:@17",
			"@18|%9|0|implement-exec\n",
			"implement-exec",
		),
		false,
	);
	assert.equal(
		tmuxObservationIsAlive(
			"runner-test-slot-2:@17",
			"@17|%9|0|foreign-exec\n",
			"implement-exec",
		),
		false,
	);
	assert.equal(
		tmuxObservationIsAlive(
			"runner-test-slot-2:@17",
			"@17|%9|0|\n",
			"implement-exec",
		),
		false,
	);
});

test("durable stub evidence advances stored PR ownership before convergence", () => {
	const stored = {
		executionId: "implement-1",
		number: 42,
		repo: "owner/sandbox",
		branch: "fixture",
		expectedHead: "a".repeat(40),
	};
	assert.deepEqual(
		resolveOwnedPrEvidence(
			stored,
			[
				{
					runId: "run-1",
					executionId: "implement-1",
					lastCompletion: {
						action: "implement",
						attempt: 2,
						prNumber: 42,
						repo: "owner/sandbox",
						branch: "fixture",
						head: "b".repeat(40),
					},
				},
				{
					runId: "foreign-run",
					executionId: "implement-1",
					lastCompletion: {
						action: "implement",
						attempt: 99,
						prNumber: 99,
						repo: "attacker/repo",
						branch: "foreign",
						head: "f".repeat(40),
					},
				},
			],
			"run-1",
			["implement-1"],
		),
		{ ...stored, expectedHead: "b".repeat(40) },
	);
});

test("replacement implement execution may advance the same owned PR", () => {
	const stored = {
		executionId: "implement-old",
		number: 42,
		repo: "owner/sandbox",
		branch: "fixture",
		expectedHead: "a".repeat(40),
	};
	assert.deepEqual(
		resolveOwnedPrEvidence(
			stored,
			[
				{
					runId: "run-1",
					executionId: "implement-new",
					lastCompletion: {
						action: "implement",
						attempt: 2,
						prNumber: 42,
						repo: "owner/sandbox",
						branch: "fixture",
						head: "b".repeat(40),
					},
				},
			],
			"run-1",
			["implement-old", "implement-new"],
		),
		{ ...stored, executionId: "implement-new", expectedHead: "b".repeat(40) },
	);
});

test("run-scoped PR marker remains owned after implement execution replacement", () => {
	const body =
		"<!-- flywheel-qa-529-generalized run=run-1 exec=implement-old -->\nfixture";
	assert.equal(
		hasOwnedPrMarker(body, "run-1", ["implement-old", "implement-new"]),
		true,
	);
	assert.equal(hasOwnedPrMarker(body, "run-1", ["implement-new"]), false);
	assert.equal(hasOwnedPrMarker(body, "run-foreign", ["implement-old"]), false);
});

test("driver start request pins a cross-vendor producer/reviewer topology", () => {
	assert.deepEqual(
		buildGeneralizedStartRequest({
			issueId: "FLY-202",
			projectName: "test-slot-2",
			leadId: "flywheel-test-2",
			idempotencyKey: "qa529-fly-202-1",
		}),
		{
			issueId: "FLY-202",
			projectName: "test-slot-2",
			leadId: "flywheel-test-2",
			taskCategory: "code",
			sessionRole: "main",
			idempotencyKey: "qa529-fly-202-1",
			overrides: {
				eng_design: { model: "fable" },
				implement: { model: "codex" },
			},
		},
	);
	assert.equal(
		validateGeneralizedStartResponse({
			success: true,
			generalized: true,
			executionId: "design-1",
			workflowRunId: "run-1",
			workflowNodeId: "design",
		}).workflowRunId,
		"run-1",
	);
	assert.throws(
		() =>
			validateGeneralizedStartResponse({ success: true, generalized: false }),
		/generalized start refused/,
	);
});

test("stub state machine is idempotent and an exit fence wins before side effects", () => {
	assert.equal(
		nextStubAction({ role: "implement", attempt: 1, completedAttempts: [] }),
		"complete-implement",
	);
	assert.equal(
		nextStubAction({
			role: "implement",
			attempt: 1,
			completedAttempts: [1],
		}),
		"park",
	);
	assert.equal(
		nextStubAction({
			role: "implement",
			attempt: 2,
			completedAttempts: [1],
		}),
		"complete-implement",
	);
	assert.equal(
		nextStubAction({
			role: "qa",
			attempt: 1,
			completedAttempts: [],
			qaFailReady: false,
		}),
		"qa-fail-ready",
	);
	assert.equal(
		nextStubAction({
			role: "qa",
			attempt: 1,
			completedAttempts: [],
			qaFailReady: true,
			qaFailReleased: false,
		}),
		"park",
	);
	assert.equal(
		nextStubAction({
			role: "qa",
			attempt: 1,
			completedAttempts: [],
			qaFailReady: true,
			qaFailReleased: true,
		}),
		"qa-fail",
	);
	assert.equal(
		nextStubAction({
			role: "qa",
			attempt: 2,
			completedAttempts: [1],
			qaReady: true,
			releaseValid: false,
		}),
		"park",
	);
	assert.equal(
		nextStubAction({
			role: "qa",
			attempt: 2,
			completedAttempts: [1],
			qaReady: true,
			releaseValid: true,
		}),
		"qa-pass",
	);
	assert.equal(
		nextStubAction({
			role: "qa",
			attempt: 2,
			completedAttempts: [1],
			qaReady: true,
			releaseValid: true,
			qaPassAttempted: true,
		}),
		"park",
	);
	assert.equal(
		nextStubAction({
			role: "qa",
			attempt: 2,
			completedAttempts: [1],
			exitRequested: true,
		}),
		"exit",
	);
});

test("QA release is bound to the exact run, execution, attempt, and head tuple", () => {
	const expected = {
		runId: "run-1",
		executionId: "qa-2",
		attempt: 2,
		expectedHead: "a".repeat(40),
	};
	assert.deepEqual(validateQaRelease(expected, expected), expected);
	for (const stale of [
		{ ...expected, runId: "run-old" },
		{ ...expected, executionId: "qa-old" },
		{ ...expected, attempt: 1 },
		{ ...expected, expectedHead: "b".repeat(40) },
	]) {
		assert.throws(() => validateQaRelease(stale, expected), /tuple mismatch/);
	}
});

test("pre-action ownership is exact-set, never subset authority", () => {
	assert.doesNotThrow(() =>
		proveOwnedExecutionSet(
			["design", "implement", "qa"],
			["qa", "design", "implement"],
		),
	);
	assert.throws(
		() => proveOwnedExecutionSet(["design", "implement"], ["design"]),
		/execution set drift/,
	);
	assert.throws(
		() =>
			proveOwnedExecutionSet(
				["design", "implement"],
				["design", "implement", "foreign"],
			),
		/execution set drift/,
	);
});

test("same-run dead-exec replacement grows ownership without dropping history", () => {
	assert.deepEqual(
		reconcileOwnedExecutionSet(
			["design", "implement-old"],
			["implement-new", "design", "implement-old"],
		),
		["design", "implement-new", "implement-old"],
	);
	assert.throws(
		() =>
			reconcileOwnedExecutionSet(
				["design", "implement-old"],
				["design", "implement-new"],
			),
		/previously owned execution disappeared/,
	);
});

test("durable launch drain blocks in-flight, live, unknown, and repairing work", () => {
	const now = Date.parse("2026-08-14T20:00:00Z");
	assert.match(
		classifyDurableLaunchDrain(
			{ lifecycleClaims: [{ execution_id: "x", state: "starting" }] },
			now,
		).reason,
		/lifecycle_starting/,
	);
	assert.match(
		classifyDurableLaunchDrain(
			{
				launchOwners: [
					{
						execution_id: "missing-lease",
						committed_generation: null,
						released_generation: null,
						acquired_at: "2026-08-14T19:00:00Z",
						delivery_state: "pending",
					},
				],
			},
			now,
		).reason,
		/launch_owner_invalid_lease:missing-lease/,
	);
	assert.match(
		classifyDurableLaunchDrain(
			{
				launchOwners: [
					{
						execution_id: "invalid-acquired",
						committed_generation: null,
						released_generation: null,
						acquired_at: "not-a-timestamp",
						lease_expires_at: "2026-08-14T19:00:00Z",
						delivery_state: "pending",
					},
				],
			},
			now,
		).reason,
		/launch_owner_invalid_acquired_at:invalid-acquired/,
	);
	assert.match(
		classifyDurableLaunchDrain(
			{
				launchOwners: [
					{
						execution_id: "repair-missing-lease",
						committed_generation: 1,
						delivery_state: "repairing",
					},
				],
				actors: [
					{
						executionId: "repair-missing-lease",
						liveness: "dead",
						sessionStatus: "terminated",
						parkOpen: false,
					},
				],
			},
			now,
		).reason,
		/delivery_repairing_invalid_lease:repair-missing-lease/,
	);
	assert.match(
		classifyDurableLaunchDrain(
			{
				launchOwners: [
					{
						execution_id: "x",
						owner_generation: 1,
						committed_generation: null,
						lease_expires_at: "2026-08-14T20:01:00Z",
						delivery_state: "pending",
					},
				],
			},
			now,
		).reason,
		/launch_owner_live/,
	);
	assert.match(
		classifyDurableLaunchDrain(
			{
				launchOwners: [
					{
						execution_id: "late",
						owner_generation: 1,
						committed_generation: null,
						released_generation: null,
						acquired_at: "2026-08-14 19:55:00",
						lease_expires_at: "2026-08-14 19:59:00",
						delivery_state: "pending",
					},
				],
			},
			now,
		).reason,
		/launch_owner_absolute_horizon/,
	);
	assert.match(
		classifyDurableLaunchDrain(
			{
				launchOwners: [
					{
						execution_id: "x",
						owner_generation: 1,
						committed_generation: 1,
						lease_expires_at: "2026-08-14T19:00:00Z",
						delivery_state: "repairing",
						delivery_lease_expires_at: "2026-08-14T20:01:00Z",
					},
				],
				actors: [
					{
						executionId: "x",
						liveness: "dead",
						sessionStatus: "terminated",
						parkOpen: false,
					},
				],
			},
			now,
		).reason,
		/delivery_repairing/,
	);
	assert.match(
		classifyDurableLaunchDrain(
			{
				launchOwners: [
					{
						execution_id: "x",
						owner_generation: 1,
						committed_generation: 1,
						lease_expires_at: "2026-08-14T19:00:00Z",
						delivery_state: "delivered",
					},
				],
				actors: [
					{
						executionId: "x",
						liveness: "unknown",
						sessionStatus: "terminated",
						parkOpen: false,
					},
				],
			},
			now,
		).reason,
		/actor_unknown/,
	);
});

test("terminated runs do not excuse a dead actor whose QA session is still awaiting review", () => {
	const terminated = classifyDurableLaunchDrain({
		runStatus: "terminated",
		launchOwners: [
			{
				execution_id: "qa-a3",
				owner_generation: 1,
				committed_generation: 1,
				released_generation: null,
				delivery_state: "delivered",
			},
		],
		actors: [
			{
				executionId: "qa-a3",
				liveness: "dead",
				sessionStatus: "awaiting_review",
				parkOpen: true,
			},
		],
	});
	assert.match(terminated.reason, /session_unsettled:qa-a3:awaiting_review/);

	const active = classifyDurableLaunchDrain({
		runStatus: "active",
		launchOwners: [
			{
				execution_id: "qa-active",
				owner_generation: 1,
				committed_generation: 1,
				delivery_state: "delivered",
			},
		],
		actors: [
			{
				executionId: "qa-active",
				liveness: "dead",
				sessionStatus: "awaiting_review",
				parkOpen: true,
			},
		],
	});
	assert.match(active.reason, /session_unsettled:qa-active:awaiting_review/);

	const undelivered = classifyDurableLaunchDrain({
		runStatus: "terminated",
		launchOwners: [
			{
				execution_id: "qa-undelivered",
				owner_generation: 1,
				committed_generation: 1,
				delivery_state: "pending",
			},
		],
		actors: [
			{
				executionId: "qa-undelivered",
				liveness: "dead",
				sessionStatus: "awaiting_review",
				parkOpen: true,
			},
		],
	});
	assert.match(
		undelivered.reason,
		/session_unsettled:qa-undelivered:awaiting_review/,
	);

	const live = classifyDurableLaunchDrain({
		runStatus: "terminated",
		launchOwners: [
			{
				execution_id: "qa-live",
				owner_generation: 1,
				committed_generation: 1,
				delivery_state: "delivered",
			},
		],
		actors: [
			{
				executionId: "qa-live",
				liveness: "alive",
				sessionStatus: "awaiting_review",
				parkOpen: true,
			},
		],
	});
	assert.match(live.reason, /actor_alive:qa-live/);
});

test("A3 exit targets the exact QA session and requires an irreversible terminal receipt", () => {
	assert.deepEqual(
		buildA3QaTerminationRequest({
			executionId: "qa-a3",
			leadId: "flywheel-test-2",
		}),
		{
			path: "/api/actions/terminate",
			body: {
				execution_id: "qa-a3",
				leadId: "flywheel-test-2",
				reason:
					"FLY-1775 A3 diagnostic exit: retire the QA session before the driver exits",
			},
		},
	);
	for (const status of [
		"blocked",
		"cancelled",
		"completed",
		"failed",
		"terminated",
	]) {
		for (const terminalAt of ["2026-08-15 12:00:00", null]) {
			assert.equal(
				a3QaSessionIsIrreversiblyTerminal(
					{
						execution_id: "qa-a3",
						status,
						terminal_at: terminalAt,
					},
					"qa-a3",
				),
				true,
				`${status} must use the same irreversible-terminal predicate as launch drain even when the legacy terminal stamp is absent`,
			);
		}
	}
	for (const unsettled of [
		{
			execution_id: "qa-a3",
			status: "awaiting_review",
			terminal_at: null,
		},
		{
			execution_id: "qa-foreign",
			status: "terminated",
			terminal_at: "2026-08-15 12:00:00",
		},
	]) {
		assert.equal(a3QaSessionIsIrreversiblyTerminal(unsettled, "qa-a3"), false);
	}
});

test("A3 closeout never re-terminates an exact session already in an irreversible terminal state", async () => {
	for (const status of ["completed", "cancelled"]) {
		for (const terminalAt of ["2026-08-15 12:00:00", null]) {
			let fetchCalls = 0;
			const result = await terminateQaSessionForA3({
				executionId: "qa-a3",
				leadId: "flywheel-test-2",
				bridgeUrl: "http://127.0.0.1:19872",
				token: "test-token",
				runId: "run-a3",
				timeoutMs: 10_000,
				fetchImpl: async () => {
					fetchCalls += 1;
					throw new Error(
						"an irreversible terminal session must not be terminated",
					);
				},
				readSession: () => ({
					execution_id: "qa-a3",
					status,
					terminal_at: terminalAt,
				}),
				requestExecutionExit: () => {},
				probeExecution: () => ({ liveness: "dead" }),
				waitFor: async (_label, probe) => probe(),
			});
			assert.equal(fetchCalls, 0);
			assert.equal(result.session.status, status);
		}
	}
});

test("A3 closeout persists the terminal session before fencing and waiting for actor exit", async () => {
	let session = {
		execution_id: "qa-a3",
		status: "awaiting_review",
		terminal_at: null,
	};
	const exits = [];
	const result = await terminateQaSessionForA3({
		executionId: "qa-a3",
		leadId: "flywheel-test-2",
		bridgeUrl: "http://127.0.0.1:19872",
		token: "test-token",
		runId: "run-a3",
		timeoutMs: 10_000,
		fetchImpl: async (url, options) => {
			assert.equal(url, "http://127.0.0.1:19872/api/actions/terminate");
			assert.equal(options.headers.authorization, "Bearer test-token");
			assert.deepEqual(JSON.parse(options.body), {
				execution_id: "qa-a3",
				leadId: "flywheel-test-2",
				reason:
					"FLY-1775 A3 diagnostic exit: retire the QA session before the driver exits",
			});
			session = {
				execution_id: "qa-a3",
				status: "terminated",
				terminal_at: "2026-08-15 12:00:00",
			};
			return new Response(JSON.stringify({ success: true }), { status: 200 });
		},
		readSession: () => session,
		requestExecutionExit: () => exits.push("qa-a3"),
		probeExecution: () => ({ executionId: "qa-a3", liveness: "dead" }),
		waitFor: async (label, probe, timeoutMs) => {
			assert.equal(label, "A3 QA execution exit");
			assert.equal(timeoutMs, 10_000);
			return probe();
		},
	});
	assert.equal(exits.length, 2);
	assert.equal(result.session.status, "terminated");
	assert.equal(result.actor.liveness, "dead");
});

test("A3 closeout is response-loss idempotent but refuses a non-terminal session", async () => {
	const terminal = {
		execution_id: "qa-a3",
		status: "terminated",
		terminal_at: "2026-08-15 12:00:00",
	};
	let committedBeforeResponseLoss = false;
	await assert.doesNotReject(() =>
		terminateQaSessionForA3({
			executionId: "qa-a3",
			leadId: "flywheel-test-2",
			bridgeUrl: "http://127.0.0.1:19872",
			token: "test-token",
			runId: "run-a3",
			timeoutMs: 10_000,
			fetchImpl: async () => {
				committedBeforeResponseLoss = true;
				throw new Error("response lost after commit");
			},
			readSession: () =>
				committedBeforeResponseLoss
					? terminal
					: {
							execution_id: "qa-a3",
							status: "awaiting_review",
							terminal_at: null,
						},
			requestExecutionExit: () => {},
			probeExecution: () => ({ liveness: "dead" }),
			waitFor: async (_label, probe) => probe(),
		}),
	);

	await assert.rejects(
		() =>
			terminateQaSessionForA3({
				executionId: "qa-a3",
				leadId: "flywheel-test-2",
				bridgeUrl: "http://127.0.0.1:19872",
				token: "test-token",
				runId: "run-a3",
				timeoutMs: 10_000,
				fetchImpl: async () =>
					new Response(JSON.stringify({ error: "forbidden" }), {
						status: 403,
					}),
				readSession: () => ({
					execution_id: "qa-a3",
					status: "awaiting_review",
					terminal_at: null,
				}),
				requestExecutionExit: () => {
					throw new Error("must not fence an unsettled session");
				},
				probeExecution: () => ({ liveness: "dead" }),
				waitFor: async (_label, probe) => probe(),
			}),
		/A3 QA session termination failed.*403/,
	);
});

test("durable launch drain passes only after committed actors are dead and settled", () => {
	const result = classifyDurableLaunchDrain(
		{
			lifecycleClaims: [{ execution_id: "x", state: "closed" }],
			launchOwners: [
				{
					execution_id: "x",
					owner_generation: 1,
					committed_generation: 1,
					lease_expires_at: "2026-08-14T19:00:00Z",
					delivery_state: "delivered",
				},
			],
			actors: [
				{
					executionId: "x",
					liveness: "dead",
					sessionStatus: "terminated",
					parkOpen: false,
				},
			],
		},
		Date.parse("2026-08-14T20:00:00Z"),
	);
	assert.deepEqual(result, { settled: true, reason: "settled" });
});

test("QA PASS preflight names every missing PR authority link", () => {
	assert.deepEqual(
		validateQaShipPreconditions({
			qaWorktreeBinding: null,
			producerPrNumber: null,
			producerPrHead: null,
			gateEntryBinding: null,
			remotePr: null,
			expectedHead: "a".repeat(40),
		}),
		{
			ok: false,
			failures: [
				"qa_worktree_binding_missing",
				"producer_pr_number_missing",
				"producer_pr_head_missing",
				"workflow_node_pr_binding_missing",
				"sandbox_pr_missing",
			],
			predictedServerReason: "land_head_unavailable",
		},
	);
	assert.deepEqual(
		validateQaShipPreconditions({
			qaWorktreeBinding: { path: "/tmp/wt", generation: "g" },
			producerPrNumber: 42,
			producerPrHead: "a".repeat(40),
			gateEntryBinding: { pr_number: 42, head_sha: "a".repeat(40) },
			remotePr: { state: "OPEN", isDraft: false, headRefOid: "a".repeat(40) },
			expectedHead: "a".repeat(40),
		}),
		{ ok: true, failures: [] },
	);
});
