import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createGitFeaturePushHandler } from "../handlers/git.js";

it("authorizes only the current canonical feature branch and head without invoking git", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "git-policy-")));
	const gitDir = join(root, ".git");
	mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
	const head = "a".repeat(40);
	writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/feature\n");
	writeFileSync(join(gitDir, "refs", "heads", "feature"), `${head}\n`);
	const policy = {
		projectName: "project",
		leadId: "lead",
		revision: "1",
		owner: "acme",
		repo: "project",
		branch: "feature",
		defaultBranch: "main",
		gitDir,
		commonGitDir: gitDir,
		gitPath: "/usr/bin/git",
		stagingRoot: join(root, "stage"),
	};
	const context = {
		requestId: "11111111-1111-4111-8111-111111111111",
		projectName: "project",
		leadId: "lead",
		activationId: "a",
		signal: new AbortController().signal,
		assertCurrent: async () => {},
	};
	let revoke = false;
	const handler = createGitFeaturePushHandler({
		policy: () => policy,
		token: () => "secret",
		authorizeTarget: async () => {
			if (revoke) policy.revision = "2";
		},
		assertTargetCurrent: () => {},
	});
	try {
		await expect(
			handler.authorize({ branch: "feature", expectedHead: head }, context),
		).resolves.toBeUndefined();
		await expect(
			handler.authorize({ branch: "main", expectedHead: head }, context),
		).rejects.toThrow("git_scope_denied");
		writeFileSync(join(gitDir, "refs", "heads", "feature"), "b".repeat(40));
		await expect(
			handler.authorize({ branch: "feature", expectedHead: head }, context),
		).rejects.toThrow("git_scope_denied");
		await expect(
			handler.authorize(
				{ branch: "feature", expectedHead: head },
				{ ...context, leadId: "foreign" },
			),
		).rejects.toThrow("git_scope_denied");
		writeFileSync(join(gitDir, "refs", "heads", "feature"), head);
		revoke = true;
		await expect(
			handler.authorize({ branch: "feature", expectedHead: head }, context),
		).rejects.toThrow("git_scope_denied");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it.each(["HEAD", "refs/heads/feature", "packed-refs"])(
	"rejects a real FIFO %s with the stable scope error (not an elapsed-time timeout)",
	async (target) => {
		const { execFileSync } = await import("node:child_process");
		const root = realpathSync(mkdtempSync(join(tmpdir(), "git-fifo-"))),
			gitDir = join(root, ".git");
		mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
		if (target !== "HEAD")
			writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/feature\n");
		execFileSync("/usr/bin/mkfifo", [join(gitDir, target)]);
		const policy = {
			projectName: "project",
			leadId: "lead",
			revision: "1",
			owner: "acme",
			repo: "project",
			branch: "feature",
			defaultBranch: "main",
			gitDir,
			commonGitDir: gitDir,
			gitPath: "/usr/bin/git",
			stagingRoot: join(root, "stage"),
		};
		const moduleUrl = new URL("../handlers/git.ts", import.meta.url).href;
		const script = `import {createGitFeaturePushHandler} from ${JSON.stringify(moduleUrl)};const h=createGitFeaturePushHandler({policy:()=>(${JSON.stringify(policy)}),token:()=>'',authorizeTarget:async()=>{},assertTargetCurrent:()=>{}});try{await h.authorize({branch:'feature',expectedHead:'a'.repeat(40)},{requestId:'11111111-1111-4111-8111-111111111111',projectName:'project',leadId:'lead',activationId:'a',signal:new AbortController().signal,assertCurrent:async()=>{}});process.exitCode=2;}catch(e){console.log(e.message);}`;
		try {
			expect(
				execFileSync(
					process.execPath,
					["--import", "tsx", "--input-type=module", "-e", script],
					{ encoding: "utf8", timeout: 5000 },
				),
			).toBe("git_scope_denied\n");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
	10000,
);
