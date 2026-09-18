import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	canonicalSubmissionDigest,
	type PersonaPin,
	type PersonaProjection,
} from "flywheel-config";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersonaActivationView } from "../persona-activation-client.js";
import {
	fetchExactPersonaBlob,
	type PersonaProjectSelector,
	projectPersona,
} from "../persona-projector.js";

const digest = (value: string | Buffer) =>
	createHash("sha256").update(value).digest("hex");
const approval = {
	channelId: "12345678901234567",
	messageId: "22345678901234567",
	contentSha256: "c".repeat(64),
};

describe("persona projector", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	function temp(prefix: string) {
		const path = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
		dirs.push(path);
		return path;
	}

	function git(cwd: string, args: string[]): string {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "Fixture",
				GIT_AUTHOR_EMAIL: "fixture@example.test",
				GIT_COMMITTER_NAME: "Fixture",
				GIT_COMMITTER_EMAIL: "fixture@example.test",
			},
		}).trim();
	}

	function initRepo(root: string) {
		git(root, ["init"]);
		git(root, ["config", "user.name", "Fixture"]);
		git(root, ["config", "user.email", "fixture@example.test"]);
	}

	function contract(pin: PersonaPin, lkg: PersonaPin = pin): PersonaProjection {
		return {
			schemaVersion: 1,
			enabled: true,
			leadId: "raya",
			repo: "xrliAnnie/raya",
			path: ".lead/raya/identity.md",
			pin,
			lastKnownGood: lkg,
		};
	}

	function selector(
		root: string,
		projection: PersonaProjection,
	): PersonaProjectSelector {
		return {
			projectsDigest: "d".repeat(64),
			projectName: "raya",
			leadId: "raya",
			projectRoot: root,
			projectRepo: "xrliAnnie/raya",
			personaProjection: projection,
			personaProjectionContractDigest: canonicalSubmissionDigest(projection),
		};
	}

	function postM0(
		projection: PersonaProjection,
		fallback: PersonaActivationView extends infer _T
			? (PersonaPin & { migrationCompatible: true }) | null
			: never = null,
	): PersonaActivationView {
		return {
			kind: "post-m0",
			windowId: "window-1",
			contractDigest: canonicalSubmissionDigest(projection),
			expected: projection.pin,
			fallback,
			dbIdentity: "e".repeat(64),
			migrationReceiptDigest: "f".repeat(64),
			revision: "7",
		};
	}

	it("fetches the authorized exact commit even when main points at different bytes", async () => {
		const source = temp("fly2696-source-");
		initRepo(source);
		mkdirSync(join(source, ".lead", "raya"), { recursive: true });
		const authorized = Buffer.from("authorized persona\n");
		writeFileSync(join(source, ".lead", "raya", "identity.md"), authorized);
		git(source, ["add", ".lead/raya/identity.md"]);
		git(source, ["commit", "-m", "authorized"]);
		const authorizedCommit = git(source, ["rev-parse", "HEAD"]);
		writeFileSync(join(source, ".lead", "raya", "identity.md"), "main moved\n");
		git(source, ["commit", "-am", "main moved"]);
		expect(git(source, ["rev-parse", "HEAD"])).not.toBe(authorizedCommit);

		const remote = temp("fly2696-remote-");
		rmSync(remote, { recursive: true, force: true });
		execFileSync("git", ["clone", "--bare", source, remote]);
		dirs.push(remote);
		const pin: PersonaPin = {
			commit: authorizedCommit,
			personaBlobDigest: digest(authorized),
			approval,
		};
		const workspace = temp("fly2696-workspace-");
		initRepo(workspace);
		const stateRoot = join(temp("fly2696-state-"), "persona");
		mkdirSync(stateRoot, { recursive: true });
		const projection = contract(pin);
		const result = await projectPersona(selector(workspace, projection), {
			stateRoot,
			readActivation: async () => postM0(projection),
			fetchBlob: (candidate) =>
				fetchExactPersonaBlob(candidate, {
					repoUrl: remote,
					allowTestRepository: true,
					tempRoot: temp("fly2696-fetch-"),
				}),
		});
		expect(result.status, JSON.stringify(result)).toBe("projected");
		expect(result).toMatchObject({
			status: "projected",
			commit: authorizedCommit,
			personaBlobDigest: digest(authorized),
		});
		expect(
			readFileSync(join(workspace, ".lead", "raya", "identity.md")),
		).toEqual(authorized);
		expect(
			readFileSync(join(workspace, ".lead", "raya", "identity.md"), "utf8"),
		).not.toContain("main moved");
	});

	it("fails open before M0 only to the verified on-disk A0", async () => {
		const workspace = temp("fly2696-pre-");
		initRepo(workspace);
		mkdirSync(join(workspace, ".lead", "raya"), { recursive: true });
		const a0 = Buffer.from("verified A0\n");
		writeFileSync(join(workspace, ".lead", "raya", "identity.md"), a0, {
			mode: 0o600,
		});
		chmodSync(join(workspace, ".lead", "raya", "identity.md"), 0o600);
		const pin: PersonaPin = {
			commit: "a".repeat(40),
			personaBlobDigest: digest(a0),
			approval,
		};
		const projection = contract(pin);
		const stateRoot = join(temp("fly2696-pre-state-"), "persona");
		mkdirSync(stateRoot);
		const fetchBlob = vi.fn(async () => {
			throw new Error("network_down");
		});
		const result = await projectPersona(selector(workspace, projection), {
			stateRoot,
			preferLocalTarget: false,
			fetchBlob,
			readActivation: async () => ({
				kind: "pre-m0",
				contractDigest: canonicalSubmissionDigest(projection),
				a0Digest: digest(a0),
				revision: "2",
			}),
		});
		expect(fetchBlob, JSON.stringify(result)).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({
			status: "fallback",
			source: "pre-m0-lkg",
			changed: false,
		});
		expect(
			readFileSync(join(workspace, ".lead", "raya", "identity.md")),
		).toEqual(a0);
	});

	it("accepts the production-shaped non-Git workspace without fetching matching A0", async () => {
		const workspace = temp("fly2696-non-git-");
		const identityDir = join(workspace, ".lead", "raya");
		mkdirSync(identityDir, { recursive: true });
		const a0 = Buffer.from("production-shaped A0\n");
		const identityPath = join(identityDir, "identity.md");
		writeFileSync(identityPath, a0, { mode: 0o600 });
		chmodSync(identityPath, 0o600);
		const pin: PersonaPin = {
			commit: "a".repeat(40),
			personaBlobDigest: digest(a0),
			approval,
		};
		const projection = contract(pin);
		const stateRoot = join(temp("fly2696-non-git-state-"), "persona");
		mkdirSync(stateRoot);
		const fetchBlob = vi.fn();
		const result = await projectPersona(selector(workspace, projection), {
			stateRoot,
			fetchBlob,
			readActivation: async () => ({
				kind: "pre-m0",
				contractDigest: canonicalSubmissionDigest(projection),
				a0Digest: digest(a0),
				revision: "2",
			}),
		});
		expect(result).toMatchObject({
			status: "projected",
			source: "target",
			changed: false,
		});
		expect(fetchBlob).not.toHaveBeenCalled();
		expect(readFileSync(identityPath)).toEqual(a0);
	});

	it("still refuses a tracked target and a corrupt Git worktree", async () => {
		const bytes = Buffer.from("tracked persona\n");
		const pin: PersonaPin = {
			commit: "a".repeat(40),
			personaBlobDigest: digest(bytes),
			approval,
		};
		const projection = contract(pin);
		const activation = async (): Promise<PersonaActivationView> => ({
			kind: "pre-m0",
			contractDigest: canonicalSubmissionDigest(projection),
			a0Digest: digest(bytes),
			revision: "2",
		});

		const tracked = temp("fly2696-tracked-");
		initRepo(tracked);
		mkdirSync(join(tracked, ".lead", "raya"), { recursive: true });
		writeFileSync(join(tracked, ".lead", "raya", "identity.md"), bytes, {
			mode: 0o600,
		});
		git(tracked, ["add", ".lead/raya/identity.md"]);
		git(tracked, ["commit", "-m", "tracked persona"]);
		const trackedStateRoot = join(temp("fly2696-tracked-state-"), "persona");
		mkdirSync(trackedStateRoot);
		await expect(
			projectPersona(selector(tracked, projection), {
				stateRoot: trackedStateRoot,
				readActivation: activation,
			}),
		).resolves.toEqual({ status: "refused", reason: "persona_target_tracked" });

		const corrupt = temp("fly2696-corrupt-git-");
		writeFileSync(join(corrupt, ".git"), "not a valid gitfile\n");
		const corruptStateRoot = join(temp("fly2696-corrupt-state-"), "persona");
		mkdirSync(corruptStateRoot);
		await expect(
			projectPersona(selector(corrupt, projection), {
				stateRoot: corruptStateRoot,
				readActivation: activation,
			}),
		).resolves.toEqual({
			status: "refused",
			reason: "persona_git_status_unavailable",
		});
		expect(() => statSync(join(corrupt, ".lead"))).toThrow();
	});

	it("after M0 refuses A0 and permits only the frozen compatible digest", async () => {
		for (const mode of ["missing", "wrong", "valid"] as const) {
			const workspace = temp(`fly2696-post-${mode}-`);
			initRepo(workspace);
			const stateRoot = join(temp(`fly2696-state-${mode}-`), "persona");
			mkdirSync(join(stateRoot, "blobs"), { recursive: true });
			const target: PersonaPin = {
				commit: "a".repeat(40),
				personaBlobDigest: digest("target\n"),
				approval,
			};
			const a0: PersonaPin = {
				commit: "b".repeat(40),
				personaBlobDigest: digest("old A0\n"),
				approval,
			};
			const fallback = {
				commit: "f".repeat(40),
				personaBlobDigest: digest("compatible\n"),
				approval,
				migrationCompatible: true as const,
			};
			const projection = contract(target, a0);
			if (mode !== "missing") {
				writeFileSync(
					join(stateRoot, "blobs", `${fallback.personaBlobDigest}.md`),
					mode === "valid" ? "compatible\n" : "wrong\n",
					{ mode: 0o600 },
				);
			}
			const result = await projectPersona(selector(workspace, projection), {
				stateRoot,
				fetchBlob: async () => {
					throw new Error("network_down");
				},
				readActivation: async () =>
					postM0(projection, mode === "missing" ? null : fallback),
			});
			if (mode === "valid") {
				expect(result.status, JSON.stringify(result)).toBe("fallback");
				expect(result).toMatchObject({
					status: "fallback",
					source: "post-m0-fallback",
				});
				expect(
					readFileSync(join(workspace, ".lead", "raya", "identity.md"), "utf8"),
				).toBe("compatible\n");
			} else {
				expect(result.status).toBe("refused");
				expect(() =>
					statSync(join(workspace, ".lead", "raya", "identity.md")),
				).toThrow();
			}
		}
	});

	it("after M0 never treats the verified on-disk A0 as a fallback", async () => {
		const workspace = temp("fly2696-post-a0-only-");
		initRepo(workspace);
		const identityDir = join(workspace, ".lead", "raya");
		mkdirSync(identityDir, { recursive: true });
		const a0 = Buffer.from("old verified A0\n");
		const identityPath = join(identityDir, "identity.md");
		writeFileSync(identityPath, a0, { mode: 0o600 });
		chmodSync(identityPath, 0o600);
		const target: PersonaPin = {
			commit: "a".repeat(40),
			personaBlobDigest: digest("post-M0 target\n"),
			approval,
		};
		const lastKnownGood: PersonaPin = {
			commit: "b".repeat(40),
			personaBlobDigest: digest(a0),
			approval,
		};
		const projection = contract(target, lastKnownGood);
		const stateRoot = join(temp("fly2696-post-a0-state-"), "persona");
		mkdirSync(stateRoot);
		const result = await projectPersona(selector(workspace, projection), {
			stateRoot,
			preferLocalTarget: false,
			fetchBlob: async () => {
				throw new Error("network_down");
			},
			readActivation: async () => postM0(projection, null),
		});
		expect(result).toEqual({ status: "refused", reason: "network_down" });
		expect(readFileSync(identityPath)).toEqual(a0);
	});

	it("performs zero projector writes for all 16 non-Raya Leads and dormant Raya", async () => {
		const inventory = JSON.parse(
			readFileSync(
				resolve(
					process.cwd(),
					"../../engineering/doc/FLY-2696-persona-projection/fleet-inventory.json",
				),
				"utf8",
			),
		) as {
			rows: Array<{
				project: string;
				lead: string;
				projectRepo: string;
				tracked: boolean;
			}>;
		};
		const nonRaya = inventory.rows.filter(
			(row) => !(row.project === "raya" && row.lead === "raya"),
		);
		expect(nonRaya).toHaveLength(16);
		expect(nonRaya.filter((row) => row.tracked)).toHaveLength(13);
		for (const [index, row] of nonRaya.entries()) {
			const workspace = temp(`fly2696-negative-${index}-`);
			initRepo(workspace);
			const identityDir = join(workspace, ".lead", row.lead);
			mkdirSync(identityDir, { recursive: true });
			const identityPath = join(identityDir, "identity.md");
			const bytes = Buffer.from(`unique-${index}-${row.project}/${row.lead}\n`);
			writeFileSync(identityPath, bytes, { mode: 0o640 });
			if (row.tracked) {
				git(workspace, ["add", `.lead/${row.lead}/identity.md`]);
				git(workspace, ["commit", "-m", `fixture ${index}`]);
			}
			const before = {
				bytes: readFileSync(identityPath),
				mode: statSync(identityPath).mode,
				mtime: statSync(identityPath).mtimeMs,
				status: git(workspace, ["status", "--porcelain"]),
			};
			const fetchBlob = vi.fn();
			const withLock = vi.fn();
			const readActivation = vi.fn();
			const result = await projectPersona(
				{
					projectsDigest: "a".repeat(64),
					projectName: row.project,
					leadId: row.lead,
					projectRoot: workspace,
					projectRepo: row.projectRepo,
				},
				{
					stateRoot: join(workspace, "must-not-exist"),
					fetchBlob,
					withLock: withLock as never,
					readActivation,
				},
			);
			expect(result).toEqual({ status: "skipped", reason: "not_raya" });
			expect(fetchBlob).not.toHaveBeenCalled();
			expect(withLock).not.toHaveBeenCalled();
			expect(readActivation).not.toHaveBeenCalled();
			expect(readFileSync(identityPath)).toEqual(before.bytes);
			expect(statSync(identityPath).mode).toBe(before.mode);
			expect(statSync(identityPath).mtimeMs).toBe(before.mtime);
			expect(git(workspace, ["status", "--porcelain"])).toBe(before.status);
			expect(() => statSync(join(workspace, "must-not-exist"))).toThrow();
		}

		const dormant = await projectPersona(
			{
				projectsDigest: "a".repeat(64),
				projectName: "raya",
				leadId: "raya",
				projectRoot: "/path/must/not/be/read",
				projectRepo: "xrliAnnie/raya",
			},
			{
				stateRoot: "/path/must/not/be/read",
				readActivation: vi.fn(),
			},
		);
		expect(dormant).toEqual({ status: "skipped", reason: "not_enrolled" });
	}, 20_000);
});
