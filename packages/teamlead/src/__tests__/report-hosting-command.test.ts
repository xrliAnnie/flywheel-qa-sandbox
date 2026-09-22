import { expect, it } from "vitest";
import { parseReportHostingCommand } from "../bridge/report-hosting-command.js";

it("keeps the no-argument legacy mode and reads only explicitly named env credentials for new modes", () => {
	expect(parseReportHostingCommand([], {})).toEqual({ mode: "legacy" });
	expect(
		parseReportHostingCommand(
			[
				"--retarget",
				"--vercel-token-env",
				"NEXT",
				"--project-name",
				"fw-reports-abc123",
			],
			{ NEXT: " account ", VERCEL_TOKEN: "legacy" },
		),
	).toMatchObject({
		mode: "retarget",
		vercelToken: "account",
		vercelTokenEnv: "NEXT",
		projectName: "fw-reports-abc123",
	});
});
it("rejects conflicting modes, literal credentials, missing values and options outside their mode", () => {
	for (const args of [
		["--retarget", "--usage-check"],
		[
			"--retarget",
			"--vercel-token-env",
			"secret-value",
			"--project-name",
			"fw-reports-abc123",
		],
		["--retarget", "--vercel-token-env", "NEXT", "--project-name", "invalid"],
		["--deploy-gateway-only", "--vercel-token-env", "NEXT"],
		["--usage-check", "--vercel-token-env", "NEXT", "--store-name", "x"],
		[
			"--retarget",
			"--vercel-token-env",
			"NEXT",
			"--project-name",
			"fw-reports-abc123",
			"--abandon-store-intent",
		],
		["--usage-check", "--vercel-token-env", "NEXT", "--token", "a".repeat(32)],
	])
		expect(() =>
			parseReportHostingCommand(args, { NEXT: "account" }),
		).toThrow();
});
it("accepts bound gateway deployment and object-size inspection", () => {
	const env = { NEXT: "account", BLOB_NEXT: "vercel_blob_rw_abc_secret" };
	expect(
		parseReportHostingCommand(
			[
				"--deploy-gateway-only",
				"--vercel-token-env",
				"NEXT",
				"--blob-token-env",
				"BLOB_NEXT",
			],
			env,
		),
	).toMatchObject({ mode: "deploy-gateway-only", blobToken: env.BLOB_NEXT });
	expect(
		parseReportHostingCommand(
			[
				"--usage-check",
				"--vercel-token-env",
				"NEXT",
				"--blob-token-env",
				"BLOB_NEXT",
				"--token",
				"a".repeat(32),
			],
			env,
		),
	).toMatchObject({ mode: "usage-check", token: "a".repeat(32) });
});

it("rejects conflicting modes at the actual CLI entrypoint before any credential or network work", async () => {
	const { spawnSync } = await import("node:child_process");
	const { fileURLToPath } = await import("node:url");
	const root = fileURLToPath(new URL("../../../../", import.meta.url));
	const result = spawnSync(
		process.execPath,
		[
			root + "node_modules/tsx/dist/cli.mjs",
			root + "scripts/migrate-report-hosting.ts",
			"--retarget",
			"--usage-check",
		],
		{ env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 20_000 },
	);
	expect(result.status).toBe(2);
	expect(result.stderr).toContain("exactly one");
});

it("dispatches all successful modes with named credentials and leaves the operator env file untouched", async () => {
	const { vi } = await import("vitest");
	const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import(
		"node:fs"
	);
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const retargetModule = await import("../bridge/report-hosting-retarget.js");
	const migrationModule = await import("../bridge/report-hosting-migration.js");
	const usageModule = await import("../bridge/report-hosting-usage.js");
	const { ReportRegistry } = await import("../bridge/report-registry.js");
	const dir = mkdtempSync(join(tmpdir(), "hosting-cli-"));
	const original = "OPERATOR_OWNS_THIS=unchanged\n";
	writeFileSync(join(dir, ".env"), original);
	const registry = new ReportRegistry(dir);
	await registry.ensureVercelProjectName();
	await registry.markHostingMigrated(
		{
			provider: "vercel-blob",
			migratedAt: new Date().toISOString(),
			gatewayDeploymentId: "old",
			storeId: "abc",
		},
		{ expectedHostingKey: registry.hostingBinding().hostingKey },
	);
	vi.stubEnv("FLY2538_ACCOUNT", "fake-account-credential");
	vi.stubEnv("FLY2538_BLOB", "vercel_blob_rw_abc_secret");
	const retarget = vi
		.spyOn(retargetModule, "retargetReportHosting")
		.mockResolvedValue({ project: "fw-reports-abc123" } as never);
	const deploy = vi
		.spyOn(migrationModule, "deployReportGatewayOnly")
		.mockResolvedValue({ deploymentId: "new" });
	const usage = vi
		.spyOn(usageModule, "checkReportHostingUsage")
		.mockResolvedValue({ wouldAlert: false });
	const output = vi.spyOn(console, "log").mockImplementation(() => {});
	try {
		const { main } = await import(
			"../../../../scripts/migrate-report-hosting.js"
		);
		const common = [
			"--vercel-token-env",
			"FLY2538_ACCOUNT",
			"--reports-dir",
			dir,
		];
		await main([
			"--retarget",
			...common,
			"--project-name",
			"fw-reports-abc123",
		]);
		expect(retarget).toHaveBeenCalledWith(
			expect.objectContaining({
				vercelToken: "fake-account-credential",
				projectName: "fw-reports-abc123",
				reportsDir: dir,
			}),
		);
		await main([
			"--deploy-gateway-only",
			...common,
			"--blob-token-env",
			"FLY2538_BLOB",
		]);
		expect(deploy).toHaveBeenCalledWith(
			expect.objectContaining({
				bound: expect.objectContaining({ storeId: "abc" }),
			}),
		);
		await main(["--usage-check", ...common]);
		expect(usage).toHaveBeenCalledWith(
			expect.objectContaining({ vercelToken: "fake-account-credential" }),
		);
		expect(readFileSync(join(dir, ".env"), "utf8")).toBe(original);
		expect(output.mock.calls.flat().join(" ")).not.toContain(
			"fake-account-credential",
		);
		expect(output.mock.calls.flat().join(" ")).not.toContain(
			"vercel_blob_rw_abc_secret",
		);
		expect(output.mock.calls.flat().join(" ")).toContain(
			"flywheel-comm epic-page publish --project",
		);
		expect(output.mock.calls.flat().join(" ")).not.toContain("无需重启 Bridge");
	} finally {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	}
});
