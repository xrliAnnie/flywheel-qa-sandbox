import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexAccountPool } from "flywheel-claude-runner/bin/codex-account-core.mjs";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAccountOccupancy } from "../occupancy.js";
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
			if (fail) throw new Error("down");
			return inventory({
				activeUnsharedAccountKeys: [key("business")],
			} as never);
		});
		const guard = await occupancy.guard(authPath, () => pool);
		expect(guard(key("business"))).toBe(true);
		fail = true;
		const failed = await occupancy.guard(authPath, () => pool);
		expect(failed(key("business"))).toBe("unknown");
		const noPool = await occupancy.guard(authPath, () => {
			throw new Error("pool unreadable");
		});
		expect(noPool(key("business"))).toBe("unknown");
	});
});
