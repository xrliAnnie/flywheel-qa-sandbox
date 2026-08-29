/**
 * FLY-350 (Z) unit 4 — GitPushRunner. Pure-logic gates (branch derivation /
 * refname / owner-repo / token-non-persistence helpers) + REAL-git adversarial
 * integration (the RCE surface: a model worktree planting hostile repo-local
 * config/hooks must NEVER execute on the gateway push path) + GitHub-API
 * open_pr / token-probe with an injected fetch.
 *
 * The adversarial tests use the REAL git binary (mocks can't prove the `-c`
 * neutralization + clean-staging cwd actually defeat the vectors — Flywheel
 * "mock tests need a real-tool integration complement").
 */
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	assertPushableBranch,
	buildPushAuditRow,
	buildRemoteUrl,
	deriveBranchName,
	type GitExec,
	makeGitPushExec,
	materializeAndPush,
	openPullRequest,
	parseOwnerRepo,
	probeGitHubToken,
	readModelHeadSha,
	urlEmbedsPassword,
} from "../GitPushRunner.js";

const GIT = "/usr/bin/git";
const SHA40 = "a".repeat(40);

// ── pure: branch derivation + the merge red line (R4-4) ──────────────────────

describe("deriveBranchName / assertPushableBranch (R4-4 server-derived ref)", () => {
	it("derives a flywheel/<lead>/<issue>-<sha> branch under the trusted prefix", () => {
		const b = deriveBranchName({
			leadId: "mufasa-lead",
			issue: "FLY-350",
			headSha: "0123456789abcdef0123456789abcdef01234567",
		});
		expect(b).toBe("flywheel/mufasa-lead/FLY-350-0123456789ab");
		expect(() => assertPushableBranch(b)).not.toThrow();
	});

	it("rejects a non-40-hex head sha", () => {
		expect(() =>
			deriveBranchName({ leadId: "x", issue: "FLY-1", headSha: "deadbeef" }),
		).toThrow(/40-hex/);
	});

	it("REQUIRES an issue identifier (blank → throws; Codex LOW)", () => {
		expect(() =>
			deriveBranchName({
				leadId: "mufasa-lead",
				issue: "   ",
				headSha: "0123456789abcdef0123456789abcdef01234567",
			}),
		).toThrow(/issue identifier is required/i);
	});

	it("REFUSES protected/default branches (the merge red line)", () => {
		for (const p of ["main", "master", "refs/heads/main", "production"]) {
			expect(() => assertPushableBranch(p)).toThrow(/protected|flywheel/i);
		}
	});

	it("REFUSES a model-supplied raw ref (not the flywheel/ prefix)", () => {
		expect(() => assertPushableBranch("evil-branch")).toThrow(/flywheel/);
		expect(() => assertPushableBranch("flywheel/../main")).toThrow();
		expect(() => assertPushableBranch("flywheel/a//b")).toThrow();
		expect(() => assertPushableBranch("flywheel/x@{0}")).toThrow();
	});
});

describe("parseOwnerRepo (R3-4 scope to the project repo)", () => {
	it("parses owner/repo and strips a .git suffix", () => {
		expect(parseOwnerRepo("xrliAnnie/GeoForge3D")).toEqual({
			owner: "xrliAnnie",
			repo: "GeoForge3D",
		});
		expect(parseOwnerRepo("o/r.git")).toEqual({ owner: "o", repo: "r" });
	});
	it("fail-closed on a malformed slug", () => {
		for (const bad of ["", "noslash", "/r", "o/", "a/b/c", "../x"]) {
			expect(() => parseOwnerRepo(bad)).toThrow(/invalid project repo/i);
		}
	});
});

describe("token-non-persistence helpers (R4-1)", () => {
	it("buildRemoteUrl carries only the non-secret x-access-token username", () => {
		const url = buildRemoteUrl("o", "r");
		expect(url).toBe("https://x-access-token@github.com/o/r.git");
		expect(urlEmbedsPassword(url)).toBe(false); // username only, no password
	});
	it("urlEmbedsPassword detects an embedded password", () => {
		expect(
			urlEmbedsPassword("https://user:ghp_secret@github.com/o/r.git"),
		).toBe(true);
		expect(urlEmbedsPassword("https://github.com/o/r.git")).toBe(false);
	});
	it("buildPushAuditRow records both SHAs + actor but NEVER the token (R4-1/R4-3)", () => {
		const row = buildPushAuditRow({
			ts: 1,
			leadId: "mufasa-lead",
			projectName: "growth",
			repo: "o/r",
			branch: "flywheel/mufasa-lead/x",
			localSha: SHA40,
			pushedSha: SHA40,
			actor: "mufasa-bot",
			prNumber: 7,
			prUrl: "https://github.com/o/r/pull/7",
			outcome: "ok",
		});
		expect(row.localSha).toBe(SHA40);
		expect(row.pushedSha).toBe(SHA40);
		expect(JSON.stringify(row)).not.toMatch(/token|secret|password|ghp_/i);
	});
});

// ── REAL-git adversarial integration (R3-1 RCE hardening) ────────────────────

describe("materializeAndPush (R3-1 — real git, hostile model worktree)", () => {
	let base: string;
	let modelDir: string;
	let remoteDir: string;
	let stagingRoot: string;
	let markers: string;
	let headSha: string;

	/** A real git in the fixture (author identity set; global/system neutralized). */
	function fixtureGit(args: string[], cwd: string): string {
		return execFileSync(GIT, args, {
			cwd,
			encoding: "utf8",
			env: {
				PATH: "/usr/bin:/bin",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_SYSTEM: "/dev/null",
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t",
			},
		});
	}

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "fly350-gitpush-"));
		modelDir = join(base, "model");
		remoteDir = join(base, "remote.git");
		stagingRoot = join(base, "staging-root");
		markers = join(base, "markers");
		mkdirSync(markers, { recursive: true });

		// A model worktree with a COMMIT, then armed with hostile repo-local config.
		fixtureGit(["init", "-q", modelDir], base);
		writeFileSync(join(modelDir, "f.txt"), "hello\n");
		fixtureGit(["add", "f.txt"], modelDir);
		fixtureGit(["commit", "-qm", "model commit"], modelDir);
		headSha = fixtureGit(["rev-parse", "HEAD"], modelDir).trim();

		// hostile pre-push hook (would run if git ran in the model worktree)
		writeFileSync(
			join(modelDir, ".git", "hooks", "pre-push"),
			`#!/bin/sh\ntouch ${markers}/HOOK_RAN\n`,
		);
		execFileSync("chmod", ["+x", join(modelDir, ".git", "hooks", "pre-push")]);
		// hostile config-exec vectors
		fixtureGit(
			[
				"config",
				"uploadpack.packObjectsHook",
				`touch ${markers}/UPLOADPACK_RAN; git pack-objects`,
			],
			modelDir,
		);
		fixtureGit(
			["config", "core.fsmonitor", `touch ${markers}/FSMONITOR_RAN; false`],
			modelDir,
		);
		fixtureGit(
			["config", `url.https://evil.invalid/.insteadOf`, "https://github.com/"],
			modelDir,
		);
		// a .gitattributes filter driver (clean) that would run on checkout/status
		writeFileSync(join(modelDir, ".gitattributes"), "f.txt filter=evil\n");
		fixtureGit(
			["config", "filter.evil.clean", `touch ${markers}/FILTER_RAN; cat`],
			modelDir,
		);

		// a bare "remote" to receive the push
		fixtureGit(["init", "-q", "--bare", remoteDir], base);
	});

	afterEach(() => {
		rmSync(base, { recursive: true, force: true });
	});

	it("pushes the validated SHA from CLEAN staging and runs NO hostile config", () => {
		const branch = deriveBranchName({
			leadId: "mufasa-lead",
			issue: "FLY-350",
			headSha,
		});
		const res = materializeAndPush(
			{
				modelGitDir: join(modelDir, ".git"),
				headSha,
				remoteUrl: remoteDir, // a local bare repo stands in for the GitHub URL
				branch,
				token: "ghp_THE_SECRET_TOKEN",
			},
			{ gitPath: GIT, stagingRoot },
		);
		expect(res.ok).toBe(true);
		expect(res.pushedSha).toBe(headSha.toLowerCase());

		// the commit really landed on the derived branch
		const onRemote = execFileSync(
			GIT,
			["-C", remoteDir, "rev-parse", `refs/heads/${branch}`],
			{ encoding: "utf8", env: { PATH: "/usr/bin:/bin" } },
		).trim();
		expect(onRemote).toBe(headSha);

		// NONE of the hostile vectors executed (clean cwd + no transport)
		for (const m of [
			"HOOK_RAN",
			"UPLOADPACK_RAN",
			"FSMONITOR_RAN",
			"FILTER_RAN",
		]) {
			expect(existsSync(join(markers, m))).toBe(false);
		}
		// the ephemeral staging repo was cleaned up
		expect(res.error).toBeUndefined();
	});

	it("token NEVER appears in any git argv (R4-1) — only in the subprocess env", () => {
		const seenArgs: string[][] = [];
		const seenEnvHadToken: boolean[] = [];
		const real = makeGitPushExec(GIT);
		const spy: GitExec = (args, opts) => {
			seenArgs.push(args);
			seenEnvHadToken.push(
				Object.values(opts.env ?? {}).some((v) =>
					v.includes("ghp_THE_SECRET_TOKEN"),
				),
			);
			return real(args, opts);
		};
		const branch = deriveBranchName({
			leadId: "mufasa-lead",
			issue: "FLY-350",
			headSha,
		});
		const res = materializeAndPush(
			{
				modelGitDir: join(modelDir, ".git"),
				headSha,
				remoteUrl: remoteDir,
				branch,
				token: "ghp_THE_SECRET_TOKEN",
			},
			{ gitPath: GIT, stagingRoot, gitExec: spy },
		);
		expect(res.ok).toBe(true);
		// token in NO argv
		for (const args of seenArgs) {
			expect(args.join(" ")).not.toContain("ghp_THE_SECRET_TOKEN");
		}
		// token present only via the askpass env on the push/ls-remote calls
		expect(seenEnvHadToken.some((b) => b)).toBe(true);
		// never in the structured result
		expect(JSON.stringify(res)).not.toContain("ghp_THE_SECRET_TOKEN");
	});

	it("refuses to push a protected branch even if asked (merge red line)", () => {
		const res = materializeAndPush(
			{
				modelGitDir: join(modelDir, ".git"),
				headSha,
				remoteUrl: remoteDir,
				branch: "main",
				token: "t",
			},
			{ gitPath: GIT, stagingRoot },
		);
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/protected|flywheel/i);
	});

	it("readModelHeadSha returns the committed HEAD via a hardened rev-parse", () => {
		const sha = readModelHeadSha(modelDir, makeGitPushExec(GIT));
		expect(sha).toBe(headSha.toLowerCase());
		// rev-parse alone runs no hostile config
		for (const m of ["FSMONITOR_RAN", "FILTER_RAN"]) {
			expect(existsSync(join(markers, m))).toBe(false);
		}
	});
});

// ── GitHub API: open PR + token probe (injected fetch) ───────────────────────

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("openPullRequest (R3-4 explicit args / R3-5 idempotent)", () => {
	it("opens a PR via the API and returns number + url", async () => {
		const calls: Array<{ url: string; method?: string }> = [];
		const fetchImpl = (async (url: string, init?: RequestInit) => {
			calls.push({ url, method: init?.method });
			return jsonResponse(201, {
				number: 42,
				html_url: "https://github.com/o/r/pull/42",
			});
		}) as unknown as typeof fetch;
		const res = await openPullRequest({
			fetchImpl,
			apiBase: "https://api.test",
			owner: "o",
			repo: "r",
			token: "t",
			head: "flywheel/mufasa-lead/FLY-350-abc",
			base: "main",
			title: "FLY-350",
			body: "body",
		});
		expect(res).toEqual({
			ok: true,
			number: 42,
			url: "https://github.com/o/r/pull/42",
		});
		expect(calls[0]?.url).toBe("https://api.test/repos/o/r/pulls");
		expect(calls[0]?.method).toBe("POST");
	});

	it("reconciles a 422 already-exists to the existing open PR (idempotent)", async () => {
		const fetchImpl = (async (url: string) => {
			if (url.includes("pulls?head=")) {
				return jsonResponse(200, [
					{ number: 7, html_url: "https://github.com/o/r/pull/7" },
				]);
			}
			return jsonResponse(422, { message: "A pull request already exists" });
		}) as unknown as typeof fetch;
		const res = await openPullRequest({
			fetchImpl,
			owner: "o",
			repo: "r",
			token: "t",
			head: "flywheel/mufasa-lead/x",
			base: "main",
			title: "t",
			body: "b",
		});
		expect(res).toEqual({
			ok: true,
			number: 7,
			url: "https://github.com/o/r/pull/7",
		});
	});

	it("refuses a non-flywheel head branch (R4-4)", async () => {
		const fetchImpl = (async () =>
			jsonResponse(201, {})) as unknown as typeof fetch;
		const res = await openPullRequest({
			fetchImpl,
			owner: "o",
			repo: "r",
			token: "t",
			head: "main",
			base: "main",
			title: "t",
			body: "b",
		});
		expect(res.ok).toBe(false);
	});
});

describe("probeGitHubToken (R3-3 fail-closed)", () => {
	it("ok when the token has repo push access; records the actor", async () => {
		const fetchImpl = (async (url: string) => {
			if (url.endsWith("/user"))
				return jsonResponse(200, { login: "mufasa-bot" });
			return jsonResponse(200, { permissions: { push: true } });
		}) as unknown as typeof fetch;
		const res = await probeGitHubToken({
			fetchImpl,
			owner: "o",
			repo: "r",
			token: "t",
		});
		expect(res).toEqual({ ok: true, actor: "mufasa-bot" });
	});

	it("FAIL-CLOSED on a CLASSIC/broad token (X-OAuth-Scopes present) — require fine-grained", async () => {
		const fetchImpl = (async () =>
			new Response(JSON.stringify({ permissions: { push: true } }), {
				status: 200,
				headers: {
					"Content-Type": "application/json",
					// a classic PAT echoes its scopes here; fine-grained tokens do not.
					"X-OAuth-Scopes": "repo, workflow, admin:org",
				},
			})) as unknown as typeof fetch;
		const res = await probeGitHubToken({
			fetchImpl,
			owner: "o",
			repo: "r",
			token: "ghp_classic",
		});
		expect(res.ok).toBe(false);
		expect(res.reason).toMatch(/classic|fine-grained|X-OAuth-Scopes/i);
	});

	it("FAIL-CLOSED when the token lacks push access", async () => {
		const fetchImpl = (async () =>
			jsonResponse(200, {
				permissions: { push: false },
			})) as unknown as typeof fetch;
		const res = await probeGitHubToken({
			fetchImpl,
			owner: "o",
			repo: "r",
			token: "t",
		});
		expect(res.ok).toBe(false);
		expect(res.reason).toMatch(/push|contents:write/i);
	});

	it("FAIL-CLOSED when the repo probe errors (HTTP 401)", async () => {
		const fetchImpl = (async () =>
			jsonResponse(401, {
				message: "Bad credentials",
			})) as unknown as typeof fetch;
		const res = await probeGitHubToken({
			fetchImpl,
			owner: "o",
			repo: "r",
			token: "t",
		});
		expect(res.ok).toBe(false);
	});

	it("FAIL-CLOSED when fetch throws (network)", async () => {
		const fetchImpl = (async () => {
			throw new Error("ENOTFOUND");
		}) as unknown as typeof fetch;
		const res = await probeGitHubToken({
			fetchImpl,
			owner: "o",
			repo: "r",
			token: "t",
		});
		expect(res.ok).toBe(false);
	});
});
