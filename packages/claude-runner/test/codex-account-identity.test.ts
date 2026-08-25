import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	identifyCodexAuth,
	loadCodexAccountRegistry,
	readCodexAuthIdentity,
	redactCodexEmail,
} from "../src/codex-account-identity.js";

const TEST_REGISTRY = {
	version: 1,
	primary: "personal",
	profiles: [
		{
			name: "school",
			email: "school@example.test",
			role: "manual_backup",
		},
		{
			name: "personal",
			email: "personal@example.test",
			role: "primary",
		},
		{
			name: "business",
			email: "business@example.test",
			role: "manual_backup",
		},
	],
} as const;

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

function fixtureRegistry(): string {
	const root = mkdtempSync(join(tmpdir(), "fly2003-registry-"));
	roots.push(root);
	const path = join(root, "registry.json");
	writeFileSync(path, JSON.stringify(TEST_REGISTRY));
	return path;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("Codex account registry", () => {
	it("ships exactly school/personal/business with one Personal primary", () => {
		const registry = loadCodexAccountRegistry();
		expect(registry.profiles.map((profile) => profile.name)).toEqual([
			"school",
			"personal",
			"business",
		]);
		expect(registry.primary).toBe("personal");
		expect(
			registry.profiles.filter((profile) => profile.role === "primary"),
		).toHaveLength(1);
	});

	it("accepts an injected registry so tests do not embed production identity", () => {
		const registry = loadCodexAccountRegistry(fixtureRegistry());
		expect(registry.profiles[1]).toEqual({
			name: "personal",
			email: "personal@example.test",
			role: "primary",
		});
	});
});

describe("Codex auth identity", () => {
	it("derives canonical label, account id, plan, and mode from the JWT", () => {
		const identity = identifyCodexAuth(
			authJson("business@example.test", "acct-business", "prolite"),
			loadCodexAccountRegistry(fixtureRegistry()),
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
		["unknown zombie email", authJson("personal1@example.test")],
	])("rejects %s without guessing a profile", (_label, raw) => {
		expect(() =>
			identifyCodexAuth(raw, loadCodexAccountRegistry(fixtureRegistry())),
		).toThrow(/Codex auth identity|unknown Codex account/i);
	});

	it("reads only regular auth files and refuses a symlink", () => {
		const root = mkdtempSync(join(tmpdir(), "fly2003-auth-"));
		roots.push(root);
		const real = join(root, "real-auth.json");
		const link = join(root, "auth.json");
		writeFileSync(real, authJson("personal@example.test"));
		symlinkSync(real, link);
		expect(() =>
			readCodexAuthIdentity(link, {
				registryPath: fixtureRegistry(),
			}),
		).toThrow(/symlink|regular file/i);
	});

	it("redacts human email output", () => {
		expect(redactCodexEmail("personal@example.test")).toBe("p***@example.test");
		expect(redactCodexEmail("invalid")).toBe("***");
	});
});
