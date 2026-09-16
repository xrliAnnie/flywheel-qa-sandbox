import { expect, it, vi } from "vitest";
import { createGitPushTransport } from "../git-push-transport.js";

const sha = "a".repeat(40),
	branch = "flywheel/eng/FLY-1";
const packet = (text: string) =>
	Buffer.from(
		(Buffer.byteLength(text) + 4).toString(16).padStart(4, "0") + text,
	);
const refs = () =>
	Buffer.concat([
		packet("# service=git-receive-pack\n"),
		Buffer.from("0000"),
		packet(`${sha} refs/heads/${branch}\0report-status\n`),
		Buffer.from("0000"),
	]);
it("relays only fixed discovery with credentials held by the parent", async () => {
	const upstream = vi.fn(
		async () =>
			new Response(refs(), {
				headers: {
					"content-type": "application/x-git-receive-pack-advertisement",
				},
			}),
	);
	const transport = await createGitPushTransport({
		owner: "acme",
		repo: "project",
		branch,
		expectedHead: sha,
		token: () => "PARENT_TOKEN_CANARY",
		signal: new AbortController().signal,
		assertCurrent: async () => {},
		assertCurrentSync: () => {},
		fetchImpl: upstream,
	});
	try {
		expect(transport.remoteUrl).toMatch(
			/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}\/repo.git$/,
		);
		const response = await fetch(
			`${transport.remoteUrl}/info/refs?service=git-receive-pack`,
		);
		expect(response.status).toBe(200);
		expect(Buffer.from(await response.arrayBuffer())).toEqual(refs());
		expect(upstream).toHaveBeenCalledWith(
			"https://github.com/acme/project.git/info/refs?service=git-receive-pack",
			expect.objectContaining({
				redirect: "error",
				headers: expect.objectContaining({
					authorization: expect.stringContaining("Basic "),
				}),
			}),
		);
		expect(transport.remoteUrl).not.toContain("CANARY");
	} finally {
		await transport.close();
	}
});

it("refuses foreign commands and never retries an uncertain receive-pack", async () => {
	const upstream = vi.fn(async () => {
		throw new Error("secret provider response");
	});
	const transport = await createGitPushTransport({
		owner: "acme",
		repo: "project",
		branch,
		expectedHead: sha,
		token: () => "secret",
		signal: new AbortController().signal,
		assertCurrent: async () => {},
		assertCurrentSync: () => {},
		fetchImpl: upstream,
	});
	const command = (target: string) =>
		Buffer.concat([
			packet(`${"0".repeat(40)} ${sha} refs/heads/${target}\0report-status\n`),
			Buffer.from("0000PACK"),
		]);
	try {
		expect(
			(
				await fetch(`${transport.remoteUrl}/git-receive-pack`, {
					method: "POST",
					body: command("main"),
				})
			).status,
		).toBe(502);
		expect(upstream).not.toHaveBeenCalled();
		const responses = await Promise.all(
			[1, 2].map(() =>
				fetch(`${transport.remoteUrl}/git-receive-pack`, {
					method: "POST",
					body: command(branch),
				}),
			),
		);
		expect(responses.map((r) => r.status)).toEqual([502, 502]);
		expect(upstream).toHaveBeenCalledTimes(1);
		expect(await responses[0].text()).toBe("git_push_transport_failed");
	} finally {
		await transport.close();
	}
});

it.each([false, true])(
	"Lead broker denies push; isolated lower-level smart HTTP transport (lost reply=%s)",
	async (lostReply) => {
		const { execFileSync } = await import("node:child_process");
		const {
			mkdtempSync,
			mkdirSync,
			writeFileSync,
			rmSync,
			realpathSync,
			existsSync,
		} = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { createGitFeaturePushHandler } = await import("../handlers/git.js");
		const { LeadCapabilityBroker } = await import("../broker.js");
		const { SqliteJournalStore } = await import(
			"../../lead-backends/codex/SqliteJournalStore.js"
		);
		const root = realpathSync(mkdtempSync(join(tmpdir(), "git-relay-")));
		const source = join(root, "source"),
			remote = join(root, "project.git");
		mkdirSync(source);
		const env = {
			PATH: "/usr/bin:/bin",
			HOME: root,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@example.test",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@example.test",
		};
		const git = (args: string[], cwd = source) =>
			execFileSync("/usr/bin/git", args, { cwd, env, encoding: "utf8" }).trim();
		let transport:
			| Awaited<ReturnType<typeof createGitPushTransport>>
			| undefined;
		try {
			git(["init", "-q"]);
			git(["checkout", "-qb", branch]);
			writeFileSync(join(source, "a"), "fixture");
			git(["add", "a"]);
			git(["commit", "-qm", "fixture"]);
			const head = git(["rev-parse", "HEAD"]);
			git(["init", "--bare", "-q", remote]);
			git(["config", "http.receivepack", "true"], remote);
			const marker = join(root, "hostile-ran");
			writeFileSync(
				join(source, ".git", "hooks", "pre-push"),
				`#!/bin/sh\ntouch '${marker}'`,
				{ mode: 0o755 },
			);
			git(["config", "core.fsmonitor", `touch ${marker}`]);
			let sends = 0;
			const backend: typeof fetch = async (_url, init) => {
				if (init?.method === "POST") sends++;
				const url = new URL(String(_url));
				expect(init?.headers).toHaveProperty("authorization");
				const bytes = execFileSync("/usr/bin/git", ["http-backend"], {
					cwd: root,
					env: {
						...env,
						GIT_PROJECT_ROOT: root,
						GIT_HTTP_EXPORT_ALL: "1",
						PATH_INFO: url.pathname.replace("/acme/", "/"),
						QUERY_STRING: url.search.slice(1),
						REQUEST_METHOD: init?.method ?? "GET",
						CONTENT_TYPE:
							init?.method === "POST"
								? "application/x-git-receive-pack-request"
								: "",
						REMOTE_USER: "fixture",
					},
					input: init?.body ? Buffer.from(init.body as Uint8Array) : undefined,
					maxBuffer: 2 * 1024 * 1024,
				});
				const end = bytes.indexOf("\r\n\r\n");
				const headers = new Headers();
				let status = 200;
				for (const line of bytes.subarray(0, end).toString().split("\r\n")) {
					const split = line.indexOf(":");
					if (split > 0) {
						if (line.slice(0, split) === "Status")
							status = Number(
								line
									.slice(split + 1)
									.trim()
									.slice(0, 3),
							);
						else
							headers.set(line.slice(0, split), line.slice(split + 1).trim());
					}
				}
				if (lostReply && init?.method === "POST")
					throw new Error("lost provider reply");
				return new Response(bytes.subarray(end + 4), { status, headers });
			};
			const store = new SqliteJournalStore(":memory:");
			const policy = {
				projectName: "project",
				leadId: "lead",
				revision: "1",
				owner: "acme",
				repo: "project",
				branch,
				defaultBranch: "main",
				gitDir: join(source, ".git"),
				commonGitDir: join(source, ".git"),
				gitPath: "/usr/bin/git",
				stagingRoot: join(root, "stage"),
			};
			const handler = createGitFeaturePushHandler({
				policy: () => policy,
				token: () => "TOKEN_NEVER_IN_CHILD",
				authorizeTarget: async () => {},
				assertTargetCurrent: () => {},
				fetchImpl: backend,
			});
			const brokerOptions = {
				projectName: "project",
				leadId: "lead",
				activationId: "a",
				receipts: store.operationReceipts,
				allowedOperationIds: () => new Set(["git.feature.push"]),
				assertCurrent: async () => {},
				handlers: new Map([["git.feature.push", handler]]),
				secrets: ["TOKEN_NEVER_IN_CHILD"],
			};
			const request = {
				schemaVersion: 1,
				requestId: "11111111-1111-4111-8111-111111111111",
				operationId: "git.feature.push",
				input: { branch, expectedHead: head },
			};
			try {
				// The later A/B/C ruling reserves push to Runner. The production
				// Lead broker must reject even with a handler registered.
				for (const input of [
					request,
					request,
					{ ...request, input: { branch, expectedHead: "f".repeat(40) } },
				]) {
					expect(
						await new LeadCapabilityBroker(brokerOptions).execute(input),
					).toMatchObject({
						status: "rejected",
						errorCode: "lead_runner_owned_operation",
					});
				}
				expect(sends).toBe(0);
				// Exercise retained transport mechanics directly against the private
				// bare repository; this is not Lead authorization or parity evidence.
				const context = {
					requestId: request.requestId,
					projectName: "project",
					leadId: "lead",
					activationId: "a",
					signal: new AbortController().signal,
					assertCurrent: async () => {},
				};
				await handler.authorize(request.input, context);
				const result = await handler.execute(request.input, context);
				expect(result.status).toBe(lostReply ? "unknown" : "succeeded");
				if (!lostReply) expect(result.data).toMatchObject({ head });
				expect(git(["rev-parse", `refs/heads/${branch}`], remote)).toBe(head);
				expect(existsSync(marker)).toBe(false);
				expect(sends).toBe(1);
			} finally {
				store.close();
			}
		} finally {
			await transport?.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
);

it("rechecks authority immediately before sending and blocks raw proxy routes", async () => {
	let allowed = true;
	const upstream = vi.fn(async () => new Response(refs()));
	const t = await createGitPushTransport({
		owner: "acme",
		repo: "project",
		branch,
		expectedHead: sha,
		token: () => "secret",
		signal: new AbortController().signal,
		assertCurrent: async () => {
			allowed = false;
		},
		assertCurrentSync: () => {
			if (!allowed) throw new Error("revoked");
		},
		fetchImpl: upstream,
	});
	try {
		for (const path of [
			"/../../other.git/info/refs?service=git-receive-pack",
			"/info/refs?service=git-upload-pack",
			"/info/refs?service=git-receive-pack",
		])
			expect((await fetch(t.remoteUrl + path)).status).toBe(502);
		expect(upstream).not.toHaveBeenCalled();
	} finally {
		await t.close();
	}
});

it.each([false, true])(
	"bounded 180-second lifetime (early cancellation=%s)",
	async (early) => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const cancel = new AbortController();
		const upstream = vi.fn(async () => new Response(refs()));
		const t = await createGitPushTransport({
			owner: "acme",
			repo: "project",
			branch,
			expectedHead: sha,
			token: () => "secret",
			signal: cancel.signal,
			assertCurrent: async () => {},
			assertCurrentSync: () => {},
			fetchImpl: upstream,
		});
		try {
			await vi.advanceTimersByTimeAsync(121000);
			expect(await t.readHead()).toBe(sha);
			if (early) cancel.abort();
			else await vi.advanceTimersByTimeAsync(59000);
			await expect(t.readHead()).rejects.toThrow("git_push_transport_denied");
			expect(upstream).toHaveBeenCalledTimes(1);
		} finally {
			await t.close();
			vi.useRealTimers();
		}
	},
);
