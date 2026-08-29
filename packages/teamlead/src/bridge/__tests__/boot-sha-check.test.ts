import { describe, expect, it, vi } from "vitest";
import {
	type BootShaCheckDeps,
	classifyBootSha,
	runBootShaCheck,
} from "../boot-sha-check.js";

/**
 * FLY-939 (G-D): Bridge boot checkout-SHA visibility. Pure classifier + a
 * best-effort effect that WARNs + records + alerts only on a STALE checkout.
 */

const HEAD = "a".repeat(40);
const MAIN = "b".repeat(40);

describe("classifyBootSha (pure, 5 states → 4 classes)", () => {
	it("HEAD === origin/main → same", () => {
		expect(
			classifyBootSha({ head: HEAD, originMain: HEAD, isAncestor: false }),
		).toBe("same");
	});
	it("HEAD is an ancestor of origin/main (behind) → stale", () => {
		expect(
			classifyBootSha({ head: HEAD, originMain: MAIN, isAncestor: true }),
		).toBe("stale");
	});
	it("HEAD ahead / diverged (not an ancestor) → branch", () => {
		expect(
			classifyBootSha({ head: HEAD, originMain: MAIN, isAncestor: false }),
		).toBe("branch");
	});
	it("origin/main unresolved (fetch failed) → unknown", () => {
		expect(
			classifyBootSha({ head: HEAD, originMain: null, isAncestor: null }),
		).toBe("unknown");
	});
	it("isAncestor unavailable → unknown", () => {
		expect(
			classifyBootSha({ head: HEAD, originMain: MAIN, isAncestor: null }),
		).toBe("unknown");
	});
});

/** A fake git driver: resolves canned stdout per subcommand, rejects on the
 *  patterns in `fail`. Records every invocation for refspec assertions. */
function fakeGit(opts: {
	head?: string;
	originMain?: string | Error;
	isAncestor?: boolean; // merge-base --is-ancestor exit code
	subject?: string;
	aheadCount?: number;
	calls: string[][];
}) {
	return async (args: string[]): Promise<string> => {
		opts.calls.push(args);
		const joined = args.join(" ");
		if (args[0] === "rev-parse" && args[1] === "HEAD") return `${opts.head}\n`;
		if (args[0] === "log") return `${opts.subject ?? ""}\n`;
		if (args[0] === "fetch") {
			if (opts.originMain instanceof Error) throw opts.originMain;
			return "";
		}
		if (args[0] === "rev-parse" && args[1] === "origin/main") {
			if (opts.originMain instanceof Error) throw opts.originMain;
			return `${opts.originMain}\n`;
		}
		if (joined.startsWith("merge-base --is-ancestor")) {
			if (opts.isAncestor) return "";
			throw new Error("not an ancestor"); // exit 1
		}
		if (args[0] === "rev-list") return `${opts.aheadCount ?? 0}\n`;
		throw new Error(`unexpected git ${joined}`);
	};
}

function harness(
	gitOpts: Parameters<typeof fakeGit>[0],
	env: Record<string, string | undefined> = {},
) {
	const logs: string[] = [];
	const warns: string[] = [];
	const stale: unknown[] = [];
	const alerts: unknown[] = [];
	const deps: BootShaCheckDeps = {
		projectRoot: "/repo",
		env: env as NodeJS.ProcessEnv,
		git: fakeGit(gitOpts),
		logger: { log: (m) => logs.push(m), warn: (m) => warns.push(m) },
		recordStaleEvent: (p) => stale.push(p),
		alertStale: async (info) => {
			alerts.push(info);
		},
	};
	return { deps, logs, warns, stale, alerts, calls: gitOpts.calls };
}

describe("runBootShaCheck effect", () => {
	it("always logs the running HEAD", async () => {
		const h = harness({
			head: HEAD,
			originMain: HEAD,
			subject: "fix stuff",
			calls: [],
		});
		await runBootShaCheck(h.deps);
		expect(h.logs.some((l) => l.includes(`running HEAD=${HEAD}`))).toBe(true);
		expect(h.logs.some((l) => l.includes("(fix stuff)"))).toBe(true);
	});

	it("STALE (behind origin/main) → WARN + durable event + alert", async () => {
		const h = harness({
			head: HEAD,
			originMain: MAIN,
			isAncestor: true,
			aheadCount: 3,
			calls: [],
		});
		await runBootShaCheck(h.deps);
		expect(h.warns.some((w) => w.includes("STALE CHECKOUT"))).toBe(true);
		expect(h.warns.some((w) => w.includes("3 commits ahead"))).toBe(true);
		expect(h.stale).toHaveLength(1);
		expect(h.stale[0]).toMatchObject({
			headSha: HEAD,
			originMainSha: MAIN,
			aheadBy: 3,
		});
		expect(h.alerts).toHaveLength(1);
	});

	it("branch (ahead / diverged) → no WARN, no event, no alert", async () => {
		const h = harness({
			head: HEAD,
			originMain: MAIN,
			isAncestor: false,
			calls: [],
		});
		await runBootShaCheck(h.deps);
		expect(h.warns.some((w) => w.includes("STALE"))).toBe(false);
		expect(h.stale).toHaveLength(0);
		expect(h.alerts).toHaveLength(0);
	});

	it("same (up to date) → no WARN/event/alert", async () => {
		const h = harness({
			head: HEAD,
			originMain: HEAD,
			isAncestor: true,
			calls: [],
		});
		await runBootShaCheck(h.deps);
		expect(h.warns.some((w) => w.includes("STALE"))).toBe(false);
		expect(h.stale).toHaveLength(0);
	});

	it("fetch fails (offline) → unknown, no WARN (skips the compare)", async () => {
		const h = harness({
			head: HEAD,
			originMain: new Error("network down"),
			calls: [],
		});
		await runBootShaCheck(h.deps);
		expect(h.logs.some((l) => l.includes("compare skipped"))).toBe(true);
		expect(h.warns.some((w) => w.includes("STALE"))).toBe(false);
		expect(h.stale).toHaveLength(0);
	});

	it("FLYWHEEL_BOOT_SHA_CHECK=0 → entirely skipped (no git calls)", async () => {
		const h = harness(
			{ head: HEAD, originMain: MAIN, isAncestor: true, calls: [] },
			{ FLYWHEEL_BOOT_SHA_CHECK: "0" },
		);
		await runBootShaCheck(h.deps);
		expect(h.calls).toHaveLength(0);
		expect(h.logs).toHaveLength(0);
	});

	it("git rev-parse HEAD throwing does NOT break boot (swallowed)", async () => {
		const deps: BootShaCheckDeps = {
			projectRoot: "/repo",
			env: {} as NodeJS.ProcessEnv,
			git: async () => {
				throw new Error("git missing");
			},
			logger: { log: () => {}, warn: () => {} },
			recordStaleEvent: () => {},
		};
		await expect(runBootShaCheck(deps)).resolves.toBeUndefined();
	});

	it("Codex R1 #3: fetch uses the EXPLICIT remote-tracking refspec (not a bare fetch)", async () => {
		const h = harness({
			head: HEAD,
			originMain: MAIN,
			isAncestor: true,
			calls: [],
		});
		await runBootShaCheck(h.deps);
		const fetchCall = h.calls.find((c) => c[0] === "fetch");
		expect(fetchCall).toEqual([
			"fetch",
			"--quiet",
			"origin",
			"+refs/heads/main:refs/remotes/origin/main",
		]);
	});

	it("recordStaleEvent throwing is swallowed (still tries the alert)", async () => {
		const h = harness({
			head: HEAD,
			originMain: MAIN,
			isAncestor: true,
			calls: [],
		});
		h.deps.recordStaleEvent = vi.fn(() => {
			throw new Error("db locked");
		});
		await expect(runBootShaCheck(h.deps)).resolves.toBeUndefined();
		expect(h.alerts).toHaveLength(1);
	});
});
