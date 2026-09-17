import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { renderBootstrapPolicy } from "../installer-manifests.js";

it("compiles the root-only fixed bootstrap and refuses unprivileged or path-driven invocation", () => {
	const dir = mkdtempSync(`${realpathSync(tmpdir())}/xhs-bootstrap-`);
	try {
		const source = fileURLToPath(
			new URL(
				"../../../../../scripts/xhs/xhs-installer-bootstrap.c",
				import.meta.url,
			),
		);
		const binary = join(dir, "bootstrap");
		execFileSync("cc", [
			"-Wall",
			"-Wextra",
			"-Werror",
			"-O2",
			source,
			"-o",
			binary,
		]);
		for (const args of [[], ["/tmp/override"], ["--policy", "/tmp/policy"]]) {
			const result = spawnSync(binary, args, {
				encoding: "utf8",
				timeout: 2000,
				env: {
					...process.env,
					NODE_OPTIONS: "--require=/tmp/untrusted",
					XHS_POLICY: "/tmp/policy",
				},
			});
			expect(result.status).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("xhs_installer_bootstrap_unavailable\n");
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
it("native policy parser accepts only the fixed digest grammar", () => {
	const dir = mkdtempSync(`${realpathSync(tmpdir())}/xhs-bootstrap-parser-`);
	try {
		const source = fileURLToPath(
			new URL(
				"../../../../../scripts/xhs/xhs-installer-bootstrap.c",
				import.meta.url,
			),
		);
		const good = renderBootstrapPolicy(
			JSON.stringify({
				schemaVersion: 1,
				root: "/Library/Application Support/Flywheel/Xhs/runtime",
				entries: [
					{
						path: "entry.js",
						kind: "file",
						mode: 0o644,
						size: 1,
						sha256: "a".repeat(64),
					},
				],
			}),
		);
		const bad = [
			`${good}enabled=true\n`,
			good.slice(0, -1),
			good.replace("version=1", "version=2"),
			good.replace("manifest_sha256=", "path="),
			good.replace(
				/manifest_sha256=[a-f0-9]{64}/,
				`manifest_sha256=${"A".repeat(64)}`,
			),
			good.replace("\n", "\r\n"),
		];
		const harness = join(dir, "harness.c"),
			binary = join(dir, "test");
		writeFileSync(
			harness,
			`#define main installer_main\n#include ${JSON.stringify(source)}\n#undef main\n#include <assert.h>\nint main(void){bootstrap_policy p;assert(parse_bootstrap_policy(${JSON.stringify(good)},${Buffer.byteLength(good)},&p)==0);${bad.map((value) => `assert(parse_bootstrap_policy(${JSON.stringify(value)},${Buffer.byteLength(value)},&p)!=0);`).join("\n")}int fd=open("/dev/null",O_RDONLY);assert(fd>=3);assert(bootstrap_close_fds()==0);errno=0;assert(fcntl(fd,F_GETFD)==-1&&errno==EBADF);return 0;}\n`,
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
		expect(spawnSync(binary, [], { timeout: 2000 }).status).toBe(0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
