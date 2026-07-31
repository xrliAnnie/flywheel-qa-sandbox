import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRawManifest } from "flywheel-v2-dag";
import { afterEach, describe, expect, it } from "vitest";
import { createOperationalDagPorts } from "../dag-ports.js";

const FULL_SHA_HEADER =
	/^:\d{6} \d{6} [0-9a-f]{40,64} [0-9a-f]{40,64} [ADMRC]\d{0,3}$/;

let root: string | null = null;

function git(repo: string, args: string[]): string {
	return execFileSync("git", ["-C", repo, ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "fly1554",
			GIT_AUTHOR_EMAIL: "fly1554@test.invalid",
			GIT_COMMITTER_NAME: "fly1554",
			GIT_COMMITTER_EMAIL: "fly1554@test.invalid",
		},
	}).trim();
}

afterEach(() => {
	if (root !== null) rmSync(root, { recursive: true, force: true });
	root = null;
});

describe("FLY-1554 rawDiff produces full object names", () => {
	it("emits records the manifest parser accepts for A, M, D, and R", async () => {
		root = mkdtempSync(join(tmpdir(), "fly1554-rawdiff-"));
		const repo = join(root, "repo");
		mkdirSync(repo);
		git(repo, ["init", "--initial-branch", "main"]);
		git(repo, ["config", "diff.renames", "true"]);

		const renamedBody = `${"stable rename payload line\n".repeat(20)}`;
		writeFileSync(join(repo, "modified.txt"), "before\n");
		writeFileSync(join(repo, "deleted.txt"), "doomed\n");
		writeFileSync(join(repo, "old-name.txt"), renamedBody);
		git(repo, ["add", "--all"]);
		git(repo, ["commit", "-m", "base"]);
		const base = git(repo, ["rev-parse", "HEAD"]);

		writeFileSync(join(repo, "added.txt"), "fresh\n");
		writeFileSync(join(repo, "modified.txt"), "after\n");
		rmSync(join(repo, "deleted.txt"));
		git(repo, ["mv", "old-name.txt", "new-name.txt"]);
		git(repo, ["add", "--all"]);
		git(repo, ["commit", "-m", "head"]);
		const head = git(repo, ["rev-parse", "HEAD"]);

		const ports = createOperationalDagPorts({
			hostEpoch: "fly1554-test",
			lockRoot: join(root, "locks"),
		});
		const raw = await ports.git.rawDiff(repo, base, head);

		const headers = raw.split("\0").filter((token) => token.startsWith(":"));
		expect(headers).toHaveLength(4);
		for (const header of headers) {
			expect(header).toMatch(FULL_SHA_HEADER);
		}

		const entries = parseRawManifest(raw);
		const byStatus = new Map(entries.map((entry) => [entry.status, entry]));
		expect(byStatus.get("A")?.path).toBe("added.txt");
		expect(byStatus.get("M")?.path).toBe("modified.txt");
		expect(byStatus.get("D")?.path).toBe("deleted.txt");
		expect(byStatus.get("R")).toMatchObject({
			oldPath: "old-name.txt",
			path: "new-name.txt",
		});
	});
});
