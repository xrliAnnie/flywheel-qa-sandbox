import {
	chmodSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { writeReportHostingSecrets } from "../bridge/report-hosting-secrets.js";
import { SecretRedactor } from "../bridge/vercel-hosting-api.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function setup() {
	const reportsDir = mkdtempSync(join(tmpdir(), "report-secrets-"));
	dirs.push(reportsDir);
	return {
		reportsDir,
		projectName: "fw-reports-abc123",
		storeId: "abc",
		token: "vercel_blob_rw_abc_secret",
		redactor: new SecretRedactor(),
	};
}
it("writes one owner-only credential line and reuses a valid same-store handoff", () => {
	const options = setup();
	const path = writeReportHostingSecrets(options);
	expect(lstatSync(path).mode & 0o777).toBe(0o600);
	expect(readFileSync(path, "utf8")).toBe(
		"BLOB_READ_WRITE_TOKEN=vercel_blob_rw_abc_secret\n",
	);
	const before = lstatSync(path).mtimeMs;
	expect(writeReportHostingSecrets(options)).toBe(path);
	expect(lstatSync(path).mtimeMs).toBe(before);
});
it("rejects unsafe parents and existing targets without disclosing credentials", () => {
	for (const kind of [
		"parent",
		"mode",
		"symlink",
		"other-store",
		"extra-line",
		"owner",
	]) {
		const options = setup();
		const path = join(
			options.reportsDir,
			`retarget.${options.projectName}.secrets.env`,
		);
		if (kind === "parent") chmodSync(options.reportsDir, 0o777);
		else if (kind === "symlink") {
			const target = join(options.reportsDir, "target");
			writeFileSync(target, "untouched");
			symlinkSync(target, path);
		} else {
			writeFileSync(
				path,
				`BLOB_READ_WRITE_TOKEN=${kind === "other-store" ? "vercel_blob_rw_xyz_other" : options.token}\n${kind === "extra-line" ? "extra\n" : ""}`,
				{ mode: kind === "mode" ? 0o644 : 0o600 },
			);
		}
		const invocation = {
			...options,
			...(kind === "owner" ? { uid: (process.getuid?.() ?? 0) + 1 } : {}),
		};
		expect(() => writeReportHostingSecrets(invocation)).toThrow();
		try {
			writeReportHostingSecrets(invocation);
		} catch (error) {
			expect(String(error)).not.toContain(options.token);
			expect(String(error)).not.toContain("vercel_blob_rw_xyz_other");
		}
		if (kind === "symlink")
			expect(readFileSync(join(options.reportsDir, "target"), "utf8")).toBe(
				"untouched",
			);
	}
});

it("rejects special permission bits rather than treating them as mode 0600", () => {
	const options = setup();
	const path = writeReportHostingSecrets(options);
	const lstat = (name: string) => {
		const result = lstatSync(name);
		if (name === path) result.mode = (result.mode & ~0o7777) | 0o4600;
		return result;
	};
	expect(() => writeReportHostingSecrets({ ...options, lstat })).toThrow();
});

it("rejects an existing target owned by another uid while the parent ownership is valid", () => {
	const options = setup();
	const path = writeReportHostingSecrets(options);
	const lstat = (name: string) => {
		const result = lstatSync(name);
		if (name === path) result.uid += 1;
		return result;
	};
	expect(() => writeReportHostingSecrets({ ...options, lstat })).toThrow();
});

it("recovers after a process dies immediately before the atomic rename", async () => {
	const { spawnSync } = await import("node:child_process");
	const { fileURLToPath } = await import("node:url");
	const { readdirSync, existsSync } = await import("node:fs");
	const options = setup();
	const root = fileURLToPath(new URL("../../../../", import.meta.url));
	const script = join(options.reportsDir, "crash.mts");
	writeFileSync(
		script,
		`import {writeReportHostingSecrets} from ${JSON.stringify(root + "packages/teamlead/src/bridge/report-hosting-secrets.ts")};
import {SecretRedactor} from ${JSON.stringify(root + "packages/teamlead/src/bridge/vercel-hosting-api.ts")};
writeReportHostingSecrets({reportsDir:${JSON.stringify(options.reportsDir)},projectName:"fw-reports-abc123",storeId:"abc",token:"vercel_blob_rw_abc_secret",redactor:new SecretRedactor(),rename:()=>process.exit(23)});`,
	);
	const result = spawnSync(
		process.execPath,
		[root + "node_modules/tsx/dist/cli.mjs", script],
		{ env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 20_000 },
	);
	expect(result.status).toBe(23);
	expect(
		existsSync(
			join(options.reportsDir, "retarget.fw-reports-abc123.secrets.env"),
		),
	).toBe(false);
	const temporary = readdirSync(options.reportsDir).filter((name) =>
		name.startsWith(".retarget."),
	);
	expect(temporary).toHaveLength(1);
	expect(lstatSync(join(options.reportsDir, temporary[0]!)).mode & 0o777).toBe(
		0o600,
	);
	expect(writeReportHostingSecrets(options)).toContain(".secrets.env");
	expect(result.stdout + result.stderr).not.toContain(options.token);
});
