import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import {
	type GitPreparationCommand,
	prepareJudgmentGit,
} from "../prepare-git.js";

it("fetches only configured GitHub repositories and exact objects, keeps auth out of argv, and cleans private objects", async () => {
	const commands: GitPreparationCommand[] = [];
	const command = vi.fn(async (value: GitPreparationCommand) => {
		commands.push(value);
		return "";
	});
	const token = vi.fn(async () => "private-token");
	const request = {
		repoIdentity: "__main__",
		repoSlug: "owner/repo",
		prNumber: 4,
		headSha: "a".repeat(40),
		diffBaseSha: "b".repeat(40),
		mainSha: "c".repeat(40),
	};
	const prepared = await prepareJudgmentGit(
		request,
		{ repositories: ["owner/repo"], token, command },
		new AbortController().signal,
	);
	const fetch = commands.find((value) => value.args.includes("fetch"))!;
	expect(fetch.args).toContain("https://github.com/owner/repo.git");
	expect(fetch.args).toEqual(
		expect.arrayContaining([
			request.headSha,
			request.diffBaseSha,
			request.mainSha,
		]),
	);
	expect(fetch.args.join(" ")).not.toContain("private-token");
	expect(fetch.env.GIT_CONFIG_VALUE_0).toContain(
		Buffer.from("x-access-token:private-token").toString("base64"),
	);
	expect(fetch.args).toContain("http.followRedirects=false");
	expect(fetch.env).not.toHaveProperty("HOME");
	expect(prepared.material.repoSlug).toBe("owner/repo");
	await access(prepared.gitDir);
	await prepared.dispose();
	await prepared.dispose();
	await expect(access(prepared.gitDir)).rejects.toThrow();
	for (const repoSlug of [
		"attacker/repo",
		"../repo",
		"https://github.com/owner/repo",
		"owner/repo\n",
	]) {
		command.mockClear();
		token.mockClear();
		await expect(
			prepareJudgmentGit(
				{ ...request, repoSlug },
				{ repositories: ["owner/repo"], token, command },
				new AbortController().signal,
			),
		).rejects.toThrow();
		expect(command).not.toHaveBeenCalled();
		expect(token).not.toHaveBeenCalled();
	}
});

it("cleans objects after fetch failure and returns a fixed error without raw credentials", async () => {
	let gitDir = "";
	const command = async (value: GitPreparationCommand) => {
		const dirArg = value.args.find((arg) => arg.startsWith("--git-dir="));
		if (dirArg) gitDir = dirArg.slice("--git-dir=".length);
		if (value.args.includes("fetch")) throw new Error("raw credential secret");
		return "";
	};
	await expect(
		prepareJudgmentGit(
			{
				repoIdentity: "__main__",
				repoSlug: "owner/repo",
				prNumber: 4,
				headSha: "a".repeat(40),
				diffBaseSha: "b".repeat(40),
				mainSha: "c".repeat(40),
			},
			{ repositories: ["owner/repo"], token: async () => "secret", command },
			new AbortController().signal,
		),
	).rejects.toThrow(/^git_preparation_failed$/);
	expect(gitDir).not.toBe("");
	await expect(access(gitDir)).rejects.toThrow();
});

it("prepares a real bare store and reads the pinned commit without changing the source worktree", async () => {
	const root = await mkdtemp(join(tmpdir(), "judgment-prep-test-"));
	const exec = promisify(execFile);
	const git = async (...args: string[]) =>
		(
			await exec("git", args, {
				cwd: root,
				env: {
					...process.env,
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_CONFIG_NOSYSTEM: "1",
				},
			})
		).stdout.trim();
	let prepared: Awaited<ReturnType<typeof prepareJudgmentGit>> | undefined;
	try {
		await git("init", "-q", "-b", "main");
		await git("config", "user.name", "Fixture");
		await git("config", "user.email", "fixture@example.invalid");
		await writeFile(join(root, "plan.md"), "approved requirement");
		await git("add", "plan.md");
		await git("commit", "-qm", "base");
		const head = await git("rev-parse", "HEAD");
		await writeFile(join(root, "plan.md"), "uncommitted change");
		prepared = await prepareJudgmentGit(
			{
				repoIdentity: "__main__",
				repoSlug: "owner/repo",
				prNumber: 4,
				headSha: head,
				mainSha: head,
			},
			{
				repositories: ["owner/repo"],
				token: async () => "fixture",
				command: async (command) => {
					// Only the test transport substitutes the local fixture for the validated remote.
					const args = [
						"-c",
						"protocol.file.allow=always",
						...command.args.map((arg) =>
							arg === "https://github.com/owner/repo.git" ? root : arg,
						),
					];
					return (
						await exec("git", args, {
							env: command.env,
							signal: command.signal,
						})
					).stdout;
				},
			},
			new AbortController().signal,
		);
		expect(
			await prepared.material
				.reader(new AbortController().signal)
				.readText(head, "plan.md"),
		).toMatchObject({ text: "approved requirement" });
		expect(await git("status", "--porcelain")).toContain("plan.md");
		const controller = new AbortController();
		controller.abort();
		await expect(
			prepared.material.reader(controller.signal).readText(head, "plan.md"),
		).rejects.toThrow();
	} finally {
		await prepared?.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

it("cancels credential work and removes private objects when collection is aborted", async () => {
	const controller = new AbortController();
	let gitDir = "";
	let credentialSignal: AbortSignal | undefined;
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	const pending = prepareJudgmentGit(
		{
			repoIdentity: "__main__",
			repoSlug: "owner/repo",
			prNumber: 4,
			headSha: "a".repeat(40),
			mainSha: "b".repeat(40),
		},
		{
			repositories: ["owner/repo"],
			token: async (signal?: AbortSignal) => {
				credentialSignal = signal;
				started();
				return new Promise<string>(() => {});
			},
			command: async (command) => {
				gitDir = command.args
					.find((arg) => arg.startsWith("--git-dir="))!
					.slice(10);
				return "";
			},
		},
		controller.signal,
	);
	await ready;
	controller.abort();
	await expect(pending).rejects.toThrow(/^git_preparation_failed$/);
	expect(credentialSignal?.aborted).toBe(true);
	await expect(access(gitDir)).rejects.toThrow();
});
