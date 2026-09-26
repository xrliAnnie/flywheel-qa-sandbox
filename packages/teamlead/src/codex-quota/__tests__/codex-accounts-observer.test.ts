import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCodexAccountPool } from "flywheel-claude-runner/bin/codex-account-core.mjs";
import { afterEach, describe, expect, it } from "vitest";
import { observeCodexAccounts } from "../codex-accounts-observer.js";

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
	const registryPath = join(root, "codex-account-registry.json");
	writeFileSync(
		registryPath,
		JSON.stringify({ version: 2, primary: "personal" }),
	);
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
			pool: () => loadCodexAccountPool({ profilesRoot, registryPath }),
			limitId: "codex",
			now: () => NOW,
		},
	};
}

describe("FLY-2688 — Codex accounts observer", () => {
	it("reads every ready profile slot from the directory pool", async () => {
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
		expect(school.resetCredits).toEqual({
			known: true,
			value: null,
			availableCount: 0,
			credits: [],
		});
		expect(school.resetCreditsObservedAt).toBe("2026-09-21T12:00:00.000Z");

		const shopping = store.accounts.find((a) => a.name === "shopping")!;
		expect(shopping.registeredProfile).toBe("shopping");
		expect(shopping.identityKey).toMatch(/^[a-f0-9]{64}$/);
		expect(shopping.weekly?.usedPercent).toBe(100);

		expect(store.accounts.find((a) => a.name === "broken")).toMatchObject({
			authHealth: "missing",
			note: "invalid_credential",
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

	it("reads an in-use account through the non-refreshing path and uses canonical auth for the active slot", async () => {
		const f = fixture();
		const first = await observeCodexAccounts(f.options);
		const probed: string[] = [];
		const readonlyPaths: string[] = [];
		const second = await observeCodexAccounts({
			...f.options,
			now: () => NOW + 86_400_000,
			previous: first,
			isInUse: (_accountKey, slot) => {
				probed.push(slot);
				return { verdict: slot === "shopping" };
			},
			readInUseQuota: async ({ authPath }) => {
				readonlyPaths.push(authPath);
				return {
					ok: {
						observedAt: "2026-09-22T12:00:00.000Z",
						planType: "prolite",
						fiveH: null,
						weekly: {
							usedPercent: 44,
							windowMinutes: 10080,
							resetAt: "2026-09-22T12:00:00.000Z",
						},
						credits: {
							known: true,
							hasCredits: false,
							unlimited: false,
							balance: "0",
						},
						resetCredits: {
							known: false,
							value: null,
							availableCount: null,
							credits: null,
						},
						unclassifiedWindows: 0,
					},
				};
			},
		});

		expect(probed).toContain("school");
		const shopping = second.accounts.find((a) => a.name === "shopping")!;
		expect(shopping).toMatchObject({ authHealth: "valid", note: null });
		expect(shopping.weekly?.usedPercent).toBe(44);
		expect(shopping.observedAt).toBe("2026-09-22T12:00:00.000Z");
		expect(shopping.resetCredits.availableCount).toBe(0);
		expect(shopping.resetCreditsObservedAt).toBe("2026-09-21T12:00:00.000Z");
		expect(readonlyPaths).toEqual([join(f.codexHome, "auth.json")]);
	});

	it("does not carry quota readings across an identity change in the same slot", async () => {
		const f = fixture();
		const first = await observeCodexAccounts(f.options);
		writeFileSync(
			join(f.profilesRoot, "school", "auth.json"),
			auth("school", "different-account"),
			{ mode: 0o600 },
		);
		const changed = JSON.parse(
			readFileSync(join(f.profilesRoot, "school", "auth.json"), "utf8"),
		);
		const payload = JSON.parse(
			Buffer.from(changed.tokens.id_token.split(".")[1], "base64url").toString(
				"utf8",
			),
		);
		payload["https://api.openai.com/auth"].chatgpt_account_id = "school-new";
		changed.tokens.id_token = `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.x`;
		writeFileSync(
			join(f.profilesRoot, "school", "auth.json"),
			JSON.stringify(changed),
			{ mode: 0o600 },
		);
		const second = await observeCodexAccounts({
			...f.options,
			previous: first,
			totalDeadlineMs: 0,
		});
		const school = second.accounts.find(
			(account) => account.name === "school",
		)!;
		expect(school.note).toBe("deadline");
		expect(school.weekly).toBeNull();
		expect(school.planType).toBeNull();
		expect(school.identityKey).not.toBe(
			first.accounts.find((account) => account.name === "school")!.identityKey,
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

	it("reports an empty slot but ignores hidden directories and stray files", async () => {
		const f = fixture();
		mkdirSync(join(f.profilesRoot, "no-auth-here"));
		mkdirSync(join(f.profilesRoot, ".hidden"));
		writeFileSync(join(f.profilesRoot, "stray-file"), "x");
		const store = await observeCodexAccounts(f.options);
		expect(store.accounts.map((a) => a.name)).toEqual([
			"broken",
			"no-auth-here",
			"school",
			"shopping",
		]);
		expect(store.accounts.find((a) => a.name === "no-auth-here")).toMatchObject(
			{
				authHealth: "missing",
				note: "not_logged_in",
			},
		);
	});

	it("emits six ready accounts plus a separate not-logged-in row", async () => {
		const f = fixture();
		for (const slot of ["business", "personal", "personal1", "personal2"]) {
			mkdirSync(join(f.profilesRoot, slot));
			writeFileSync(
				join(f.profilesRoot, slot, "auth.json"),
				auth(slot, "old"),
				{
					mode: 0o600,
				},
			);
		}
		mkdirSync(join(f.profilesRoot, "new-account"));
		const store = await observeCodexAccounts({
			...f.options,
			totalDeadlineMs: 0,
		});
		expect(store.accounts.map((account) => account.name)).toEqual([
			"broken",
			"business",
			"new-account",
			"personal",
			"personal1",
			"personal2",
			"school",
			"shopping",
		]);
		expect(
			store.accounts.filter((account) => account.note === "deadline"),
		).toHaveLength(6);
		expect(
			store.accounts.find((account) => account.name === "new-account"),
		).toMatchObject({
			authHealth: "missing",
			note: "not_logged_in",
		});
	});

	it("re-reads the in-use inventory before every slot", async () => {
		const f = fixture();
		const seen: string[] = [];
		let round = 0;
		const store = await observeCodexAccounts({
			...f.options,
			readInUseQuota: async () => ({
				ok: {
					observedAt: "2026-09-21T12:00:00.000Z",
					planType: "pro",
					fiveH: null,
					weekly: null,
					credits: {
						known: false,
						hasCredits: null,
						unlimited: null,
						balance: null,
					},
					resetCredits: {
						known: false,
						value: null,
						availableCount: null,
						credits: null,
					},
					unclassifiedWindows: 0,
				},
			}),
			refreshInUse: async () => {
				round += 1;
				return (_accountKey, slot) => {
					seen.push(`${round}:${slot}`);
					// A Lead launches on `shopping` after the first slot is read.
					return { verdict: round > 1 && slot === "shopping" };
				};
			},
		});

		// `broken` never reaches the guard: the pool marks it invalid first.
		expect(seen).toEqual(["1:school", "2:shopping"]);
		expect(store.accounts.find((a) => a.name === "shopping")).toMatchObject({
			authHealth: "valid",
			note: null,
		});
		expect(store.accounts.find((a) => a.name === "school")?.note).toBeNull();
	});

	it("says the inventory is unknown instead of claiming every account is busy", async () => {
		const f = fixture();
		const store = await observeCodexAccounts({
			...f.options,
			isInUse: () => ({
				verdict: "unknown",
				detail: "canonical_identity_unreadable",
			}),
		});

		for (const account of store.accounts.filter((a) => a.name !== "broken")) {
			expect(account).toMatchObject({
				authHealth: "unknown",
				note: "inventory_unavailable",
				noteDetail: "canonical_identity_unreadable",
			});
		}
	});

	it("records guard_failed when the occupancy refresh itself rejects", async () => {
		const f = fixture();
		const store = await observeCodexAccounts({
			...f.options,
			refreshInUse: async () => {
				throw new Error("boom");
			},
		});
		expect(store.accounts.find((a) => a.name === "school")).toMatchObject({
			note: "inventory_unavailable",
			noteDetail: "guard_failed",
		});
	});

	it("reads the in-use canonical account through WHAM when the guard proves it", async () => {
		const f = fixture();
		const reads: string[] = [];
		const store = await observeCodexAccounts({
			...f.options,
			refreshInUse: async () => (_accountKey, slot) => ({
				verdict: slot === "shopping",
			}),
			readInUseQuota: async ({ authPath }) => {
				reads.push(authPath);
				return {
					ok: {
						observedAt: "2026-09-21T12:00:00.000Z",
						planType: "pro",
						fiveH: null,
						weekly: {
							usedPercent: 28,
							windowMinutes: 10080,
							resetAt: "2026-10-02T03:35:25.000Z",
						},
						credits: {
							known: false,
							hasCredits: null,
							unlimited: null,
							balance: null,
						},
						resetCredits: {
							known: false,
							value: null,
							availableCount: null,
							credits: null,
						},
						unclassifiedWindows: 0,
					},
				};
			},
		});
		expect(reads).toEqual([join(f.codexHome, "auth.json")]);
		const shopping = store.accounts.find((a) => a.name === "shopping")!;
		expect(shopping).toMatchObject({ note: null, authHealth: "valid" });
		expect(shopping.noteDetail).toBeUndefined();
		expect(shopping.weekly?.usedPercent).toBe(28);
	});

	it("refuses to replace the store when the profiles root cannot be read", async () => {
		const f = fixture();
		rmSync(f.profilesRoot, { recursive: true, force: true });
		await expect(observeCodexAccounts(f.options)).rejects.toThrow();
	});
});
