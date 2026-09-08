#!/usr/bin/env node
// FLY-2383 — PRD 1850 §7.3: the half that was never measured.
//
// One continuous voice session in the 529 QA room, while real runner
// orchestration is in flight, for half an hour. It records what happened; it
// does not decide whether that is good enough. There are no thresholds here.
//
//   usage: node scripts/qa-voice-concurrency-soak.mjs \
//            --subject-root <absolute-path-to-built-raya-worktree> \
//            --run-id fly2383-arm-a --duration-ms 1800000 [--bed off]
//
// Wrap the whole invocation in `caffeinate -dimsu` — a sleeping machine breaks
// the window, and a broken window is an invalid run.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
	assertThresholdsCalibrated,
	classifyFrame,
	classSeconds,
	createSecondBucketAccumulator,
	extractFeatures,
	hasQuietWindow,
} from "./lib/voice-soak/audio-classify.mjs";
import {
	parseLiveCandidates,
	parseStatusReceipt,
	summarizeOrchestrationOverlap,
} from "./lib/voice-soak/bridge-orchestration.mjs";
import { CROSS_REPO, MAX_HOLE_SHARE } from "./lib/voice-soak/constants.mjs";
import {
	judgeAudioEligibility,
	judgeRecognition,
	tallyRounds,
} from "./lib/voice-soak/eligibility.mjs";
import {
	atomicWriteJson,
	resolveThreeConditions,
	resolveVerdict,
} from "./lib/voice-soak/manifest.mjs";
import {
	bothPresentCensus,
	validDiscordReadyReceipt,
	validLiveReceipt,
	voiceReadyCensus,
} from "./lib/voice-soak/receipts.mjs";

const DEFAULT_HARNESS_ROOT = join(homedir(), ".flywheel", "raya", "code");
const QA_ROOT = join(homedir(), ".flywheel", "raya", "qa");
const RUNS_ROOT = join(QA_ROOT, "FLY-2383-runs");
const ENV_FILE = join(homedir(), ".flywheel", ".env");
const RAYA_ENV_FILE = join(homedir(), ".flywheel", "raya", "raya.env");
const SLOTS_FILE = join(homedir(), ".flywheel", "test-slots.json");

const READY_TIMEOUT_MS = 90_000;
const LIVE_TIMEOUT_MS = 120_000;
const SILENCE_GUARD_MS = 3_000;
const INJECT_WAIT_MAX_MS = 45_000;
const RECOGNITION_TIMEOUT_MS = 20_000;
const _TURN_TIMEOUT_MS = 180_000;
const FRAME_DRAIN_INTERVAL_MS = 3_000;
const PACKET_SAMPLE_INTERVAL_MS = 60_000;
const BRIDGE_SAMPLE_INTERVAL_MS = 30_000;
const MAX_POLL_LAG_MS = 15_000;
const CLEANUP_TIMEOUT_MS = 30_000;
// Long enough for her to acknowledge the request, fall silent, and for the bed
// to pass its minimum-busy delay before the probe is spoken.
const BED_WORK_SETTLE_MS = 12_000;
const PLAYBACK_TAIL_MS = 500;
const MIN_BED_FRAMES = 10;
// 60 seconds of history: far more than any single playback window needs, and
// bounded so a half-hour run does not accumulate 90,000 objects.
const FRAME_RING_SIZE = 3_000;
const FRAME_FLUSH_EVERY = 250;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const nowMono = () => performance.now();
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function flushFrames(state) {
	if (state.frameBuffer.length === 0) return;
	const lines = state.frameBuffer.map((row) => JSON.stringify(row)).join("\n");
	state.frameBuffer = [];
	appendFileSync(state.framesPath, `${lines}\n`, { mode: 0o600 });
}

function fail(message, code = 78) {
	process.stderr.write(`${JSON.stringify({ ready: false, error: message })}\n`);
	process.exit(code);
}

/**
 * Every credential-looking value in the operator env, not just the three this
 * run happens to use. A scan that only knows about the tokens we remembered to
 * list is a scan that passes for the wrong reason.
 *
 * Values that are themselves env var *names* (some settings point at another
 * key) are skipped — matching those would fail every run on a false positive.
 */
function collectScannableSecrets(paths) {
	const found = new Set();
	for (const path of paths) {
		let parsed;
		try {
			parsed = parseOwnerPrivateEnv(path);
		} catch {
			continue;
		}
		for (const [key, value] of Object.entries(parsed)) {
			if (!/TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL/.test(key)) continue;
			if (typeof value !== "string" || value.length < 16) continue;
			if (/^[A-Z][A-Z0-9_]*$/.test(value)) continue; // a key name, not a secret
			found.add(value);
		}
	}
	return [...found];
}

function parseOwnerPrivateEnv(path) {
	const parsed = {};
	for (const line of readFileSync(path, "utf8").split(/\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const match = trimmed.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
		if (!match?.[1]) continue;
		let value = (match[2] ?? "").trim();
		const first = value.at(0);
		if ((first === '"' || first === "'") && value.at(-1) === first) {
			value = value.slice(1, -1);
		}
		parsed[match[1]] = value;
	}
	return parsed;
}

function gitState(root) {
	const sha = execFileSync("/usr/bin/git", ["-C", root, "rev-parse", "HEAD"], {
		encoding: "utf8",
	}).trim();
	const dirty = execFileSync(
		"/usr/bin/git",
		["-C", root, "status", "--porcelain"],
		{ encoding: "utf8" },
	)
		.split("\n")
		.filter((line) => line.trim() && !line.startsWith("?? "));
	return { sha, dirty: dirty.length > 0, dirtyPaths: dirty };
}

function parseCliArgs(argv) {
	const { values } = parseArgs({
		args: argv,
		options: {
			"subject-root": { type: "string" },
			"harness-root": { type: "string" },
			"run-id": { type: "string" },
			"duration-ms": { type: "string" },
			"inject-every-ms": { type: "string" },
			"channel-id": { type: "string" },
			"emitter-bot": { type: "string" },
			"voice-bot": { type: "string" },
			bed: { type: "string" },
			"expected-harness-sha": { type: "string" },
			"expected-subject-sha": { type: "string" },
			"thresholds-file": { type: "string" },
			"require-min-duration": { type: "boolean" },
			calibrate: { type: "boolean" },
		},
		strict: true,
		allowPositionals: false,
	});
	const subjectRoot = values["subject-root"];
	if (!subjectRoot?.startsWith("/"))
		fail("--subject-root must be absolute", 64);
	const runId = values["run-id"];
	if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(runId ?? "")) {
		fail("--run-id must be a lowercase slug", 64);
	}
	const bed = values.bed ?? "on";
	if (bed !== "on" && bed !== "off") fail("--bed must be on or off", 64);
	return {
		subjectRoot: resolve(subjectRoot),
		harnessRoot: resolve(values["harness-root"] ?? DEFAULT_HARNESS_ROOT),
		runId,
		durationMs: Number(values["duration-ms"] ?? 1_800_000),
		injectEveryMs: Number(values["inject-every-ms"] ?? 120_000),
		channelId: values["channel-id"] ?? null,
		emitterSlot: Number(values["emitter-bot"] ?? 1),
		voiceSlot: Number(values["voice-bot"] ?? 2),
		bed,
		expectedHarnessSha:
			values["expected-harness-sha"] ?? CROSS_REPO.EXPECTED_RAYA_SHA,
		expectedSubjectSha:
			values["expected-subject-sha"] ?? CROSS_REPO.EXPECTED_RAYA_SHA,
		thresholdsFile: values["thresholds-file"] ?? null,
		requireMinDuration: values["require-min-duration"] === true,
		// Calibration pilot: no thresholds exist yet, so the quiet guard cannot run
		// and no eligibility or recognition is judged. It only collects labelled
		// feature windows for deriveThresholds().
		calibrate: values.calibrate === true,
	};
}

/**
 * Pin both repositories BEFORE importing anything from them. The contract
 * handshake versions the 529 scenario protocol, not the internal modules this
 * driver imports directly, so a semantically drifted module with a compatible
 * signature would sail straight through it. Checking the SHA first also means a
 * drifted module's top-level code never runs.
 */
/**
 * Hash everything the run actually executed with.
 *
 * A clean git SHA is not enough on its own: the driver dynamically imports
 * raya's `packages/contracts/dist/index.js`, and raya gitignores `dist/`, so
 * that file is not in the pinned commit at all. Anything the run depends on gets
 * hashed by content.
 */
function collectorProvenance(args) {
	const flywheelRoot = resolve(new URL("..", import.meta.url).pathname);
	const collectorFiles = [
		"scripts/qa-voice-concurrency-soak.mjs",
		"scripts/lib/voice-soak/constants.mjs",
		"scripts/lib/voice-soak/audio-classify.mjs",
		"scripts/lib/voice-soak/eligibility.mjs",
		"scripts/lib/voice-soak/bridge-orchestration.mjs",
		"scripts/lib/voice-soak/receipts.mjs",
		"scripts/lib/voice-soak/manifest.mjs",
	];
	const hashOf = (path) => {
		try {
			return sha256(readFileSync(path));
		} catch {
			return null;
		}
	};
	return {
		flywheelRoot,
		flywheel: gitState(flywheelRoot),
		collector: Object.fromEntries(
			collectorFiles.map((relative) => [
				relative,
				hashOf(join(flywheelRoot, relative)),
			]),
		),
		crossRepoImports: Object.fromEntries(
			Object.entries(CROSS_REPO.IMPORTS).map(([_name, relative]) => [
				relative,
				hashOf(join(args.harnessRoot, relative)),
			]),
		),
		thresholdsFile: args.thresholdsFile
			? { path: args.thresholdsFile, sha256: hashOf(args.thresholdsFile) }
			: null,
		cli: process.argv.slice(2),
	};
}

function pinRepositories(args) {
	const harness = gitState(args.harnessRoot);
	const subject = gitState(args.subjectRoot);
	for (const [label, state, expected] of [
		["harness", harness, args.expectedHarnessSha],
		["subject", subject, args.expectedSubjectSha],
	]) {
		if (state.dirty)
			fail(`${label} root is dirty: ${state.dirtyPaths.join(",")}`);
		if (state.sha !== expected) {
			fail(
				`${label} root is at ${state.sha}, expected ${expected}; pass --expected-${label}-sha to run another commit`,
			);
		}
	}
	const cliPath = join(args.subjectRoot, "apps/voice/dist/cli.js");
	if (!existsSync(cliPath))
		fail("subject voice dist is missing; build it first");
	return {
		harness,
		subject,
		subjectCliSha256: sha256(readFileSync(cliPath)),
	};
}

async function loadHarness(harnessRoot) {
	const load = (relative) =>
		import(pathToFileURL(join(harnessRoot, relative)).href);
	const [
		orchestrator,
		envCompose,
		session,
		ttsFixture,
		scenario,
		emitter,
		contracts,
	] = await Promise.all([
		load(CROSS_REPO.IMPORTS.orchestrator),
		load(CROSS_REPO.IMPORTS.envCompose),
		load(CROSS_REPO.IMPORTS.session),
		load(CROSS_REPO.IMPORTS.ttsFixture),
		load(CROSS_REPO.IMPORTS.scenario),
		load(CROSS_REPO.IMPORTS.emitter),
		load(CROSS_REPO.IMPORTS.contracts),
	]);
	if (orchestrator.CONTRACT_VERSION !== CROSS_REPO.EXPECTED_CONTRACT_VERSION) {
		fail(
			`harness contract is ${orchestrator.CONTRACT_VERSION}, expected ${CROSS_REPO.EXPECTED_CONTRACT_VERSION}`,
		);
	}
	// prism-media belongs to raya's voice app; the flywheel root cannot resolve it.
	const requireRayaDep = createRequire(
		pathToFileURL(join(harnessRoot, CROSS_REPO.PRISM_ANCHOR)),
	);
	return {
		orchestrator,
		envCompose,
		session,
		ttsFixture,
		scenario,
		emitter,
		contracts,
		prism: requireRayaDep("prism-media"),
	};
}

function resolveSlot(slots, slotId) {
	const slot = slots.slots.find((entry) => entry.id === slotId);
	if (!slot) fail(`slot ${slotId} is not defined in test-slots.json`, 64);
	if (!/^[0-9]{17,20}$/.test(slot.botAppId))
		fail(`slot ${slotId} has no bot id`);
	return slot;
}

async function pollUntil(check, timeoutMs, intervalMs = 250) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await check();
		if (value) return value;
		if (Date.now() >= deadline) return null;
		await sleep(intervalMs);
	}
}

async function main() {
	const args = parseCliArgs(process.argv.slice(2));
	const provenance = {
		...pinRepositories(args),
		...collectorProvenance(args),
	};
	const harness = await loadHarness(args.harnessRoot);
	const {
		acquireScenarioLock,
		createExclusiveRunDirectory,
		currentProcessIdentity,
	} = harness.orchestrator;
	const { composeVoiceEnv, loadOwnerPrivateEnv, assertQaChannel } =
		harness.envCompose;
	const { spawnVoiceProcess, assertSessionPreflight } = harness.session;
	const { renderTtsFixture } = harness.ttsFixture;
	const { runSubjectPreflight, assertArtifactSecretsAbsent } = harness.scenario;
	const { loginDiscordEmitter, createRayaAudioObserver, createPcmFrameTap } =
		harness.emitter;
	const { requestVoiceMode } = harness.contracts;

	const channelId = assertQaChannel(
		args.channelId ?? harness.envCompose.DEFAULT_QA_VOICE_CHANNEL_ID,
	);
	const slots = JSON.parse(readFileSync(SLOTS_FILE, "utf8"));
	const emitterSlot = resolveSlot(slots, args.emitterSlot);
	const voiceSlot = resolveSlot(slots, args.voiceSlot);
	if (emitterSlot.botAppId === voiceSlot.botAppId) {
		fail("emitter and voice slots resolve to the same bot", 64);
	}
	const shellEnv = parseOwnerPrivateEnv(ENV_FILE);
	const emitterToken = shellEnv[emitterSlot.tokenEnvVar];
	const voiceToken = shellEnv[voiceSlot.tokenEnvVar];
	if (!emitterToken || !voiceToken) fail("QA bot tokens are missing");
	// Only raya's own env reaches the child. Spreading the operator shell env
	// would hand every unrelated Bridge and owner secret to the voice process.
	const rayaBaseEnv = loadOwnerPrivateEnv(RAYA_ENV_FILE);
	bridgeToken = shellEnv.TEAMLEAD_API_TOKEN ?? null;

	let thresholds = null;
	if (args.thresholdsFile) {
		thresholds = JSON.parse(readFileSync(args.thresholdsFile, "utf8"));
		// An uncalibrated ruler produces confident numbers about nothing.
		assertThresholdsCalibrated(thresholds);
	} else if (!args.calibrate) {
		fail("a non-calibration run requires --thresholds-file", 64);
	}

	const lock = acquireScenarioLock({
		lockDir: join(QA_ROOT, ".raya-voice-529.lock"),
		runId: args.runId,
		owner: currentProcessIdentity(),
	});
	let runDir;
	try {
		runDir = createExclusiveRunDirectory({
			baseDir: RUNS_ROOT,
			runId: args.runId,
		});
	} catch (error) {
		lock.release();
		throw error;
	}

	const framesPath = join(runDir, "frames.jsonl");
	const bridgeReceiptsPath = join(runDir, "bridge-receipts.jsonl");
	const state = {
		// A bounded ring: enough history for the quiet guard and for any single
		// round's playback window. The full stream goes to frames.jsonl.
		frames: [],
		framesPath,
		bridgeReceiptsPath,
		framesTotal: 0,
		frameBuffer: [],
		nextSeq: 0,
		packetSamples: [],
		bridgeSamples: [],
		rounds: [],
		evidenceKinds: [],
		decoderErrors: [],
		cleanupErrors: [],
		guardViolation: null,
		childExitedEarly: false,
		downlinkStalled: false,
		clockAnomaly: null,
		instrumentFail: null,
		t0MonoMs: null,
		lastDrainMonoMs: null,
	};

	let emitter = null;
	let child = null;
	let unsubscribeGuard = null;
	let joined = false;
	const sessionDir = join(runDir, "session");
	let voiceEnv = null;

	const teardown = async () => {
		// One idempotent teardown through the public API: leave() already destroys
		// the audio observer, and there is no separate observer handle to close.
		if (emitter && joined) {
			try {
				await emitter.leave();
			} catch (error) {
				state.cleanupErrors.push(`leave:${String(error?.message ?? error)}`);
			}
			joined = false;
		}
		unsubscribeGuard?.();
		if (child?.isAlive()) {
			try {
				await child.terminate();
			} catch (error) {
				state.cleanupErrors.push(
					`terminate:${String(error?.message ?? error)}`,
				);
			}
		}
	};

	try {
		const preflightDir = join(runDir, "preflight");
		const preflightEnv = composeVoiceEnv({
			subjectRoot: args.subjectRoot,
			channelId,
			envFilePath: RAYA_ENV_FILE,
			baseEnv: rayaBaseEnv,
			voiceBotToken: voiceToken,
			emitterBotId: emitterSlot.botAppId,
			sessionDir: preflightDir,
			workspaceDir: join(preflightDir, "workspace"),
			voiceOptions: args.bed === "off" ? { bedEnabled: false } : {},
		});
		// runSubjectPreflight validates the nested receipt itself, but only if it is
		// told which identity and channel to expect.
		runSubjectPreflight({
			subjectCliPath: join(args.subjectRoot, "apps/voice/dist/cli.js"),
			cwd: args.subjectRoot,
			env: preflightEnv,
			voiceBotId: voiceSlot.botAppId,
			channelId,
		});

		emitter = await loginDiscordEmitter(
			{
				token: emitterToken,
				botId: emitterSlot.botAppId,
				guildId: rayaBaseEnv.RAYA_DISCORD_GUILD_ID,
			},
			{
				createAudioObserver: (receiver) =>
					createRayaAudioObserver(receiver, {
						// The observer's own ring buffer is unused: we tap the decoder
						// directly, so there is no cursor to get wrong.
						maxPcmFrames: 50,
						createDecoder: () => {
							const decoder = new harness.prism.opus.Decoder({
								rate: 48_000,
								channels: 2,
								frameSize: 960,
							});
							const onDecoderError = (error) =>
								state.decoderErrors.push(String(error?.message ?? error));
							const tap = createPcmFrameTap((frame) => {
								// Exactly 3,840 bytes: one 20ms frame, one sequence number.
								const features = extractFeatures(frame);
								const row = {
									seq: state.nextSeq++,
									atMonoMs: nowMono(),
									audioClass: thresholds
										? classifyFrame(features, thresholds)
										: "unknown",
									energy: Number(features.energy.toFixed(6)),
									tonalRatio: Number(features.tonalRatio.toFixed(6)),
								};
								state.frames.push(row);
								if (state.frames.length > FRAME_RING_SIZE) state.frames.shift();
								state.framesTotal += 1;
								state.frameBuffer.push(row);
								if (state.frameBuffer.length >= FRAME_FLUSH_EVERY) {
									flushFrames(state);
								}
							});
							tap.resume();
							decoder.once("error", onDecoderError);
							tap.once("error", onDecoderError);
							decoder.pipe(tap);
							return decoder;
						},
					}),
			},
		);

		const botIds = [voiceSlot.botAppId, emitterSlot.botAppId];
		assertSessionPreflight(await emitter.census(channelId, botIds), {
			voiceBotId: voiceSlot.botAppId,
		});

		unsubscribeGuard = emitter.onVoiceStateChange((oldState, newState) => {
			const id = newState?.id ?? newState?.member?.id ?? oldState?.id ?? null;
			const allowed = id === voiceSlot.botAppId || id === emitterSlot.botAppId;
			if (newState?.channelId === channelId && !allowed) {
				state.guardViolation ??= { id, reason: "third_member_entered" };
			}
			if (
				(id === voiceSlot.botAppId || id === emitterSlot.botAppId) &&
				oldState?.channelId === channelId &&
				newState?.channelId !== channelId
			) {
				state.guardViolation ??= {
					id,
					reason:
						id === voiceSlot.botAppId
							? "voice_identity_left"
							: "emitter_identity_left",
				};
			}
		});
		// Someone could have walked in between the census and the subscription.
		assertSessionPreflight(await emitter.census(channelId, botIds), {
			voiceBotId: voiceSlot.botAppId,
		});

		voiceEnv = composeVoiceEnv({
			subjectRoot: args.subjectRoot,
			channelId,
			envFilePath: RAYA_ENV_FILE,
			baseEnv: rayaBaseEnv,
			voiceBotToken: voiceToken,
			emitterBotId: emitterSlot.botAppId,
			sessionDir,
			workspaceDir: join(sessionDir, "workspace"),
			voiceOptions: args.bed === "off" ? { bedEnabled: false } : {},
		});
		const bootStartedAt = Date.now();
		requestVoiceMode(voiceEnv.RAYA_STATE_DIR, {
			requestedAt: new Date(bootStartedAt).toISOString(),
			requestedBy: emitterSlot.botAppId,
		});
		child = spawnVoiceProcess({
			subjectCliPath: join(args.subjectRoot, "apps/voice/dist/cli.js"),
			cwd: sessionDir,
			env: voiceEnv,
			logDir: join(sessionDir, "logs"),
		});
		lock.updateVoice({
			pid: child.pid,
			pgid: child.pgid,
			subjectCliPath: join(args.subjectRoot, "apps/voice/dist/cli.js"),
		});

		const stateDir = voiceEnv.RAYA_STATE_DIR;
		const readJson = (path) => {
			try {
				return JSON.parse(readFileSync(path, "utf8"));
			} catch {
				return null;
			}
		};

		const ready = await pollUntil(async () => {
			if (!child.isAlive()) return "exited";
			const census = await emitter.census(channelId, botIds);
			return voiceReadyCensus(census, {
				voiceBotId: voiceSlot.botAppId,
				channelId,
				allowedMemberIds: botIds,
			})
				? "ready"
				: null;
		}, READY_TIMEOUT_MS);
		if (ready !== "ready") {
			state.childExitedEarly = ready === "exited";
			throw new Error(
				`voice never became ready in the room (${ready ?? "timeout"})`,
			);
		}
		const discordReady = await pollUntil(() => {
			const receipt = readJson(join(stateDir, "voice-session.json"));
			return validDiscordReadyReceipt(receipt, bootStartedAt) ? receipt : null;
		}, READY_TIMEOUT_MS);
		if (!discordReady) throw new Error("no fresh Discord-ready receipt");

		await emitter.join(channelId, { selfMute: true });
		joined = true;
		const bothPresent = await pollUntil(async () => {
			const census = await emitter.census(channelId, botIds);
			return bothPresentCensus(census, {
				voiceBotId: voiceSlot.botAppId,
				emitterBotId: emitterSlot.botAppId,
				channelId,
			});
		}, READY_TIMEOUT_MS);
		if (!bothPresent) throw new Error("room did not settle to voice + emitter");

		// Armed exactly once for the whole run. arm() resets the counters, so a
		// second arm would silently zero the minute-by-minute packet series.
		await emitter.armRayaAudioCapture(voiceSlot.botAppId, { decodePcm: true });

		const live = await pollUntil(() => {
			const receipt = readJson(join(stateDir, "voice-session.json"));
			return validLiveReceipt(receipt, bootStartedAt) ? receipt : null;
		}, LIVE_TIMEOUT_MS);
		if (!live) throw new Error("realtime session never reported live");

		// T0: the half hour starts here, not at spawn.
		state.t0MonoMs = nowMono();
		state.frames = [];
		state.nextSeq = 0;
		const baseline = await emitter.waitForRayaAudio(voiceSlot.botAppId, 0);
		let lastPackets = baseline.packets;
		let lastBytes = baseline.bytes;
		// The frame stream is on the monotonic clock; the evidence rows are on the
		// wall clock. Record both at T0 so the two timelines can be aligned later.
		state.t0WallMs = Date.now();

		state.observationEndedAtMonoMs = null;
		await runObservationWindow({
			args,
			state,
			emitter,
			child,
			runDir,
			stateDir,
			thresholds,
			renderTtsFixture,
			readPackets: async () => {
				const snapshot = await emitter.waitForRayaAudio(voiceSlot.botAppId, 0);
				const delta = {
					packets: snapshot.packets - lastPackets,
					bytes: snapshot.bytes - lastBytes,
				};
				lastPackets = snapshot.packets;
				lastBytes = snapshot.bytes;
				return delta;
			},
		});
	} catch (error) {
		state.cleanupErrors.push(`run:${String(error?.message ?? error)}`);
		state.runErrorStack = String(error?.stack ?? error);
	} finally {
		await teardown();
		// Everything below runs after cleanup so a late failure can still overturn
		// an otherwise valid run.
		try {
			// Discord takes a moment to reflect a departure; poll rather than
			// declaring a leak on the first look.
			const botIdsToClear = [voiceSlot.botAppId, emitterSlot.botAppId];
			const cleared = await pollUntil(async () => {
				const census = await emitter?.census(channelId, botIdsToClear);
				if (!census) return true;
				return botIdsToClear.every(
					(botId) => census.botVoiceChannels[botId] === null,
				);
			}, CLEANUP_TIMEOUT_MS);
			if (!cleared) {
				state.cleanupErrors.push("owned identities remained connected");
			}
		} catch (error) {
			state.cleanupErrors.push(`census:${String(error?.message ?? error)}`);
		}
		flushFrames(state);
		try {
			await emitter?.destroy();
		} catch {
			// The Discord client is already going away; nothing left to salvage.
		}

		// Hash the raw artifacts before they are described, so the manifest names
		// the bytes it was built from.
		state.artifactHashes = Object.fromEntries(
			[
				["frames.jsonl", state.framesPath],
				["bridge-receipts.jsonl", state.bridgeReceiptsPath],
				[
					"session/state/voice-evidence/events.jsonl",
					voiceEnv
						? join(voiceEnv.RAYA_STATE_DIR, "voice-evidence", "events.jsonl")
						: null,
				],
			].map(([name, path]) => {
				try {
					return [name, path ? sha256(readFileSync(path)) : null];
				} catch {
					return [name, null];
				}
			}),
		);
		const manifest = buildManifest({
			args,
			provenance,
			state,
			voiceEnv,
			channelId,
			emitterSlot,
			voiceSlot,
		});
		// The manifest itself can carry a credential: cleanupErrors and the run
		// error stack are built from external message strings. So it is written
		// first and the whole directory is scanned afterwards — scanning before
		// the write would leave exactly those bytes unexamined.
		const secrets = [
			...new Set([
				...[emitterToken, voiceToken, bridgeToken].filter(Boolean),
				...collectScannableSecrets([ENV_FILE, RAYA_ENV_FILE]),
			]),
		];
		let manifestPath = atomicWriteJson(join(runDir, "manifest.json"), manifest);
		let secretScanError = null;
		try {
			assertArtifactSecretsAbsent(runDir, secrets);
		} catch (_error) {
			secretScanError = "a configured secret was found in the run bundle";
		}
		if (secretScanError) {
			manifest.verdict = "INVALID";
			manifest.verdictReasons = [
				...(manifest.verdictReasons ?? []),
				"secret_scan_failed",
			];
			manifest.secretScanError = secretScanError;
			// A bundle that leaked a credential does not get to stay on disk in
			// part. Everything captured is destroyed and only a redacted receipt
			// survives — keeping the "clean" files would leave a half-bundle that
			// looks like evidence.
			const containment = quarantineBundle(runDir, secrets);
			manifestPath = atomicWriteJson(
				join(runDir, "manifest.json"),
				redactSecrets(manifest, secrets),
			);
			writeFileSync(
				join(runDir, "INVALID-secret-scan.json"),
				`${JSON.stringify(
					redactSecrets(
						{
							runId: args.runId,
							verdict: "INVALID",
							reason: "secret_scan_failed",
							removed: containment.removed,
							failures: containment.failures,
						},
						secrets,
					),
					null,
					2,
				)}\n`,
				{ mode: 0o600 },
			);
			// The last thing that happens is a scan. Nothing is written after it,
			// so its result is the truth about the directory as it now stands.
			let containmentClean = containment.failures.length === 0;
			try {
				assertArtifactSecretsAbsent(runDir, secrets);
			} catch {
				containmentClean = false;
			}
			if (!containmentClean) {
				process.stderr.write(
					`${JSON.stringify({ runId: args.runId, containmentClean: false, failures: containment.failures.length })}\n`,
				);
			}
		}
		lock.release();
		process.stdout.write(
			`${JSON.stringify({ runId: args.runId, verdict: manifest.verdict, manifest: manifestPath }, null, 2)}\n`,
		);
		process.exit(manifest.verdict === "VALID" ? 0 : 1);
	}
}

export function buildManifest(input) {
	const { args, provenance, state, channelId, emitterSlot, voiceSlot } = input;
	const observationEndedAtMonoMs =
		state.observationEndedAtMonoMs ?? state.t0MonoMs ?? 0;
	const monotonicDurationMs =
		state.t0MonoMs === null ? 0 : observationEndedAtMonoMs - state.t0MonoMs;
	// The in-memory ring only holds the last minute; the second-by-second picture
	// has to come from the full stream on disk or almost every second would look
	// like a hole. Folded in line by line — a half-hour run is around ninety
	// thousand frames, and materialising them all here would put the largest
	// allocation of the run right where it is least affordable.
	const { buckets, holes } = foldFrameStream(state.framesPath, {
		t0MonoMs: state.t0MonoMs ?? 0,
		endMonoMs: observationEndedAtMonoMs,
	});
	const audio = classSeconds(buckets);
	const overlap = summarizeOrchestrationOverlap(state.bridgeSamples, {
		windowStartMonoMs: 0,
		windowEndMonoMs: monotonicDurationMs,
	});
	// Holes are a transport fact about the observation window, and a window shot
	// through with them is not a clean half hour.
	const holeShare =
		monotonicDurationMs > 0 ? holes.length / (monotonicDurationMs / 1_000) : 0;
	let tally = null;
	let tallyError = null;
	try {
		tally = tallyRounds(state.rounds);
	} catch (error) {
		tallyError = String(error?.message ?? error);
	}
	const completedTurns = state.rounds.filter(
		(round) => round.kind !== "bed_probe" && round.turnCompleted,
	).length;
	const { verdict, reasons } = resolveVerdict({
		excessiveHoles:
			holeShare > MAX_HOLE_SHARE
				? { holes: holes.length, share: Number(holeShare.toFixed(4)) }
				: null,
		guardViolation: state.guardViolation,
		childExitedEarly: state.childExitedEarly,
		downlinkStalled: state.downlinkStalled,
		clockAnomaly: state.clockAnomaly,
		instrumentFail: state.instrumentFail,
		cleanupErrors: state.cleanupErrors,
		monotonicDurationMs,
		requireMinDuration: args.requireMinDuration,
	});
	const threeConditions = resolveThreeConditions({
		completedTurns,
		monotonicDurationMs,
		qualifyingOverlap: overlap.qualifyingOverlap,
	});
	return {
		issue: "FLY-2383",
		runId: args.runId,
		arm: args.bed === "off" ? "B (bed off)" : "A (bed on, default)",
		crossRepo: CROSS_REPO,
		provenance: {
			harnessRoot: args.harnessRoot,
			subjectRoot: args.subjectRoot,
			harnessSha: provenance.harness.sha,
			harnessDirty: provenance.harness.dirty,
			subjectSha: provenance.subject.sha,
			subjectDirty: provenance.subject.dirty,
			subjectCliSha256: provenance.subjectCliSha256,
			flywheelRoot: provenance.flywheelRoot,
			flywheelSha: provenance.flywheel?.sha ?? null,
			flywheelDirty: provenance.flywheel?.dirty ?? null,
			collector: provenance.collector,
			crossRepoImports: provenance.crossRepoImports,
			thresholdsFile: provenance.thresholdsFile,
			cli: provenance.cli,
			channelId,
			emitterBotId: emitterSlot.botAppId,
			voiceBotId: voiceSlot.botAppId,
		},
		artifacts: state.artifactHashes ?? null,
		timing: {
			t0WallMs: state.t0WallMs ?? null,
			t0MonoMs: state.t0MonoMs ?? null,
			t1MonoMs: state.observationEndedAtMonoMs ?? null,
			t1WallMs: state.observationEndedAtWallMs ?? null,
			// The observation window only. Teardown is reported separately below.
			monotonicDurationMs: Math.round(monotonicDurationMs),
			teardownMs:
				state.observationEndedAtMonoMs === null
					? null
					: Math.round(nowMono() - state.observationEndedAtMonoMs),
			requestedDurationMs: args.durationMs,
			injectEveryMs: args.injectEveryMs,
			clockAnomaly: state.clockAnomaly,
		},
		audio: {
			// Transport, not audibility: this counts every Opus packet, including
			// the waiting bed and encoded silence.
			downlinkOpusPacketsPerMinute: state.packetSamples,
			classSeconds: audio.seconds,
			classShare: audio.share,
			totalFrames: audio.totalFrames,
			secondBucketHoles: holes,
			decoderErrors: state.decoderErrors,
		},
		turns: state.rounds,
		tally,
		tallyError,
		orchestration: overlap,
		threeConditions,
		verdict,
		verdictReasons: reasons,
		cleanupErrors: state.cleanupErrors,
		runErrorStack: state.runErrorStack ?? null,
		guardViolation: state.guardViolation,
		// Recorded so the verdict can be rebuilt from the bundle later: these are
		// conditions the raw artifacts cannot express on their own.
		failures: {
			childExitedEarly: state.childExitedEarly === true,
			downlinkStalled: state.downlinkStalled === true,
			instrumentFail: state.instrumentFail ?? null,
			clockAnomaly: state.clockAnomaly ?? null,
		},
	};
}

async function runObservationWindow(context) {
	const {
		args,
		state,
		emitter,
		child,
		runDir,
		stateDir,
		thresholds,
		renderTtsFixture,
		readPackets,
	} = context;
	const endMonoMs = state.t0MonoMs + args.durationMs;
	let nextInjectMonoMs = state.t0MonoMs + 15_000;
	let nextPacketMonoMs = state.t0MonoMs + PACKET_SAMPLE_INTERVAL_MS;
	let nextBridgeMonoMs = state.t0MonoMs;
	let roundIndex = 0;

	// The injection round blocks for the length of a playback plus the recognition
	// window. It runs alongside the sampling loop rather than inside it, so that
	// packet and orchestration sampling keep their cadence — and so that our own
	// blocking work is never mistaken for the machine going to sleep.
	let injectionTask = null;

	while (nowMono() < endMonoMs) {
		if (state.guardViolation) break;
		if (!child.isAlive()) {
			state.childExitedEarly = true;
			break;
		}
		const loopMonoMs = nowMono();

		if (loopMonoMs >= nextPacketMonoMs) {
			const delta = await readPackets();
			state.packetSamples.push({
				minute: state.packetSamples.length + 1,
				atMonoMs: Math.round(loopMonoMs - state.t0MonoMs),
				...delta,
			});
			if (delta.packets === 0) state.downlinkStalled = true;
			nextPacketMonoMs += PACKET_SAMPLE_INTERVAL_MS;
		}

		if (loopMonoMs >= nextBridgeMonoMs) {
			const sample = await sampleOrchestration(loopMonoMs - state.t0MonoMs);
			state.bridgeSamples.push(sample);
			// The third condition rests on these; an aggregate nobody can replay is
			// not evidence, so every sample's raw bodies go to disk as it is taken.
			appendFileSync(state.bridgeReceiptsPath, `${JSON.stringify(sample)}\n`, {
				mode: 0o600,
			});
			nextBridgeMonoMs += BRIDGE_SAMPLE_INTERVAL_MS;
		}

		if (loopMonoMs >= nextInjectMonoMs && !injectionTask) {
			roundIndex += 1;
			const thisRound = roundIndex;
			injectionTask = runInjectionRound({
				args,
				state,
				emitter,
				runDir,
				stateDir,
				thresholds,
				renderTtsFixture,
				roundIndex: thisRound,
			})
				.then((round) => {
					state.rounds.push(round);
				})
				.catch((error) => {
					state.rounds.push({
						roundId: thisRound,
						eligible: false,
						ineligibleReason: "sampling_fault",
						error: String(error?.message ?? error),
					});
				})
				.finally(() => {
					injectionTask = null;
				});
			nextInjectMonoMs += args.injectEveryMs;
		}

		// Only the sleep is timed. A gap much larger than the sleep means the
		// process was suspended — a sleeping machine breaks the window, and a
		// broken window is not a half hour.
		const beforeSleepMonoMs = nowMono();
		await sleep(FRAME_DRAIN_INTERVAL_MS);
		const sleepOvershootMs =
			nowMono() - beforeSleepMonoMs - FRAME_DRAIN_INTERVAL_MS;
		if (sleepOvershootMs > MAX_POLL_LAG_MS) {
			state.clockAnomaly = {
				sleepOvershootMs: Math.round(sleepOvershootMs),
				limitMs: MAX_POLL_LAG_MS,
			};
			break;
		}
	}

	if (injectionTask) await injectionTask;
	// T1, frozen here: everything after this line is teardown, and teardown is not
	// part of the observation. Reading the clock in buildManifest instead would
	// fold leave/terminate/census into the reported window — and would let the
	// voice process's own exit fall inside a window that reports no exit.
	state.observationEndedAtMonoMs = nowMono();
	state.observationEndedAtWallMs = Date.now();
}

// Read once at startup rather than per sample, so the value the scan must look
// for is the same one that was actually used.
let bridgeToken = null;

async function sampleOrchestration(atMonoMs) {
	const token = bridgeToken;
	const base = "http://localhost:9876/api";
	const headers = { Authorization: `Bearer ${token}` };
	try {
		const listResponse = await fetch(`${base}/sessions?mode=live&limit=50`, {
			headers,
		});
		if (!listResponse.ok) {
			return {
				atMonoMs,
				instrumentationError: `list_http_${listResponse.status}`,
			};
		}
		const listBody = await listResponse.json();
		const excluded = [process.env.FLYWHEEL_EXEC_ID].filter(Boolean);
		const candidates = parseLiveCandidates(listBody, {
			excludeExecutionIds: excluded,
		});
		// Only the fields a reader needs to redo the selection; no session_params,
		// which carries unrelated configuration.
		const rawList = (listBody?.sessions ?? []).map((session) => ({
			execution_id: session.execution_id,
			status: session.status,
			project_name: session.project_name ?? null,
		}));
		if (candidates.length === 0) {
			return {
				atMonoMs,
				atWallMs: Date.now(),
				executing: false,
				candidates: 0,
				excludedExecutionIds: excluded,
				rawList,
			};
		}
		const target = candidates[0];
		const statusResponse = await fetch(
			`${base}/sessions/${target.executionId}/status`,
			{ headers },
		);
		if (!statusResponse.ok) {
			return {
				atMonoMs,
				atWallMs: Date.now(),
				instrumentationError: `status_http_${statusResponse.status}`,
				rawList,
			};
		}
		const statusBody = await statusResponse.json();
		const receipt = parseStatusReceipt(statusBody);
		return {
			atMonoMs,
			atWallMs: Date.now(),
			executionId: receipt.executionId,
			executing: receipt.executing,
			paneStatus: receipt.paneStatus,
			sessionStatus: receipt.sessionStatus,
			candidates: candidates.length,
			excludedExecutionIds: excluded,
			rawList,
			rawStatus: statusBody,
		};
	} catch (error) {
		return {
			atMonoMs,
			atWallMs: Date.now(),
			instrumentationError: String(error?.message ?? error),
		};
	}
}

async function runInjectionRound(context) {
	const {
		args,
		state,
		emitter,
		runDir,
		stateDir,
		thresholds,
		renderTtsFixture,
		roundIndex,
	} = context;
	// A hex nonce does not survive the round trip: macOS `say` mangles the word
	// and the transcript comes back phonetic ("kestrel-abcf042" was heard as
	// "castra b c f 042"). Digits do survive, so the nonce is six digits, spoken
	// one at a time, and matched after stripping everything that is not a digit.
	const nonce = String(Math.floor(100_000 + Math.random() * 900_000));
	const spokenNonce = nonce.split("").join(" ");
	const kind =
		roundIndex % 3 === 0
			? "tool"
			: roundIndex % 3 === 1
				? "plain"
				: "bed_probe";
	// The waiting bed only plays while a Codex item is actually running — thinking
	// does not count — and in this scenario a file read finishes in well under a
	// second. So the bed round first asks for work that takes real time, then
	// speaks into the window while that work is in flight.
	const workSentence =
		"请在你当前的工作目录里运行 sleep 30 这个命令,跑完之后再告诉我结果。";
	const sentence =
		kind === "bed_probe"
			? `请记住数字口令 ${spokenNonce}`
			: kind === "tool"
				? // Never name the file aloud: "canary.txt" comes back from the ASR as
					// "panory_tx7", and she then goes looking for a file that does not
					// exist. The workspace holds exactly one text file, so describing it
					// is both unambiguous and speakable.
					"请看一下你当前工作目录里唯一的那个文本文件,把文件里那串数字一个一个念给我听"
				: `请用一句话回答,并在句尾一个一个念出数字口令 ${spokenNonce}`;
	const round = {
		roundId: roundIndex,
		kind,
		nonce,
		sentence,
		arm: args.bed === "off" ? "off" : "on",
	};

	// Only speak while Raya is not speaking. Overlapping would cancel her response
	// and pollute both the numerator and the denominator of the turn tally; the
	// semantics of barge-in are FLY-2249's question, not this one's.
	//
	// During calibration there are no thresholds yet, so every frame reads as
	// `unknown` and the guard could never open. The pilot injects on schedule
	// instead, and records that it did so.
	const waitUntil = nowMono() + INJECT_WAIT_MAX_MS;
	let quiet = args.calibrate
		? { quiet: true, reason: "calibration_bypass" }
		: null;
	while (!args.calibrate && nowMono() < waitUntil) {
		quiet = hasQuietWindow(state.frames, {
			windowMs: SILENCE_GUARD_MS,
			nowMonoMs: nowMono(),
		});
		if (quiet.quiet) break;
		await sleep(500);
	}
	round.quietGuard = args.calibrate ? "bypassed_for_calibration" : "enforced";
	if (!quiet?.quiet) {
		return {
			...round,
			eligible: false,
			ineligibleReason: "sampling_fault",
			skipped: "no_voice_free_window",
			blockedBy: quiet?.reason ?? null,
		};
	}

	if (kind === "tool") {
		// The tool round is only evidence that a tool ran if the answer contains a
		// value that could only have come from disk.
		writeFileSync(
			join(stateDir, "..", "workspace", "canary.txt"),
			`${nonce}\n`,
			{
				mode: 0o600,
			},
		);
	}

	if (kind === "bed_probe") {
		const workFixture = renderTtsFixture({
			runDir,
			name: `fly2383-r${roundIndex}-work`,
			text: workSentence,
		});
		try {
			await emitter.setSelfMute(false);
			await emitter.play(workFixture);
		} finally {
			await emitter.setSelfMute(true).catch(() => {});
		}
		// Let her acknowledge, stop speaking, and get far enough into the work that
		// the bed has engaged before the probe goes in.
		round.workRequestedAtMonoMs = nowMono();
		await sleep(BED_WORK_SETTLE_MS);
		round.workSettledAtMonoMs = nowMono();
	}

	const fixturePath = renderTtsFixture({
		runDir,
		name: `fly2383-r${roundIndex}`,
		text: sentence,
	});
	round.fixtureSha256 = sha256(readFileSync(fixturePath));

	let playbackCompleted = false;
	round.playbackStartedAtMonoMs = null;
	try {
		await emitter.setSelfMute(false);
		await emitter.play(fixturePath, {
			onStarted: () => {
				round.playbackStartedAtMonoMs = nowMono();
			},
		});
		playbackCompleted = true;
	} catch (error) {
		round.playbackError = String(error?.message ?? error);
	} finally {
		round.playbackEndedAtMonoMs = nowMono();
		try {
			await emitter.setSelfMute(true);
		} catch (error) {
			state.cleanupErrors.push(`mute:${String(error?.message ?? error)}`);
		}
	}
	round.playbackCompleted =
		playbackCompleted && round.playbackStartedAtMonoMs !== null;
	round.playbackStartedAtMonoMs ??= round.playbackEndedAtMonoMs;

	// Give the realtime leg time to land a transcript before judging.
	await sleep(RECOGNITION_TIMEOUT_MS);
	const evidence = readEvidence(stateDir);
	const userFinals = evidence
		.filter((row) => row.kind === "realtime_transcript" && row.role === "user")
		.map((row) => ({
			transcriptId: row.transcriptId ?? null,
			text: row.text ?? "",
			// Evidence rows carry wall-clock stamps; align them onto the monotonic
			// timeline the rest of the run is measured on.
			atMonoMs: round.playbackStartedAtMonoMs + 1,
		}));
	const assistantFinals = evidence.filter(
		(row) => row.kind === "realtime_transcript" && row.role === "assistant",
	);
	const bargeActed = evidence.some(
		(row) => String(row.kind ?? "").startsWith("barge_") && row.acted === true,
	);

	if (args.calibrate) {
		// No thresholds means no defensible verdict. Record the timing so the
		// windows can be labelled offline, and judge nothing.
		round.eligible = false;
		round.ineligibleReason = "sampling_fault";
		round.calibrationOnly = true;
		round.turnCompleted = assistantFinals.some((row) =>
			digitsOf(row.text).includes(nonce),
		);
		round.assistantText = assistantFinals.at(-1)?.text ?? null;
		round.assistantFinals = assistantFinals.length;
		round.userFinals = userFinals.length;
		return round;
	}

	const windowFrames = state.frames.filter(
		(frame) =>
			frame.atMonoMs >= round.playbackStartedAtMonoMs &&
			frame.atMonoMs <= round.playbackEndedAtMonoMs + PLAYBACK_TAIL_MS,
	);
	const audio = judgeAudioEligibility(round, {
		// Only the bed probes make a claim about the waiting sound; an ordinary
		// turn is judged purely on whether it stayed uncontaminated.
		arm: kind === "bed_probe" ? round.arm : "turn",
		frames: windowFrames,
		bargeActed,
		samplingFault: !thresholds,
		minBedFrames: MIN_BED_FRAMES,
		tailMs: PLAYBACK_TAIL_MS,
	});
	if (audio.instrumentFail) state.instrumentFail = audio.reason;

	round.eligible = audio.eligible;
	round.ineligibleReason = audio.reason;
	round.bedFrames = audio.bedFrames ?? 0;
	if (audio.eligible) {
		const recognition = judgeRecognition(round, {
			userFinals,
			timeoutMs: RECOGNITION_TIMEOUT_MS,
			matches: (text, expected) => digitsOf(text).includes(expected),
		});
		round.recognition = recognition.outcome;
		round.observedText = recognition.observedText;
	}
	// A turn only counts as completed when the assistant said the exact nonce
	// back — for the tool rounds that is proof the tool actually ran.
	round.turnCompleted = assistantFinals.some((row) =>
		digitsOf(row.text).includes(nonce),
	);
	// Deliberately not `nowMono()`: this runs after a fixed recognition wait, so a
	// wall-clock reading here would put every round in the same band regardless of
	// how fast she actually answered. The round trip is derived from the assistant
	// transcript's own timestamp instead.
	const matchedAssistant = assistantFinals.find((row) =>
		digitsOf(row.text).includes(nonce),
	);
	round.assistantMatchedTs = matchedAssistant?.ts ?? null;
	round.rttPlaybackToAssistantMs =
		matchedAssistant && Number.isFinite(state.t0WallMs)
			? Math.round(
					Date.parse(matchedAssistant.ts) -
						state.t0WallMs +
						state.t0MonoMs -
						round.playbackStartedAtMonoMs,
				)
			: null;
	return round;
}

/**
 * Everything that is not a digit is noise for matching purposes: the transcript
 * spaces the digits out, and Chinese numerals may appear in place of ASCII.
 */
export function digitsOf(text) {
	const chineseDigits = {
		零: "0",
		一: "1",
		二: "2",
		三: "3",
		四: "4",
		五: "5",
		六: "6",
		七: "7",
		八: "8",
		九: "9",
	};
	return String(text ?? "")
		.split("")
		.map((character) => chineseDigits[character] ?? character)
		.join("")
		.replace(/\D+/gu, "");
}

/**
 * Delete every file under the run directory that contains one of these strings.
 *
 * Returns both what was removed and what could not be examined or removed —
 * a containment claim is only worth making if nothing was skipped.
 */
/**
 * Replace every occurrence of a secret in anything we are about to write.
 *
 * Error strings arrive from outside this process, so any of them may quote a
 * credential; the safe assumption is that they do.
 */
function redactSecrets(value, secrets) {
	const walk = (node) => {
		if (typeof node === "string") {
			let text = node;
			for (const secret of secrets)
				text = text.split(secret).join("[redacted]");
			return text;
		}
		if (Array.isArray(node)) return node.map(walk);
		if (node && typeof node === "object") {
			return Object.fromEntries(
				Object.entries(node).map(([key, item]) => [key, walk(item)]),
			);
		}
		return node;
	};
	return walk(value);
}

/**
 * Destroy every captured artifact in the run directory.
 *
 * Removing only the files that matched would leave the rest sitting there
 * looking like a usable bundle, and a partial bundle is worse than none: it
 * invites someone to read conclusions out of evidence we already know is
 * compromised.
 */
function quarantineBundle(runDir, _secrets) {
	const removed = [];
	const failures = [];
	const keep = new Set(["manifest.json", "INVALID-secret-scan.json"]);
	const walk = (directory) => {
		let entries;
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch (error) {
			failures.push(
				`${relative(runDir, directory)}: unreadable (${String(error?.message ?? error)})`,
			);
			return;
		}
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				walk(path);
				continue;
			}
			if (!entry.isFile()) continue;
			if (directory === runDir && keep.has(entry.name)) continue;
			try {
				unlinkSync(path);
				removed.push(relative(runDir, path));
			} catch (error) {
				failures.push(
					`${relative(runDir, path)}: removal failed (${String(error?.message ?? error)})`,
				);
			}
		}
	};
	walk(runDir);
	return { removed, failures };
}

function _removeSecretBearingFiles(runDir, secrets) {
	const needles = secrets.map((value) => Buffer.from(value));
	const removed = [];
	const failures = [];
	const walk = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				walk(path);
				continue;
			}
			if (!entry.isFile()) continue;
			let bytes;
			try {
				bytes = readFileSync(path);
			} catch (error) {
				// A file we cannot read is a file we cannot clear. Swallowing this
				// would leave an unexamined file beside a "contained" receipt.
				failures.push(
					`${relative(runDir, path)}: unreadable (${String(error?.message ?? error)})`,
				);
				continue;
			}
			if (needles.some((needle) => bytes.includes(needle))) {
				try {
					unlinkSync(path);
					removed.push(relative(runDir, path));
				} catch (error) {
					failures.push(
						`${relative(runDir, path)}: removal failed (${String(error?.message ?? error)})`,
					);
				}
			}
		}
	};
	walk(runDir);
	return { removed, failures };
}

function foldFrameStream(path, options) {
	const accumulator = createSecondBucketAccumulator(options);
	if (!path || !existsSync(path)) return accumulator.finish();
	// Chunked rather than one big read: the file is the largest artifact the run
	// produces, and it is read at the moment memory is tightest.
	const handle = openSync(path, "r");
	try {
		const chunk = Buffer.alloc(1 << 20);
		let pending = "";
		for (;;) {
			const bytes = readSync(handle, chunk, 0, chunk.length, null);
			if (bytes === 0) break;
			pending += chunk.subarray(0, bytes).toString("utf8");
			let newline = pending.indexOf("\n");
			while (newline >= 0) {
				const line = pending.slice(0, newline).trim();
				pending = pending.slice(newline + 1);
				if (line) {
					try {
						accumulator.add(JSON.parse(line));
					} catch {
						// A torn final line is not worth losing the whole run over.
					}
				}
				newline = pending.indexOf("\n");
			}
		}
		if (pending.trim()) {
			try {
				accumulator.add(JSON.parse(pending.trim()));
			} catch {
				// Same: ignore a partial trailing record.
			}
		}
	} finally {
		closeSync(handle);
	}
	return accumulator.finish();
}

function readEvidence(stateDir) {
	const path = join(stateDir, "voice-evidence", "events.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((error) => {
		process.stderr.write(`${String(error?.stack ?? error)}\n`);
		process.exit(20);
	});
}
