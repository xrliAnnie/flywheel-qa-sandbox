#!/usr/bin/env node
// FLY-907 QA — corrected retry of scenario B (my first script's B② had a test-
// harness bug: it left qa's park probe at "unknown" instead of "parked" — per
// the real keep-alive semantics (issue-display.ts comment + the passing unit
// test "qa FAIL → wake implement (park marker cleared)"), a QA runner that
// already emitted a FAIL verdict PARKS (status stays "running", park="parked")
// before the implement wake. Fresh thread (own issueId) to respect the 2
// renames/10min-per-thread Discord limit.
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEAMLEAD_DIST = join(__dirname, "..", "packages", "teamlead", "dist");
const { StateStore } = await import(`file://${TEAMLEAD_DIST}/StateStore.js`);
const { ChatThreadCreator, buildPipelineHeaderContent } = await import(
	`file://${TEAMLEAD_DIST}/bridge/ChatThreadCreator.js`
);
const { derivePhaseDisplayState, deriveIssueTitleBadge } = await import(
	`file://${TEAMLEAD_DIST}/bridge/issue-display.js`
);
const { PHASE_THREAD_BADGE, THREE_STAGE_PHASE_SEQUENCE, phaseMessageTag } =
	await import(
		`file://${TEAMLEAD_DIST}/../node_modules/flywheel-config/dist/index.js`
	);

const BOT_TOKEN = process.env.TEST_BOT_TOKEN_2;
const CHANNEL_ID = "1493080993173737583";
const DISCORD_API = "https://discord.com/api/v10";

async function discordGetChannel(threadId) {
	const res = await fetch(`${DISCORD_API}/channels/${threadId}`, {
		headers: { Authorization: `Bot ${BOT_TOKEN}` },
	});
	return res.json();
}

const tmpDir = mkdtempSync(join(tmpdir(), "qa-fly907-b2-"));
const store = await StateStore.create(join(tmpDir, "teamlead.db"));
const creator = new ChatThreadCreator(store);
const runId = randomUUID().slice(0, 8);
const issueId = `qa-fly907-${runId}-b2r`;
const ctx = {
	chatChannelId: CHANNEL_ID,
	issueId,
	issueIdentifier: `FLY-907QA-${runId}-B2R`,
	issueTitle: `[QA-907/B2-retry] wake-fix corrected ${runId}`,
	botToken: BOT_TOKEN,
	leadId: "qa-lead",
};

function badgeFor(phaseStatuses, parkByRole) {
	const phaseStates = new Map();
	for (const role of THREE_STAGE_PHASE_SEQUENCE) {
		const status = phaseStatuses[role];
		phaseStates.set(
			role,
			status
				? derivePhaseDisplayState({
						role,
						status,
						park: parkByRole[role] ?? "unknown",
					})
				: "pending",
		);
	}
	return deriveIssueTitleBadge({
		phaseStates,
		mainSessionStage: undefined,
		mainSessionStatus: undefined,
	});
}
async function stampBadge(threadId, badge) {
	if (badge.kind === "phase")
		await creator.stampStageEmoji(
			ctx,
			threadId,
			"",
			true,
			PHASE_THREAD_BADGE[badge.phase],
		);
	else if (badge.kind === "completed")
		await creator.stampStageEmoji(ctx, threadId, "completed", true);
	else if (badge.kind === "blocked")
		await creator.stampStatusBadge(ctx, threadId, "🔴 受阻");
}
async function pinRows(threadId, phaseStatuses, parkByRole, execByRole) {
	const rows = THREE_STAGE_PHASE_SEQUENCE.map((role) => {
		const status = phaseStatuses[role];
		if (!status)
			return {
				label: phaseMessageTag(role).trim(),
				status: "pending",
				plannedModel: "Fable",
			};
		const state = derivePhaseDisplayState({
			role,
			status,
			park: parkByRole[role] ?? "unknown",
		});
		return {
			label: phaseMessageTag(role, "claude-fable-5").trim(),
			status: state,
			execId: (execByRole[role] ?? "exec0000").slice(0, 8),
			attachCommand:
				state !== "pending" ? `tmux attach -t runner-${role}` : undefined,
		};
	});
	await creator.ensureRunnerPipelineHeaderPin(
		ctx,
		threadId,
		buildPipelineHeaderContent(ctx, rows),
	);
}

async function main() {
	const created = await creator.ensureChatThread({ ...ctx, modelCode: "F" });
	const threadId = created.threadId;

	// B①: implement handed to QA (design done+parked, implement awaiting_review+parked, qa running+unknown/fresh)
	const statusesB1 = {
		design: "design_done",
		implement: "awaiting_review",
		qa: "running",
	};
	const parkB1 = { design: "parked", implement: "parked" };
	await pinRows(threadId, statusesB1, parkB1, {
		design: "e1",
		implement: "e2",
		qa: "e3",
	});
	await stampBadge(threadId, badgeFor(statusesB1, parkB1)); // rename #1
	console.log("B①", (await discordGetChannel(threadId)).name);

	// B② CORRECTED: QA already emitted FAIL verdict → PARKS (status stays
	// running, park="parked"); implement's wake clears ITS OWN marker →
	// not_parked. This is the real keep-alive shape the passing unit test uses.
	const statusesB2 = {
		design: "design_done",
		implement: "awaiting_review",
		qa: "running",
	};
	const parkB2 = { design: "parked", implement: "not_parked", qa: "parked" };
	await pinRows(threadId, statusesB2, parkB2, {
		design: "e1",
		implement: "e2",
		qa: "e3",
	});
	await stampBadge(threadId, badgeFor(statusesB2, parkB2)); // rename #2
	console.log("B②(corrected)", (await discordGetChannel(threadId)).name);
	console.log("thread:", threadId);
}
main().catch((e) => {
	console.error("FATAL", e);
	process.exit(1);
});
