/**
 * FLY-2003: the Codex profile command is a manual, identity-verified selector.
 * The live auth.json JWT is authoritative; .active is only a diagnostic hint.
 */
import { execFileSync, spawnSync } from "node:child_process";
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
		accountId: "acct-zombie",
		plan: "pro",
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

	it("list exposes only the canonical three and reports untracked pool entries", () => {
		writeFileSync(join(homeA, "auth.json"), auth("personal"));
		runProfile(homeA, ["status", "--json"]);
		const result = JSON.parse(runProfile(homeA, ["list", "--json"]));

		expect(
			result.profiles.map((entry: { name: string }) => entry.name),
		).toEqual(["school", "personal", "business"]);
		expect(result.profiles).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "personal", status: "ready" }),
			]),
		);
		expect(result.untracked).toEqual(["personal1"]);
		expect(
			result.profiles.find(
				(entry: { name: string }) => entry.name === "personal",
			),
		).toMatchObject({
			status: "ready",
			lastObservation: { profile: "personal", lastSource: "status" },
		});
		expect(JSON.stringify(result)).not.toContain("secret-");
	});

	it("keeps all live profile health visible when one ledger snapshot is corrupt", () => {
		const corruptSnapshot = join(
			stateDir,
			"codex-account-ledger",
			"business.json",
		);
		mkdirSync(dirname(corruptSnapshot), { recursive: true });
		writeFileSync(corruptSnapshot, "{truncated");

		const result = failProfile(homeA, ["list", "--json"]);

		expect(result.status).toBe(0);
		const output = JSON.parse(result.stdout);
		expect(
			output.profiles.map((entry: { name: string }) => entry.name),
		).toEqual(["school", "personal", "business"]);
		expect(
			output.profiles.find(
				(entry: { name: string }) => entry.name === "business",
			),
		).toMatchObject({
			status: "ready",
			lastObservation: null,
			ledgerUnreadable: true,
		});
		expect(result.stderr).toContain("ledger snapshot unreadable for business");
		expect(result.stderr).toContain(corruptSnapshot);
	});

	it("refuses to install a mislabeled pool credential without changing either file", () => {
		const businessPath = join(pool, "business", "auth.json");
		writeFileSync(businessPath, auth("personal"));
		writeFileSync(join(homeA, "auth.json"), auth("business"));
		writeFileSync(join(homeA, ".active"), "business\n");
		const beforeAuth = readFileSync(join(homeA, "auth.json"));
		const beforeSidecar = readFileSync(join(homeA, ".active"));

		const result = failProfile(homeA, ["use", "business"]);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("expected business");
		expect(readFileSync(join(homeA, "auth.json"))).toEqual(beforeAuth);
		expect(readFileSync(join(homeA, ".active"))).toEqual(beforeSidecar);
	});

	it("manually installs a verified backup credential with mode 0600", () => {
		runProfile(homeA, ["use", "school"]);

		expect(readFileSync(join(homeA, "auth.json"), "utf8")).toBe(auth("school"));
		expect(readFileSync(join(homeA, ".active"), "utf8")).toBe("school\n");
		expect(statSync(join(homeA, "auth.json")).mode & 0o777).toBe(0o600);
		expect(readFileSync(join(homeA, "auth.json"), "utf8")).not.toContain(
			"secret-access-personal",
		);
		expect(
			JSON.parse(
				readFileSync(
					join(stateDir, "codex-account-ledger", "school.json"),
					"utf8",
				),
			),
		).toMatchObject({ profile: "school", lastSource: "use" });
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
		writeFileSync(join(homeA, "auth.json"), auth("business"));

		runProfile(homeA, ["save", "business"]);

		expect(
			JSON.parse(
				readFileSync(
					join(stateDir, "codex-account-ledger", "business.json"),
					"utf8",
				),
			),
		).toMatchObject({ profile: "business", lastSource: "save" });
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
