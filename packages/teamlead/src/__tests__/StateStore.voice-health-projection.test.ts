import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VoiceHealthView } from "../epic-page/model.js";
import { StateStore } from "../StateStore.js";

let store: StateStore;
let root: string;

const healthy = (
	overrides: Partial<VoiceHealthView> = {},
): VoiceHealthView => ({
	schemaVersion: 1,
	sourceStatus: "complete",
	observedAt: "2026-09-18T20:00:00.000Z",
	status: "healthy",
	demandState: "required",
	phase: "idle",
	lastIterationSuccessAt: "2026-09-18T20:00:00.000Z",
	lastProgressAt: "2026-09-18T20:00:00.000Z",
	failureStreak: 0,
	activeIncidents: [],
	...overrides,
});

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "voice-health-projection-"));
	store = await StateStore.create(join(root, "teamlead.db"));
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

describe("voice health projection", () => {
	it("atomically advances one source cursor and ignores stale replay", () => {
		expect(
			store.applyVoiceHealthProjection({
				sourceId: "10000000-0000-4000-8000-000000000001",
				cursor: 3,
				status: "complete",
				view: healthy(),
				now: "2026-09-18T20:00:01.000Z",
			}),
		).toEqual({ changed: true });
		expect(store.getVoiceHealthProjectionCursor()).toMatchObject({
			sourceId: "10000000-0000-4000-8000-000000000001",
			cursor: 3,
			status: "complete",
		});
		expect(store.getVoiceHealthProjection("flywheel")).toEqual(healthy());

		expect(
			store.applyVoiceHealthProjection({
				sourceId: "10000000-0000-4000-8000-000000000001",
				cursor: 2,
				status: "complete",
				view: healthy({ observedAt: "2026-09-18T19:59:00.000Z" }),
				now: "2026-09-18T20:00:02.000Z",
			}),
		).toEqual({ changed: false });
		expect(store.getVoiceHealthProjection("flywheel")).toEqual(healthy());
	});

	it("preserves the last fault when the source becomes unavailable", () => {
		const incident = {
			scope: "poll_dependency" as const,
			openedAt: "2026-09-18T19:59:00.000Z",
			reasonClass: "bridge_connect_failed" as const,
			threshold: "three_consecutive_failures" as const,
			deliveryState: "sent" as const,
		};
		store.applyVoiceHealthProjection({
			sourceId: "10000000-0000-4000-8000-000000000001",
			cursor: 3,
			status: "complete",
			view: healthy({ status: "unhealthy", activeIncidents: [incident] }),
			now: "2026-09-18T20:00:01.000Z",
		});
		expect(
			store.markVoiceHealthProjectionUnavailable({
				error: "health_store_unavailable",
				now: "2026-09-18T20:00:02.000Z",
			}),
		).toBe(true);
		expect(store.getVoiceHealthProjection("flywheel")).toMatchObject({
			sourceStatus: "unavailable",
			status: "unhealthy",
			activeIncidents: [incident],
		});
	});

	it("does not let an empty replacement source erase an unresolved fault", () => {
		const incident = {
			scope: "session_unavailable" as const,
			openedAt: "2026-09-18T19:59:00.000Z",
			reasonClass: "startup_not_ready" as const,
			threshold: "startup_failure" as const,
			deliveryState: "pending" as const,
		};
		store.applyVoiceHealthProjection({
			sourceId: "10000000-0000-4000-8000-000000000001",
			cursor: 3,
			status: "complete",
			view: healthy({ status: "unhealthy", activeIncidents: [incident] }),
			now: "2026-09-18T20:00:01.000Z",
		});
		store.markVoiceHealthProjectionUnavailable({
			error: "voice_health_export_page_limit",
			now: "2026-09-18T20:00:02.000Z",
			sourceId: "20000000-0000-4000-8000-000000000002",
			cursor: 32,
		});
		expect(store.getVoiceHealthProjectionCursor()).toMatchObject({
			sourceId: "20000000-0000-4000-8000-000000000002",
			cursor: 32,
			status: "unavailable",
		});
		expect(() =>
			store.applyVoiceHealthProjection({
				sourceId: "20000000-0000-4000-8000-000000000002",
				cursor: 33,
				status: "complete",
				view: healthy({
					status: "dormant",
					demandState: "none",
					activeIncidents: [],
				}),
				now: "2026-09-18T20:00:03.000Z",
			}),
		).toThrow("voice_health_projection_source_reset_unverified");
		expect(store.getVoiceHealthProjection("flywheel")).toMatchObject({
			status: "unhealthy",
			activeIncidents: [incident],
		});
	});
});
