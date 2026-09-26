import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const roots: string[] = [];
const request = (suffix: string) =>
	`10000000-0000-4000-8000-${suffix.padStart(12, "0")}`;

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "voice-target-lock-"));
	roots.push(root);
	const store = await StateStore.create(join(root, "teamlead.db"));
	return { root, store };
}

describe("voice capability target locks", () => {
	it("drains held and unknown targets without admitting another write or acquiring unrelated targets", async () => {
		const { store } = await fixture();
		try {
			const owner = {
				targetKey: "flywheel:linear:fly-4",
				projectName: "flywheel",
				leadId: "eng",
				actor: "voice" as const,
				activationId: "voice:session",
				requestId: request("10"),
				now: 1_000,
				deadline: 2_000,
			};
			const lock = store.acquireCapabilityTargetLock(owner);
			if (lock.status !== "acquired") throw new Error("fixture");
			const holder = { ...owner, fence: lock.fence };
			store.markCapabilityTargetLockDispatched({ ...holder, now: 1_100 });
			const resident = {
				...owner,
				actor: "resident" as const,
				activationId: "resident:1",
				requestId: request("11"),
				now: 1_200,
				deadline: 3_000,
				checkOnly: true,
			};
			expect(store.acquireCapabilityTargetLock(resident)).toEqual({
				status: "target_pending_reconcile",
			});
			expect(store.getCapabilityTargetLock(owner.targetKey)?.state).toBe(
				"held",
			);
			expect(
				store.acquireCapabilityTargetLock({
					...resident,
					targetKey: "flywheel:linear:fly-other",
				}),
			).toEqual({ status: "unguarded" });
			expect(
				store.getCapabilityTargetLock("flywheel:linear:fly-other"),
			).toBeUndefined();
			store.releaseCapabilityTargetLock({ ...holder, outcome: "unknown" });
			expect(
				store.acquireCapabilityTargetLock({
					...resident,
					now: 100_000,
					deadline: 115_000,
				}),
			).toEqual({ status: "target_pending_reconcile" });
			store.releaseCapabilityTargetLock({ ...holder, outcome: "succeeded" });
			expect(store.acquireCapabilityTargetLock(resident)).toEqual({
				status: "unguarded",
			});
		} finally {
			store.close();
		}
	});

	it("recovers only expired undispatched holders and preserves dispatched uncertainty across restart", async () => {
		const { store, root } = await fixture();
		const owner = {
			targetKey: "flywheel:linear:fly-5",
			projectName: "flywheel",
			leadId: "eng",
			actor: "voice" as const,
			activationId: "voice:session",
			requestId: request("12"),
			now: 1_000,
			deadline: 2_000,
		};
		const lock = store.acquireCapabilityTargetLock(owner);
		if (lock.status !== "acquired") throw new Error("fixture");
		store.markCapabilityTargetLockDispatched({
			...owner,
			fence: lock.fence,
			now: 1_100,
		});
		store.acquireCapabilityTargetLock({
			...owner,
			targetKey: "flywheel:linear:fly-6",
			requestId: request("13"),
		});
		store.close();
		const reopened = await StateStore.create(join(root, "teamlead.db"));
		try {
			expect(
				reopened.listCapabilityTargetLocks("flywheel", "eng", 2_001),
			).toMatchObject([
				{
					targetKey: owner.targetKey,
					state: "unknown",
					reason: "holder_deadline_expired",
				},
			]);
			expect(reopened.listCapabilityTargetLocks("other", "eng", 2_001)).toEqual(
				[],
			);
		} finally {
			reopened.close();
		}
	});

	it("cannot mark an expired fence as dispatched", async () => {
		const { store } = await fixture();
		try {
			const owner = {
				targetKey: "flywheel:linear:fly-2",
				activationId: "voice:session",
				requestId: request("7"),
			};
			const lock = store.acquireCapabilityTargetLock({
				...owner,
				projectName: "flywheel",
				leadId: "eng",
				actor: "voice",
				now: 1_000,
				deadline: 2_000,
			});
			if (lock.status !== "acquired") throw new Error("fixture");
			expect(
				store.markCapabilityTargetLockDispatched({
					...owner,
					fence: lock.fence,
					now: 2_000,
				}),
			).toBe(false);
		} finally {
			store.close();
		}
	});

	it("retains a dispatched lock when a lost mark reply is reported as not dispatched", async () => {
		const { store } = await fixture();
		try {
			const owner = {
				targetKey: "flywheel:linear:fly-3",
				activationId: "voice:session",
				requestId: request("8"),
			};
			const lock = store.acquireCapabilityTargetLock({
				...owner,
				projectName: "flywheel",
				leadId: "eng",
				actor: "voice",
				now: 1_000,
				deadline: 2_000,
			});
			if (lock.status !== "acquired") throw new Error("fixture");
			const holder = { ...owner, fence: lock.fence };
			expect(
				store.markCapabilityTargetLockDispatched({ ...holder, now: 1_100 }),
			).toBe(true);
			expect(
				store.releaseCapabilityTargetLock({
					...holder,
					outcome: "not_dispatched",
				}),
			).toBe("unknown");
			expect(
				store.acquireCapabilityTargetLock({
					...owner,
					projectName: "flywheel",
					leadId: "eng",
					actor: "resident",
					activationId: "resident:new",
					requestId: request("9"),
					now: 1_200,
					deadline: 3_000,
				}),
			).toEqual({ status: "target_pending_reconcile" });
			expect(
				store.releaseCapabilityTargetLock({ ...holder, outcome: "succeeded" }),
			).toBe("released");
		} finally {
			store.close();
		}
	});

	it("gives a queued resident the target after a voice write finishes", async () => {
		const { store } = await fixture();
		try {
			const voice = store.acquireCapabilityTargetLock({
				targetKey: "flywheel:linear:fly-2886",
				projectName: "flywheel",
				leadId: "eng",
				actor: "voice",
				activationId: "voice:session",
				requestId: request("1"),
				now: 1_000,
				deadline: 16_000,
			});
			expect(voice.status).toBe("acquired");
			expect(
				store.acquireCapabilityTargetLock({
					targetKey: "flywheel:linear:fly-2886",
					projectName: "flywheel",
					leadId: "eng",
					actor: "resident",
					activationId: "resident:1",
					requestId: request("2"),
					now: 1_001,
					deadline: 16_000,
				}),
			).toEqual({ status: "waiting" });
			expect(
				store.releaseCapabilityTargetLock({
					targetKey: "flywheel:linear:fly-2886",
					activationId: "voice:session",
					requestId: request("1"),
					fence: voice.status === "acquired" ? voice.fence : "",
					outcome: "succeeded",
				}),
			).toBe("released");
			expect(
				store.acquireCapabilityTargetLock({
					targetKey: "flywheel:linear:fly-2886",
					projectName: "flywheel",
					leadId: "eng",
					actor: "resident",
					activationId: "resident:1",
					requestId: request("2"),
					now: 1_002,
					deadline: 16_000,
				}).status,
			).toBe("acquired");
		} finally {
			store.close();
		}
	});

	it("rejects voice behind a resident and preserves dispatched uncertainty", async () => {
		const { store } = await fixture();
		try {
			const resident = store.acquireCapabilityTargetLock({
				targetKey: "flywheel:issue:fly-2886",
				projectName: "flywheel",
				leadId: "eng",
				actor: "resident",
				activationId: "resident:1",
				requestId: request("3"),
				now: 1_000,
				deadline: 2_000,
			});
			expect(resident.status).toBe("acquired");
			expect(
				store.acquireCapabilityTargetLock({
					targetKey: "flywheel:issue:fly-2886",
					projectName: "flywheel",
					leadId: "eng",
					actor: "voice",
					activationId: "voice:session",
					requestId: request("4"),
					now: 1_100,
					deadline: 3_000,
				}),
			).toEqual({ status: "resident_lead_active_on_target" });
			const fence = resident.status === "acquired" ? resident.fence : "";
			expect(
				store.markCapabilityTargetLockDispatched({
					targetKey: "flywheel:issue:fly-2886",
					activationId: "resident:1",
					requestId: request("3"),
					fence,
					now: 1_200,
				}),
			).toBe(true);
			expect(
				store.acquireCapabilityTargetLock({
					targetKey: "flywheel:issue:fly-2886",
					projectName: "flywheel",
					leadId: "eng",
					actor: "voice",
					activationId: "voice:session",
					requestId: request("4"),
					now: 2_001,
					deadline: 4_000,
				}),
			).toEqual({ status: "target_pending_reconcile" });
			expect(
				store.getCapabilityTargetLock("flywheel:issue:fly-2886")?.state,
			).toBe("unknown");
		} finally {
			store.close();
		}
	});

	it("safely releases an undispatched expired holder", async () => {
		const { store } = await fixture();
		try {
			store.acquireCapabilityTargetLock({
				targetKey: "flywheel:linear:fly-1",
				projectName: "flywheel",
				leadId: "eng",
				actor: "voice",
				activationId: "voice:old",
				requestId: request("5"),
				now: 1_000,
				deadline: 2_000,
			});
			expect(
				store.acquireCapabilityTargetLock({
					targetKey: "flywheel:linear:fly-1",
					projectName: "flywheel",
					leadId: "eng",
					actor: "resident",
					activationId: "resident:new",
					requestId: request("6"),
					now: 2_001,
					deadline: 4_000,
				}).status,
			).toBe("acquired");
		} finally {
			store.close();
		}
	});
});
