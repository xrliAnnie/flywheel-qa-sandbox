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
	identifyCodexAuth,
	loadCodexAccountPool,
	readCodexAuthIdentity,
	redactCodexEmail,
} from "../src/codex-account-identity.js";

function authJson(
	email: string,
	accountId = "acct-personal",
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
		OPENAI_API_KEY: null,
		tokens: {
			id_token: `header.${payload}.signature`,
			access_token: "SECRET_ACCESS_CANARY",
			refresh_token: "SECRET_REFRESH_CANARY",
		},
	});
}

const roots: string[] = [];

function fixturePool() {
	const root = mkdtempSync(join(tmpdir(), "fly2003-registry-"));
	roots.push(root);
	const registryPath = join(root, "registry.json");
	const profilesRoot = join(root, "profiles");
	mkdirSync(profilesRoot);
	for (const name of ["business", "personal", "school"]) {
		mkdirSync(join(profilesRoot, name));
		writeFileSync(
			join(profilesRoot, name, "auth.json"),
			authJson(`${name}@example.test`, `acct-${name}`),
		);
	}
	writeFileSync(
		registryPath,
		JSON.stringify({ version: 2, primary: "personal" }),
	);
	return {
		profilesRoot,
		registryPath,
		pool: loadCodexAccountPool({ profilesRoot, registryPath }),
	};
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("Codex account registry", () => {
	it("derives all profile identities from directories with one configured primary", () => {
		const { pool } = fixturePool();
		expect(pool.profiles.map((profile) => profile.name)).toEqual([
			"business",
			"personal",
			"school",
		]);
		expect(pool.primary).toBe("personal");
		expect(
			pool.profiles.filter((profile) => profile.role === "primary"),
		).toHaveLength(1);
	});

	it("accepts injected roots so tests do not read production identity", () => {
		const { pool } = fixturePool();
		expect(pool.profiles[1]).toEqual({
			name: "personal",
			email: "personal@example.test",
			role: "primary",
		});
	});
});

describe("Codex auth identity", () => {
	it("derives canonical label, account id, plan, and mode from the JWT", () => {
		const { pool } = fixturePool();
		const identity = identifyCodexAuth(
			authJson("business@example.test", "acct-business", "prolite"),
			pool,
		);
		expect(identity).toEqual({
			profile: "business",
			email: "business@example.test",
			accountId: "acct-business",
			plan: "prolite",
			mode: "manual_backup",
		});
		expect(JSON.stringify(identity)).not.toMatch(
			/SECRET_|id_token|access_token|refresh_token/,
		);
	});

	it.each([
		["malformed JSON", "{"],
		["missing id token", JSON.stringify({ tokens: {} })],
		["not a JWT", JSON.stringify({ tokens: { id_token: "nope" } })],
		[
			"invalid base64 payload",
			JSON.stringify({ tokens: { id_token: "head.%%%%.sig" } }),
		],
	])("rejects %s without guessing a profile", (_label, raw) => {
		const { pool } = fixturePool();
		expect(() => identifyCodexAuth(raw, pool)).toThrow(
			/Codex auth identity|unknown Codex account/i,
		);
	});

	it("accepts an unregistered account with an email-derived profile (FLY-2750)", () => {
		const { pool } = fixturePool();
		const identity = identifyCodexAuth(
			authJson("xrliannie.shopping@example.test"),
			pool,
		);
		expect(identity.profile).toBe("account-xrliannie-shopping");
		expect(identity.mode).toBe("manual_backup");
		expect(identity.email).toBe("xrliannie.shopping@example.test");
	});

	it("reads only regular auth files and refuses a symlink", () => {
		const f = fixturePool();
		const root = mkdtempSync(join(tmpdir(), "fly2003-auth-"));
		roots.push(root);
		const real = join(root, "real-auth.json");
		const link = join(root, "auth.json");
		writeFileSync(real, authJson("personal@example.test"));
		symlinkSync(real, link);
		expect(() =>
			readCodexAuthIdentity(link, {
				profilesRoot: f.profilesRoot,
				registryPath: f.registryPath,
			}),
		).toThrow(/symlink|regular file/i);
	});

	it("redacts human email output", () => {
		expect(redactCodexEmail("personal@example.test")).toBe("p***@example.test");
		expect(redactCodexEmail("invalid")).toBe("***");
	});
});
