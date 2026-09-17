import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	fingerprintApprovedContent,
	proveApprovedContentContinuity,
} from "../land-content-proof.js";

const roots: string[] = [];

function git(root: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function write(root: string, path: string, value: string): void {
	writeFileSync(join(root, path), value);
}

function commitAll(root: string, message: string): string {
	git(root, "add", "-A");
	git(root, "commit", "-m", message);
	return git(root, "rev-parse", "HEAD");
}

function initFixture(): {
	root: string;
	repoRoot: string;
	mergeBase: string;
	approvedHead: string;
} {
	const root = mkdtempSync(join(tmpdir(), "fly2632-content-proof-"));
	roots.push(root);
	git(root, "init", "-b", "main");
	git(root, "config", "user.email", "flywheel-test@example.com");
	git(root, "config", "user.name", "Flywheel Test");
	write(
		root,
		"plugin.ts",
		[
			"export const header = 'base';",
			"export const shared = 'base';",
			"export const protectedFeature = 'base';",
			"export const footer = 'base';",
			"",
		].join("\n"),
	);
	write(root, "stable.txt", "stable\n");
	const mergeBase = commitAll(root, "root");
	git(root, "checkout", "-b", "feature");
	write(
		root,
		"plugin.ts",
		[
			"export const header = 'base';",
			"export const shared = 'feature';",
			"export const protectedFeature = 'approved';",
			"export const footer = 'base';",
			"",
		].join("\n"),
	);
	const approvedHead = commitAll(root, "approved feature");
	return { root, repoRoot: root, mergeBase, approvedHead };
}

function createConflictingBase(sample: ReturnType<typeof initFixture>): string {
	git(sample.root, "checkout", "main");
	write(
		sample.root,
		"plugin.ts",
		[
			"export const header = 'base';",
			"export const shared = 'main';",
			"export const protectedFeature = 'base';",
			"export const footer = 'base';",
			"",
		].join("\n"),
	);
	write(sample.root, "stable.txt", "stable\nmain context\n");
	return commitAll(sample.root, "move main");
}

function createResolvedCandidate(input: {
	sample: ReturnType<typeof initFixture>;
	baseOid: string;
	protectedValue?: string;
	addSmuggledFile?: boolean;
}): string {
	const { sample } = input;
	git(sample.root, "checkout", "feature");
	try {
		git(sample.root, "merge", "--no-ff", "--no-edit", input.baseOid);
	} catch {
		// Expected: the fixture intentionally conflicts in `shared`.
	}
	write(
		sample.root,
		"plugin.ts",
		[
			"export const header = 'base';",
			"export const shared = 'resolved';",
			`export const protectedFeature = '${input.protectedValue ?? "approved"}';`,
			"export const footer = 'base';",
			"",
		].join("\n"),
	);
	if (input.addSmuggledFile)
		write(sample.root, "smuggled.txt", "not approved\n");
	return commitAll(sample.root, "resolve conflict");
}

function initMultiConflictFixture(): {
	root: string;
	repoRoot: string;
	mergeBase: string;
	approvedHead: string;
	baseOid: string;
	candidateHead: string;
} {
	const root = mkdtempSync(join(tmpdir(), "fly2632-multi-conflict-proof-"));
	roots.push(root);
	git(root, "init", "-b", "main");
	git(root, "config", "user.email", "flywheel-test@example.com");
	git(root, "config", "user.name", "Flywheel Test");
	const render = (first: string, protectedValue: string, second: string) =>
		[
			"export const header = 'base';",
			`export const firstWiring = '${first}';`,
			"export const spacerA = 'base';",
			"export const spacerB = 'base';",
			"export const spacerC = 'base';",
			`export const protectedFeature = '${protectedValue}';`,
			"export const spacerD = 'base';",
			"export const spacerE = 'base';",
			"export const spacerF = 'base';",
			`export const secondWiring = '${second}';`,
			"export const footer = 'base';",
			"",
		].join("\n");
	write(root, "plugin.ts", render("base", "base", "base"));
	const mergeBase = commitAll(root, "root");

	git(root, "checkout", "-b", "feature");
	write(root, "plugin.ts", render("feature", "approved", "feature"));
	const approvedHead = commitAll(root, "approved feature");

	git(root, "checkout", "main");
	write(root, "plugin.ts", render("main", "base", "main"));
	const baseOid = commitAll(root, "advance main in two regions");

	git(root, "checkout", "feature");
	try {
		git(root, "merge", "--no-ff", "--no-edit", baseOid);
	} catch {
		// Expected: both wiring regions conflict independently.
	}
	write(
		root,
		"plugin.ts",
		render("resolved-first", "approved", "resolved-second"),
	);
	const candidateHead = commitAll(root, "resolve both conflicts");
	return {
		root,
		repoRoot: root,
		mergeBase,
		approvedHead,
		baseOid,
		candidateHead,
	};
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("content-bound land proof", { timeout: 60_000 }, () => {
	it("fingerprints exact hunk bytes while ignoring line-number movement", async () => {
		const sample = initFixture();
		const original = await fingerprintApprovedContent(sample);
		expect(original.files).toHaveLength(1);
		expect(original.files[0]?.path).toBe("plugin.ts");

		git(sample.root, "checkout", "main");
		const base = readFileSync(join(sample.root, "plugin.ts"), "utf8");
		write(sample.root, "plugin.ts", `// shifted context\n${base}`);
		const shiftedBase = commitAll(sample.root, "shift context");
		git(sample.root, "checkout", "-b", "shifted-feature", shiftedBase);
		write(
			sample.root,
			"plugin.ts",
			`// shifted context\n${base.replace("shared = 'base'", "shared = 'feature'").replace("protectedFeature = 'base'", "protectedFeature = 'approved'")}`,
		);
		const shiftedHead = commitAll(sample.root, "same patch at new lines");
		const shifted = await fingerprintApprovedContent({
			repoRoot: sample.root,
			mergeBase: shiftedBase,
			approvedHead: shiftedHead,
		});
		expect(shifted.files.map((file) => file.hunkDigests)).toEqual(
			original.files.map((file) => file.hunkDigests),
		);

		git(sample.root, "checkout", "-b", "whitespace-feature", shiftedBase);
		write(
			sample.root,
			"plugin.ts",
			`// shifted context\n${base.replace("shared = 'base'", "shared  = 'feature'").replace("protectedFeature = 'base'", "protectedFeature = 'approved'")}`,
		);
		const whitespaceHead = commitAll(sample.root, "different bytes");
		const whitespace = await fingerprintApprovedContent({
			repoRoot: sample.root,
			mergeBase: shiftedBase,
			approvedHead: whitespaceHead,
		});
		expect(whitespace.rootDigest).not.toBe(shifted.rootDigest);
	});

	it("allows only the machine-frozen conflict slot and reports production QA impact", async () => {
		const sample = initFixture();
		const fingerprint = await fingerprintApprovedContent(sample);
		const baseOid = createConflictingBase(sample);
		const candidateHead = createResolvedCandidate({ sample, baseOid });

		await expect(
			proveApprovedContentContinuity({
				repoRoot: sample.root,
				fingerprint,
				approvedHead: sample.approvedHead,
				mergeBase: sample.mergeBase,
				priorHead: sample.approvedHead,
				baseOid,
				candidateHead,
			}),
		).resolves.toMatchObject({
			ok: true,
			proofKind: "content_bound_merge_v2",
			conflictFiles: ["plugin.ts"],
			requiresFreshQa: true,
		});
	});

	it("proves continuity when one approved file has multiple conflict slots", async () => {
		const sample = initMultiConflictFixture();
		const fingerprint = await fingerprintApprovedContent(sample);

		await expect(
			proveApprovedContentContinuity({
				repoRoot: sample.root,
				fingerprint,
				approvedHead: sample.approvedHead,
				mergeBase: sample.mergeBase,
				priorHead: sample.approvedHead,
				baseOid: sample.baseOid,
				candidateHead: sample.candidateHead,
			}),
		).resolves.toMatchObject({
			ok: true,
			proofKind: "content_bound_merge_v2",
			conflictFiles: ["plugin.ts"],
			requiresFreshQa: true,
		});
	});

	it("rejects a conflict resolution that changes a protected non-conflict hunk", async () => {
		const sample = initFixture();
		const fingerprint = await fingerprintApprovedContent(sample);
		const baseOid = createConflictingBase(sample);
		const candidateHead = createResolvedCandidate({
			sample,
			baseOid,
			protectedValue: "smuggled",
		});

		await expect(
			proveApprovedContentContinuity({
				repoRoot: sample.root,
				fingerprint,
				approvedHead: sample.approvedHead,
				mergeBase: sample.mergeBase,
				priorHead: sample.approvedHead,
				baseOid,
				candidateHead,
			}),
		).resolves.toEqual({ ok: false, reason: "protected_content_changed" });
	});

	it("rejects file-set expansion outside the approved patch", async () => {
		const sample = initFixture();
		const fingerprint = await fingerprintApprovedContent(sample);
		const baseOid = createConflictingBase(sample);
		const candidateHead = createResolvedCandidate({
			sample,
			baseOid,
			addSmuggledFile: true,
		});

		await expect(
			proveApprovedContentContinuity({
				repoRoot: sample.root,
				fingerprint,
				approvedHead: sample.approvedHead,
				mergeBase: sample.mergeBase,
				priorHead: sample.approvedHead,
				baseOid,
				candidateHead,
			}),
		).resolves.toEqual({ ok: false, reason: "approved_file_set_changed" });
	});

	it("preserves approved text additions and deletions across an unrelated base merge", async () => {
		const sample = initFixture();
		git(sample.root, "checkout", "main");
		git(sample.root, "checkout", "-b", "file-shapes");
		write(sample.root, "added.txt", "approved addition\n");
		git(sample.root, "rm", "stable.txt");
		const approvedHead = commitAll(sample.root, "approved add and delete");
		const fingerprint = await fingerprintApprovedContent({
			repoRoot: sample.root,
			mergeBase: sample.mergeBase,
			approvedHead,
		});
		expect(fingerprint.files.map((file) => file.status)).toEqual(["A", "D"]);

		git(sample.root, "checkout", "main");
		write(sample.root, "main-only.txt", "main advanced\n");
		const baseOid = commitAll(sample.root, "advance main elsewhere");
		git(sample.root, "checkout", "file-shapes");
		git(sample.root, "merge", "--no-ff", "--no-edit", baseOid);
		const candidateHead = git(sample.root, "rev-parse", "HEAD");

		await expect(
			proveApprovedContentContinuity({
				repoRoot: sample.root,
				fingerprint,
				approvedHead,
				mergeBase: sample.mergeBase,
				priorHead: approvedHead,
				baseOid,
				candidateHead,
			}),
		).resolves.toMatchObject({
			ok: true,
			conflictFiles: [],
			requiresFreshQa: false,
		});
	});

	it("fails closed when the frozen merge base is no longer the unique merge base", async () => {
		const sample = initFixture();
		const fingerprint = await fingerprintApprovedContent(sample);
		const baseOid = createConflictingBase(sample);
		const candidateHead = createResolvedCandidate({ sample, baseOid });

		await expect(
			proveApprovedContentContinuity({
				repoRoot: sample.root,
				fingerprint,
				approvedHead: sample.approvedHead,
				mergeBase: "f".repeat(40),
				priorHead: sample.approvedHead,
				baseOid,
				candidateHead,
			}),
		).resolves.toEqual({
			ok: false,
			reason: "content_proof_merge_base_changed",
		});
	});
});
