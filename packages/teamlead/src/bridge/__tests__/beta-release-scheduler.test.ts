import { afterEach, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import type { BetaProjectConfig } from "../beta-release-config-source.js";
import type { BetaBinding, BetaOccurrence } from "../beta-release-contract.js";
import {
	BetaReleaseScheduler,
	type BetaReleaseTransport,
} from "../beta-release-scheduler.js";

const hour = 3600000;
const stores: StateStore[] = [];
afterEach(() => {
	for (const s of stores) s.close();
	stores.length = 0;
});
const projects: BetaProjectConfig[] = ["a", "b"].map((name, i) => ({
	projectName: name,
	projectRoot: `/test/${name}`,
	projectRepo: `test/${name}`,
	reason: null,
	config: {
		interval_hours: i ? 24 : 6,
		workflow_file: "beta.yml",
		token_env: `TOKEN_${name.toUpperCase()}`,
	},
}));
function fixture() {
	let owner: "legacy" | "paused" | "bridge" = "bridge";
	const dispatched: { binding: BetaBinding; occurrence: BetaOccurrence }[] = [];
	const transport: BetaReleaseTransport = {
		async assertDrained() {},
		async resolve(p) {
			return {
				projectName: p.projectName,
				repositoryId: p.projectName === "a" ? 1 : 2,
				workflowId: 2,
				canonicalRepo: p.projectRepo!,
				defaultBranch: "main",
				bindingRevision: p.projectName,
			};
		},
		async owner() {
			return owner;
		},
		async head() {
			return "a".repeat(40);
		},
		async dispatch(binding, occurrence) {
			dispatched.push({ binding, occurrence });
			return dispatched.length;
		},
		async observe(binding, occurrence) {
			return {
				runs: occurrence.runIds.map((id) => ({
					id,
					status: "completed",
					conclusion: "success",
					receipt: {
						schemaVersion: 1,
						projectName: binding.projectName,
						repositoryId: binding.repositoryId,
						workflowId: binding.workflowId,
						runId: id,
						scheduleKey: occurrence.occurrenceId,
						sourceCommit: occurrence.sourceCommit,
						outcome: "published",
						publishedSourceCommit: occurrence.sourceCommit,
						publishedVersion: "beta-a",
						publishedAt: "2026-09-11T00:00:00.000Z",
					},
				})),
			};
		},
	};
	return {
		transport,
		dispatched,
		setOwner: (v: typeof owner) => {
			owner = v;
		},
	};
}
it("dispatches separate 6h/24h lanes for 48h and never dispatches legacy or paused", async () => {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const f = fixture();
	let now = 0;
	const scheduler = new BetaReleaseScheduler({
		store: store.betaSchedules,
		transport: f.transport,
		projects: async () => projects,
		now: () => now,
	});
	f.setOwner("legacy");
	await scheduler.tick();
	now = 24 * hour;
	await scheduler.tick();
	expect(f.dispatched).toHaveLength(0);
	f.setOwner("bridge");
	await scheduler.tick();
	const start = now;
	for (now = start + hour; now <= start + 48 * hour; now += hour)
		await scheduler.tick();
	expect(
		f.dispatched.filter((x) => x.binding.projectName === "a"),
	).toHaveLength(8);
	expect(
		f.dispatched.filter((x) => x.binding.projectName === "b"),
	).toHaveLength(2);
	f.setOwner("paused");
	now += 24 * hour;
	await scheduler.tick();
	expect(f.dispatched).toHaveLength(10);
});
it("restarts by observing a known live run without another POST", async () => {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const f = fixture();
	let now = 0;
	const options = {
		store: store.betaSchedules,
		transport: f.transport,
		projects: async () => projects,
		now: () => now,
	};
	await new BetaReleaseScheduler(options).tick();
	now = 6 * hour;
	await new BetaReleaseScheduler(options).tick();
	f.transport.observe = async (_b, o) => ({
		runs: o.runIds.map((id) => ({
			id,
			status: "in_progress",
			conclusion: null,
		})),
	});
	now = 100 * hour;
	await new BetaReleaseScheduler(options).tick();
	expect(
		f.dispatched.filter((x) => x.binding.projectName === "a"),
	).toHaveLength(1);
	expect(store.betaSchedules.active("a")?.runIds).toEqual([1]);
});
it("retries unknown acceptance only after complete lookup and two minutes, with the same key and SHA", async () => {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const f = fixture();
	let now = 0;
	const options = {
		store: store.betaSchedules,
		transport: f.transport,
		projects: async () => [projects[0]],
		now: () => now,
	};
	const realDispatch = f.transport.dispatch;
	f.transport.dispatch = async (b, o, s) => {
		await realDispatch(b, o, s);
		return null;
	};
	f.transport.observe = async () => ({ runs: [] });
	await new BetaReleaseScheduler(options).tick();
	now = 6 * hour;
	await new BetaReleaseScheduler(options).tick();
	now += 60000;
	await new BetaReleaseScheduler(options).tick();
	expect(f.dispatched).toHaveLength(1);
	now += 60000;
	await new BetaReleaseScheduler(options).tick();
	expect(f.dispatched).toHaveLength(2);
	expect(f.dispatched[1].occurrence.sourceCommit).toBe(
		f.dispatched[0].occurrence.sourceCommit,
	);
	expect(f.dispatched[1].occurrence.occurrenceId).toBe(
		f.dispatched[0].occurrence.occurrenceId,
	);
});
it("resumes a prepared reservation after owner is restored, without losing its due", async () => {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const f = fixture();
	let now = 0;
	const options = {
		store: store.betaSchedules,
		transport: f.transport,
		projects: async () => [projects[0]],
		now: () => now,
	};
	await new BetaReleaseScheduler(options).tick();
	now = 6 * hour;
	let calls = 0;
	f.transport.owner = async () => (++calls === 1 ? "bridge" : "paused");
	await new BetaReleaseScheduler(options).tick();
	expect(f.dispatched).toHaveLength(0);
	expect(store.betaSchedules.active("a")?.state).toBe("prepared");
	f.transport.owner = async () => "bridge";
	now += 60000;
	await new BetaReleaseScheduler(options).tick();
	expect(f.dispatched).toHaveLength(1);
});
it("does not exhaust an unknown retry merely because its older run is terminal", async () => {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const f = fixture();
	let now = 0;
	const options = {
		store: store.betaSchedules,
		transport: f.transport,
		projects: async () => [projects[0]],
		now: () => now,
	};
	await new BetaReleaseScheduler(options).tick();
	now = 6 * hour;
	await new BetaReleaseScheduler(options).tick();
	f.transport.observe = async () => ({
		runs: [{ id: 1, status: "completed", conclusion: "failure" }],
	});
	now += 60000;
	await new BetaReleaseScheduler(options).tick();
	f.transport.dispatch = async () => null;
	now += 120000;
	await new BetaReleaseScheduler(options).tick();
	expect(store.betaSchedules.active("a")?.state).toBe("dispatch_unknown");
	now += 7 * hour;
	await new BetaReleaseScheduler(options).tick();
	expect(store.betaSchedules.active("a")).not.toBeNull();
	expect(store.betaSchedules.active("a")?.runIds).toEqual([1]);
});
it("continues reconciling a removed project using its frozen binding, without new dispatch", async () => {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const f = fixture();
	let now = 0;
	let current = [projects[0]];
	const options = {
		store: store.betaSchedules,
		transport: f.transport,
		projects: async () => current,
		now: () => now,
	};
	await new BetaReleaseScheduler(options).tick();
	now = 6 * hour;
	await new BetaReleaseScheduler(options).tick();
	current = [];
	now += hour;
	await new BetaReleaseScheduler(options).tick();
	expect(store.betaSchedules.active("a")).toBeNull();
	expect(store.betaSchedules.lane("a")?.nextDueAtMs).toBe(12 * hour);
	expect(f.dispatched).toHaveLength(1);
});
it("records not_activated without counting publication and allows a later cycle", async () => {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const f = fixture();
	let now = 0;
	const observe = f.transport.observe;
	f.transport.observe = async (b, o, s) => {
		const result = await observe(b, o, s);
		for (const run of result.runs)
			if (run.receipt)
				run.receipt = {
					...run.receipt,
					outcome: "not_activated",
					publishedSourceCommit: null,
					publishedVersion: null,
					publishedAt: null,
				};
		return result;
	};
	const scheduler = new BetaReleaseScheduler({
		store: store.betaSchedules,
		transport: f.transport,
		projects: async () => [projects[0]!],
		now: () => now,
	});
	await scheduler.tick();
	now = 6 * hour;
	await scheduler.tick();
	now += 60000;
	await scheduler.tick();
	expect(scheduler.snapshot()[0]?.status).toBe("not_activated");
	expect(store.betaSchedules.active("a")).toBeNull();
	expect(store.betaSchedules.latestResult("a")?.[0]?.outcome).toBe(
		"not_activated",
	);
	now = 12 * hour;
	await scheduler.tick();
	expect(f.dispatched).toHaveLength(2);
});
it("isolates a failing project lookup and permits at most four concurrent project requests", async () => {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const f = fixture();
	let inFlight = 0;
	let maximum = 0;
	const all = Array.from({ length: 10 }, (_, i) => ({
		...projects[0]!,
		projectName: `p${i}`,
		projectRepo: `test/p${i}`,
	}));
	const resolve = f.transport.resolve;
	f.transport.resolve = async (p, s) => {
		inFlight++;
		maximum = Math.max(maximum, inFlight);
		await new Promise((r) => setTimeout(r, 5));
		inFlight--;
		if (p.projectName === "p0") throw new Error("secret should not escape");
		return resolve(p, s);
	};
	const scheduler = new BetaReleaseScheduler({
		store: store.betaSchedules,
		transport: f.transport,
		projects: async () => all,
		now: () => 0,
	});
	await scheduler.tick();
	expect(maximum).toBe(4);
	expect(store.betaSchedules.lanes()).toHaveLength(9);
	expect(scheduler.snapshot().find((p) => p.projectName === "p0")?.reason).toBe(
		"beta_observation_failed",
	);
	expect(JSON.stringify(scheduler.snapshot())).not.toContain("secret");
});
it("persists Retry-After across restart and does not poll or resubmit the lane early", async () => {
	const { BetaGitHubError } = await import("../beta-release-github.js");
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const f = fixture();
	let now = 0;
	let observations = 0;
	const options = {
		store: store.betaSchedules,
		transport: f.transport,
		projects: async () => [projects[0]!],
		now: () => now,
	};
	await new BetaReleaseScheduler(options).tick();
	now = 6 * hour;
	await new BetaReleaseScheduler(options).tick();
	f.transport.observe = async () => {
		observations++;
		throw new BetaGitHubError("beta_github_http_429", now + hour);
	};
	now += 60000;
	await new BetaReleaseScheduler(options).tick();
	expect(observations).toBe(1);
	now += 60000;
	await new BetaReleaseScheduler(options).tick();
	expect(observations).toBe(1);
	now += hour;
	await new BetaReleaseScheduler(options).tick();
	expect(observations).toBe(2);
	expect(f.dispatched).toHaveLength(1);
});
it("contains a roster-read failure and recovers on the next tick", async () => {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const f = fixture();
	let broken = true;
	const errors: string[] = [];
	const scheduler = new BetaReleaseScheduler({
		store: store.betaSchedules,
		transport: f.transport,
		projects: async () => {
			if (broken) throw new Error("private config detail");
			return [projects[0]!];
		},
		now: () => 0,
		onError: (code) => errors.push(code),
	});
	await expect(scheduler.tick()).resolves.toBeUndefined();
	expect(errors).toEqual(["beta_project_source_failed"]);
	broken = false;
	await scheduler.tick();
	expect(store.betaSchedules.lane("a")).not.toBeNull();
	await scheduler.stop();
});
it("does not activate a new lane until previous workflow runs are drained", async () => {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const f = fixture();
	let now = 0;
	let drained = false;
	f.transport.assertDrained = async () => {
		if (!drained) throw new Error("old run still live");
	};
	const scheduler = new BetaReleaseScheduler({
		store: store.betaSchedules,
		transport: f.transport,
		projects: async () => [projects[0]!],
		now: () => now,
	});
	await scheduler.tick();
	expect(store.betaSchedules.lane("a")).toBeNull();
	expect(f.dispatched).toHaveLength(0);
	drained = true;
	now = 900000;
	await scheduler.tick();
	expect(store.betaSchedules.lane("a")?.activatedAtMs).toBe(now);
	expect(store.betaSchedules.lane("a")?.nextDueAtMs).toBe(now + 6 * hour);
});
it("backs off an authorization error before a lane has been bound", async () => {
	const { BetaGitHubError } = await import("../beta-release-github.js");
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const f = fixture();
	let now = 0;
	let calls = 0;
	f.transport.resolve = async () => {
		calls++;
		throw new BetaGitHubError("beta_github_http_403");
	};
	const scheduler = new BetaReleaseScheduler({
		store: store.betaSchedules,
		transport: f.transport,
		projects: async () => [projects[0]!],
		now: () => now,
	});
	await scheduler.tick();
	now = 60000;
	await scheduler.tick();
	expect(calls).toBe(1);
	now = 900000;
	await scheduler.tick();
	expect(calls).toBe(2);
});
