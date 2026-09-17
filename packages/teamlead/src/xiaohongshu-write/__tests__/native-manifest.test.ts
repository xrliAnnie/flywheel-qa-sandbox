import { expect, it } from "vitest";
import { projectNativeManifest } from "../native-manifest.js";

const raw = (path = "Frameworks/Google Chrome Framework.framework/helper") =>
	JSON.stringify({
		schemaVersion: 1,
		root: "/Library/Application Support/Flywheel/Xhs/runtime",
		entries: [
			{ path: "Frameworks", kind: "directory", mode: 0o755 },
			{
				path: "Frameworks/Google Chrome Framework.framework",
				kind: "directory",
				mode: 0o755,
			},
			{ path, kind: "file", mode: 0o555, size: 5, sha256: "a".repeat(64) },
			{
				path: "entry.js",
				kind: "file",
				mode: 0o644,
				size: 1,
				sha256: "b".repeat(64),
			},
		],
	});
it("projects the full fixed tree into sorted bounded ASCII file rows without renaming Chrome paths", () => {
	expect(projectNativeManifest(raw())).toBe(
		`${"a".repeat(64)} 0555 0:0 Frameworks/Google Chrome Framework.framework/helper\n${"b".repeat(64)} 0644 0:0 entry.js\n`,
	);
});
it.each([
	" leading",
	"trailing ",
	"double  space",
	"tab\tname",
	"new\nline",
	"非ASCII",
	"../entry",
	"/entry",
	"Frameworks/../entry",
	"Frameworks//helper",
])("rejects unsafe path %j", (path) => {
	expect(() => projectNativeManifest(raw(path))).toThrow(
		"native_manifest_unavailable",
	);
});
it("rejects a spacing-only substitution that leaves directory inventory mismatched", () => {
	expect(() =>
		projectNativeManifest(
			raw("Frameworks/GoogleChrome Framework.framework/helper"),
		),
	).toThrow("native_manifest_unavailable");
});
it("refuses another root and unrepresentable empty directories", () => {
	const m = JSON.parse(raw());
	m.root = "/Library/Application Support/Flywheel/Xhs/other";
	expect(() => projectNativeManifest(JSON.stringify(m))).toThrow(
		"native_manifest_unavailable",
	);
	m.root = "/Library/Application Support/Flywheel/Xhs/runtime";
	m.entries.push({ path: "empty", kind: "directory", mode: 0o755 });
	expect(() => projectNativeManifest(JSON.stringify(m))).toThrow(
		"native_manifest_unavailable",
	);
});

it("the compiled native parser accepts the projection and rejects malformed/ambiguous bytes", async () => {
	const { execFileSync, spawnSync } = await import("node:child_process");
	const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
	const { join } = await import("node:path");
	const { fileURLToPath } = await import("node:url");
	const dir = mkdtempSync("/tmp/xhs-manifest-parser-");
	try {
		const header = fileURLToPath(
			new URL(
				"../../../../../scripts/xhs/xhs-native-manifest.h",
				import.meta.url,
			),
		);
		const source = join(dir, "test.c"),
			executable = join(dir, "test"),
			data = join(dir, "manifest");
		writeFileSync(
			source,
			`#include ${JSON.stringify(header)}\nint main(int argc,char **argv) { if(argc!=2)return 2; FILE *f=fopen(argv[1],"rb"); if(!f)return 2; char *raw=malloc(XHS_MANIFEST_BYTES+1); if(!raw)return 2; size_t n=fread(raw,1,XHS_MANIFEST_BYTES+1,f); fclose(f); xhs_manifest m={0}; int bad=xhs_parse_manifest(raw,n,&m); free(raw); free(m.entries); return bad?1:0; }\n`,
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
		const valid = projectNativeManifest(raw());
		const run = (value: string) => {
			writeFileSync(data, value);
			return spawnSync(executable, [data], { timeout: 2000 }).status;
		};
		expect(run(valid)).toBe(0);
		for (const invalid of [
			"",
			valid + valid,
			valid.slice(0, -1),
			valid.replace("0:0", "501:0"),
			valid.replace("0555", "0777"),
			valid.replace("0:0 Frameworks", "0:0  Frameworks"),
			valid.replace("/helper\n", "/helper \n"),
			valid.replace("Google Chrome", "Google  Chrome"),
			valid.replace("Frameworks/Google", "../Google"),
			valid.replace("Frameworks/Google", "/Google"),
			valid.replace("/helper", "/hel\0per"),
			"a".repeat(4 * 1024 * 1024 + 1),
		])
			expect(run(invalid)).toBe(1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
