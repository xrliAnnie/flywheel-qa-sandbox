#!/usr/bin/env node
// FLY-2383: derive the audio classifier thresholds from a calibration pilot.
//
// The labels come from independent anchors, never from the classifier itself:
//
//   silence  T0 until the first injection — nothing has been asked yet
//   voice    the seconds immediately before each assistant final transcript
//   bed      between a user final and the assistant starting to speak, when she
//            is working; this is the label the bed-off arm must fail to produce
//
// The bed-off run is the negative control: the same detector must find no bed
// there. Passing that is what makes "bed" mean the waiting sound rather than
// whatever the threshold happened to catch.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
	classifyFrame,
	emptyClassCounts,
} from "./lib/voice-soak/audio-classify.mjs";
import {
	deriveThresholds,
	HOLDOUT_RULES,
	QUALIFICATION_POLICY_ID,
	summarizeWindow,
	validateHoldout,
} from "./lib/voice-soak/calibrate.mjs";

const VOICE_LEAD_MS = 4_000;

/**
 * Strict, for the same reason the report is: a dropped line in the middle of a
 * frame stream is invisible, and a calibration signed over a gap would look
 * exactly like one signed over the whole thing.
 */
function readJsonl(path) {
	if (!existsSync(path)) return [];
	const text = readFileSync(path, "utf8");
	const lines = text.split("\n");
	const rows = [];
	for (const [index, line] of lines.entries()) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const isLast = index === lines.length - 1 && !text.endsWith("\n");
		try {
			rows.push(JSON.parse(trimmed));
		} catch (_error) {
			if (isLast) break; // a run cut off mid-write
			throw new Error(
				`${path}: malformed record at line ${index + 1}; refusing to calibrate over a gap`,
			);
		}
	}
	return rows;
}

function loadRun(runDir) {
	const manifest = JSON.parse(
		readFileSync(join(runDir, "manifest.json"), "utf8"),
	);
	const frames = readJsonl(join(runDir, "frames.jsonl"));
	const evidence = readJsonl(
		join(runDir, "session", "state", "voice-evidence", "events.jsonl"),
	);
	const { t0WallMs, t0MonoMs } = manifest.timing;
	if (t0WallMs === null || t0MonoMs === null) {
		throw new Error(`${runDir}: manifest has no T0 anchor to align clocks on`);
	}
	const toMono = (isoOrMs) => {
		const wall = typeof isoOrMs === "number" ? isoOrMs : Date.parse(isoOrMs);
		return Number.isFinite(wall) ? wall - t0WallMs + t0MonoMs : null;
	};
	return { runDir, manifest, frames, evidence, toMono, t0MonoMs };
}

function framesBetween(frames, startMonoMs, endMonoMs) {
	return frames.filter(
		(frame) => frame.atMonoMs >= startMonoMs && frame.atMonoMs <= endMonoMs,
	);
}

function labelWindows(run) {
	const { manifest, frames, evidence, toMono, t0MonoMs } = run;
	const transcripts = evidence
		.filter((row) => row.kind === "realtime_transcript" && row.ts)
		.map((row) => ({ role: row.role, atMonoMs: toMono(row.ts) }))
		.filter((row) => Number.isFinite(row.atMonoMs))
		.sort((a, b) => a.atMonoMs - b.atMonoMs);

	const firstInjectionMonoMs = manifest.turns
		.map((round) => round.playbackStartedAtMonoMs)
		.filter((value) => Number.isFinite(value))
		.sort((a, b) => a - b)[0];

	const silence =
		firstInjectionMonoMs === undefined
			? []
			: framesBetween(frames, t0MonoMs + 2_000, firstInjectionMonoMs - 1_000);

	// Collect the bed windows first: their loudest frame anchors onset detection.
	const bed = [];
	for (const round of manifest.turns) {
		if (round.kind !== "bed_probe") continue;
		if (
			!Number.isFinite(round.workSettledAtMonoMs) ||
			!Number.isFinite(round.playbackStartedAtMonoMs)
		) {
			continue;
		}
		bed.push(
			...framesBetween(
				frames,
				round.workSettledAtMonoMs - 4_000,
				round.playbackStartedAtMonoMs - 500,
			),
		);
	}
	const bedEnergyCeiling = bed.reduce(
		(highest, frame) => Math.max(highest, frame.energy),
		0,
	);
	const voice = [];
	const transition = [];
	for (const [_index, entry] of transcripts.entries()) {
		if (entry.role !== "assistant") continue;
		// The assistant's final transcript lands as her audio begins, not when it
		// ends: the observed clusters start within a few hundred ms of the row and
		// run on for seconds afterwards.
		voice.push(
			...framesBetween(
				frames,
				entry.atMonoMs + 400,
				entry.atMonoMs + VOICE_LEAD_MS,
			),
		);
		// The onset itself. It is located by a threshold-independent anchor — the
		// loudest frame the bed windows ever produced — so the test does not
		// quietly depend on the thresholds it is meant to check.
		const onset = frames.find(
			(frame) =>
				frame.atMonoMs >= entry.atMonoMs &&
				frame.atMonoMs <= entry.atMonoMs + VOICE_LEAD_MS &&
				frame.energy > bedEnergyCeiling,
		);
		if (onset) {
			transition.push(
				...framesBetween(frames, onset.atMonoMs, onset.atMonoMs + 400),
			);
		}
	}

	return { silence, voice, bed, transition };
}

function splitHoldout(frames, fraction = 0.3) {
	const cut = Math.floor(frames.length * (1 - fraction));
	return { fit: frames.slice(0, cut), holdout: frames.slice(cut) };
}

/**
 * The calibration tables, emitted rather than typed.
 *
 * Every figure a reader might check has to come from the same pass that computed
 * it; a hand-copied count is how a "passed" ends up next to numbers that do not
 * support it.
 */
function renderCalibrationMarkdown(report) {
	const lines = [];
	lines.push("<!-- 由 scripts/qa-voice-soak-calibrate.mjs 生成,请勿手改 -->");
	lines.push(`<!-- policy: ${report.qualificationPolicyId} -->`);
	lines.push("");
	lines.push("**冻结的阈值**(⛔ 尺子的标定,不是产品阈值):");
	lines.push("");
	lines.push("```json");
	lines.push(
		JSON.stringify(
			Object.fromEntries(
				Object.entries(report.thresholds).filter(
					([key]) => !["derivedFrom", "separability"].includes(key),
				),
			),
			null,
			2,
		),
	);
	lines.push("```");
	lines.push("");
	lines.push("**holdout(未参与定阈值的窗)—— 政策上限 vs 实测值**:");
	lines.push("");
	lines.push(
		"| 窗 | 帧 | voice | bed | silence | unknown | 政策 | 实测 | 结果 |",
	);
	lines.push("|---|---:|---:|---:|---:|---:|---|---|---|");
	const rules = report.holdoutRules ?? {};
	for (const [label, share] of Object.entries(report.holdout?.shares ?? {})) {
		const rule = rules[label] ?? {};
		const policy = Object.entries(rule)
			.map(([name, value]) => `${name}=${value}`)
			.join(", ");
		const observed = `bed ${(share.bedShare * 100).toFixed(2)}% / voice ${(share.voiceShare * 100).toFixed(2)}%`;
		lines.push(
			`| ${label} | ${share.frames} | ${share.counts.voice} | ${share.counts.bed} | ${share.counts.silence} | ${share.counts.unknown} | ${policy} | ${observed} | ${report.holdout.passed ? "✓" : "✗"} |`,
		);
	}
	lines.push("");
	if (report.negativeControl) {
		const n = report.negativeControl;
		lines.push("**负对照(bed-OFF 臂的忙窗)**:");
		lines.push("");
		lines.push(
			`\`\`\`
忙窗帧 ${n.busyFrames} → bed ${n.classified.bed} 帧(bedShare ${(n.bedShare * 100).toFixed(2)}%),passed=${n.passed}
分类: ${JSON.stringify(n.classified)}
\`\`\``,
		);
		lines.push("");
	}
	lines.push("**标定窗的样本量**:");
	lines.push("");
	lines.push("```");
	lines.push(JSON.stringify(report.windowFrames));
	lines.push("```");
	return lines.join("\n");
}

function main() {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			"on-run": { type: "string" },
			"off-run": { type: "string" },
			out: { type: "string" },
			markdown: { type: "string" },
		},
		strict: true,
		allowPositionals: false,
	});
	if (!values["on-run"] || !values.out) {
		process.stderr.write(
			"usage: --on-run <runDir> [--off-run <runDir>] --out <thresholds.json>\n",
		);
		process.exit(64);
	}
	const onRun = loadRun(values["on-run"]);
	const labelled = labelWindows(onRun);
	const report = {
		issue: "FLY-2383",
		// Stamped so a threshold file can never be mistaken for one qualified
		// under a different rule.
		qualificationPolicyId: QUALIFICATION_POLICY_ID,
		holdoutRules: HOLDOUT_RULES,
		onRun: values["on-run"],
		offRun: values["off-run"] ?? null,
		windowFrames: Object.fromEntries(
			Object.entries(labelled).map(([label, frames]) => [label, frames.length]),
		),
		windowSummaries: Object.fromEntries(
			Object.entries(labelled).map(([label, frames]) => [
				label,
				frames.length > 0 ? summarizeWindow(frames) : null,
			]),
		),
	};

	const silenceSplit = splitHoldout(labelled.silence);
	const bedSplit = splitHoldout(labelled.bed);
	const voiceSplit = splitHoldout(labelled.voice);
	const thresholds = deriveThresholds({
		silence: silenceSplit.fit,
		bed: bedSplit.fit,
		voice: voiceSplit.fit,
	});
	report.thresholds = thresholds;

	if (thresholds.calibrated) {
		report.holdout = validateHoldout(
			thresholds,
			{
				silence: silenceSplit.holdout,
				bed: bedSplit.holdout,
				voice: voiceSplit.holdout,
				transition: labelled.transition,
			},
			classifyFrame,
		);
		if (!report.holdout.passed) {
			report.thresholds = {
				calibrated: false,
				error: report.holdout.failures
					.map(
						(failure) =>
							`${failure.label}.${failure.rule}=${failure.observed} (limit ${failure.limit})`,
					)
					.join("; "),
			};
		}
	}

	// The negative control. If the bed-off arm still shows bed frames, the
	// detector is finding something other than the waiting sound.
	if (values["off-run"] && report.thresholds.calibrated) {
		const offRun = loadRun(values["off-run"]);
		const offLabelled = labelWindows(offRun);
		const counts = emptyClassCounts();
		for (const frame of offLabelled.bed) {
			counts[classifyFrame(frame, report.thresholds)] += 1;
		}
		const bedShare =
			offLabelled.bed.length > 0 ? counts.bed / offLabelled.bed.length : 0;
		report.negativeControl = {
			busyFrames: offLabelled.bed.length,
			classified: counts,
			bedShare: Number(bedShare.toFixed(4)),
			passed: offLabelled.bed.length > 0 && bedShare <= 0.02,
		};
		if (!report.negativeControl.passed) {
			report.thresholds = {
				calibrated: false,
				error: `negative control failed: bed signature present in ${(bedShare * 100).toFixed(1)}% of bed-off busy frames`,
			};
		}
	}

	writeFileSync(
		values.out,
		`${JSON.stringify({ ...report.thresholds, qualificationPolicyId: QUALIFICATION_POLICY_ID, onRun: values["on-run"], offRun: values["off-run"] ?? null }, null, 2)}\n`,
		{ mode: 0o600 },
	);
	if (values.markdown) {
		writeFileSync(values.markdown, `${renderCalibrationMarkdown(report)}\n`, {
			mode: 0o600,
		});
	}
	writeFileSync(
		values.out.replace(/\.json$/u, "-report.json"),
		`${JSON.stringify(report, null, 2)}\n`,
		{ mode: 0o600 },
	);
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	process.exit(report.thresholds.calibrated ? 0 : 1);
}

main();
