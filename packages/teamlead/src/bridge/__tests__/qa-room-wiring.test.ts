import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import { initializeFlagStore } from "../flag-store-runtime.js";
import { qaRoomServiceEnabled } from "../qa-room-host.js";

describe("QA room production assembly", () => {
	it("reads the managed switch on every call and bounds isolated opt-in", async () => {
		const store = await StateStore.create(":memory:");
		try {
			initializeFlagStore(store, {});
			expect(qaRoomServiceEnabled(store, {})).toBe(true);
			expect(
				qaRoomServiceEnabled(store, { FLYWHEEL_ISOLATION_ROOT: "/tmp/room" }),
			).toBe(false);
			const isolated = {
				FLYWHEEL_ISOLATION_ROOT: "/tmp/room",
				TEST_QA_ROOM_SERVICE: "1",
			};
			expect(qaRoomServiceEnabled(store, isolated)).toBe(true);
			expect(
				qaRoomServiceEnabled(store, {
					...isolated,
					TEST_QA_ROOM_SERVICE: "typo",
				}),
			).toBe(false);
			const revision = store.getFlagValueRow("qa_room_service")!.revision;
			expect(
				store.applyFlagValueChange({
					name: "qa_room_service",
					rawTo: "0",
					expectedRevision: revision,
					actor: "bridge-local-operator",
					reason: "pause room service",
				}),
			).toMatchObject({ ok: true });
			expect(qaRoomServiceEnabled(store, {})).toBe(false);
			expect(qaRoomServiceEnabled(store, isolated)).toBe(false);
		} finally {
			store.close();
		}
	});
	it("mounts authenticated room routes and starts/stops its reconciler with the Bridge", () => {
		const source = readFileSync(
			new URL("../plugin.ts", import.meta.url),
			"utf8",
		);
		expect(source).toContain('req.path.startsWith("/qa-rooms/")');
		expect(source).toContain('"/api/qa-rooms"');
		expect(source).toContain("createQaRoomRouter(");
		expect(source).toContain(
			"createLocalQaRoomService(store, flywheelRepoRoot)",
		);
		expect(source).toContain("qaRoomService.start()");
		expect(source).toContain("await qaRoomService.stop()");
	});
});
