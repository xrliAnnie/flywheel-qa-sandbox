import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { LeadArtifactStore } from "../artifacts.js";
import { createLeadRuntimeDirectories } from "../runtime-directories.js";

it("creates real activation storage under the derived writable root and cleans only owned directories", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "runtime-dirs-")));
	let dirs: ReturnType<typeof createLeadRuntimeDirectories> | undefined;
	try {
		const production = join(root, "production");
		mkdirSync(production);
		writeFileSync(join(production, "keep"), "unchanged");
		dirs = createLeadRuntimeDirectories({
			projectRoot: production,
			deploymentRoot: production,
			assertCurrent: () => {},
		});
		expect(
			dirs.workspaceRoot.startsWith(`${join(production, "worktrees")}/`),
		).toBe(true);
		expect(dirs.activationRoot.startsWith(`${production}/`)).toBe(false);
		writeFileSync(join(dirs.modelTempRoot, "test"), "scratch");
		const store = new LeadArtifactStore({
			projectRoot: dirs.workspaceRoot,
			artifactRoot: dirs.artifactRoot,
			assertCurrent: dirs.assertCurrent,
		});
		const artifact = await store.put(Buffer.from("report"), "text/plain");
		expect((await store.read(artifact.handle)).data.toString()).toBe("report");
		store.close();
		dirs.close();
		dirs.close();
		expect(existsSync(dirs.workspaceRoot)).toBe(false);
		expect(existsSync(dirs.activationRoot)).toBe(false);
		expect(readFileSync(join(production, "keep"), "utf8")).toBe("unchanged");
	} finally {
		dirs?.close();
		rmSync(root, { recursive: true, force: true });
	}
});
it("rejects a worktrees symlink outside production before allocating activation storage", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "runtime-dirs-")));
	try {
		const production = join(root, "production"),
			outside = join(root, "outside");
		mkdirSync(production);
		mkdirSync(outside);
		symlinkSync(outside, join(production, "worktrees"));
		expect(() =>
			createLeadRuntimeDirectories({
				projectRoot: production,
				deploymentRoot: production,
				assertCurrent: () => {},
			}),
		).toThrow("runtime_directories_invalid");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("invalidates a replaced workspace and preserves its replacement while closing control resources", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "runtime-dirs-")));
	try {
		const production = join(root, "production");
		mkdirSync(production);
		const dirs = createLeadRuntimeDirectories({
			projectRoot: production,
			deploymentRoot: production,
			assertCurrent: () => {},
		});
		renameSync(dirs.workspaceRoot, join(root, "original"));
		mkdirSync(dirs.workspaceRoot);
		writeFileSync(join(dirs.workspaceRoot, "keep"), "replacement");
		expect(() => dirs.assertCurrent()).toThrow("runtime_directories_invalid");
		expect(() => dirs.close()).toThrow("runtime_directories_invalid");
		expect(readFileSync(join(dirs.workspaceRoot, "keep"), "utf8")).toBe(
			"replacement",
		);
		expect(existsSync(dirs.activationRoot)).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
