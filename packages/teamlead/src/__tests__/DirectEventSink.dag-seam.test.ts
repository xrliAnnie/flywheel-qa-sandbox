/**
 * FLY-1372 §2.5: the durable emitStarted seam for Bridge-trusted behavior
 * fields (doc_tier / issue_url / codex_skip / founder_facing_ux).
 *
 * - Envelope WITH fields (pipeline.dag start) → columns land in the SAME
 *   upsert transaction as row creation (crash-convergent by construction).
 * - Envelope WITHOUT fields (every legacy start) → columns untouched — the
 *   legacy route-patch persistence timing stays byte-identical (#14d).
 * - Engine successor propagation: the successor start request carries the
 *   predecessor row's founder_facing_ux (hop-2 continuity).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type { EventEnvelope } from "flywheel-edge-worker/dist/ExecutionEventEmitter.js";
import { afterEach, describe, expect, it } from "vitest";
import type { BridgeConfig } from "../bridge/plugin.js";
import { DirectEventSink } from "../DirectEventSink.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const testProjects = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/flywheel-seam",
		leads: [],
	},
] as unknown as ProjectEntry[];

const testConfig = {
	host: "127.0.0.1",
	port: 0,
	dbPath: ":memory:",
	ingestToken: "ingest-secret",
	notificationChannel: "test-channel",
	defaultLeadAgentId: "lead",
	stuckThresholdMinutes: 15,
	stuckCheckIntervalMs: 300000,
	orphanThresholdMinutes: 60,
	discordBotToken: "bot-token",
} as unknown as BridgeConfig;

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

async function harness() {
	const dir = mkdtempSync(join(tmpdir(), "fly1372-seam-"));
	const dbPath = join(dir, "state.db");
	const store = await StateStore.create(dbPath);
	cleanups.push(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const sink = new DirectEventSink(store, testConfig, testProjects);
	const raw = (executionId: string) => {
		const reader = new BetterSqlite3(dbPath, { readonly: true });
		try {
			return reader
				.prepare(
					`SELECT doc_tier, issue_url, codex_skip, founder_facing_ux
					   FROM sessions WHERE execution_id = ?`,
				)
				.get(executionId) as {
				doc_tier: string | null;
				issue_url: string | null;
				codex_skip: number;
				founder_facing_ux: number;
			};
		} finally {
			reader.close();
		}
	};
	return { store, sink, raw };
}

const baseEnv: EventEnvelope = {
	executionId: "seam-1",
	issueId: "FLY-802",
	projectName: "flywheel",
};

describe("FLY-1372 DirectEventSink behavior-field seam", () => {
	it("persists the four behavior fields atomically with session-row creation", async () => {
		const { sink, raw } = await harness();
		await sink.emitStarted({
			...baseEnv,
			docTier: "full",
			issueUrl: "https://linear.app/x/FLY-802",
			codexSkip: false,
			founderFacingUx: true,
		});
		expect(raw("seam-1")).toEqual({
			doc_tier: "full",
			issue_url: "https://linear.app/x/FLY-802",
			codex_skip: 0,
			founder_facing_ux: 1,
		});
	});

	it("#14d an envelope WITHOUT the fields (legacy start) leaves the columns at their defaults — route-patch timing unchanged", async () => {
		const { sink, raw } = await harness();
		await sink.emitStarted({ ...baseEnv, executionId: "seam-legacy" });
		expect(raw("seam-legacy")).toEqual({
			doc_tier: null,
			issue_url: null,
			codex_skip: 0,
			founder_facing_ux: 0,
		});
	});

	it("a repeated started upsert without fields does not clobber previously landed values", async () => {
		const { sink, raw } = await harness();
		await sink.emitStarted({
			...baseEnv,
			executionId: "seam-re",
			docTier: "plan_only",
			issueUrl: "https://linear.app/x/FLY-802",
			codexSkip: true,
			founderFacingUx: true,
		});
		await sink.emitStarted({ ...baseEnv, executionId: "seam-re" });
		expect(raw("seam-re")).toEqual({
			doc_tier: "plan_only",
			issue_url: "https://linear.app/x/FLY-802",
			codex_skip: 1,
			founder_facing_ux: 1,
		});
	});
});
