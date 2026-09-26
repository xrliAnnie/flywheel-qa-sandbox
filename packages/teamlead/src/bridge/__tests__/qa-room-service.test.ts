import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QaRoomRuntime, RoomJobObservation } from "../qa-room-runtime.js";
import { type QaRoomActor, QaRoomService } from "../qa-room-service.js";
import { QaRoomStore } from "../qa-room-store.js";

const actor: QaRoomActor = {
	key: "runner:one",
	issue: "FLY-2405",
	lead: false,
};
const lead: QaRoomActor = { key: "lead:eng", issue: null, lead: true };
const head = "a".repeat(40);
describe("QA room lifecycle", () => {
	let db: Database.Database;
	let store: QaRoomStore;
	let service: QaRoomService;
	let runtime: QaRoomRuntime;
	let clock: number;
	let load: number;
	let observation: RoomJobObservation;
	let terminalOwners: Set<string>;
	let enabled: boolean;
	const request = (extra = {}) => ({
		request_id: randomUUID(),
		head,
		...extra,
	});
	const recreate = () =>
		new QaRoomService({
			store,
			runtime,
			stateRoot: "/fixture/rooms",
			slotCount: 4,
			now: () => clock,
			load: () => load,
			threshold: () => 144,
			ownerTerminal: (key) => terminalOwners.has(key),
			enabled: () => enabled,
		});
	beforeEach(() => {
		db = new Database(":memory:");
		store = new QaRoomStore(db);
		store.migrate();
		clock = Date.parse("2026-09-26T18:00:00Z");
		load = 0;
		enabled = true;
		terminalOwners = new Set();
		observation = { alive: true, phase: "prepare" };
		runtime = {
			occupied: vi.fn(() => false),
			claim: vi.fn(() => true),
			release: vi.fn(() => []),
			start: vi.fn(() => 1234),
			observe: vi.fn(async () => observation),
			terminate: vi.fn(async () => {}),
			verifyDeploy: vi.fn(async (room) => ({
				slot: room.slot,
				port: 1981,
				bridgeUrl: "http://127.0.0.1:1981",
				slotDir: `/tmp/flywheel-test-slot-${room.slot}`,
				projectName: "test",
			})),
			residue: vi.fn(async () => ({ ok: true, details: [] })),
			removeSource: vi.fn(async () => {}),
			evidence: vi.fn(() => null),
			logTail: vi.fn(() => []),
		};
		service = recreate();
	});
	afterEach(() => db.close());
	const finishDeploy = async (roomId: string) => {
		await service.tick();
		const op = store.operations(roomId)[0]!;
		observation = {
			alive: false,
			phase: "deploy",
			receipt: {
				operation_id: op.operation_id,
				phase_reached: "deploy",
				exit_code: 0,
				finished_at: new Date(clock).toISOString(),
			},
		};
		await service.tick();
	};
	it("replays identical requests and rejects payload reuse with an audit", () => {
		const body = request();
		const first = service.deploy(actor, body);
		expect(service.deploy(actor, body)).toEqual(first);
		expect(() =>
			service.deploy(actor, { ...body, head: "b".repeat(40) }),
		).toThrow("request_conflict");
		expect(store.rooms()).toHaveLength(1);
		expect(store.audits().at(-1)?.decision).toBe("refused");
	});
	it("returns the original operation when a transport retry follows a later room action", async () => {
		const body = request();
		const deploy = service.deploy(actor, body);
		await finishDeploy(deploy.room_id);
		const teardownBody = { request_id: randomUUID() };
		const teardown = service.teardown(actor, deploy.room_id, teardownBody);
		expect(service.deploy(actor, body).operation_id).toBe(deploy.operation_id);
		await service.tick();
		observation = { alive: false };
		await service.tick();
		service.teardown(actor, deploy.room_id, { request_id: randomUUID() });
		expect(
			service.teardown(actor, deploy.room_id, teardownBody).operation_id,
		).toBe(teardown.operation_id);
	});
	it("audits schema refusals without persisting raw credentials or tokens", () => {
		expect(() =>
			service.deploy(
				actor,
				request({ label: "com.flywheel.bridge", credential: "secret" }),
			),
		).toThrow("production_target_refused");
		expect(store.audits()[0]?.reason).toBe("production_target_refused");
		expect(JSON.stringify(store.audits())).not.toContain("secret");
	});
	it("auto selects free primary and reserves borrowed slots atomically", () => {
		vi.mocked(runtime.occupied).mockImplementation((slot) => slot === 1);
		const result = service.deploy(
			actor,
			request({ extra_leads: [{ slot: 2, label: "ops" }] }),
		);
		expect(result.slot).toBe(3);
		expect(store.reservedSlots()).toEqual([2, 3]);
		expect(() => service.deploy(lead, request({ slot: 2 }))).toThrow(
			"slot_unavailable",
		);
	});
	it("queues at the exact load threshold and preserves the same operation across restart", async () => {
		load = 144;
		const result = service.deploy(actor, request());
		await service.tick();
		expect(runtime.start).not.toHaveBeenCalled();
		expect(service.status(actor, result.room_id).queue_reason).toBe(
			"load_pressure",
		);
		service = recreate();
		load = 143;
		await service.tick();
		expect(runtime.claim).toHaveBeenCalledTimes(1);
		expect(runtime.start).toHaveBeenCalledTimes(1);
		expect(store.operations()[0]?.operation_id).toBe(result.operation_id);
	});
	it("expires queue age instead of resetting it at restart", async () => {
		load = 144;
		const result = service.deploy(actor, request());
		clock += 60 * 60 * 1000;
		service = recreate();
		await service.tick();
		expect(service.status(actor, result.room_id).status_reason).toBe(
			"load_gate_timeout",
		);
		expect(store.reservedSlots()).toEqual([]);
		expect(runtime.start).not.toHaveBeenCalled();
	});
	it("refuses a physical claim race without running a job", async () => {
		const result = service.deploy(actor, request());
		vi.mocked(runtime.claim).mockReturnValue(false);
		await service.tick();
		expect(service.status(actor, result.room_id).status).toBe("refused");
		expect(store.reservedSlots()).toEqual([]);
		expect(runtime.start).not.toHaveBeenCalled();
	});
	it("keeps deploy concurrency at one", async () => {
		service.deploy(actor, request({ slot: 1 }));
		service.deploy(lead, request({ slot: 2 }));
		await service.tick();
		await service.tick();
		expect(runtime.start).toHaveBeenCalledTimes(1);
	});
	it("retains live recovered owners and rejects stale attempt receipts", async () => {
		const result = service.deploy(actor, request());
		await service.tick();
		service = recreate();
		observation = {
			alive: true,
			receipt: {
				operation_id: "old",
				exit_code: 0,
				phase_reached: "deploy",
				finished_at: new Date(clock).toISOString(),
			},
		};
		await service.tick();
		expect(runtime.start).toHaveBeenCalledTimes(1);
		expect(service.status(actor, result.room_id).status).toBe("preparing");
		observation = { alive: false };
		await service.tick();
		expect(service.status(actor, result.room_id).status).toBe("interrupted");
		expect(store.reservedSlots()).toEqual([1]);
		const audits = store.audits().length;
		const releases = vi.mocked(runtime.release).mock.calls.length;
		await service.tick();
		expect(store.audits()).toHaveLength(audits);
		expect(runtime.release).toHaveBeenCalledTimes(releases);
	});
	it("releases failed preparation but retains a failed deploy for teardown", async () => {
		const first = service.deploy(actor, request());
		await service.tick();
		observation = {
			alive: false,
			receipt: {
				operation_id: first.operation_id,
				phase_reached: "prepare",
				exit_code: 1,
				finished_at: new Date(clock).toISOString(),
			},
		};
		await service.tick();
		expect(service.status(actor, first.room_id).status).toBe("released");
		expect(runtime.removeSource).toHaveBeenCalledTimes(1);
		const second = service.deploy(actor, request());
		await service.tick();
		observation = {
			alive: false,
			receipt: {
				operation_id: second.operation_id,
				phase_reached: "deploy",
				exit_code: 1,
				finished_at: new Date(clock).toISOString(),
			},
		};
		await service.tick();
		expect(service.status(actor, second.room_id).status).toBe("failed");
		expect(store.reservedSlots()).toEqual([1]);
	});
	it("fails exact-head verification while keeping claims", async () => {
		const result = service.deploy(actor, request());
		vi.mocked(runtime.verifyDeploy).mockRejectedValue(
			new Error("build_sha_mismatch"),
		);
		await finishDeploy(result.room_id);
		expect(service.status(actor, result.room_id).status_reason).toBe(
			"build_sha_mismatch",
		);
		expect(runtime.release).not.toHaveBeenCalled();
	});
	it("authorizes owner, Lead and same-issue terminal-owner takeover only", async () => {
		const result = service.deploy(actor, request());
		await finishDeploy(result.room_id);
		const successor = { ...actor, key: "runner:two" };
		expect(() =>
			service.teardown(successor, result.room_id, { request_id: randomUUID() }),
		).toThrow("room_not_owned");
		terminalOwners.add(actor.key);
		expect(() =>
			service.teardown({ ...successor, issue: "FLY-1" }, result.room_id, {
				request_id: randomUUID(),
			}),
		).toThrow("room_not_owned");
		const response = service.teardown(successor, result.room_id, {
			request_id: randomUUID(),
		});
		expect(response.status).toBe("tearing_down");
		expect(store.audits().at(-1)?.reason).toBe("takeover_from=runner:one");
		expect(service.list({ ...actor, issue: "FLY-1" })).toEqual([]);
		expect(() =>
			service.status({ ...actor, issue: "FLY-1" }, result.room_id),
		).toThrow("room_not_visible");
		expect(service.list(lead)).toHaveLength(1);
	});
	it("tears down under high load, checks residues before releasing and hides claim token", async () => {
		const result = service.deploy(actor, request());
		await finishDeploy(result.room_id);
		load = 200;
		const teardown = service.teardown(lead, result.room_id, {
			request_id: randomUUID(),
		});
		await service.tick();
		expect(runtime.start).toHaveBeenCalledTimes(2);
		observation = {
			alive: false,
			receipt: {
				operation_id: teardown.operation_id,
				phase_reached: "teardown",
				exit_code: 0,
				finished_at: new Date(clock).toISOString(),
			},
		};
		vi.mocked(runtime.residue).mockImplementation(async () => {
			expect(runtime.release).not.toHaveBeenCalled();
			return { ok: true, details: [] };
		});
		await service.tick();
		const status = service.status(actor, result.room_id);
		expect(status.status).toBe("torn_down");
		expect(store.reservedSlots()).toEqual([]);
		expect(JSON.stringify(status)).not.toContain(
			store.getRoom(result.room_id)!.claim_token,
		);
	});
	it("retains prior evidence and retries a failed teardown using a new operation", async () => {
		const result = service.deploy(actor, request());
		await finishDeploy(result.room_id);
		const first = service.teardown(actor, result.room_id, {
			request_id: randomUUID(),
		});
		await service.tick();
		vi.mocked(runtime.evidence).mockReturnValue("/evidence/previous");
		observation = {
			alive: false,
			receipt: {
				operation_id: first.operation_id,
				phase_reached: "teardown",
				exit_code: 1,
				finished_at: new Date(clock).toISOString(),
			},
		};
		await service.tick();
		service = recreate();
		const second = service.teardown(actor, result.room_id, {
			request_id: randomUUID(),
		});
		await service.tick();
		vi.mocked(runtime.evidence).mockReturnValue(null);
		observation = {
			alive: false,
			receipt: {
				operation_id: second.operation_id,
				phase_reached: "snapshot",
				exit_code: 96,
				finished_at: new Date(clock).toISOString(),
			},
		};
		await service.tick();
		const status = service.status(actor, result.room_id);
		expect(status.evidence_dir).toBe("/evidence/previous");
		expect(status.recovery_hint).toContain("--skip-snapshot");
		expect(store.operations(result.room_id).map((o) => o.attempt)).toEqual([
			1, 1, 2,
		]);
		expect(runtime.release).not.toHaveBeenCalled();
	});
	it("preserves claims when residual processes remain or a release token conflicts", async () => {
		const result = service.deploy(actor, request());
		await finishDeploy(result.room_id);
		let teardown = service.teardown(actor, result.room_id, {
			request_id: randomUUID(),
		});
		await service.tick();
		observation = {
			alive: false,
			receipt: {
				operation_id: teardown.operation_id,
				phase_reached: "teardown",
				exit_code: 0,
				finished_at: new Date(clock).toISOString(),
			},
		};
		vi.mocked(runtime.residue).mockResolvedValue({
			ok: false,
			details: ["process:42"],
		});
		await service.tick();
		expect(service.status(actor, result.room_id).status_reason).toBe("residue");
		expect(runtime.release).not.toHaveBeenCalled();
		teardown = service.teardown(actor, result.room_id, {
			request_id: randomUUID(),
			skip_snapshot: true,
			reason: "previous evidence",
		});
		await service.tick();
		observation = {
			alive: false,
			receipt: {
				operation_id: teardown.operation_id,
				phase_reached: "teardown",
				exit_code: 0,
				finished_at: new Date(clock).toISOString(),
			},
		};
		vi.mocked(runtime.residue).mockResolvedValue({ ok: true, details: [] });
		vi.mocked(runtime.release).mockReturnValue([1]);
		await service.tick();
		expect(service.status(actor, result.room_id).status_reason).toBe(
			"release_conflict",
		);
		expect(store.reservedSlots()).toEqual([1]);
		const audits = store.audits().length;
		const releases = vi.mocked(runtime.release).mock.calls.length;
		await service.tick();
		expect(store.audits()).toHaveLength(audits);
		expect(runtime.release).toHaveBeenCalledTimes(releases);
	});
	it("resumes an interrupted release without rerunning teardown", async () => {
		const result = service.deploy(actor, request());
		await service.tick();
		store.updateRoom(result.room_id, {
			status: "tearing_down",
			release_state: "releasing",
		});
		store.updateOperation(result.operation_id, { status: "succeeded" });
		store.addOperation({
			...store.getOperation(result.operation_id)!,
			operation_id: "td",
			kind: "teardown",
			request_id: "td",
			status: "running",
		});
		service = recreate();
		await service.tick();
		expect(runtime.start).toHaveBeenCalledTimes(1);
		expect(service.status(actor, result.room_id).status).toBe("torn_down");
	});
	it("terminates the job group on timeout and on failed post-spawn persistence", async () => {
		const result = service.deploy(actor, request());
		await service.tick();
		clock += 45 * 60 * 1000;
		await service.tick();
		expect(runtime.terminate).toHaveBeenCalled();
		expect(service.status(actor, result.room_id).status_reason).toBe("timeout");
		const second = service.deploy(lead, request({ slot: 2 }));
		const update = store.updateOperation.bind(store);
		vi.spyOn(store, "updateOperation").mockImplementation((id, patch) => {
			if (patch.status === "running") throw new Error("write failed");
			update(id, patch);
		});
		await service.tick();
		expect(runtime.terminate).toHaveBeenCalledTimes(2);
		expect(service.status(lead, second.room_id).status_reason).toBe(
			"spawn_record_failed",
		);
	});
	it("does not start or admit new operations while disabled", async () => {
		service.deploy(actor, request());
		enabled = false;
		await service.tick();
		expect(runtime.start).not.toHaveBeenCalled();
		expect(() => service.deploy(lead, request())).toThrow(
			"room_service_disabled",
		);
	});
});
