import { cpSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
export function copyRetentionModules() {
	const repo = fileURLToPath(new URL("../../../", import.meta.url));
	const root = mkdtempSync(join(tmpdir(), "fly2413-modules-"));
	mkdirSync(join(root, "scripts"));
	cpSync(join(repo, "scripts/lib"), join(root, "scripts/lib"), {
		recursive: true,
	});
	symlinkSync(join(repo, "packages"), join(root, "packages"));
	return root;
}
