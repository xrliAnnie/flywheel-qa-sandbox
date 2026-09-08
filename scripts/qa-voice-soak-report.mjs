#!/usr/bin/env node
// FLY-2383: build the appendix data block from the run bundles.
//
// Everything here is recomputed from the retained evidence - frames.jsonl,
// bridge-receipts.jsonl, the voice evidence stream - and cross-checked against
// the manifest. Copying the manifest's own aggregates would make this a
// formatter rather than a check, and the appendix would inherit any drift
// silently.
//
// Parsing is strict on purpose: a dropped line in the middle of a frame or event
// stream is exactly what would turn a contaminated round into a clean one.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
	bucketFramesBySecond,
	classSeconds,
} from "./lib/voice-soak/audio-classify.mjs";
import {
	parseLiveCandidates,
	parseStatusReceipt,
	summarizeOrchestrationOverlap,
} from "./lib/voice-soak/bridge-orchestration.mjs";
import {
	AUDIO_CLASSES,
	MAX_HOLE_SHARE,
	MIN_MAIN_RUN_DURATION_MS,
	REQUIRED_RAW_ARTIFACTS,
} from "./lib/voice-soak/constants.mjs";
import {
	judgeAudioEligibility,
	tallyRounds,
} from "./lib/voice-soak/eligibility.mjs";

const PLAYBACK_TAIL_MS = 500;
const RECOGNITION_DEADLINE_MS = 20_000;

const CHINESE_DIGITS = {
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

function digitsOf(text) {
	return String(text ?? "")
		.split("")
		.map((character) => CHINESE_DIGITS[character] ?? character)
		.join("")
		.replace(/\D+/gu, "");
}

/**
 * Only a torn final record is forgiven. A malformed line anywhere else means we
 * cannot say what happened in that stretch, and guessing would bias every
 * derived figure towards "nothing went wrong".
 */
export function readJsonlStrict(path, label) {
	if (!existsSync(path)) return { rows: [], missing: true };
	const text = readFileSync(path, "utf8");
	const lines = text.split("\n");
	const rows = [];
	for (const [index, line] of lines.entries()) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const isLast = index === lines.length - 1 && !text.endsWith("\n");
		try {
			rows.push(JSON.parse(trimmed));
		} catch {
			if (isLast) break; // a run cut off mid-write
			throw new Error(
				`${label}: malformed record at line ${index + 1}; refusing to report over a gap`,
			);
		}
	}
	return { rows, missing: false };
}

function loadRun(runDir) {
	const manifest = JSON.parse(
		readFileSync(join(runDir, "manifest.json"), "utf8"),
	);
	const frames = readJsonlStrict(join(runDir, "frames.jsonl"), "frames").rows;
	const bridge = readJsonlStrict(
		join(runDir, "bridge-receipts.jsonl"),
		"bridge-receipts",
	);
	const events = readJsonlStrict(
		join(runDir, "session", "state", "voice-evidence", "events.jsonl"),
		"voice-evidence",
	).rows;
	for (const frame of frames) {
		if (!AUDIO_CLASSES.includes(frame.audioClass)) {
			throw new Error(`frames: unknown audio class ${frame.audioClass}`);
		}
	}
	// One finite generation across the whole transcript stream, or the bundle
	// cannot support per-round generation checks at all.
	const transcripts = events.filter(
		(row) => row.kind === "realtime_transcript",
	);
	const generations = new Set(transcripts.map((row) => row.generation));
	const finite = [...generations].filter((value) => Number.isFinite(value));
	const generationEvidence =
		transcripts.length === 0
			? { usable: false, expectedGeneration: null, reason: "absent" }
			: finite.length !== 1
				? {
						usable: false,
						expectedGeneration: null,
						reason: `ambiguous (${[...generations].join(", ")})`,
					}
				: generations.size !== 1
					? {
							usable: false,
							expectedGeneration: null,
							reason: "partly missing on some transcripts",
						}
					: { usable: true, expectedGeneration: finite[0], reason: null };

	return { runDir, manifest, frames, bridge, events, generationEvidence };
}

function toMonoFactory(manifest) {
	const { t0WallMs, t0MonoMs } = manifest.timing ?? {};
	if (!Number.isFinite(t0WallMs) || !Number.isFinite(t0MonoMs)) return null;
	return (iso) => {
		const wall = Date.parse(iso);
		return Number.isFinite(wall) ? wall - t0WallMs + t0MonoMs : null;
	};
}

/** Barge activity is read from the evidence, never assumed absent. */
function bargeActedBetween(events, toMono, startMonoMs, endMonoMs) {
	if (!toMono) return false;
	return events.some((row) => {
		if (!String(row.kind ?? "").startsWith("barge_")) return false;
		if (row.acted !== true) return false;
		const at = toMono(row.ts);
		return Number.isFinite(at) && at >= startMonoMs && at <= endMonoMs;
	});
}

function analyseRounds(run) {
	const { manifest, frames, events } = run;
	const toMono = toMonoFactory(manifest);
	const windowEndMonoMs = manifest.timing?.t1MonoMs ?? null;
	const assistantFinals = (toMono ? events : [])
		.filter(
			(row) => row.kind === "realtime_transcript" && row.role === "assistant",
		)
		.map((row) => ({
			atMonoMs: toMono(row.ts),
			transcriptId: row.transcriptId ?? null,
			generation: row.generation ?? null,
			digits: digitsOf(row.text),
			text: row.text ?? "",
		}))
		.filter((row) => Number.isFinite(row.atMonoMs))
		.sort((a, b) => a.atMonoMs - b.atMonoMs);

	const userFinals = (toMono ? events : [])
		.filter((row) => row.kind === "realtime_transcript" && row.role === "user")
		.map((row) => ({
			atMonoMs: toMono(row.ts),
			transcriptId: row.transcriptId ?? null,
			generation: row.generation ?? null,
			digits: digitsOf(row.text),
			text: row.text ?? "",
		}))
		.filter((row) => Number.isFinite(row.atMonoMs))
		.sort((a, b) => a.atMonoMs - b.atMonoMs);

	// Round boundaries, so a late transcript cannot be claimed by an earlier round
	// once the next one has begun.
	const roundStarts = manifest.turns
		.map((round) => round.playbackStartedAtMonoMs)
		.filter((value) => Number.isFinite(value))
		.sort((a, b) => a - b);

	// The session generation, taken from the evidence stream as a whole rather
	// than from the candidate we are about to accept: deriving it from the first
	// matching transcript would make the check self-satisfying.
	//
	// Ambiguity is a failure, not a licence. Falling back to "accept anything"
	// when the evidence is unclear is precisely the direction that would let a
	// transcript from another session be claimed by this one.
	const { expectedGeneration, usable } = run.generationEvidence;
	const sameGeneration = (entry) =>
		usable && entry.generation === expectedGeneration;

	const rounds = [];
	for (const round of manifest.turns) {
		if (!Number.isFinite(round.playbackStartedAtMonoMs)) {
			rounds.push({
				roundId: round.roundId,
				kind: round.kind,
				verdict: "no_playback_window",
			});
			continue;
		}
		const startMonoMs = round.playbackStartedAtMonoMs;
		const endMonoMs = round.playbackEndedAtMonoMs + PLAYBACK_TAIL_MS;
		const bargeActed = bargeActedBetween(
			events,
			toMono,
			startMonoMs,
			endMonoMs,
		);
		const audio = judgeAudioEligibility(round, {
			arm: round.kind === "bed_probe" ? round.arm : "turn",
			frames,
			bargeActed,
			minBedFrames: round.kind === "bed_probe" ? 10 : 1,
			tailMs: PLAYBACK_TAIL_MS,
		});
		// Bounded by a fixed deadline and required to carry this round's nonce, so
		// a late or cross-generation transcript cannot be claimed after the fact.
		const deadlineMonoMs =
			round.playbackEndedAtMonoMs + RECOGNITION_DEADLINE_MS;
		const carriesNonce = assistantFinals.filter(
			(entry) =>
				entry.atMonoMs >= startMonoMs &&
				entry.digits.includes(round.nonce ?? " ") &&
				sameGeneration(entry),
		);
		// Stage two of the approved contract is about the UPLINK: did she hear us.
		// The assistant repeating the code is a different fact and cannot stand in
		// for it — she could echo a code she guessed, or hear one she never repeats.
		const heard = userFinals.find(
			(entry) =>
				entry.atMonoMs >= startMonoMs &&
				entry.atMonoMs <=
					round.playbackEndedAtMonoMs + RECOGNITION_DEADLINE_MS &&
				entry.digits.includes(round.nonce ?? " ") &&
				sameGeneration(entry),
		);
		const matched = carriesNonce.find(
			(entry) => entry.atMonoMs <= deadlineMonoMs,
		);
		// Answered correctly, just past the deadline. Reported as its own category
		// rather than folded either way: counting it would move the boundary after
		// seeing the data, and dropping it silently would read as a failure to
		// answer when the transcript plainly says otherwise.
		// A late candidate must still belong to this round: same generation, and
		// before the next round starts or the window closes.
		const nextRoundStart =
			roundStarts.find((value) => value > startMonoMs) ??
			windowEndMonoMs ??
			Number.POSITIVE_INFINITY;
		const late = matched
			? null
			: carriesNonce.find((entry) => entry.atMonoMs < nextRoundStart);
		rounds.push({
			roundId: round.roundId,
			kind: round.kind,
			arm: round.arm,
			nonce: round.nonce,
			eligible: audio.eligible,
			ineligibleReason: audio.reason,
			coverage: audio.coverage ?? null,
			bargeActed,
			turnCompleted: Boolean(matched),
			matchedTranscriptId: matched?.transcriptId ?? null,
			generation: matched?.generation ?? null,
			rttPlaybackToAssistantMs: matched
				? Math.round(matched.atMonoMs - startMonoMs)
				: null,
			expectedGeneration,
			nonceEchoed: carriesNonce.length > 0,
			heardByRaya: Boolean(heard),
			heardTranscriptId: heard?.transcriptId ?? null,
			lateButCorrect: Boolean(late),
			lateRttMs: late ? Math.round(late.atMonoMs - startMonoMs) : null,
			deadlineMs: Math.round(deadlineMonoMs - startMonoMs),
			withinObservationWindow:
				windowEndMonoMs === null ? null : startMonoMs < windowEndMonoMs,
		});
	}
	return rounds;
}

function quantile(values, q) {
	if (values.length === 0) return null;
	return values[
		Math.min(
			values.length - 1,
			Math.max(0, Math.round((values.length - 1) * q)),
		)
	];
}

function rttByKind(rounds) {
	return Object.fromEntries(
		["plain", "tool", "bed_probe"].map((kind) => {
			const values = rounds
				.filter((row) => row.kind === kind)
				.map((row) => row.rttPlaybackToAssistantMs)
				.filter((value) => Number.isFinite(value))
				.sort((a, b) => a - b);
			return [
				kind,
				{
					n: values.length,
					minMs: values[0] ?? null,
					medianMs: quantile(values, 0.5),
					maxMs: values[values.length - 1] ?? null,
					allMs: values,
				},
			];
		}),
	);
}

function clockStallBuckets(run) {
	const toMono = toMonoFactory(run.manifest);
	const t0 = run.manifest.timing?.t0MonoMs ?? 0;
	const t1 = run.manifest.timing?.t1MonoMs ?? null;
	const buckets = {
		beforeWindow: 0,
		inWindow: 0,
		afterWindow: 0,
		byReason: {},
	};
	for (const row of run.events) {
		if (row.kind !== "audio_clock_stall") continue;
		const reason = row.reason ?? "unknown";
		buckets.byReason[reason] = (buckets.byReason[reason] ?? 0) + 1;
		const at = toMono ? toMono(row.ts) : null;
		if (!Number.isFinite(at) || t1 === null) continue;
		if (at < t0) buckets.beforeWindow += 1;
		else if (at >= t1) buckets.afterWindow += 1;
		else buckets.inWindow += 1;
	}
	return buckets;
}

export function authoritativeDurationMs(manifest) {
	const t0 = manifest.timing?.t0MonoMs;
	const t1 = manifest.timing?.t1MonoMs;
	if (!Number.isFinite(t0) || !Number.isFinite(t1)) {
		throw new Error("manifest has no finite T0/T1 to measure the window with");
	}
	if (t1 < t0) throw new Error("manifest T1 precedes T0");
	return t1 - t0;
}

export function summarize(runDir) {
	const run = loadRun(runDir);
	const { manifest } = run;
	const t1MonoMs = manifest.timing?.t1MonoMs ?? null;
	// The window is measured from the clock readings, never from the derived
	// aggregate: that field is a summary of them and can disagree.
	const durationMs = authoritativeDurationMs(manifest);
	const { buckets, holes } = bucketFramesBySecond(run.frames, {
		t0MonoMs: manifest.timing?.t0MonoMs ?? 0,
		endMonoMs: t1MonoMs,
	});
	const audio = classSeconds(buckets);
	const rounds = analyseRounds(run);
	const turns = rounds.filter((row) => row.kind !== "bed_probe");
	const probes = rounds.filter((row) => row.kind === "bed_probe");
	// Re-derive each sample from its own raw bodies rather than trusting the
	// derived fields written alongside them, and say so if the two disagree.
	const bridgeDisagreements = [];
	const rederived = run.bridge.missing
		? []
		: run.bridge.rows.map((row) => {
				if (row.instrumentationError) return row;
				try {
					if (!Array.isArray(row.rawList)) {
						throw new Error("receipt has no rawList to re-select from");
					}
					const candidates = parseLiveCandidates(
						{ sessions: row.rawList },
						{ excludeExecutionIds: row.excludedExecutionIds ?? [] },
					);
					if (candidates.length === 0) {
						if (row.executing) {
							throw new Error("recorded executing but no candidate re-selects");
						}
						return { ...row, executing: false };
					}
					if (!row.rawStatus) {
						throw new Error(
							"receipt selected a candidate but kept no status body",
						);
					}
					const receipt = parseStatusReceipt(row.rawStatus);
					// The status body must belong to the runner this receipt actually
					// selected — otherwise it says nothing about this sample.
					if (candidates[0].executionId !== receipt.executionId) {
						throw new Error(
							`status body is for ${receipt.executionId}, but the raw list selects ${candidates[0].executionId}`,
						);
					}
					if (
						receipt.executing !== row.executing ||
						receipt.executionId !== row.executionId ||
						candidates.length !== row.candidates
					) {
						throw new Error("derived fields disagree with the raw bodies");
					}
					return {
						...row,
						executing: receipt.executing,
						executionId: receipt.executionId,
					};
				} catch (error) {
					bridgeDisagreements.push({
						atMonoMs: row.atMonoMs,
						error: String(error?.message ?? error),
					});
					return row;
				}
			});
	const orchestration = run.bridge.missing
		? { missing: true }
		: summarizeOrchestrationOverlap(
				rederived.map((row) => ({
					atMonoMs: row.atMonoMs,
					executionId: row.executionId,
					executing: row.executing,
					instrumentationError: row.instrumentationError,
				})),
				{ windowStartMonoMs: 0, windowEndMonoMs: durationMs },
			);
	let probeTally = null;
	let probeTallyError = null;
	try {
		probeTally = tallyRounds(
			probes.map((row) => ({
				eligible: row.eligible,
				ineligibleReason: row.ineligibleReason,
				// hit/miss is the uplink question, not whether she echoed it back.
				recognition: row.eligible ? (row.heardByRaya ? "hit" : "miss") : null,
			})),
		);
	} catch (error) {
		probeTallyError = String(error?.message ?? error);
	}
	return {
		runDir,
		runId: manifest.runId,
		arm: manifest.arm,
		verdict: manifest.verdict,
		verdictReasons: manifest.verdictReasons,
		timing: manifest.timing,
		provenance: manifest.provenance,
		artifacts: manifest.artifacts ?? null,
		threeConditions: manifest.threeConditions,
		// Rebuilt from what the evidence now yields, so a manifest claiming more
		// than its own receipts support cannot pass unnoticed.
		authoritativeDurationMs: durationMs,
		threeConditionsRecomputed: {
			realAgentTurnDuringVoice:
				turns.filter((row) => row.turnCompleted).length > 0,
			halfHourScale: durationMs >= MIN_MAIN_RUN_DURATION_MS,
			realOrchestrationInFlight: orchestration.qualifyingOverlap === true,
		},
		turns: {
			attempted: turns.length,
			completed: turns.filter((row) => row.turnCompleted).length,
			// Three separate facts, because collapsing them would hide which of the
			// two failure modes actually occurred.
			nonceEchoedAtAll: turns.filter((row) => row.nonceEchoed).length,
			lateButCorrect: turns.filter((row) => row.lateButCorrect).length,
			uncontaminated: turns.filter((row) => row.eligible).length,
			rttByKind: rttByKind(rounds),
			rounds: turns,
		},
		probes: { tally: probeTally, error: probeTallyError, rounds: probes },
		audio: {
			classSeconds: audio.seconds,
			classShare: audio.share,
			totalFrames: audio.totalFrames,
			holes: holes.length,
			packetsPerMinute: (
				manifest.audio?.downlinkOpusPacketsPerMinute ?? []
			).map((sample) => sample.packets),
			decoderErrors: manifest.audio?.decoderErrors?.length ?? 0,
			clockStalls: clockStallBuckets(run),
		},
		orchestration,
		bridgeReceiptsPresent: !run.bridge.missing,
		bridgeDisagreements,
		artifactVerification: verifyArtifacts(runDir, manifest),
		// A voice_exit at teardown is the run ending normally. Only one inside the
		// observation window would mean she dropped out mid-conversation, and the
		// two must never be reported as the same number.
		voiceExit: (() => {
			const toMono = toMonoFactory(manifest);
			const exits = run.events
				.filter((row) => row.kind === "voice_exit")
				.map((row) => ({
					atMonoMs: toMono ? toMono(row.ts) : null,
					code: row.code ?? null,
					reason: row.reason ?? null,
				}));
			return {
				total: exits.length,
				withinObservationWindow: exits.filter(
					(exit) =>
						Number.isFinite(exit.atMonoMs) &&
						t1MonoMs !== null &&
						exit.atMonoMs < t1MonoMs,
				).length,
				exits,
			};
		})(),
		cleanupErrors: manifest.cleanupErrors,
		// An actual comparison, not a copy: any difference between what the run
		// recorded and what the evidence now yields is a drift the reader must see.
		manifestDrift: diffAgainstManifest(manifest, audio, holes.length, {
			orchestration,
			turnsCompleted: turns.filter((row) => row.turnCompleted).length,
			durationMs,
		}),
		verdictRecomputed: recomputeVerdict(manifest, holes.length, durationMs),
		generationEvidence: run.generationEvidence,
		roundIntegrity: checkRoundIntegrity(manifest),
	};
}

const fmt = (value, suffix = "") =>
	value === null || value === undefined ? "n/a" : `${value}${suffix}`;

/**
 * The appendix data block, emitted rather than transcribed.
 *
 * Hand-copying these figures is how a denominator loses a round between the
 * bundle and the document, so the same pass that computes them writes them out.
 */
function renderMarkdown(summary) {
	const a = summary.armA;
	const b = summary.armB;
	const probeTally = (run) => run?.probes?.tally ?? null;
	const lines = [];

	lines.push("<!-- 由 scripts/qa-voice-soak-report.mjs 生成,请勿手改 -->");
	lines.push(`<!-- generatedAt: ${summary.generatedAt} -->`);
	lines.push("");
	lines.push("### 两臂概览");
	lines.push("");
	lines.push("| | 臂 A(bed 开,默认) | 臂 B(bed 关,对照) |");
	lines.push("|---|---|---|");
	lines.push(`| run-id | \`${a.runId}\` | ${b ? `\`${b.runId}\`` : "—"} |`);
	lines.push(
		`| 观测窗(单调钟,[T0,T1)) | ${fmt(a.timing?.monotonicDurationMs, " ms")} | ${fmt(b?.timing?.monotonicDurationMs, " ms")} |`,
	);
	lines.push(
		`| teardown(**不计入观测窗**) | ${fmt(a.timing?.teardownMs, " ms")} | ${fmt(b?.timing?.teardownMs, " ms")} |`,
	);
	lines.push(
		`| verdict | **${a.verdict}** | ${b ? `**${b.verdict}**` : "—"} |`,
	);
	lines.push(
		`| 三条件全部成立 | ${a.threeConditions?.allSatisfied ? "**是**" : "否"} | ${b ? (b.threeConditions?.allSatisfied ? "是" : "否(对照臂本就不是半小时)") : "—"} |`,
	);
	lines.push("");

	lines.push("### agent turn");
	lines.push("");
	lines.push("| | 臂 A | 臂 B |");
	lines.push("|---|---|---|");
	lines.push(`| 尝试 | ${a.turns.attempted} | ${fmt(b?.turns.attempted)} |`);
	lines.push(
		`| **完成**(assistant 回出本轮口令) | **${a.turns.completed}** | ${fmt(b?.turns.completed)} |`,
	);
	lines.push(
		`| 播放窗未被抢话/采样不足污染 | ${a.turns.uncontaminated} | ${fmt(b?.turns.uncontaminated)} |`,
	);
	lines.push("");

	lines.push("### 往返(playback 开始 → 含本轮口令的 assistant final)");
	lines.push("");
	lines.push("> ⛔ 分类型读。工具轮大部分时间是**它在跑命令**,不是语音慢。");
	lines.push("");
	lines.push(
		"| 类型 | 臂 A n / min / 中位 / max (ms) | 臂 B n / min / 中位 / max (ms) |",
	);
	lines.push("|---|---|---|");
	for (const [kind, label] of [
		["plain", "纯问答"],
		["tool", "带工具"],
		["bed_probe", "忙窗探针"],
	]) {
		const ra = a.turns.rttByKind[kind];
		const rb = b?.turns.rttByKind?.[kind];
		const cell = (r) =>
			r && r.n > 0 ? `${r.n} / ${r.minMs} / ${r.medianMs} / ${r.maxMs}` : "n/a";
		lines.push(`| ${label} | ${cell(ra)} | ${cell(rb)} |`);
	}
	lines.push("");

	lines.push("### 下行 Opus 包(**含 voice / bed / 编码静音**)");
	lines.push("");
	lines.push("| | 臂 A | 臂 B |");
	lines.push("|---|---|---|");
	const pk = (run) => {
		const p = run?.audio?.packetsPerMinute ?? [];
		return p.length
			? `${p.length} 格,${Math.min(...p)} – ${Math.max(...p)}`
			: "n/a";
	};
	lines.push(`| 每分钟包数(格数,min – max) | ${pk(a)} | ${pk(b)} |`);
	lines.push(
		`| 窗内总帧(20ms/帧) | ${a.audio.totalFrames} | ${fmt(b?.audio.totalFrames)} |`,
	);
	lines.push(`| 逐秒桶空洞 | ${a.audio.holes} | ${fmt(b?.audio.holes)} |`);
	lines.push("");
	lines.push("⛔ 这一格证明**下行传输还在**,**不是**「电话里一直有声音」。");
	lines.push("");

	lines.push("### 分类器看到的内容(窗内秒数)");
	lines.push("");
	lines.push("| | 臂 A | 臂 B |");
	lines.push("|---|---|---|");
	for (const name of summary.audioClasses) {
		const sa = a.audio.classSeconds[name];
		const sb = b?.audio.classSeconds?.[name];
		const shA = a.audio.classShare[name];
		const shB = b?.audio.classShare?.[name];
		lines.push(
			`| \`${name}\` | ${fmt(sa, " s")}(${((shA ?? 0) * 100).toFixed(2)}%) | ${sb === undefined ? "—" : `${sb} s(${((shB ?? 0) * 100).toFixed(2)}%)`} |`,
		);
	}
	lines.push("");

	lines.push("### 掉线 / 断档");
	lines.push("");
	lines.push("| 观测项 | 臂 A | 臂 B |");
	lines.push("|---|---|---|");
	lines.push(
		`| **观测窗内**的 \`voice_exit\` | ${a.voiceExit.withinObservationWindow} | ${fmt(b?.voiceExit.withinObservationWindow)} |`,
	);
	lines.push(
		`| 收尾时的 \`voice_exit\`(正常结束) | ${a.voiceExit.total - a.voiceExit.withinObservationWindow} | ${b ? b.voiceExit.total - b.voiceExit.withinObservationWindow : "—"} |`,
	);
	lines.push(
		`| driver 旁路监听到的 decoder error | ${a.audio.decoderErrors} | ${fmt(b?.audio.decoderErrors)} |`,
	);
	lines.push(
		`| \`audio_clock_stall\` **窗内** | ${a.audio.clockStalls.inWindow} | ${fmt(b?.audio.clockStalls.inWindow)} |`,
	);
	lines.push(
		`| \`audio_clock_stall\` 窗前 / 窗后 | ${a.audio.clockStalls.beforeWindow} / ${a.audio.clockStalls.afterWindow} | ${b ? `${b.audio.clockStalls.beforeWindow} / ${b.audio.clockStalls.afterWindow}` : "—"} |`,
	);
	lines.push(
		`| cleanup 错误 | ${a.cleanupErrors?.length ?? 0} | ${fmt(b?.cleanupErrors?.length ?? 0)} |`,
	);
	lines.push("");
	lines.push("⛔ `meeting_container_*` 在非 meeting 场是 **N/A**,本表不含。");
	lines.push(
		"⛔ receiver stream error 公开 API **不暴露**,本表不报 —— 那是「没观测」,不是 0。",
	);
	lines.push("");

	lines.push("### 忙窗探针识别(等待音那半格)");
	lines.push("");
	lines.push("| | 臂 A(bed confirmed) | 臂 B(bed absent confirmed) |");
	lines.push("|---|---|---|");
	const ta = probeTally(a);
	const tb = probeTally(b);
	for (const [key, label] of [
		["attempted", "attempted"],
		["audioEligible", "**audio-eligible**"],
		["hit", "hit"],
		["miss", "**miss**"],
	]) {
		lines.push(`| ${label} | ${fmt(ta?.[key])} | ${fmt(tb?.[key])} |`);
	}
	const reasons = new Set([
		...Object.keys(ta?.ineligibleByReason ?? {}),
		...Object.keys(tb?.ineligibleByReason ?? {}),
	]);
	for (const reason of [...reasons].sort()) {
		const va = ta?.ineligibleByReason?.[reason] ?? 0;
		const vb = tb?.ineligibleByReason?.[reason] ?? 0;
		if (va === 0 && vb === 0) continue;
		lines.push(`| ineligible:\`${reason}\` | ${va} | ${vb} |`);
	}
	lines.push("");
	lines.push(
		"> 🔴 **N 太小,⛔ 不许比较两臂的命中【率】。** 只读这几个数本身。",
	);
	lines.push("");

	lines.push("### 窗内编排(条件③)");
	lines.push("");
	lines.push("| | 臂 A | 臂 B |");
	lines.push("|---|---|---|");
	const orch = (run) => run?.orchestration ?? {};
	lines.push(
		`| 原始 Bridge 收据已落盘 | ${a.bridgeReceiptsPresent ? "是" : "**否**"} | ${b ? (b.bridgeReceiptsPresent ? "是" : "**否**") : "—"} |`,
	);
	lines.push(`| 采样点 | ${fmt(orch(a).samples)} | ${fmt(orch(b).samples)} |`);
	lines.push(
		`| 其中 \`executing\` 的采样点 | ${fmt(orch(a).executingSamples)} | ${fmt(orch(b).executingSamples)} |`,
	);
	lines.push(
		`| 仪器故障 | ${fmt(orch(a).instrumentationFaults)} | ${fmt(orch(b).instrumentationFaults)} |`,
	);
	lines.push("");
	lines.push("⛔ 这是**离散采样点**,不是「窗内始终」。");
	lines.push("");

	lines.push("### provenance");
	lines.push("");
	lines.push("⚠️ **两臂的执行物不一定相同**,逐臂列出;⛔ 不要只读臂 A 那一列。");
	lines.push("");
	lines.push("```");
	for (const run of [a, b].filter(Boolean)) {
		const p = run.provenance ?? {};
		lines.push(`── ${run.runId} ──`);
		lines.push(`flywheel   ${p.flywheelSha ?? "?"}  dirty=${p.flywheelDirty}`);
		lines.push(`harness    ${p.harnessSha ?? "?"}  dirty=${p.harnessDirty}`);
		lines.push(`subject    ${p.subjectSha ?? "?"}  dirty=${p.subjectDirty}`);
		lines.push(`subject cli sha256 ${p.subjectCliSha256 ?? "?"}`);
		if (p.thresholdsFile) {
			lines.push(
				`thresholds (运行时) ${p.thresholdsFile.path}  ${p.thresholdsFile.sha256}`,
			);
		}
		for (const [file, hash] of Object.entries(p.crossRepoImports ?? {})) {
			lines.push(`cross-repo ${file}  ${hash ?? "MISSING"}`);
		}
		for (const [file, hash] of Object.entries(p.collector ?? {})) {
			lines.push(`collector  ${file}  ${hash ?? "MISSING"}`);
		}
		for (const [name, hash] of Object.entries(run.artifacts ?? {})) {
			lines.push(`artifact   ${name}  ${hash ?? "MISSING"}`);
		}
		lines.push("");
	}
	lines.push("```");
	lines.push("");
	return lines.join("\n");
}

/**
 * Rebuild the verdict from what the evidence now shows.
 *
 * A manifest can be edited to say VALID; the receipts underneath it cannot be
 * made to agree without also editing them. Anything the driver would have
 * refused — too many unobserved seconds, a window short of the required length,
 * a guard that fired, a cleanup that failed — is refused here too.
 */
/**
 * A round is identified by its id and by the nonce it spoke. Duplicating an
 * entry would otherwise be counted twice — the cheapest possible way to add a
 * hit without touching a single frame.
 */
export function checkRoundIntegrity(manifest) {
	const problems = [];
	const seenIds = new Set();
	const seenNonces = new Set();
	for (const round of manifest.turns ?? []) {
		if (seenIds.has(round.roundId)) {
			problems.push(`duplicate roundId ${round.roundId}`);
		}
		seenIds.add(round.roundId);
		if (round.nonce) {
			if (seenNonces.has(round.nonce)) {
				problems.push(`duplicate nonce ${round.nonce}`);
			}
			seenNonces.add(round.nonce);
		}
	}
	return { clean: problems.length === 0, problems };
}

export function recomputeVerdict(manifest, holes, durationMs) {
	const reasons = [];
	const holeShare = durationMs > 0 ? holes / (durationMs / 1_000) : 0;
	if (holeShare > MAX_HOLE_SHARE) reasons.push(`excessive_holes:${holes}`);
	if (manifest.guardViolation) {
		reasons.push(`guard:${manifest.guardViolation.reason}`);
	}
	for (const error of manifest.cleanupErrors ?? []) {
		reasons.push(`cleanup:${error}`);
	}
	if (manifest.secretScanError) reasons.push("secret_scan_failed");
	if (manifest.timing?.clockAnomaly || manifest.failures?.clockAnomaly) {
		reasons.push("clock_anomaly");
	}
	// Conditions the raw artifacts cannot express, so they are read from the
	// recorded flags rather than silently dropped from the rebuilt verdict.
	if (manifest.failures?.childExitedEarly) reasons.push("child_exited_early");
	if (manifest.failures?.downlinkStalled) reasons.push("downlink_stalled");
	if (manifest.failures?.instrumentFail) reasons.push("instrument_fail");
	// Only a run that asked to be a main run is held to the half-hour floor.
	const requiredMinDuration = (manifest.provenance?.cli ?? []).includes(
		"--require-min-duration",
	);
	if (requiredMinDuration && durationMs < MIN_MAIN_RUN_DURATION_MS) {
		reasons.push("below_min_duration");
	}
	return {
		verdict: reasons.length === 0 ? "VALID" : "INVALID",
		reasons,
		holeShare: Number(holeShare.toFixed(4)),
	};
}

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * The manifest names the bytes it was built from; check that they still are —
 * and that it named all of them.
 *
 * The required set is fixed here rather than taken from the manifest: a bundle
 * that simply omits an artifact would otherwise verify an empty set and report
 * everything as matching.
 */
export function verifyArtifacts(runDir, manifest) {
	const expected = manifest.artifacts ?? {};
	const results = {};
	let allMatch = true;
	for (const name of REQUIRED_RAW_ARTIFACTS) {
		if (!(name in expected)) {
			results[name] = "not_listed_in_manifest";
			allMatch = false;
		}
	}
	for (const [name, hash] of Object.entries(expected)) {
		const path = join(runDir, name);
		if (!hash) {
			results[name] = "not_hashed_at_run_time";
			allMatch = false;
			continue;
		}
		if (!existsSync(path)) {
			results[name] = "missing";
			allMatch = false;
			continue;
		}
		const actual = sha256File(path);
		results[name] = actual === hash ? "match" : `mismatch:${actual}`;
		if (actual !== hash) allMatch = false;
	}
	return { allMatch, results };
}

function diffAgainstManifest(manifest, audio, holes, extra) {
	const recorded = {
		classSeconds: manifest.audio?.classSeconds ?? null,
		holes: manifest.audio?.secondBucketHoles?.length ?? null,
		totalFrames: manifest.audio?.totalFrames ?? null,
	};
	const recomputed = {
		classSeconds: audio.seconds,
		holes,
		totalFrames: audio.totalFrames,
	};
	const differences = [];
	if (recorded.holes !== recomputed.holes) {
		differences.push({
			field: "holes",
			recorded: recorded.holes,
			recomputed: recomputed.holes,
		});
	}
	if (recorded.totalFrames !== recomputed.totalFrames) {
		differences.push({
			field: "totalFrames",
			recorded: recorded.totalFrames,
			recomputed: recomputed.totalFrames,
		});
	}
	for (const [name, value] of Object.entries(recomputed.classSeconds)) {
		if (recorded.classSeconds?.[name] !== value) {
			differences.push({
				field: `classSeconds.${name}`,
				recorded: recorded.classSeconds?.[name] ?? null,
				recomputed: value,
			});
		}
	}
	// The conclusions matter more than the aggregates: a bundle whose receipts no
	// longer support its own threeConditions must not produce an appendix.
	const recordedConditions = manifest.threeConditions?.conditions ?? {};
	const rebuilt = {
		realAgentTurnDuringVoice: extra.turnsCompleted > 0,
		halfHourScale: extra.durationMs >= MIN_MAIN_RUN_DURATION_MS,
		realOrchestrationInFlight: extra.orchestration.qualifyingOverlap === true,
	};
	// The duration aggregate must agree with the clock readings it summarises.
	const recordedDuration = manifest.timing?.monotonicDurationMs ?? null;
	if (Math.round(extra.durationMs) !== Math.round(recordedDuration ?? -1)) {
		differences.push({
			field: "timing.monotonicDurationMs",
			recorded: recordedDuration,
			recomputed: Math.round(extra.durationMs),
		});
	}
	for (const [name, value] of Object.entries(rebuilt)) {
		if (recordedConditions[name] !== value) {
			differences.push({
				field: `threeConditions.${name}`,
				recorded: recordedConditions[name] ?? null,
				recomputed: value,
			});
		}
	}
	const recordedAll = manifest.threeConditions?.allSatisfied ?? null;
	const rebuiltAll = Object.values(rebuilt).every(Boolean);
	if (recordedAll !== rebuiltAll) {
		differences.push({
			field: "threeConditions.allSatisfied",
			recorded: recordedAll,
			recomputed: rebuiltAll,
		});
	}
	return { clean: differences.length === 0, recorded, recomputed, differences };
}

export function evidenceProblems(runs) {
	const problems = [];
	for (const run of runs.filter(Boolean)) {
		if (run.verdict === "VALID" && !run.artifactVerification.allMatch) {
			problems.push(`${run.runId}: artifact hashes do not verify`);
		}
		if (!run.manifestDrift.clean) {
			problems.push(
				`${run.runId}: recomputation differs from the manifest (${run.manifestDrift.differences
					.map((d) => d.field)
					.join(", ")})`,
			);
		}
		if (run.bridgeDisagreements?.length > 0) {
			problems.push(
				`${run.runId}: ${run.bridgeDisagreements.length} Bridge samples disagree with their raw bodies`,
			);
		}
		if (run.verdictRecomputed.verdict !== run.verdict) {
			problems.push(
				`${run.runId}: manifest says ${run.verdict} but the evidence gives ${run.verdictRecomputed.verdict} (${run.verdictRecomputed.reasons.join("; ")})`,
			);
		}
		if (!run.roundIntegrity.clean) {
			problems.push(`${run.runId}: ${run.roundIntegrity.problems.join("; ")}`);
		}
		if (!run.generationEvidence.usable) {
			problems.push(
				`${run.runId}: transcript generations are ${run.generationEvidence.reason}`,
			);
		}
	}
	return problems;
}

function main() {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			"arm-a": { type: "string" },
			"arm-b": { type: "string" },
			out: { type: "string" },
			markdown: { type: "string" },
		},
		strict: true,
		allowPositionals: false,
	});
	if (!values["arm-a"] || !values.out) {
		process.stderr.write(
			"usage: --arm-a <runDir> [--arm-b <runDir>] --out <summary.json>\n",
		);
		process.exit(64);
	}
	const summary = {
		issue: "FLY-2383",
		generatedAt: new Date().toISOString(),
		armA: summarize(values["arm-a"]),
		armB: values["arm-b"] ? summarize(values["arm-b"]) : null,
		audioClasses: AUDIO_CLASSES,
	};
	writeFileSync(values.out, `${JSON.stringify(summary, null, 2)}\n`, {
		mode: 0o600,
	});
	if (values.markdown) {
		// The appendix block is only worth generating from a bundle that still
		// matches its own hashes and agrees with its own manifest.
		const problems = evidenceProblems([summary.armA, summary.armB]);
		if (problems.length > 0) {
			process.stderr.write(
				`refusing to generate the appendix block:\n  ${problems.join("\n  ")}\n`,
			);
			process.exit(1);
		}
		writeFileSync(values.markdown, `${renderMarkdown(summary)}\n`, {
			mode: 0o600,
		});
	}
	process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main();
}
