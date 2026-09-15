import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	createBusinessWakePass,
	readBusinessWakeFile,
} from "../business-wake-pass.js";

const roots: string[] = [];
afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const file = (enabled = true, revision = 1) =>
	JSON.stringify({
		version: 1,
		schedules: [
			{ id: "evening", enabled, revision, at: "20:00", timezone: "UTC" },
		],
	});
it("recovers append-before-enqueue across restart, retaining the frozen date after disabling", async () => {
	const root = mkdtempSync(join(tmpdir(), "business-wake-"));
	roots.push(root);
	mkdirSync(join(root, "state"));
	writeFileSync(join(root, "state/business-wakes.json"), file());
	const path = join(root, "store.db");
	let store = await StateStore.create(path);
	const projects = [
		{
			projectName: "demo",
			projectRoot: root,
			leads: [
				{ agentId: "lead", businessWakeFile: "state/business-wakes.json" },
			],
		},
	];
	const enqueue = vi.fn(() => {
		throw new Error("queue down");
	});
	const options = {
		projects,
		store,
		now: () => Date.parse("2026-09-14T21:00:00Z"),
		founderTimezone: () => "UTC",
		enqueueLeadEvent: enqueue,
		inspectDeliveryState: () => ({ kind: "absent_identity" as const }),
		log: vi.fn(),
	};
	await createBusinessWakePass(options)();
	expect(enqueue).toHaveBeenCalledOnce();
	const first = enqueue.mock.calls[0][0];
	store.close();
	store = await StateStore.create(path);
	writeFileSync(join(root, "state/business-wakes.json"), file(false, 2));
	const recovered = vi.fn(() => ({}));
	try {
		await createBusinessWakePass({
			...options,
			store,
			enqueueLeadEvent: recovered,
		})();
		expect(recovered).toHaveBeenCalledOnce();
		expect(recovered.mock.calls[0][0]).toEqual(first);
	} finally {
		store.close();
	}
});
it("deduplicates a local day across repeated and concurrent passes and configuration revisions", async () => {
	const root = mkdtempSync(join(tmpdir(), "business-wake-"));
	roots.push(root);
	mkdirSync(join(root, "state"));
	writeFileSync(join(root, "state/business-wakes.json"), file());
	const store = await StateStore.create(":memory:");
	const accepted = new Set<string>();
	const enqueue = vi.fn((env) => {
		accepted.add(env.eventId);
		return {};
	});
	const pass = createBusinessWakePass({
		projects: [
			{
				projectName: "demo",
				projectRoot: root,
				leads: [
					{ agentId: "lead", businessWakeFile: "state/business-wakes.json" },
				],
			},
		],
		store,
		now: () => Date.parse("2026-09-14T21:00:00Z"),
		founderTimezone: () => "UTC",
		enqueueLeadEvent: enqueue,
		inspectDeliveryState: (_project, _id) =>
			accepted.size
				? ({ kind: "active_inbox" } as never)
				: { kind: "absent_identity" },
		log: vi.fn(),
	});
	try {
		await Promise.all([pass(), pass()]);
		writeFileSync(join(root, "state/business-wakes.json"), file(true, 2));
		await pass();
		expect(enqueue).toHaveBeenCalledOnce();
		expect(enqueue.mock.calls[0][0].eventId).toBe(
			"business-wake:demo:lead:evening:2026-09-14",
		);
	} finally {
		store.close();
	}
});

it("discards a candidate if the schedule changes before materialization", async () => {
	const root = mkdtempSync(join(tmpdir(), "business-wake-"));
	roots.push(root);
	mkdirSync(join(root, "state"));
	writeFileSync(join(root, "state/business-wakes.json"), file());
	const store = await StateStore.create(":memory:");
	const enqueue = vi.fn();
	let reads = 0;
	const pass = createBusinessWakePass({
		projects: [
			{
				projectName: "demo",
				projectRoot: root,
				leads: [
					{ agentId: "lead", businessWakeFile: "state/business-wakes.json" },
				],
			},
		],
		store,
		now: () => Date.parse("2026-09-14T21:00:00Z"),
		founderTimezone: () => "UTC",
		enqueueLeadEvent: enqueue,
		inspectDeliveryState: () => ({ kind: "absent_identity" }),
		readSchedule: async (workspace) => {
			const result = await readBusinessWakeFile(workspace);
			if (++reads === 1)
				writeFileSync(join(root, "state/business-wakes.json"), file(false, 2));
			return result;
		},
	});
	try {
		await pass();
		expect(enqueue).not.toHaveBeenCalled();
		expect(store.listPendingBusinessWakeEvents()).toEqual([]);
	} finally {
		store.close();
	}
});
it("rejects schedule symlinks and oversized files", async () => {
	const root = mkdtempSync(join(tmpdir(), "business-wake-"));
	roots.push(root);
	mkdirSync(join(root, "state"));
	const target = join(root, "other.json");
	writeFileSync(target, file());
	const schedulePath = join(root, "state/business-wakes.json");
	symlinkSync(target, schedulePath);
	await expect(readBusinessWakeFile(root)).rejects.toThrow();
	rmSync(schedulePath);
	writeFileSync(schedulePath, " ".repeat(16385));
	await expect(readBusinessWakeFile(root)).rejects.toThrow();
});
