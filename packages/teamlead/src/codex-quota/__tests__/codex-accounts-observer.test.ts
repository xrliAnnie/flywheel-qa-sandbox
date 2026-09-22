import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { observeCodexAccounts } from "../codex-accounts-observer.js";

const registry = {
	version: 1 as const,
	primary: "personal" as const,
	profiles: [
		{
			name: "school" as const,
			email: "school@example.test",
			role: "manual_backup" as const,
		},
		{
			name: "personal" as const,
			email: "personal@example.test",
			role: "primary" as const,
		},
		{
			name: "business" as const,
			email: "business@example.test",
			role: "manual_backup" as const,
		},
	],
};

const auth = (local: string, refresh: string) =>
	JSON.stringify({
		tokens: {
			id_token: `x.${Buffer.from(
				JSON.stringify({
					email: `${local}@example.test`,
					"https://api.openai.com/auth": { chatgpt_account_id: local },
				}),
			).toString("base64url")}.x`,
			refresh_token: refresh,
		},
	});

const NOW = Date.parse("2026-09-21T12:00:00.000Z");
const roots: string[] = [];
afterEach(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * Stands in for `codex app-server`: answers initialize / account/read /
 * account/rateLimits/read and rotates the refresh token the way the real
 * binary may while reading.
 */
const FAKE_APP_SERVER = `
const fs = require("node:fs");
const readline = require("node:readline");
const home = process.env.CODEX_HOME;
const auth = JSON.parse(fs.readFileSync(home + "/auth.json", "utf8"));
const payload = JSON.parse(
  Buffer.from(auth.tokens.id_token.split(".")[1], "base64url").toString("utf8"),
);
const local = payload.email.split("@")[0];
const used = local === "shopping" ? 100 : 30;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result = {};
  if (message.method === "account/read") result = { account: { email: payload.email } };
  if (message.method === "account/rateLimits/read") {
    result = {
      rateLimits: {
        limitId: "codex",
        planType: local === "school" ? "plus" : "pro",
        primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: ${Math.floor(NOW / 1000)} + 3600 },
        secondary: { usedPercent: used, windowDurationMins: 10080, resetsAt: ${Math.floor(NOW / 1000)} + 86400 },
        credits: { hasCredits: false, unlimited: false, balance: "0" },
        rateLimitReachedType: null,
      },
      rateLimitResetCredits: null,
    };
    auth.tokens.refresh_token = "rotated";
    fs.writeFileSync(home + "/auth.json", JSON.stringify(auth));
  }
  process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
});
`;

function fixture(body = FAKE_APP_SERVER) {
	const root = mkdtempSync(join(tmpdir(), "fly2688-observer-"));
	roots.push(root);
	const codexHome = join(root, "codex");
	const profilesRoot = join(codexHome, "profiles");
	mkdirSync(profilesRoot, { recursive: true });
	for (const slot of ["school", "shopping"]) {
		mkdirSync(join(profilesRoot, slot));
		writeFileSync(join(profilesRoot, slot, "auth.json"), auth(slot, "old"), {
			mode: 0o600,
		});
	}
	mkdirSync(join(profilesRoot, "broken"));
	writeFileSync(join(profilesRoot, "broken", "auth.json"), "{}", {
		mode: 0o600,
	});
	writeFileSync(join(codexHome, "auth.json"), auth("shopping", "old"), {
		mode: 0o600,
	});
	const binary = join(root, "codex-bin");
	writeFileSync(binary, `#!${process.execPath}\n${body}`, { mode: 0o700 });
	return {
		root,
		codexHome,
		profilesRoot,
		binary,
		options: {
			profilesRoot,
			canonicalAuthPath: join(codexHome, "auth.json"),
			workspaceRoot: join(root, "candidates"),
			binary,
			registry,
			limitId: "codex",
			now: () => NOW,
		},
	};
}

describe("FLY-2688 — Codex accounts observer", () => {
	it("reads every profile slot, including accounts the registry does not list", async () => {
		const f = fixture();
		const store = await observeCodexAccounts(f.options);

		expect(store.version).toBe(1);
		expect(store.generatedAt).toBe("2026-09-21T12:00:00.000Z");
		expect(store.accounts.map((a) => a.name)).toEqual([
			"broken",
			"school",
			"shopping",
		]);
		expect(store.activeAccount).toBe("shopping");

		const school = store.accounts.find((a) => a.name === "school")!;
		expect(school).toMatchObject({
			registeredProfile: "school",
			authHealth: "valid",
			note: null,
			planType: "plus",
		});
		expect(school.weekly).toEqual({
			usedPercent: 30,
			windowMinutes: 10080,
			resetAt: "2026-09-22T12:00:00.000Z",
		});
		expect(school.fiveH?.usedPercent).toBe(5);
		expect(school.credits).toEqual({
			known: true,
			hasCredits: false,
			unlimited: false,
			balance: "0",
		});
		expect(school.resetCredits).toEqual({ known: true, value: null });

		const shopping = store.accounts.find((a) => a.name === "shopping")!;
		expect(shopping.registeredProfile).toBeNull();
		expect(shopping.weekly?.usedPercent).toBe(100);

		expect(store.accounts.find((a) => a.name === "broken")).toMatchObject({
			authHealth: "missing",
			note: "read_failed",
			weekly: null,
		});
		expect(JSON.stringify(store)).not.toContain("id_token");
		expect(JSON.stringify(store)).not.toContain("@example.test");
	});

	it("persists a refresh token the read rotated back into the slot", async () => {
		const f = fixture();
		await observeCodexAccounts(f.options);
		for (const slot of ["school", "shopping"]) {
			const persisted = JSON.parse(
				readFileSync(join(f.profilesRoot, slot, "auth.json"), "utf8"),
			);
			expect(persisted.tokens.refresh_token).toBe("rotated");
		}
	});

	it("never probes an account in use and keeps its last reading visible", async () => {
		const f = fixture();
		const first = await observeCodexAccounts(f.options);
		const probed: string[] = [];
		const second = await observeCodexAccounts({
			...f.options,
			previous: first,
			isInUse: (_accountKey, slot) => {
				probed.push(slot);
				return slot === "school";
			},
		});

		expect(probed).toContain("school");
		const school = second.accounts.find((a) => a.name === "school")!;
		expect(school).toMatchObject({
			authHealth: "in_use_unshared",
			note: "in_use_unshared",
		});
		expect(school.weekly?.usedPercent).toBe(30);
		expect(school.observedAt).toBe(
			first.accounts.find((a) => a.name === "school")!.observedAt,
		);
	});

	it("stops starting probes once the round deadline passes", async () => {
		const f = fixture();
		const previous = await observeCodexAccounts(f.options);
		const store = await observeCodexAccounts({
			...f.options,
			previous,
			totalDeadlineMs: 0,
		});
		expect(
			store.accounts.filter((a) => a.note === "deadline").length,
		).toBeGreaterThan(0);
		const school = store.accounts.find((a) => a.name === "school")!;
		expect(school.weekly?.usedPercent).toBe(30);
		expect(school.note).toBe("deadline");
	});

	it("records a failed read without inventing numbers", async () => {
		const f = fixture("process.exit(3);");
		const store = await observeCodexAccounts(f.options);
		const school = store.accounts.find((a) => a.name === "school")!;
		expect(school.note).toBe("read_failed");
		expect(school.weekly).toBeNull();
		expect(school.credits.known).toBe(false);
	});

	it("ignores paths that are not usable profile slots", async () => {
		const f = fixture();
		mkdirSync(join(f.profilesRoot, "no-auth-here"));
		mkdirSync(join(f.profilesRoot, ".hidden"));
		writeFileSync(join(f.profilesRoot, "stray-file"), "x");
		const store = await observeCodexAccounts(f.options);
		expect(store.accounts.map((a) => a.name)).toEqual([
			"broken",
			"school",
			"shopping",
		]);
	});

	it("re-reads the in-use inventory before every slot", async () => {
		const f = fixture();
		const seen: string[] = [];
		let round = 0;
		const store = await observeCodexAccounts({
			...f.options,
			refreshInUse: async () => {
				round += 1;
				return (_accountKey, slot) => {
					seen.push(`${round}:${slot}`);
					// A Lead launches on `shopping` after the first slot is read.
					return round > 1 && slot === "shopping";
				};
			},
		});

		// `broken` never reaches the guard: its identity fails first.
		expect(seen).toEqual(["1:school", "2:shopping"]);
		expect(store.accounts.find((a) => a.name === "shopping")).toMatchObject({
			authHealth: "in_use_unshared",
			note: "in_use_unshared",
		});
		expect(store.accounts.find((a) => a.name === "school")?.note).toBeNull();
	});

	it("says the inventory is unknown instead of claiming every account is busy", async () => {
		const f = fixture();
		const store = await observeCodexAccounts({
			...f.options,
			isInUse: () => "unknown",
		});

		for (const account of store.accounts.filter((a) => a.name !== "broken")) {
			expect(account).toMatchObject({
				authHealth: "unknown",
				note: "inventory_unavailable",
			});
		}
	});

	it("refuses to replace the store when the profiles root cannot be read", async () => {
		const f = fixture();
		rmSync(f.profilesRoot, { recursive: true, force: true });
		await expect(observeCodexAccounts(f.options)).rejects.toThrow();
	});
});
