#!/usr/bin/env node
// FLY-2799: QA-owned, isolated two-persona Codex voice harness.
// It delegates room lifecycle to the FLY-2655 test-slot carrier and never
// installs launchd state or changes a production backend route.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { loadSlot } from "./fly2655-voice-room.mjs";

export const FLY2799_CONTRACT_SHA = "313befcfa3a7039dca2fc7eb1178803d47699026";
export const FLY2799_BINARY_VERSION = "codex-cli 0.156.1";
export const FLY2799_BINARY_SHA256 =
	"0196e89fe5a7598f816ee54232c3d7c26d75e502ab5cfe2c9240e81d90f7255a";
export const FLY2799_CAPABILITIES = Object.freeze({
	verbatim: false,
	attribution: false,
	bargeIn: false,
});

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const roomHarness = join(repo, "scripts/qa/fly2655-voice-room.mjs");
const SHA256 = /^[a-f0-9]{64}$/;
const HEAD_SHA = /^[a-f0-9]{40}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SLOT = /^\/(?:private\/)?tmp\/flywheel-test-slot-[1-9][0-9]*$/;
const MAX_JSON_BYTES = 1024 * 1024;

function check(value, reason) {
	if (!value) throw new Error(reason);
}

function exactKeys(value, expected, reason) {
	check(value && typeof value === "object" && !Array.isArray(value), reason);
	check(
		Object.keys(value).sort().join(",") === [...expected].sort().join(","),
		reason,
	);
}

function validDate(value) {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function directChild(root, path, reason) {
	check(typeof path === "string" && isAbsolute(path), reason);
	const resolvedRoot = resolve(root);
	const resolvedPath = resolve(path);
	check(dirname(resolvedPath) === resolvedRoot, reason);
	return resolvedPath;
}

function underRoot(root, path, reason) {
	const canonicalRoot = realpathSync(root);
	const canonicalPath = realpathSync(path);
	const rel = relative(canonicalRoot, canonicalPath);
	check(
		rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel),
		reason,
	);
	check(!lstatSync(path).isSymbolicLink(), reason);
	return canonicalPath;
}

export function readPrivateJson(path, maxBytes = MAX_JSON_BYTES) {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = fstatSync(fd);
		const uid = process.getuid?.();
		check(
			info.isFile() &&
				info.size <= maxBytes &&
				(info.mode & 0o777) === 0o600 &&
				(uid === undefined || info.uid === uid),
			"private_json_invalid",
		);
		return JSON.parse(readFileSync(fd, "utf8"));
	} finally {
		closeSync(fd);
	}
}

function writePrivateJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
		mode: 0o600,
		flag: "wx",
	});
}

function validateGate(value, name) {
	exactKeys(value, ["status", "receiptId"], `manifest_${name}_invalid`);
	check(value.status === "closed", `manifest_${name}_not_closed`);
	check(
		typeof value.receiptId === "string" && ID.test(value.receiptId),
		`manifest_${name}_invalid`,
	);
}

function validateEngine(value) {
	exactKeys(
		value,
		[
			"backendId",
			"binaryPath",
			"binaryVersion",
			"binarySha256",
			"realtimeVersion",
			"model",
			"configDigest",
			"capabilities",
		],
		"manifest_engine_invalid",
	);
	check(value.backendId === "codex-realtime", "manifest_backend_invalid");
	check(isAbsolute(value.binaryPath), "manifest_binary_absolute_required");
	check(
		value.binaryVersion === FLY2799_BINARY_VERSION &&
			value.binarySha256 === FLY2799_BINARY_SHA256,
		"manifest_binary_pin_invalid",
	);
	check(
		value.realtimeVersion === "v2" && value.model === "gpt-realtime-2.1",
		"manifest_realtime_pin_invalid",
	);
	check(SHA256.test(value.configDigest), "manifest_config_digest_invalid");
	exactKeys(
		value.capabilities,
		["verbatim", "attribution", "bargeIn"],
		"manifest_capabilities_invalid",
	);
	check(
		Object.entries(FLY2799_CAPABILITIES).every(
			([name, enabled]) => value.capabilities[name] === enabled,
		),
		"manifest_capabilities_drift",
	);
}

function validateRun(value) {
	exactKeys(
		value,
		[
			"persona",
			"slotDir",
			"projectName",
			"leadId",
			"leadModel",
			"topic",
			"holdSeconds",
			"verdictPath",
		],
		"manifest_run_invalid",
	);
	check(
		["raya", "honey-lemon"].includes(value.persona),
		"manifest_persona_invalid",
	);
	check(SLOT.test(value.slotDir), "manifest_slot_invalid");
	check(
		value.persona === "raya"
			? value.projectName === "raya" && value.leadId === "raya"
			: value.projectName === "flywheel" &&
					value.leadId === "flywheel-product-lead" &&
					/^opus(?:\[|$)/.test(value.leadModel),
		"manifest_persona_binding_invalid",
	);
	check(
		typeof value.leadModel === "string" && value.leadModel,
		"manifest_lead_model_invalid",
	);
	check(
		typeof value.topic === "string" &&
			value.topic.trim() === value.topic &&
			value.topic.length > 0 &&
			Array.from(value.topic).length <= 200,
		"manifest_topic_invalid",
	);
	check(
		Number.isSafeInteger(value.holdSeconds) &&
			value.holdSeconds >= 30 &&
			value.holdSeconds <= 900,
		"manifest_hold_invalid",
	);
	directChild(
		value.slotDir,
		value.verdictPath,
		"manifest_verdict_path_invalid",
	);
	return value;
}

export function validateAuthorizedManifest(value, now = new Date()) {
	exactKeys(
		value,
		[
			"schemaVersion",
			"kind",
			"issueId",
			"contractSha",
			"authorizedBy",
			"authorizedAt",
			"expiresAt",
			"expectedHead",
			"productionRoutingChangeAuthorized",
			"gates",
			"engine",
			"runs",
			"receiptPath",
		],
		"manifest_invalid",
	);
	check(
		value.schemaVersion === 1 &&
			value.kind === "fly2799-authorized-test-room" &&
			value.issueId === "FLY-2799" &&
			value.contractSha === FLY2799_CONTRACT_SHA,
		"manifest_identity_invalid",
	);
	check(
		typeof value.authorizedBy === "string" && ID.test(value.authorizedBy),
		"manifest_authorizer_invalid",
	);
	check(
		validDate(value.authorizedAt) && validDate(value.expiresAt),
		"manifest_time_invalid",
	);
	const authorizedAt = Date.parse(value.authorizedAt);
	const expiresAt = Date.parse(value.expiresAt);
	const at = now.getTime();
	check(
		authorizedAt <= at &&
			at < expiresAt &&
			expiresAt - authorizedAt <= 24 * 60 * 60 * 1000,
		"manifest_authorization_expired",
	);
	check(HEAD_SHA.test(value.expectedHead), "manifest_head_invalid");
	check(
		value.productionRoutingChangeAuthorized === false,
		"production_route_mutation_rejected",
	);
	exactKeys(value.gates, ["g1", "g2"], "manifest_gates_invalid");
	validateGate(value.gates.g1, "g1");
	validateGate(value.gates.g2, "g2");
	validateEngine(value.engine);
	check(
		Array.isArray(value.runs) && value.runs.length === 2,
		"manifest_runs_invalid",
	);
	const runs = value.runs.map(validateRun);
	check(
		new Set(runs.map((run) => run.persona)).size === 2 &&
			new Set(runs.map((run) => resolve(run.slotDir))).size === 2,
		"manifest_runs_not_disjoint",
	);
	check(isAbsolute(value.receiptPath), "manifest_receipt_path_invalid");
	return value;
}

function digestFile(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function inspectBinary(path) {
	const info = lstatSync(path);
	check(
		info.isFile() && !info.isSymbolicLink() && (info.mode & 0o100) !== 0,
		"codex_binary_invalid",
	);
	const version = execFileSync(path, ["--version"], {
		encoding: "utf8",
		timeout: 5_000,
		env: {},
	}).trim();
	const features = execFileSync(path, ["features", "list"], {
		encoding: "utf8",
		timeout: 5_000,
		env: {},
	});
	return {
		version,
		sha256: digestFile(path),
		realtimeFeatureEnabled: /^realtime_conversation\s+stable\s+true$/mu.test(
			features,
		),
	};
}

function repositoryState() {
	return {
		head: execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: repo,
			encoding: "utf8",
		}).trim(),
		dirty:
			execFileSync("git", ["status", "--porcelain"], {
				cwd: repo,
				encoding: "utf8",
			}).trim() !== "",
	};
}

function parseLastJson(output, reason) {
	const line = output.trim().split("\n").filter(Boolean).at(-1);
	check(line, reason);
	return JSON.parse(line);
}

function roomCommand(command, run, manifest, sessionId) {
	const args = [
		roomHarness,
		command,
		"--slot-dir",
		run.slotDir,
		"--expected-head",
		manifest.expectedHead,
	];
	if (command === "start") args.push("--mode", "meeting", "--topic", run.topic);
	if ((command === "stop" || command === "verify") && sessionId)
		args.push("--session", sessionId);
	const stdout = execFileSync(process.execPath, args, {
		cwd: repo,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
		env: {
			...process.env,
			FLYWHEEL_VOICE_BACKEND: manifest.engine.backendId,
			FLYWHEEL_CODEX_BIN: manifest.engine.binaryPath,
		},
	});
	return parseLastJson(stdout, `room_${command}_output_missing`);
}

function assertRunTopology(run, manifest) {
	const slot = loadSlot(run.slotDir, manifest.expectedHead);
	check(
		slot.topology.projectName === run.projectName &&
			slot.topology.leadId === run.leadId &&
			slot.lead.model === run.leadModel,
		"manifest_slot_topology_drift",
	);
}

function readJsonLines(slotDir, path) {
	if (!existsSync(path)) return [];
	underRoot(slotDir, path, "evidence_path_outside_slot");
	const info = lstatSync(path);
	check(
		info.isFile() && info.size <= 32 * MAX_JSON_BYTES,
		"evidence_file_invalid",
	);
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function collectEvidence(run, started) {
	const transcriptPath = join(
		run.slotDir,
		"state/voice/sessions",
		started.sessionId,
		"codex-transcript.jsonl",
	);
	const minutesRoot = join(run.slotDir, "state/voice/minutes");
	const minuteJobs = existsSync(minutesRoot)
		? readdirSync(minutesRoot)
				.filter(
					(name) =>
						SHA256.test(name.replace(/\.json$/, "")) && name.endsWith(".json"),
				)
				.map((name) => readPrivateJson(join(minutesRoot, name)))
				.filter((job) => job?.payload?.sessionId === started.sessionId)
		: [];
	return {
		events: readJsonLines(run.slotDir, started.evidencePath),
		transcript: readJsonLines(run.slotDir, transcriptPath),
		minuteJobs,
	};
}

function validateVerdict(value, run, started, capabilities) {
	exactKeys(
		value,
		[
			"schemaVersion",
			"issueId",
			"sessionId",
			"persona",
			"evaluatorUserId",
			"heardAssistantAudio",
			"identityFactCount",
			"currentWorkObserved",
			"pendingDecisionObserved",
			"externalAudioAnswered",
			"activeSpeakObserved",
			"controlCadenceObserved",
			"interruptResult",
			"actionHandoff",
			"notes",
		],
		"qa_verdict_invalid",
	);
	check(
		value.schemaVersion === 1 &&
			value.issueId === "FLY-2799" &&
			value.sessionId === started.sessionId &&
			value.persona === run.persona &&
			typeof value.evaluatorUserId === "string" &&
			ID.test(value.evaluatorUserId),
		"qa_verdict_identity_invalid",
	);
	for (const name of [
		"heardAssistantAudio",
		"currentWorkObserved",
		"pendingDecisionObserved",
		"externalAudioAnswered",
		"activeSpeakObserved",
		"controlCadenceObserved",
	])
		check(typeof value[name] === "boolean", "qa_verdict_invalid");
	check(
		Number.isSafeInteger(value.identityFactCount) &&
			value.identityFactCount >= 1,
		"qa_identity_facts_missing",
	);
	check(
		["passed", "failed", "not-testable"].includes(value.interruptResult),
		"qa_interrupt_invalid",
	);
	check(
		typeof value.notes === "string" && value.notes.length <= 4_096,
		"qa_notes_invalid",
	);
	exactKeys(
		value.actionHandoff,
		["requested", "targetLeadId", "deliveryId", "state", "reason"],
		"qa_handoff_invalid",
	);
	check(
		value.actionHandoff.targetLeadId === run.leadId,
		"qa_handoff_target_invalid",
	);
	if (!capabilities.attribution) {
		check(
			value.actionHandoff.requested === false &&
				value.actionHandoff.deliveryId === null &&
				value.actionHandoff.state === "blocked" &&
				value.actionHandoff.reason === "attribution_false",
			"qa_handoff_must_fail_closed",
		);
	}
	return value;
}

function challenge(run, started, manifest) {
	return {
		schemaVersion: 1,
		issueId: "FLY-2799",
		sessionId: started.sessionId,
		persona: run.persona,
		leadId: run.leadId,
		leadModel: run.leadModel,
		expectedHead: manifest.expectedHead,
		verdictPath: run.verdictPath,
		capabilities: manifest.engine.capabilities,
		requiredChecks: [
			"assistant_audio",
			"unique_memory_fact",
			"current_work",
			"pending_decision",
			"external_audio_answer",
			"active_speak",
			"control_cadence",
			"interrupt_or_fail_closed",
			"action_handoff_or_attribution_fail_closed",
		],
	};
}

async function waitForVerdict(run, started, manifest, deps) {
	check(!existsSync(run.verdictPath), "qa_verdict_must_not_preexist");
	const challengePath = directChild(
		run.slotDir,
		join(
			run.slotDir,
			`fly2799-${run.persona}-${started.sessionId}-challenge.json`,
		),
		"qa_challenge_path_invalid",
	);
	deps.writePrivateJson(challengePath, challenge(run, started, manifest));
	deps.emit({
		status: "WAITING_FOR_QA_VERDICT",
		persona: run.persona,
		sessionId: started.sessionId,
		challengePath,
		verdictPath: run.verdictPath,
	});
	const deadline = deps.now().getTime() + run.holdSeconds * 1_000;
	while (deps.now().getTime() < deadline) {
		if (existsSync(run.verdictPath))
			return validateVerdict(
				deps.readPrivateJson(run.verdictPath),
				run,
				started,
				manifest.engine.capabilities,
			);
		await deps.pause(1_000);
	}
	throw new Error("qa_verdict_timeout");
}

export function summarizeRunEvidence(input) {
	const opened = input.evidence.events.filter(
		(event) => event.kind === "codex_voice_container_opened",
	);
	const closed = input.evidence.events.filter(
		(event) => event.kind === "codex_voice_container_closed",
	);
	const proof = input.evidence.events.filter(
		(event) => event.kind === "codex_speak_receipt",
	);
	const roles = new Set(
		input.evidence.transcript
			.filter((entry) => entry.final === true)
			.map((entry) => entry.role),
	);
	const minute = input.evidence.minuteJobs;
	const automated =
		opened.length === 1 &&
		opened[0].sessionId === input.started.sessionId &&
		opened[0].binaryDigest === input.manifest.engine.binarySha256 &&
		opened[0].configDigest === input.manifest.engine.configDigest &&
		SHA256.test(String(opened[0].contextDigest)) &&
		closed.length === 1 &&
		closed[0].sessionId === input.started.sessionId &&
		closed[0].threadId === opened[0].threadId &&
		input.evidence.events.every(
			(event) =>
				event.kind !== "codex_voice_cleanup_pending" &&
				event.kind !== "codex_voice_capability_violation" &&
				event.kind !== "codex_input_gap",
		) &&
		proof.length >= 1 &&
		proof.every(
			(receipt) =>
				receipt.outcome === "completed" &&
				receipt.transport === "submitted" &&
				receipt.contentProof === "transcript_equivalent",
		) &&
		roles.has("user") &&
		roles.has("assistant") &&
		minute.length === 1 &&
		minute[0].state === "delivered" &&
		minute[0].payload?.sessionId === input.started.sessionId;
	const human =
		input.verdict.heardAssistantAudio === true &&
		input.verdict.identityFactCount >= 1 &&
		input.verdict.currentWorkObserved === true &&
		input.verdict.pendingDecisionObserved === true &&
		input.verdict.externalAudioAnswered === true &&
		input.verdict.activeSpeakObserved === true &&
		input.verdict.controlCadenceObserved === true &&
		(input.manifest.engine.capabilities.bargeIn
			? input.verdict.interruptResult === "passed"
			: input.verdict.interruptResult === "not-testable");
	return {
		persona: input.run.persona,
		sessionId: input.started.sessionId,
		threadId: opened[0]?.threadId ?? null,
		contextDigest: opened[0]?.contextDigest ?? null,
		transcriptDigest: createHash("sha256")
			.update(JSON.stringify(input.evidence.transcript))
			.digest("hex"),
		userTranscriptCount: input.evidence.transcript.filter(
			(entry) => entry.final === true && entry.role === "user",
		).length,
		assistantTranscriptCount: input.evidence.transcript.filter(
			(entry) => entry.final === true && entry.role === "assistant",
		).length,
		speakProofCount: proof.length,
		minutesDeliveryId: minute[0]?.deliveryId ?? null,
		automatedEvidencePassed: automated,
		humanEvidencePassed: human,
	};
}

export async function runHarness(manifestInput, overrides = {}) {
	const deps = {
		now: () => new Date(),
		pause: (ms) => new Promise((done) => setTimeout(done, ms)),
		inspectBinary,
		repositoryState,
		assertRunTopology,
		roomCommand,
		collectEvidence,
		readPrivateJson,
		writePrivateJson,
		emit: (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
		waitForVerdict,
		...overrides,
	};
	const manifest = validateAuthorizedManifest(manifestInput, deps.now());
	const binary = await deps.inspectBinary(manifest.engine.binaryPath);
	check(
		binary.version === manifest.engine.binaryVersion &&
			binary.sha256 === manifest.engine.binarySha256 &&
			binary.realtimeFeatureEnabled === true,
		"codex_binary_evidence_mismatch",
	);
	const state = await deps.repositoryState();
	check(
		state.head === manifest.expectedHead && state.dirty === false,
		"checkout_not_exact_clean_head",
	);
	const summaries = [];
	for (const run of manifest.runs) {
		await deps.assertRunTopology(run, manifest);
		await deps.roomCommand("prepare", run, manifest);
		const started = await deps.roomCommand("start", run, manifest);
		let verdict;
		try {
			verdict = await deps.waitForVerdict(run, started, manifest, deps);
		} finally {
			await deps.roomCommand("stop", run, manifest, started.sessionId);
		}
		const verified = await deps.roomCommand(
			"verify",
			run,
			manifest,
			started.sessionId,
		);
		const evidence = await deps.collectEvidence(run, started, verified);
		summaries.push(
			summarizeRunEvidence({
				run,
				manifest,
				started,
				verified,
				verdict,
				evidence,
			}),
		);
	}
	check(
		new Set(summaries.map((row) => row.threadId)).size === summaries.length,
		"qa_threads_not_unique",
	);
	const evidencePassed = summaries.every(
		(row) => row.automatedEvidencePassed && row.humanEvidencePassed,
	);
	const capabilityGatesOpen = Object.values(manifest.engine.capabilities).every(
		Boolean,
	);
	return {
		schemaVersion: 1,
		issueId: "FLY-2799",
		status: !evidencePassed
			? "FAILED"
			: capabilityGatesOpen
				? "PASSED"
				: "INCOMPLETE_CAPABILITY_GATES",
		checkedAt: deps.now().toISOString(),
		expectedHead: manifest.expectedHead,
		contractSha: manifest.contractSha,
		binary,
		engine: {
			backendId: manifest.engine.backendId,
			realtimeVersion: manifest.engine.realtimeVersion,
			model: manifest.engine.model,
			configDigest: manifest.engine.configDigest,
			capabilities: manifest.engine.capabilities,
		},
		runs: summaries,
	};
}

async function main(argv) {
	const { values } = parseArgs({
		args: argv,
		options: { manifest: { type: "string" } },
		allowPositionals: false,
		strict: true,
	});
	check(
		values.manifest && isAbsolute(values.manifest),
		"absolute_manifest_required",
	);
	const manifestPath = resolve(values.manifest);
	const manifest = validateAuthorizedManifest(readPrivateJson(manifestPath));
	directChild(
		dirname(manifestPath),
		manifest.receiptPath,
		"manifest_receipt_path_invalid",
	);
	check(!existsSync(manifest.receiptPath), "qa_receipt_exists");
	const receipt = await runHarness(manifest);
	writePrivateJson(manifest.receiptPath, receipt);
	process.stdout.write(`${JSON.stringify(receipt)}\n`);
	process.exitCode = receipt.status === "PASSED" ? 0 : 2;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(
			`fly2799-codex-container: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exitCode = 1;
	});
}
