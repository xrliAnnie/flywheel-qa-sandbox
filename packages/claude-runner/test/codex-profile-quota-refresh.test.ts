import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	identifyCodexAuth,
	loadCodexAccountPool,
} from "../bin/codex-account-core.mjs";
import {
	acquireCodexAccountLease,
	codexInstallAccountKey,
	markCodexCandidateProcess,
	persistCodexProfileQuotaRefresh,
	registerCodexCandidateWorkspace,
} from "../bin/codex-account-install.mjs";

const digest = (raw: string) => createHash("sha256").update(raw).digest("hex");
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

const roots: string[] = [];
afterEach(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture(slot = "shopping", local = slot) {
	const root = mkdtempSync(join(tmpdir(), "codex-quota-refresh-"));
	roots.push(root);
	const profilesRoot = join(root, "profiles");
	mkdirSync(join(profilesRoot, slot), { recursive: true });
	const profilePath = join(profilesRoot, slot, "auth.json");
	const before = auth(local, "old");
	writeFileSync(profilePath, before, { mode: 0o600 });
	const registry = loadCodexAccountPool({ profilesRoot });
	const workspaceAuthPath = join(root, "candidate-auth.json");
	const after = auth(local, "rotated");
	writeFileSync(workspaceAuthPath, after, { mode: 0o600 });
	const accountKey = codexInstallAccountKey(
		identifyCodexAuth(before, registry),
	);
	const lease = acquireCodexAccountLease(profilesRoot, accountKey);
	registerCodexCandidateWorkspace(lease, {
		authPath: workspaceAuthPath,
		originalAuthDigest: digest(before),
	});
	markCodexCandidateProcess(lease, { state: "stopped" });
	return {
		root,
		profilesRoot,
		slot,
		profilePath,
		workspaceAuthPath,
		accountKey,
		registry,
		lease,
		before,
		after,
	};
}

it("persists a rotated refresh token back into a dynamically discovered profile slot", () => {
	const f = fixture();
	const result = persistCodexProfileQuotaRefresh({
		profilesRoot: f.profilesRoot,
		profileDir: f.slot,
		registry: f.registry,
		accountKey: f.accountKey,
		finalAuthPath: f.workspaceAuthPath,
		expectedProfileDigest: digest(f.before),
		accountLease: f.lease,
	});

	expect(result).toMatchObject({ status: "persisted", profilePersisted: true });
	expect(readFileSync(f.profilePath, "utf8")).toBe(f.after);
	expect(statSync(f.profilePath).mode & 0o777).toBe(0o600);
	expect(f.lease.orphanRecovery).toBeNull();
	f.lease.release();
});

it("persists a registered slot through the same identity-only guard", () => {
	const f = fixture("school", "school");
	expect(
		persistCodexProfileQuotaRefresh({
			profilesRoot: f.profilesRoot,
			profileDir: f.slot,
			registry: f.registry,
			accountKey: f.accountKey,
			finalAuthPath: f.workspaceAuthPath,
			expectedProfileDigest: digest(f.before),
			accountLease: f.lease,
		}),
	).toMatchObject({ status: "persisted", profilePersisted: true });
	f.lease.release();
});

it("refuses to write another account's bytes into the slot", () => {
	const f = fixture();
	writeFileSync(f.workspaceAuthPath, auth("someone-else", "rotated"));
	expect(
		persistCodexProfileQuotaRefresh({
			profilesRoot: f.profilesRoot,
			profileDir: f.slot,
			registry: f.registry,
			accountKey: f.accountKey,
			finalAuthPath: f.workspaceAuthPath,
			expectedProfileDigest: digest(f.before),
			accountLease: f.lease,
		}),
	).toMatchObject({ status: "identity_mismatch", profilePersisted: false });
	expect(readFileSync(f.profilePath, "utf8")).toBe(f.before);
	f.lease.release();
});

it("refuses when the slot changed under us", () => {
	const f = fixture();
	writeFileSync(f.profilePath, auth("shopping", "changed-by-someone-else"));
	expect(
		persistCodexProfileQuotaRefresh({
			profilesRoot: f.profilesRoot,
			profileDir: f.slot,
			registry: f.registry,
			accountKey: f.accountKey,
			finalAuthPath: f.workspaceAuthPath,
			expectedProfileDigest: digest(f.before),
			accountLease: f.lease,
		}),
	).toMatchObject({ status: "candidate_conflict", profilePersisted: false });
	expect(readFileSync(f.profilePath, "utf8")).toContain(
		"changed-by-someone-else",
	);
	f.lease.release();
});

it("refuses a slot path that escapes the profiles root", () => {
	const f = fixture();
	for (const profileDir of ["../escape", "..", ".", "a/b", ""]) {
		expect(
			persistCodexProfileQuotaRefresh({
				profilesRoot: f.profilesRoot,
				profileDir,
				registry: f.registry,
				accountKey: f.accountKey,
				finalAuthPath: f.workspaceAuthPath,
				expectedProfileDigest: digest(f.before),
				accountLease: f.lease,
			}).profilePersisted,
		).toBe(false);
	}
	expect(readFileSync(f.profilePath, "utf8")).toBe(f.before);
	f.lease.release();
});

it("refuses while the candidate process has not drained", () => {
	const f = fixture();
	markCodexCandidateProcess(f.lease, { state: "starting" });
	expect(
		persistCodexProfileQuotaRefresh({
			profilesRoot: f.profilesRoot,
			profileDir: f.slot,
			registry: f.registry,
			accountKey: f.accountKey,
			finalAuthPath: f.workspaceAuthPath,
			expectedProfileDigest: digest(f.before),
			accountLease: f.lease,
		}),
	).toMatchObject({ status: "process_not_drained", profilePersisted: false });
	f.lease.release();
});
