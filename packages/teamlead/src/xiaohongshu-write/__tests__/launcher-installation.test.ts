import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { renderInstallationMetadata } from "../installation-metadata.js";
import { renderBootstrapPolicy } from "../installer-manifests.js";
import { projectNativeManifest } from "../native-manifest.js";

it.skipIf(process.platform !== "darwin")(
	"production launcher refuses tampered tree/metadata before socket activation with the exact path",
	() => {
		const temp = mkdtempSync(`${realpathSync(tmpdir())}/xhs-launch-install-`),
			root = join(temp, "install"),
			tree = join(root, "runtime");
		try {
			mkdirSync(tree, { recursive: true, mode: 0o755 });
			const paths = [
				"installer-entry.js",
				"node",
				"packages/teamlead/dist/xiaohongshu-write/authority-main.js",
				"xhs-installer-bootstrap",
			];
			const entries: Array<Record<string, string | number>> = [],
				dirs = new Set<string>();
			for (const path of paths) {
				const mode = path.endsWith(".js") ? 0o644 : 0o755;
				mkdirSync(dirname(join(tree, path)), { recursive: true, mode: 0o755 });
				writeFileSync(join(tree, path), "fixture", { mode });
				chmodSync(join(tree, path), mode);
				entries.push({
					path,
					kind: "file",
					mode,
					size: 7,
					sha256: createHash("sha256").update("fixture").digest("hex"),
				});
				for (let p = dirname(path); p !== "."; p = dirname(p)) dirs.add(p);
			}
			for (const path of dirs)
				entries.push({ path, kind: "directory", mode: 0o755 });
			const json = JSON.stringify({
				schemaVersion: 1,
				root: "/Library/Application Support/Flywheel/Xhs/runtime",
				entries,
			});
			const policy = renderBootstrapPolicy(json);
			const metadata = renderInstallationMetadata(json);
			writeFileSync(join(root, "installation.metadata"), metadata);
			writeFileSync(join(root, "runtime.manifest.json"), json);
			writeFileSync(
				join(root, "runtime.manifest"),
				projectNativeManifest(json),
			);
			writeFileSync(join(root, "installer-bootstrap.policy"), policy);
			const source = fileURLToPath(
					new URL(
						"../../../../../scripts/xhs/xhs-authority-launcher.c",
						import.meta.url,
					),
				),
				harness = join(temp, "harness.c"),
				binary = join(temp, "launcher");
			writeFileSync(
				harness,
				`#include <sys/stat.h>\n#include <string.h>\n#define XHS_INSTALL_ROOT ${JSON.stringify(root)}\n#define XHS_INSTALL_TREE ${JSON.stringify(tree)}
int fixture_lstat(const char*p,struct stat*s){int r=lstat(p,s);if(!r){s->st_uid=0;s->st_gid=0;if(strncmp(p,XHS_INSTALL_ROOT,strlen(XHS_INSTALL_ROOT)))s->st_mode&=~07022;}return r;}
int fixture_fstat(int fd,struct stat*s){int r=fstat(fd,s);if(!r){s->st_uid=0;s->st_gid=0;}return r;}
#define lstat fixture_lstat
#define fstat fixture_fstat
#define launch_activate_socket fixture_activate
#include ${JSON.stringify(source)}
int fixture_activate(const char*n,int**fds,size_t*count){(void)n;(void)fds;(void)count;puts("socket-activation-reached");return -1;}
`,
			);
			execFileSync("cc", [
				"-Wall",
				"-Wextra",
				"-Werror",
				"-O2",
				harness,
				"-o",
				binary,
			]);
			const run = () =>
				spawnSync(
					binary,
					[
						join(tree, "node"),
						join(tree, paths[2]!),
						"--config",
						join(root, "authority.json"),
					],
					{ encoding: "utf8", timeout: 5000 },
				);
			expect(run().stdout).toBe("socket-activation-reached\n");
			writeFileSync(join(tree, "installer-entry.js"), "changed");
			const changed = run();
			expect(changed.status).toBe(1);
			expect(changed.stdout).toBe("");
			expect(changed.stderr).toContain(join(tree, "installer-entry.js"));
			writeFileSync(join(tree, "installer-entry.js"), "fixture");
			writeFileSync(
				join(root, "installer-bootstrap.policy"),
				`${policy}extra=true\n`,
			);
			const bad = run();
			expect(bad.status).toBe(1);
			expect(bad.stdout).toBe("");
			expect(bad.stderr).toContain(join(root, "installer-bootstrap.policy"));
			writeFileSync(join(root, "installer-bootstrap.policy"), policy);
			writeFileSync(
				join(root, "installation.metadata"),
				metadata.replace(
					/bootstrap_sha256=[a-f0-9]{64}/,
					`bootstrap_sha256=${"d".repeat(64)}`,
				),
			);
			const badMetadata = run();
			expect(badMetadata.stdout).toBe("");
			expect(badMetadata.stderr).toContain(join(root, "installation.metadata"));
			writeFileSync(join(root, "installation.metadata"), metadata);
			writeFileSync(join(tree, "bad\nfile"), "unexpected");
			const unsafe = run();
			expect(unsafe.stdout).toBe("");
			expect(unsafe.stderr).toContain(join(tree, "bad\\x0afile"));
			expect(unsafe.stderr.split("\n")).toHaveLength(2);
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	},
);
