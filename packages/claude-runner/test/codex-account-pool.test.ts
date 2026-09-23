import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	enumerateCodexProfileSlots,
	identifyCodexAuth,
	loadCodexAccountPolicy,
	loadCodexAccountPool,
	validateCodexAccountPool,
} from "../bin/codex-account-core.mjs";

const roots: string[] = [];

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "fly2762-pool-"));
	roots.push(value);
	return value;
}

function auth(
	email: string,
	accountId = `acct-${email}`,
	plan = "pro",
): string {
	const payload = Buffer.from(
		JSON.stringify({
			email,
			"https://api.openai.com/auth": {
				chatgpt_account_id: accountId,
				chatgpt_plan_type: plan,
			},
		}),
	).toString("base64url");
	return JSON.stringify({
		tokens: { id_token: `header.${payload}.signature` },
	});
}

function fixture(
	names = [
		"business",
		"personal",
		"personal1",
		"personal2",
		"school",
		"shopping",
	],
) {
	const dir = root();
	const profilesRoot = join(dir, "profiles");
	mkdirSync(profilesRoot);
	for (const name of names) {
		mkdirSync(join(profilesRoot, name));
		writeFileSync(
			join(profilesRoot, name, "auth.json"),
			auth(
				`${name}@example.test`,
				`acct-${name}`,
				name.startsWith("personal") ? "prolite" : "pro",
			),
			{ mode: 0o600 },
		);
	}
	const registryPath = join(dir, "policy.json");
	writeFileSync(
		registryPath,
		JSON.stringify({ version: 2, primary: "personal" }),
	);
	return { dir, profilesRoot, registryPath };
}

afterEach(() => {
	for (const value of roots.splice(0)) {
		rmSync(value, { recursive: true, force: true });
	}
});

describe("directory-enumerated Codex account pool", () => {
	it("enumerates six ready profiles with directory names and JWT identities", () => {
		const f = fixture();
		const pool = loadCodexAccountPool(f);

		expect(pool.version).toBe(2);
		expect(pool.primary).toBe("personal");
		expect(pool.profiles.map((entry) => entry.name)).toEqual([
			"business",
			"personal",
			"personal1",
			"personal2",
			"school",
			"shopping",
		]);
		expect(pool.profiles.find((entry) => entry.name === "personal")).toEqual({
			name: "personal",
			email: "personal@example.test",
			role: "primary",
		});
		expect(pool.profiles.find((entry) => entry.name === "shopping")).toEqual({
			name: "shopping",
			email: "shopping@example.test",
			role: "manual_backup",
		});
		expect(pool.problems).toEqual([]);
	});

	it("ignores hidden entries and loose files but reports unsafe or unusable directories", () => {
		const f = fixture(["personal"]);
		mkdirSync(join(f.profilesRoot, ".codex-quota-account-locks"));
		writeFileSync(join(f.profilesRoot, ".active"), "personal\n");
		writeFileSync(join(f.profilesRoot, "shopping-auth.json.bak"), "secret");
		mkdirSync(join(f.profilesRoot, "not-logged-in"));
		mkdirSync(join(f.profilesRoot, "broken"));
		writeFileSync(join(f.profilesRoot, "broken", "auth.json"), "{");
		mkdirSync(join(f.profilesRoot, "Foo"));
		mkdirSync(join(f.profilesRoot, "account-reserved"));
		const outside = join(f.dir, "outside");
		mkdirSync(outside);
		symlinkSync(outside, join(f.profilesRoot, "linked"));

		const slots = enumerateCodexProfileSlots(f.profilesRoot);
		expect(slots.map((slot) => [slot.name, slot.state])).toEqual([
			["Foo", "invalid_name"],
			["account-reserved", "invalid_name"],
			["broken", "invalid_credential"],
			["linked", "invalid_name"],
			["not-logged-in", "not_logged_in"],
			["personal", "ready"],
		]);
	});

	it("excludes every slot that shares a duplicate email", () => {
		const f = fixture(["personal", "shopping"]);
		writeFileSync(
			join(f.profilesRoot, "shopping", "auth.json"),
			auth("personal@example.test", "acct-duplicate"),
		);
		const pool = loadCodexAccountPool(f);
		expect(pool.profiles).toEqual([]);
		expect(pool.primary).toBeNull();
		expect(pool.problems).toEqual([
			{ name: "personal", code: "duplicate_email" },
			{ name: "shopping", code: "duplicate_email" },
		]);
	});

	it("maps a directory credential to its slot and keeps a bounded derived identity outside the pool", () => {
		const f = fixture(["personal", "shopping"]);
		const pool = loadCodexAccountPool(f);
		expect(
			identifyCodexAuth(auth("shopping@example.test", "acct-shopping"), pool)
				.profile,
		).toBe("shopping");
		const derived = identifyCodexAuth(
			auth(`${"very-long-local-part-".repeat(8)}@example.test`, "acct-outside"),
			pool,
		).profile;
		expect(derived).toMatch(/^account-/);
		expect(derived.length).toBeLessThanOrEqual(80);
	});

	it.each([
		[{ version: 1, primary: "personal", profiles: [] }, /version 2/i],
		[{ version: 2, primary: "Personal" }, /primary/i],
		[{ version: 2, primary: "personal", extra: true }, /keys/i],
	])("rejects an invalid policy: %j", (policy, expected) => {
		const dir = root();
		const path = join(dir, "policy.json");
		writeFileSync(path, JSON.stringify(policy));
		expect(() => loadCodexAccountPolicy(path)).toThrow(expected);
	});

	it.each([
		[
			"duplicate name",
			{
				version: 2,
				primary: "personal",
				profiles: [
					{ name: "personal", email: "a@example.test", role: "primary" },
					{ name: "personal", email: "b@example.test", role: "manual_backup" },
				],
			},
		],
		[
			"duplicate email",
			{
				version: 2,
				primary: "personal",
				profiles: [
					{ name: "personal", email: "a@example.test", role: "primary" },
					{ name: "shopping", email: "a@example.test", role: "manual_backup" },
				],
			},
		],
		[
			"two primaries",
			{
				version: 2,
				primary: "personal",
				profiles: [
					{ name: "personal", email: "a@example.test", role: "primary" },
					{ name: "shopping", email: "b@example.test", role: "primary" },
				],
			},
		],
		[
			"primary role mismatch",
			{
				version: 2,
				primary: "personal",
				profiles: [
					{ name: "personal", email: "a@example.test", role: "manual_backup" },
				],
			},
		],
	] as const)("rejects an invalid pool: %s", (_label, pool) => {
		expect(() => validateCodexAccountPool(pool)).toThrow();
	});

	it("fails closed when the profiles root cannot be read", () => {
		const f = fixture([]);
		expect(() =>
			enumerateCodexProfileSlots(join(f.dir, "missing-profiles")),
		).toThrow(/profile pool/i);
	});
});
