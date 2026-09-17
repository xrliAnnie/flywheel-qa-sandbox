import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { renderFixtureRunnerPolicy } from "../fixture-runner-policy.js";

it("compiles the fixed principal runner and refuses actual unprivileged execution", () => {
	const dir = mkdtempSync("/tmp/xhs-root-worker-");
	try {
		const executable = join(dir, "runner");
		execFileSync("cc", [
			"-Wall",
			"-Wextra",
			"-Werror",
			"-O2",
			fileURLToPath(
				new URL(
					"../../../../../scripts/xhs/xhs-fixture-principal.c",
					import.meta.url,
				),
			),
			"-o",
			executable,
		]);
		for (const args of [
			[],
			[
				"service",
				"450",
				"450",
				"/usr/bin/true",
				"/tmp/script",
				"/tmp/fixture",
				"authority-flow",
			],
		]) {
			const result = spawnSync(executable, args, {
				encoding: "utf8",
				timeout: 2000,
			});
			expect(result.status).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("xhs_fixture_principal_unavailable\n");
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("checks strict root-policy syntax, measured immutable bytes and inherited descriptor closure", () => {
	const dir = mkdtempSync("/tmp/xhs-principal-parser-");
	try {
		const source = fileURLToPath(
			new URL(
				"../../../../../scripts/xhs/xhs-fixture-principal.c",
				import.meta.url,
			),
		);
		const policy = renderFixtureRunnerPolicy({
			serviceUid: 450,
			serviceGid: 450,
			modelUid: 501,
			modelGid: 20,
			node: {
				path: "/Library/Application Support/Flywheel/Xhs/node",
				sha256: "a".repeat(64),
			},
			boundaryProbe: {
				path: "/Library/Application Support/Flywheel/Xhs/probe.js",
				sha256: "b".repeat(64),
			},
			nonce: "c".repeat(64),
		});
		const bad = [
			`${policy}extra=true\n`,
			policy.replace("service_uid=450", "service_uid=0"),
			policy.replace("model_uid=501", "model_uid=450"),
			policy.replace("service_gid=450", "service_gid=80"),
			policy.replace("/Xhs/node", "/Xhs/../node"),
			policy.replace(
				"/private/var/db/flywheel-xhs-qa/",
				"/var/db/flywheel-xhs/",
			),
			policy.replace(`node_sha256=${"a".repeat(64)}`, "node_sha256=oops"),
		];
		const harness = join(dir, "harness.c"),
			executable = join(dir, "harness");
		writeFileSync(
			harness,
			`#define main fixture_main
#include ${JSON.stringify(source)}
#undef main
#include <assert.h>
static int parse(const char *value) { FILE *f=tmpfile(); assert(f); fputs(value,f); rewind(f); runner_policy p; int result=parse_policy(f,&p); fclose(f); return result; }
int main(void) {
 assert(parse(${JSON.stringify(policy)})==0);
 ${bad.map((value) => `assert(parse(${JSON.stringify(value)})!=0);`).join("\n")}
 unsigned int id; assert(positive_id("450",&id)==0 && id==450);
 assert(positive_id("+450",&id)!=0); assert(positive_id("0450",&id)!=0); assert(positive_id("2147483648",&id)!=0);
 assert(allowed_probe("model","file-authority")==0); assert(allowed_probe("model","authority-flow")!=0);
 assert(allowed_probe("service","authority-flow")==0); assert(allowed_probe("service","file-authority")!=0);
#ifdef __APPLE__
 assert(measured_binary("/usr/bin/true",${JSON.stringify(createHash("sha256").update(readFileSync("/usr/bin/true")).digest("hex"))},1)==0);
 assert(measured_binary("/usr/bin/true",${JSON.stringify("0".repeat(64))},1)!=0);
#endif
 int fd=open("/dev/null",O_RDONLY); assert(fd>=3); assert(close_inherited()==0); errno=0; assert(fcntl(fd,F_GETFD)==-1 && errno==EBADF);
 return 0;
}
`,
		);
		execFileSync("cc", [
			"-Wall",
			"-Wextra",
			"-Werror",
			"-O2",
			harness,
			"-o",
			executable,
		]);
		expect(spawnSync(executable, [], { timeout: 3000 }).status).toBe(0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
