import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	buildStandingAuthorityPackageManifest,
	resolveStandingAuthorityPackageEntry,
	verifyStandingAuthorityPackage,
} from "./standing-authority-package.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "fly2654-package-")));
	dirs.push(root);
	mkdirSync(join(root, "scripts", "lib"), { recursive: true });
	writeFileSync(join(root, "a-entry"), "lowercase\n");
	writeFileSync(join(root, "Z-entry"), "uppercase\n");
	writeFileSync(join(root, "scripts", "update-flywheel.sh"), "#!/bin/bash\n");
	writeFileSync(join(root, "scripts", "lib", "guard.sh"), "guard=1\n");
	const manifest = buildStandingAuthorityPackageManifest({
		root,
		sourceCommit: "a".repeat(40),
	});
	writeFileSync(
		join(root, "standing-authority-package.json"),
		`${JSON.stringify(manifest)}\n`,
	);
	return { root, manifest };
}

it("verifies every byte in a content-addressed immutable package", () => {
	const { root, manifest } = fixture();
	expect(verifyStandingAuthorityPackage(root, manifest)).toMatchObject({
		packageDigest: manifest.packageDigest,
		fileCount: 4,
	});
	expect(
		resolveStandingAuthorityPackageEntry(
			root,
			manifest,
			"scripts/update-flywheel.sh",
		),
	).toBe(join(root, "scripts", "update-flywheel.sh"));
});

it("rejects changed, undeclared, and traversing runtime loads", () => {
	const { root, manifest } = fixture();
	writeFileSync(join(root, "scripts", "update-flywheel.sh"), "changed\n");
	expect(() => verifyStandingAuthorityPackage(root, manifest)).toThrow(
		"standing-authority-package-file-mismatch",
	);
	writeFileSync(join(root, "scripts", "update-flywheel.sh"), "#!/bin/bash\n");
	writeFileSync(join(root, "scripts", "undeclared.sh"), "outside inventory\n");
	expect(() => verifyStandingAuthorityPackage(root, manifest)).toThrow(
		"standing-authority-package-inventory-mismatch",
	);
	expect(() =>
		resolveStandingAuthorityPackageEntry(root, manifest, "../mutable.sh"),
	).toThrow("standing-authority-package-entry-invalid");
	expect(() =>
		resolveStandingAuthorityPackageEntry(
			root,
			manifest,
			"scripts/undeclared.sh",
		),
	).toThrow("standing-authority-package-entry-undeclared");
});

it("inventories internal dependency links but rejects them as runtime entries", () => {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "fly2654-package-link-")),
	);
	dirs.push(root);
	mkdirSync(join(root, "store", "dependency"), { recursive: true });
	mkdirSync(join(root, "node_modules"), { recursive: true });
	writeFileSync(join(root, "store", "dependency", "index.js"), "export {}\n");
	symlinkSync("../store/dependency", join(root, "node_modules", "dependency"));
	const manifest = buildStandingAuthorityPackageManifest({
		root,
		sourceCommit: "b".repeat(40),
	});
	expect(verifyStandingAuthorityPackage(root, manifest).fileCount).toBe(2);
	expect(
		manifest.files.find((file) => file.path === "node_modules/dependency"),
	).toMatchObject({ kind: "symlink" });
	expect(() =>
		resolveStandingAuthorityPackageEntry(
			root,
			manifest,
			"node_modules/dependency",
		),
	).toThrow("standing-authority-package-entry-invalid");
	unlinkSync(join(root, "node_modules", "dependency"));
	symlinkSync("../outside", join(root, "node_modules", "dependency"));
	expect(() => verifyStandingAuthorityPackage(root, manifest)).toThrow();
});
