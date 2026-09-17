import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parseInstallationMetadata } from "../installation-metadata.js";
import { verifyManifestProjection } from "../installer-manifests.js";

it("measures ordinary artifact bytes into the exact native/JSON policy pair and rejects links", () => {
	const dir = mkdtempSync(`${realpathSync(tmpdir())}/xhs-offline-inventory-`);
	try {
		const tree = join(dir, "tree"),
			out = join(dir, "manifest");
		mkdirSync(tree);
		writeFileSync(join(tree, "entry with space"), "measured");
		const script = fileURLToPath(
			new URL("../../../../../scripts/xhs/measure-runtime.ts", import.meta.url),
		);
		const run = (output: string) =>
			spawnSync(
				process.execPath,
				["--import", "tsx", script, "--tree", tree, "--output-dir", output],
				{ encoding: "utf8", timeout: 10000 },
			);
		const child = run(out);
		expect(child.status, child.stderr).toBe(0);
		const json = readFileSync(join(out, "runtime.manifest.json"), "utf8"),
			native = readFileSync(join(out, "runtime.manifest"), "utf8"),
			policy = readFileSync(join(out, "installer-bootstrap.policy"), "utf8");
		expect(JSON.parse(json).entries).toEqual([
			{
				path: "entry with space",
				kind: "file",
				mode: 0o644,
				size: 8,
				sha256: createHash("sha256").update("measured").digest("hex"),
			},
		]);
		expect(verifyManifestProjection(policy, json, native).jsonSha256).toBe(
			createHash("sha256").update(json).digest("hex"),
		);
		expect(run(out).status).toBe(1);
		expect(run(join(tree, "..nested-output")).status).toBe(1);
		writeFileSync(join(tree, "xhs-installer-bootstrap"), "bootstrap", {
			mode: 0o755,
		});
		const withBootstrap = join(dir, "with-bootstrap");
		expect(run(withBootstrap).status).toBe(0);
		expect(
			parseInstallationMetadata(
				readFileSync(join(withBootstrap, "installation.metadata"), "utf8"),
			),
		).toEqual({
			bootstrapSha256: createHash("sha256").update("bootstrap").digest("hex"),
			manifestSha256: createHash("sha256")
				.update(readFileSync(join(withBootstrap, "runtime.manifest")))
				.digest("hex"),
		});
		symlinkSync("entry with space", join(tree, "alias"));
		const bad = run(join(dir, "bad"));
		expect(bad.status).toBe(1);
		expect(bad.stderr).toBe("offline_inventory_unavailable\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
