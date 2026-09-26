import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexAccountPool } from "flywheel-claude-runner/bin/codex-account-core.mjs";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAccountOccupancy, occupancyVerdict } from "../occupancy.js";
import { codexQuotaIdentityReader } from "../probe.js";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

const pool = {
	version: 2,
	primary: "personal",
	profiles: [
		{ name: "personal", email: "personal@example.test", role: "primary" },
		{ name: "business", email: "business@example.test", role: "manual_backup" },
	],
	slots: [],
	problems: [],
} as unknown as CodexAccountPool;
const auth = (profile: string) =>
	JSON.stringify({
		tokens: {
			id_token: `x.${Buffer.from(JSON.stringify({ email: `${profile}@example.test`, "https://api.openai.com/auth": { chatgpt_account_id: profile } })).toString("base64url")}.x`,
			refresh_token: "r",
		},
	});
const key = (profile: string) =>
	codexQuotaIdentityReader(pool)(auth(profile)).accountKey;

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}
type Inventory = Awaited<
	ReturnType<ConstructorParameters<typeof CodexAccountOccupancy>[0]>
>;
const inventory = (fields: Partial<Inventory> = {}): Inventory =>
	({ complete: true, homes: [], ...fields }) as Inventory;

async function canonical(profile: string) {
	const root = await mkdtemp(join(tmpdir(), "fly2869-occupancy-"));
	roots.push(root);
	const path = join(root, "auth.json");
	await writeFile(path, auth(profile));
	return path;
}

describe("FLY-2869 — shared Codex account occupancy", () => {
	it("is unknown before any collection and while one is in flight", async () => {
		const pending = deferred<Inventory>();
		const occupancy = new CodexAccountOccupancy(() => pending.promise);
		const authPath = await canonical("personal");
		expect(occupancy.isInUse(key("business"), pool, authPath)).toBe("unknown");
		const collecting = occupancy.collect();
		expect(occupancy.isInUse(key("business"), pool, authPath)).toBe("unknown");
		pending.resolve(inventory({ activeUnsharedAccountKeys: [] } as never));
		await collecting;
		expect(occupancy.isInUse(key("business"), pool, authPath)).toBe(false);
	});

	it("marks unshared active accounts and the canonical account of an active chain", async () => {
		const authPath = await canonical("personal");
		const occupancy = new CodexAccountOccupancy(async () =>
			inventory({
				canonicalChainActive: true,
				activeUnsharedAccountKeys: [key("business")],
			} as never),
		);
		await occupancy.collect();
		expect(occupancy.isInUse(key("business"), pool, authPath)).toBe(true);
		expect(occupancy.isInUse(key("personal"), pool, authPath)).toBe(true);
	});

	it("treats a managed active home as an active canonical chain", async () => {
		const authPath = await canonical("personal");
		const occupancy = new CodexAccountOccupancy(async () =>
			inventory({
				homes: [{ home: "/h", ownership: "managed", activity: "active" }],
			}),
		);
		await occupancy.collect();
		expect(occupancy.isInUse(key("personal"), pool, authPath)).toBe(true);
		expect(occupancy.isInUse(key("business"), pool, authPath)).toBe(false);
	});

	it("never lets an older collection that finishes last overwrite a newer one", async () => {
		const authPath = await canonical("personal");
		const older = deferred<Inventory>();
		const newer = deferred<Inventory>();
		const queue = [older.promise, newer.promise];
		const occupancy = new CodexAccountOccupancy(() => queue.shift()!);
		const first = occupancy.collect();
		const second = occupancy.collect();
		newer.resolve(
			inventory({ activeUnsharedAccountKeys: [key("business")] } as never),
		);
		await second;
		expect(occupancy.isInUse(key("business"), pool, authPath)).toBe(true);
		// The older "idle" answer still reaches its own caller...
		older.resolve(inventory({ activeUnsharedAccountKeys: [] } as never));
		await expect(first).resolves.toMatchObject({ complete: true });
		// ...but cannot roll the shared fact back.
		expect(occupancy.isInUse(key("business"), pool, authPath)).toBe(true);
	});

	it("stays unknown after a failed latest collection and when canonical is unreadable", async () => {
		const occupancy = new CodexAccountOccupancy(async () => {
			throw new Error("ps failed");
		});
		await expect(occupancy.collect()).rejects.toThrow("ps failed");
		const authPath = await canonical("personal");
		expect(occupancy.isInUse(key("business"), pool, authPath)).toBe("unknown");

		const chain = new CodexAccountOccupancy(async () =>
			inventory({ canonicalChainActive: true } as never),
		);
		await chain.collect();
		expect(chain.isInUse(key("business"), pool, "/missing/auth.json")).toBe(
			"unknown",
		);
	});

	it("guard() collects first and answers unknown when the collector fails", async () => {
		const authPath = await canonical("personal");
		let fail = false;
		const occupancy = new CodexAccountOccupancy(async () => {
			if (fail) throw new Error("ps failed: /bin/ps exited");
			return inventory({
				activeUnsharedAccountKeys: [key("business")],
			} as never);
		});
		const guard = await occupancy.guard(authPath, () => pool);
		expect(guard(key("business"))).toEqual({ verdict: true });
		fail = true;
		const failed = await occupancy.guard(authPath, () => pool);
		expect(failed(key("business"))).toEqual({
			verdict: "unknown",
			detail: "collector_failed:error",
		});
		fail = false;
		// No pool = canonical identity unreadable; the unshared fact still stands.
		const noPool = await occupancy.guard(authPath, () => {
			throw new Error("pool unreadable");
		});
		expect(noPool(key("business"))).toEqual({ verdict: true });
		expect(noPool(key("personal"))).toEqual({ verdict: false });
	});
});

describe("FLY-2830 — guard answers from its own collection", () => {
	it("answers the in-use canonical account even when a newer collection started meanwhile", async () => {
		const authPath = await canonical("personal");
		const a = deferred<Inventory>();
		const b = deferred<Inventory>();
		const queue = [a.promise, b.promise];
		const occupancy = new CodexAccountOccupancy(() => queue.shift()!);
		const guardA = occupancy.guard(authPath, () => pool);
		const collectB = occupancy.collect();
		a.resolve(inventory({ canonicalChainActive: true } as never));
		const answer = await guardA;
		expect(answer(key("personal"))).toEqual({ verdict: true });
		expect(answer(key("business"))).toEqual({ verdict: false });
		// B finishes later with a different fact: shared snapshot = B, A unchanged.
		b.resolve(
			inventory({
				canonicalChainActive: false,
				activeUnsharedAccountKeys: [key("business")],
			} as never),
		);
		await collectB;
		expect(occupancy.isInUse(key("business"), pool, authPath)).toBe(true);
		expect(occupancy.isInUse(key("personal"), pool, authPath)).toBe(false);
		expect(answer(key("personal"))).toEqual({ verdict: true });
	});

	it("answers unknown for every unproven account when an active chain's canonical identity is unreadable", async () => {
		const occupancy = new CodexAccountOccupancy(async () =>
			inventory({
				canonicalChainActive: true,
				activeUnsharedAccountKeys: [key("business")],
			} as never),
		);
		const answer = await occupancy.guard("/missing/auth.json", () => pool);
		expect(answer(key("personal"))).toEqual({
			verdict: "unknown",
			detail: "canonical_identity_unreadable",
		});
		expect(answer(key("business"))).toEqual({ verdict: true });
	});

	it("answers false for everything when no chain is active, even if canonical is unreadable", async () => {
		const occupancy = new CodexAccountOccupancy(async () => inventory());
		const answer = await occupancy.guard("/missing/auth.json", () => pool);
		expect(answer(key("personal"))).toEqual({ verdict: false });
		expect(answer(key("business"))).toEqual({ verdict: false });
	});

	it("carries a bounded collector reason code", async () => {
		const occupancy = new CodexAccountOccupancy(async () => {
			throw new Error("process_authority_invalid");
		});
		const answer = await occupancy.guard(
			await canonical("personal"),
			() => pool,
		);
		expect(answer(key("personal"))).toEqual({
			verdict: "unknown",
			detail: "collector_failed:process_authority_invalid",
		});
	});

	it("occupancyVerdict applies the four rules in order", () => {
		const active = inventory({
			canonicalChainActive: true,
			activeUnsharedAccountKeys: ["u"],
		} as never);
		const idle = inventory({ activeUnsharedAccountKeys: ["u"] } as never);
		const known = { known: true as const, accountKey: "c" };
		const unreadable = {
			known: false as const,
			detail: "canonical_identity_unreadable",
		};
		expect(occupancyVerdict(active, "u", unreadable)).toEqual({
			verdict: true,
		});
		expect(occupancyVerdict(idle, "c", unreadable)).toEqual({ verdict: false });
		expect(occupancyVerdict(active, "c", known)).toEqual({ verdict: true });
		expect(occupancyVerdict(active, "x", known)).toEqual({ verdict: false });
		expect(occupancyVerdict(active, "x", unreadable)).toEqual({
			verdict: "unknown",
			detail: "canonical_identity_unreadable",
		});
		const managedActive = inventory({
			homes: [{ home: "/h", ownership: "managed", activity: "active" }],
		});
		expect(occupancyVerdict(managedActive, "c", known)).toEqual({
			verdict: true,
		});
	});
});
