import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export async function runMigrationStaticPreflight(input: {
	home: string;
	root: string;
	projectRoot: string;
	deploymentSha: string;
	botTokenEnv: string;
	assertWindow(): void;
}): Promise<{ codexHome: string; stateDir: string }> {
	input.assertWindow();
	if (
		![input.home, input.root, input.projectRoot].every(
			(path) => isAbsolute(path) && !/[\r\n\0]/.test(path),
		) ||
		!/^[a-f0-9]{40}$/.test(input.deploymentSha) ||
		!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.botTokenEnv)
	)
		throw new Error("invalid migration static preflight input");
	const helper = join(input.root, "scripts/lib/lead-backend-migration.sh");
	const stat = lstatSync(helper);
	if (!stat.isFile() || stat.isSymbolicLink())
		throw new Error("unsafe migration static preflight helper");
	const stdout = await new Promise<string>((resolve, reject) => {
		execFile(
			"/bin/bash",
			[
				"-c",
				'source "$1" || exit $?; shift; lead_backend_migration_static_preflight "$@"',
				"migration-static",
				helper,
				input.home,
				input.root,
				input.projectRoot,
				input.deploymentSha,
				input.botTokenEnv,
			],
			{
				cwd: input.root,
				env: {
					...process.env,
					HOME: input.home,
					FLYWHEEL_DIR: input.root,
					FLYWHEEL_STATE_DIR: join(input.home, ".flywheel"),
					FLYWHEEL_LAUNCHD_DIR: join(input.home, "Library/LaunchAgents"),
				},
				timeout: 60_000,
				maxBuffer: 16 * 1024,
				encoding: "utf8",
			},
			(error, output) =>
				error
					? reject(new Error("migration static preflight failed"))
					: resolve(output),
		);
	});
	input.assertWindow();
	const invalid = (): never => {
		throw new Error("migration static preflight result invalid");
	};
	let result: unknown;
	try {
		result = JSON.parse(stdout);
	} catch {
		return invalid();
	}
	if (!result || typeof result !== "object" || Array.isArray(result))
		return invalid();
	const row = result as Record<string, unknown>;
	if (Object.keys(row).sort().join(",") !== "codexHome,stateDir")
		return invalid();
	const codexHome = row.codexHome,
		stateDir = row.stateDir;
	if (
		typeof codexHome !== "string" ||
		typeof stateDir !== "string" ||
		![codexHome, stateDir].every(
			(path) => isAbsolute(path) && !/[\r\n\0]/.test(path),
		)
	)
		return invalid();
	return { codexHome, stateDir };
}

/** Internal window adapter. Successful command exit is not activation/stop proof. */
export async function runMigrationLifecycle(
	input: { home: string; root: string; assertWindow(): void },
	operation: "preflight" | "stop" | "load",
): Promise<void> {
	if (!["preflight", "stop", "load"].includes(operation))
		throw new Error("invalid migration lifecycle operation");
	for (const path of [input.home, input.root]) {
		if (!isAbsolute(path) || /[\r\n\0]/.test(path))
			throw new Error("invalid migration lifecycle path");
	}
	input.assertWindow();
	const script = join(
		input.root,
		operation === "load"
			? "scripts/lib/lead-backend-migration.sh"
			: "scripts/flywheel-lead.sh",
	);
	const stat = lstatSync(script);
	if (!stat.isFile() || stat.isSymbolicLink())
		throw new Error("unsafe migration lifecycle script");
	const args =
		operation === "preflight"
			? [
					operation,
					join(
						input.home,
						".flywheel/manifests/flywheel-flywheel-product-lead.json",
					),
				]
			: [operation, "--project", "flywheel", "--lead", "flywheel-product-lead"];
	await new Promise<void>((resolve, reject) => {
		execFile(
			"/bin/bash",
			operation === "load"
				? [
						"-c",
						'source "$1" || exit $?; shift; lead_backend_migration_load_staged "$@"',
						"migration-load",
						script,
						input.home,
						input.root,
					]
				: [script, ...args],
			{
				cwd: input.root,
				env: {
					...process.env,
					HOME: input.home,
					FLYWHEEL_DIR: input.root,
					FLYWHEEL_STATE_DIR: join(input.home, ".flywheel"),
					FLYWHEEL_COMM_CLI: join(
						input.root,
						"packages/flywheel-comm/dist/index.js",
					),
					FLYWHEEL_LAUNCHD_DIR: join(input.home, "Library/LaunchAgents"),
					FLYWHEEL_TEAMLEAD_ROOT: join(input.root, "packages/teamlead"),
					FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR: join(
						input.root,
						"packages/teamlead/dist/bin/validate-projects.js",
					),
				},
				timeout: 60_000,
				maxBuffer: 256 * 1024,
				encoding: "utf8",
			},
			(error) => {
				// Child output may contain credentials from inherited launcher diagnostics.
				if (error) reject(new Error(`migration lifecycle ${operation} failed`));
				else resolve();
			},
		);
	});
	input.assertWindow();
}
