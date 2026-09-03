import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverArtifacts } from "../proofshot/artifact-discovery.js";

describe("discoverArtifacts", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "artifact-discovery-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("recursively discovers regular artifacts in deterministic path order", () => {
		const nested = join(root, "steps", "nested");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(root, "SUMMARY.md"), "summary");
		writeFileSync(join(nested, "step-ui.png"), "png");
		writeFileSync(join(root, "session.webm"), "video");

		const files = discoverArtifacts(root);

		expect(files.map((file) => file.path)).toEqual([
			join(root, "SUMMARY.md"),
			join(root, "session.webm"),
			join(nested, "step-ui.png"),
		]);
		expect(files.map((file) => file.kind)).toEqual(["summary", "webm", "png"]);
	});

	it("keeps symlinks to files but never traverses symlink directories", () => {
		const external = mkdtempSync(join(tmpdir(), "artifact-external-"));
		try {
			const externalPng = join(external, "linked-file.png");
			writeFileSync(externalPng, "png");
			writeFileSync(join(external, "must-not-traverse.png"), "hidden");
			symlinkSync(externalPng, join(root, "file-link.png"));
			symlinkSync(external, join(root, "directory-link"));

			const files = discoverArtifacts(root);

			expect(files.map((file) => file.path)).toEqual([
				join(root, "file-link.png"),
			]);
		} finally {
			rmSync(external, { recursive: true, force: true });
		}
	});
});
