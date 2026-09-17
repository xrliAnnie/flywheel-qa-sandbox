import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
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
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("native fixed-tree verification rejects links, changed hashes and incomplete inventory", () => {
	const dir = mkdtempSync(`${realpathSync(tmpdir())}/xhs-native-tree-`),
		root = join(dir, "tree");
	try {
		const source = join(dir, "test.c"),
			executable = join(dir, "test"),
			manifest = join(dir, "manifest");
		const header = fileURLToPath(
			new URL("../../../../../scripts/xhs/xhs-native-tree.h", import.meta.url),
		);
		writeFileSync(
			source,
			`#include <sys/stat.h>\n#include <string.h>\n#define XHS_INSTALL_TREE ${JSON.stringify(root)}
static int fixture_lstat(const char *p,struct stat *s){int r=lstat(p,s);if(!r){s->st_uid=0;s->st_gid=0;if(strncmp(p,XHS_INSTALL_TREE,strlen(XHS_INSTALL_TREE)))s->st_mode&=~07022;}return r;}
static int fixture_fstat(int fd,struct stat *s){int r=fstat(fd,s);if(!r){s->st_uid=0;s->st_gid=0;}return r;}
#define lstat fixture_lstat
#define fstat fixture_fstat
#include ${JSON.stringify(header)}
int main(int argc,char **argv){if(argc!=2)return 2;FILE *f=fopen(argv[1],"rb");if(!f)return 2;char *raw=malloc(XHS_MANIFEST_BYTES+1);if(!raw)return 2;size_t n=fread(raw,1,XHS_MANIFEST_BYTES+1,f);fclose(f);xhs_manifest m={0};int bad=xhs_parse_manifest(raw,n,&m);if(!bad)bad=xhs_verify_native_tree(&m);free(raw);free(m.entries);return bad?1:0;}
`,
		);
		execFileSync("cc", [
			"-Wall",
			"-Wextra",
			"-Werror",
			"-O2",
			source,
			"-o",
			executable,
		]);
		const hash = (s: string) => createHash("sha256").update(s).digest("hex");
		writeFileSync(
			manifest,
			`${hash("data")} 0644 0:0 Framework/Chrome Helper\n${hash("")} 0644 0:0 empty\n`,
		);
		const reset = () => {
			rmSync(root, { recursive: true, force: true });
			mkdirSync(join(root, "Framework"), { recursive: true, mode: 0o755 });
			chmodSync(root, 0o755);
			writeFileSync(join(root, "Framework/Chrome Helper"), "data", {
				mode: 0o644,
			});
			writeFileSync(join(root, "empty"), "", { mode: 0o644 });
		};
		const run = () =>
			spawnSync(executable, [manifest], { timeout: 3000 }).status;
		reset();
		if (process.platform !== "darwin") {
			// The native verifier deliberately refuses unsupported platforms.
			// Ubuntu CI proves that refusal; macOS exercises the positive matrix.
			expect(run()).toBe(1);
			return;
		}
		expect(run()).toBe(0);
		for (const mode of [
			"symlink",
			"hash",
			"extra",
			"missing",
			"extra-directory",
			"writable",
			"spacing",
		]) {
			reset();
			if (mode === "symlink") {
				unlinkSync(join(root, "empty"));
				symlinkSync("Framework/Chrome Helper", join(root, "empty"));
			}
			if (mode === "hash")
				writeFileSync(join(root, "Framework/Chrome Helper"), "evil");
			if (mode === "extra") writeFileSync(join(root, "extra"), "x");
			if (mode === "missing") unlinkSync(join(root, "empty"));
			if (mode === "extra-directory") mkdirSync(join(root, "extra"));
			if (mode === "writable") chmodSync(join(root, "Framework"), 0o777);
			if (mode === "spacing") {
				unlinkSync(join(root, "Framework/Chrome Helper"));
				writeFileSync(join(root, "Framework/ChromeHelper"), "data");
			}
			expect(run(), mode).toBe(1);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
