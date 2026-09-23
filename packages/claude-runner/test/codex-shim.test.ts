/**
 * FLY-2003: the Codex profile command is a manual, identity-verified selector.
 * The live auth.json JWT is authoritative; .active is only a diagnostic hint.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	accessSync,
	constants,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flywheelCodexBin } from "../src/codex-home.js";

const PROFILE_BIN = join(
	dirname(flywheelCodexBin({})),
	"flywheel-codex-profile",
);
const TOKEN_STATE_VECTORS = JSON.parse(
	readFileSync(
		new URL(
			"../../../scripts/__tests__/fixtures/codex-token-state-vectors.json",
			import.meta.url,
		),
		"utf8",
	),
) as readonly {
	authHealth: string;
	note: string | null;
	usedPercent: number | null;
	expected: string;
}[];

const ACCOUNTS = {
	school: {
		email: "xiaorongli2011@u.northwestern.edu",
		accountId: "acct-school",
		plan: "pro",
	},
	personal: {
		email: "xrliannie@gmail.com",
		accountId: "acct-personal",
		plan: "pro",
	},
	business: {
		email: "xrliannie.b@gmail.com",
		accountId: "acct-business",
		plan: "prolite",
	},
	personal1: {
		email: "xrliannie.1@gmail.com",
		accountId: "acct-personal1",
		plan: "prolite",
	},
	personal2: {
		email: "xrliannie.2@gmail.com",
		accountId: "acct-personal2",
		plan: "prolite",
	},
	shopping: {
		email: "xrliannie.shopping@gmail.com",
		accountId: "acct-shopping",
		plan: "prolite",
	},
} as const;

type AccountName = keyof typeof ACCOUNTS;

let tempRoot: string;
let hostHome: string;
let pool: string;
let stateDir: string;
let homeA: string;
let homeB: string;

function jwt(payload: Record<string, unknown>): string {
	return [
		Buffer.from('{"alg":"none"}').toString("base64url"),
		Buffer.from(JSON.stringify(payload)).toString("base64url"),
		"signature",
	].join(".");
}

function auth(name: AccountName): string {
	const account = ACCOUNTS[name];
	return JSON.stringify({
		tokens: {
			id_token: jwt({
				email: account.email,
				"https://api.openai.com/auth": {
					chatgpt_account_id: account.accountId,
					chatgpt_plan_type: account.plan,
				},
			}),
			access_token: `secret-access-${name}`,
			refresh_token: `secret-refresh-${name}`,
		},
	});
}

function profileEnv(home: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		HOME: hostHome,
		CODEX_HOME: home,
		FLYWHEEL_CODEX_PROFILES_DIR: pool,
		FLYWHEEL_STATE_DIR: stateDir,
	};
}

function runProfile(home: string, args: string[]): string {
	return execFileSync("bash", [PROFILE_BIN, ...args], {
		env: profileEnv(home),
		encoding: "utf8",
	});
}

function failProfile(home: string, args: string[]) {
	return spawnSync("bash", [PROFILE_BIN, ...args], {
		env: profileEnv(home),
		encoding: "utf8",
	});
}

function runProfileMerged(home: string, args: string[]) {
	return spawnSync(
		"bash",
		["-c", 'exec "$@" 2>&1', "fly2003-profile-merged", PROFILE_BIN, ...args],
		{
			env: profileEnv(home),
			encoding: "utf8",
		},
	);
}

function seedPool(name: AccountName, contents = auth(name)): string {
	const profileDir = join(pool, name);
	mkdirSync(profileDir, { recursive: true });
	const authPath = join(profileDir, "auth.json");
	writeFileSync(authPath, contents, { mode: 0o600 });
	return authPath;
}

beforeEach(() => {
	tempRoot = mkdtempSync(join(tmpdir(), "fly2003-profile-"));
	hostHome = join(tempRoot, "host-home");
	pool = join(tempRoot, "pool");
	stateDir = join(tempRoot, "state");
	homeA = join(tempRoot, "home-a");
	homeB = join(tempRoot, "home-b");
	for (const directory of [hostHome, pool, stateDir, homeA, homeB]) {
		mkdirSync(directory, { recursive: true });
	}
	seedPool("school");
	seedPool("personal");
	seedPool("business");
	seedPool("personal1");
	seedPool("personal2");
	seedPool("shopping");
});

afterEach(() => {
	rmSync(tempRoot, { recursive: true, force: true });
});

describe("flywheelCodexBin resolver", () => {
	it("honors an explicit FLYWHEEL_CODEX_BIN override", () => {
		expect(flywheelCodexBin({ FLYWHEEL_CODEX_BIN: "/custom/bin" })).toBe(
			"/custom/bin",
		);
	});

	it("defaults to the bundled, executable repo shims", () => {
		const bin = flywheelCodexBin({});
		expect(bin).toMatch(/bin\/flywheel-codex-with-fallback$/);
		expect(() => accessSync(bin, constants.X_OK)).not.toThrow();
		expect(() => accessSync(PROFILE_BIN, constants.X_OK)).not.toThrow();
	});
});

describe("flywheel-codex-profile manual identity control", () => {
	it("status trusts auth.json and calls out a stale sidecar hint", () => {
		writeFileSync(join(homeA, "auth.json"), auth("personal"));
		writeFileSync(join(homeA, ".active"), "school\n");

		const output = runProfile(homeA, ["status"]);

		expect(output).toContain("Actual profile: personal");
		expect(output).toContain("Email: x***@gmail.com");
		expect(output).toContain("Mode: primary");
		expect(output).toContain("Sidecar hint: school (DRIFT)");
		expect(output).not.toContain("secret-");
	});

	it("status --json is structured and token-free", () => {
		writeFileSync(join(homeA, "auth.json"), auth("business"));
		const result = JSON.parse(runProfile(homeA, ["status", "--json"]));

		expect(result).toMatchObject({
			actual: {
				profile: "business",
				email: ACCOUNTS.business.email,
				accountId: ACCOUNTS.business.accountId,
				plan: "prolite",
				mode: "manual_backup",
			},
			sidecarHint: null,
			drift: false,
		});
		expect(JSON.stringify(result)).not.toContain("secret-");
		expect(
			JSON.parse(
				readFileSync(
					join(stateDir, "codex-account-ledger", "business.json"),
					"utf8",
				),
			),
		).toMatchObject({ profile: "business", lastSource: "status" });
	});

	it("prints live identity before a best-effort ledger failure", () => {
		writeFileSync(
			join(stateDir, "codex-account-ledger"),
			"ledger-root-is-not-a-directory",
		);
		writeFileSync(join(homeA, "auth.json"), auth("personal"));

		const result = runProfileMerged(homeA, ["status"]);

		expect(result.status).toBe(0);
		const identityOffset = result.stdout.indexOf("Actual profile: personal");
		const warningOffset = result.stdout.indexOf(
			"account ledger observation failed for personal; live identity remains authoritative",
		);
		expect(identityOffset).toBeGreaterThanOrEqual(0);
		expect(warningOffset).toBeGreaterThan(identityOffset);
		expect(result.stdout).not.toContain("secret-");
	});

	it("keeps status --json successful when its ledger snapshot cannot be written", () => {
		writeFileSync(
			join(stateDir, "codex-account-ledger"),
			"ledger-root-is-not-a-directory",
		);
		writeFileSync(join(homeA, "auth.json"), auth("business"));

		const result = failProfile(homeA, ["status", "--json"]);

		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			actual: { profile: "business", mode: "manual_backup" },
		});
		expect(result.stderr).toContain(
			"account ledger observation failed for business; live identity remains authoritative",
		);
		expect(`${result.stdout}${result.stderr}`).not.toContain("secret-");
	});

	it("list exposes every directory profile without an Untracked bucket", () => {
		writeFileSync(join(homeA, "auth.json"), auth("personal"));
		runProfile(homeA, ["status", "--json"]);
		const result = JSON.parse(runProfile(homeA, ["list", "--json"]));

		expect(
			result.accounts.map((entry: { name: string }) => entry.name),
		).toEqual([
			"business",
			"personal",
			"personal1",
			"personal2",
			"school",
			"shopping",
		]);
		expect(result.accounts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "personal1",
					email: ACCOUNTS.personal1.email,
					plan: "prolite",
					tokenStatus: "未探",
				}),
				expect.objectContaining({ name: "shopping", tokenStatus: "未探" }),
			]),
		);
		expect(result).not.toHaveProperty("untracked");
		expect(JSON.stringify(result)).not.toContain("secret-");
	});

	it("uses a matching identityKey snapshot for token state and reset times", () => {
		const snapshot = join(stateDir, "codex-quota", "codex-accounts.json");
		mkdirSync(dirname(snapshot), { recursive: true });
		writeFileSync(
			snapshot,
			JSON.stringify({
				version: 1,
				generatedAt: "2026-09-22T20:00:00.000Z",
				activeAccount: "shopping",
				accounts: [
					{
						name: "shopping",
						identityKey: createHash("sha256")
							.update("shopping:acct-shopping")
							.digest("hex"),
						authHealth: "valid",
						note: null,
						planType: "prolite",
						fiveH: {
							usedPercent: 100,
							windowMinutes: 300,
							resetAt: "2026-09-22T21:00:00.000Z",
						},
						weekly: {
							usedPercent: 50,
							windowMinutes: 10080,
							resetAt: "2026-09-25T21:00:00.000Z",
						},
						observedAt: "2026-09-22T20:00:00.000Z",
					},
				],
			}),
		);

		const result = JSON.parse(runProfile(homeA, ["list", "--json"]));
		expect(
			result.accounts.find(
				(entry: { name: string }) => entry.name === "shopping",
			),
		).toMatchObject({
			tokenStatus: "打满",
			fiveHResetAt: "2026-09-22T21:00:00.000Z",
			weeklyResetAt: "2026-09-25T21:00:00.000Z",
		});
	});

	it("matches the shared account-page token-state vectors", () => {
		const snapshot = join(stateDir, "codex-quota", "codex-accounts.json");
		mkdirSync(dirname(snapshot), { recursive: true });
		const identityKey = createHash("sha256")
			.update("shopping:acct-shopping")
			.digest("hex");
		for (const vector of TOKEN_STATE_VECTORS) {
			writeFileSync(
				snapshot,
				JSON.stringify({
					version: 1,
					generatedAt: "2026-09-22T20:00:00.000Z",
					accounts: [
						{
							name: "shopping",
							identityKey,
							authHealth: vector.authHealth,
							note: vector.note,
							fiveH:
								vector.usedPercent === null
									? null
									: { usedPercent: vector.usedPercent, resetAt: null },
							weekly: null,
						},
					],
				}),
			);
			const result = JSON.parse(runProfile(homeA, ["list", "--json"]));
			expect(
				result.accounts.find(
					(entry: { name: string }) => entry.name === "shopping",
				)?.tokenStatus,
			).toBe(vector.expected);
		}
	});

	it.each([undefined, "not-a-sha256", "0".repeat(64)])(
		"does not trust a missing, malformed, or mismatched identityKey: %s",
		(identityKey) => {
			const snapshot = join(stateDir, "codex-quota", "codex-accounts.json");
			mkdirSync(dirname(snapshot), { recursive: true });
			writeFileSync(
				snapshot,
				JSON.stringify({
					version: 1,
					generatedAt: "2026-09-22T20:00:00.000Z",
					accounts: [
						{
							name: "shopping",
							...(identityKey === undefined ? {} : { identityKey }),
							authHealth: "valid",
							note: null,
							fiveH: { usedPercent: 100, resetAt: "2026-09-22T21:00:00.000Z" },
						},
					],
				}),
			);
			const result = JSON.parse(runProfile(homeA, ["list", "--json"]));
			expect(
				result.accounts.find(
					(entry: { name: string }) => entry.name === "shopping",
				),
			).toMatchObject({
				tokenStatus: "未探",
				fiveHResetAt: null,
			});
		},
	);

	it("manually installs a verified backup credential with mode 0600", () => {
		runProfile(homeA, ["use", "shopping"]);

		expect(readFileSync(join(homeA, "auth.json"), "utf8")).toBe(
			auth("shopping"),
		);
		expect(readFileSync(join(homeA, ".active"), "utf8")).toBe("shopping\n");
		expect(statSync(join(homeA, "auth.json")).mode & 0o777).toBe(0o600);
		expect(readFileSync(join(homeA, "auth.json"), "utf8")).not.toContain(
			"secret-access-personal",
		);
		expect(
			JSON.parse(
				readFileSync(
					join(stateDir, "codex-account-ledger", "shopping.json"),
					"utf8",
				),
			),
		).toMatchObject({ profile: "shopping", lastSource: "use" });
	});

	it("reports a successful use when only its ledger observation fails", () => {
		const ledgerRoot = join(stateDir, "codex-account-ledger");
		writeFileSync(ledgerRoot, "ledger-root-is-not-a-directory");

		const result = runProfileMerged(homeA, ["use", "school"]);

		expect(result.status).toBe(0);
		const successOffset = result.stdout.indexOf(
			"Selected Codex profile 'school' for this home (manual_backup)",
		);
		const warningOffset = result.stdout.indexOf(
			"account ledger observation failed for school",
		);
		expect(successOffset).toBeGreaterThanOrEqual(0);
		expect(warningOffset).toBeGreaterThan(successOffset);
		expect(result.stdout).toContain(join(ledgerRoot, "school.json"));
		expect(readFileSync(join(homeA, "auth.json"), "utf8")).toBe(auth("school"));
		expect(readFileSync(join(homeA, ".active"), "utf8")).toBe("school\n");
	});

	it("refuses a dangling auth symlink instead of replacing it", () => {
		const authPath = join(homeA, "auth.json");
		symlinkSync(join(homeA, "missing-auth-target"), authPath);

		const result = failProfile(homeA, ["use", "school"]);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("symlink");
		expect(lstatSync(authPath).isSymbolicLink()).toBe(true);
	});

	it("records a successful verified save", () => {
		writeFileSync(join(homeA, "auth.json"), auth("personal1"));

		runProfile(homeA, ["save", "personal1"]);

		expect(
			JSON.parse(
				readFileSync(
					join(stateDir, "codex-account-ledger", "personal1.json"),
					"utf8",
				),
			),
		).toMatchObject({ profile: "personal1", lastSource: "save" });
	});

	it("refuses save into an empty slot and points to direct login", () => {
		mkdirSync(join(pool, "newslot"));
		writeFileSync(join(homeA, "auth.json"), auth("personal1"));
		const result = failProfile(homeA, ["save", "newslot"]);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("not_logged_in");
		expect(result.stderr).toContain(`CODEX_HOME=${join(pool, "newslot")}`);
	});

	it("refuses save when email matches but account id differs", () => {
		const target = join(pool, "personal1", "auth.json");
		const differentAccount = JSON.parse(auth("personal1"));
		const payload = {
			email: ACCOUNTS.personal1.email,
			"https://api.openai.com/auth": {
				chatgpt_account_id: "acct-different",
				chatgpt_plan_type: "prolite",
			},
		};
		differentAccount.tokens.id_token = jwt(payload);
		writeFileSync(join(homeA, "auth.json"), JSON.stringify(differentAccount));
		const before = readFileSync(target);
		const result = failProfile(homeA, ["save", "personal1"]);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("identity mismatch");
		expect(readFileSync(target)).toEqual(before);
	});

	it("reports a successful save when only its ledger observation fails", () => {
		const ledgerRoot = join(stateDir, "codex-account-ledger");
		writeFileSync(ledgerRoot, "ledger-root-is-not-a-directory");
		writeFileSync(join(homeA, "auth.json"), auth("business"));

		const result = runProfileMerged(homeA, ["save", "business"]);

		expect(result.status).toBe(0);
		const successOffset = result.stdout.indexOf(
			"Saved verified Codex profile 'business' (manual_backup)",
		);
		const warningOffset = result.stdout.indexOf(
			"account ledger observation failed for business",
		);
		expect(successOffset).toBeGreaterThanOrEqual(0);
		expect(warningOffset).toBeGreaterThan(successOffset);
		expect(result.stdout).toContain(join(ledgerRoot, "business.json"));
		expect(readFileSync(join(pool, "business", "auth.json"), "utf8")).toBe(
			auth("business"),
		);
	});

	it("refuses to save the current credential under the wrong profile", () => {
		writeFileSync(join(homeA, "auth.json"), auth("personal"));
		const businessPath = join(pool, "business", "auth.json");
		const before = readFileSync(businessPath);

		const result = failProfile(homeA, ["save", "business"]);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("expected business");
		expect(readFileSync(businessPath)).toEqual(before);
	});

	it("retires automatic next-profile rotation without touching credentials", () => {
		writeFileSync(join(homeA, "auth.json"), auth("personal"));
		writeFileSync(join(homeA, ".active"), "personal\n");
		const beforeAuth = readFileSync(join(homeA, "auth.json"));
		const beforeSidecar = readFileSync(join(homeA, ".active"));

		const result = failProfile(homeA, ["next"]);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(
			"Automatic Codex account switching is retired",
		);
		expect(readFileSync(join(homeA, "auth.json"))).toEqual(beforeAuth);
		expect(readFileSync(join(homeA, ".active"))).toEqual(beforeSidecar);
	});

	it("keeps manual choices isolated across runner homes", () => {
		runProfile(homeA, ["use", "school"]);
		runProfile(homeB, ["use", "business"]);

		expect(
			JSON.parse(runProfile(homeA, ["status", "--json"])).actual.profile,
		).toBe("school");
		expect(
			JSON.parse(runProfile(homeB, ["status", "--json"])).actual.profile,
		).toBe("business");
	});
});
