import { parseArgs } from "node:util";
import { ReportRetargetError } from "./report-hosting-retarget.js";
export type ReportHostingCommand =
	| { mode: "legacy" }
	| {
			mode: "retarget" | "deploy-gateway-only" | "usage-check";
			vercelToken: string;
			vercelTokenEnv: string;
			blobToken?: string;
			blobTokenEnv?: string;
			projectName?: string;
			storeName?: string;
			storeId?: string;
			abandonStoreIntent?: boolean;
			region?: string;
			reportsDir?: string;
			token?: string;
	  };
export function parseReportHostingCommand(
	args: string[],
	env: NodeJS.ProcessEnv = process.env,
): ReportHostingCommand {
	if (args.length === 0) return { mode: "legacy" };
	const fail = (message: string): never => {
		throw new ReportRetargetError(2, message);
	};
	let values: Record<string, string | boolean | undefined>;
	try {
		values = parseArgs({
			args,
			strict: true,
			allowPositionals: false,
			options: {
				retarget: { type: "boolean" },
				"deploy-gateway-only": { type: "boolean" },
				"usage-check": { type: "boolean" },
				"vercel-token-env": { type: "string" },
				"blob-token-env": { type: "string" },
				"project-name": { type: "string" },
				"store-name": { type: "string" },
				"store-id": { type: "string" },
				"abandon-store-intent": { type: "boolean" },
				region: { type: "string" },
				"reports-dir": { type: "string" },
				token: { type: "string" },
			},
		}).values;
	} catch {
		return fail("invalid report hosting arguments");
	}
	const modes = (
		["retarget", "deploy-gateway-only", "usage-check"] as const
	).filter((mode) => values[mode] === true);
	if (modes.length !== 1) return fail("select exactly one report hosting mode");
	const mode = modes[0]!;
	const credential = (
		key: string,
		required: boolean,
	): { name?: string; value?: string } => {
		const name = values[key];
		if (name === undefined) {
			if (required) fail(`--${key} is required`);
			return {};
		}
		if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
			return fail(`--${key} must be an environment variable name`);
		const value = env[name]?.trim();
		if (!value) return fail(`environment variable ${name} is missing or empty`);
		return { name, value };
	};
	const account = credential("vercel-token-env", true);
	const blob = credential(
		"blob-token-env",
		mode === "deploy-gateway-only" || values.token !== undefined,
	);
	const string = (key: string) =>
		typeof values[key] === "string" ? (values[key] as string) : undefined;
	const projectName = string("project-name");
	if (
		mode === "retarget" &&
		(!projectName || !/^fw-reports-[0-9a-f]{6}$/.test(projectName))
	)
		return fail("--project-name must match fw-reports-<6 lowercase hex>");
	for (const key of [
		"project-name",
		"store-name",
		"region",
		"abandon-store-intent",
	]) {
		if (values[key] !== undefined && mode !== "retarget")
			return fail(`--${key} is only valid with --retarget`);
	}
	if (values["store-id"] !== undefined && mode === "deploy-gateway-only")
		return fail("--store-id is not valid with --deploy-gateway-only");
	if (
		values.token !== undefined &&
		(mode !== "usage-check" || !/^[0-9a-f]{32}$/.test(string("token") ?? ""))
	)
		return fail("--token requires --usage-check and a 32-hex report token");
	if (
		values["abandon-store-intent"] &&
		!values["store-name"] &&
		!values["store-id"]
	)
		return fail("--abandon-store-intent requires --store-name or --store-id");
	for (const key of ["store-name", "store-id", "region", "reports-dir"])
		if (values[key] !== undefined && !string(key)?.trim())
			return fail(`--${key} must not be empty`);
	return {
		mode,
		vercelToken: account.value!,
		vercelTokenEnv: account.name!,
		blobToken: blob.value,
		blobTokenEnv: blob.name,
		projectName,
		storeName: string("store-name"),
		storeId: string("store-id"),
		region: string("region"),
		reportsDir: string("reports-dir"),
		abandonStoreIntent: values["abandon-store-intent"] === true,
		token: string("token"),
	};
}
