import { parseArgs } from "node:util";
import { assertLoopbackCarrierUrl } from "../lead-lease.js";

interface Dependencies {
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	log?: (message: string) => void;
}
const isUtc = (value: string | undefined): value is string => {
	if (!value || !Number.isFinite(Date.parse(value))) return false;
	return new Date(value).toISOString() === value;
};
/** Read-only Bridge client. Never opens or migrates local state databases. */
export async function runShipJudgment(
	args: string[],
	deps: Dependencies = {},
): Promise<number> {
	const log = deps.log ?? console.log;
	const fail = (error: string) => {
		log(JSON.stringify({ error }));
		return 1;
	};
	const operation = args[0];
	if (operation !== "report" && operation !== "show")
		return fail(
			"use ship-judgment report --project flywheel --from UTC --to UTC, or show --project flywheel --question ID|--id ID",
		);
	let values: Record<string, string | undefined>;
	try {
		const parsed = parseArgs({
			args: args.slice(1),
			strict: true,
			allowPositionals: false,
			tokens: true,
			options: {
				project: { type: "string" },
				...(operation === "show"
					? {
							question: { type: "string" as const },
							id: { type: "string" as const },
						}
					: {
							from: { type: "string" as const },
							to: { type: "string" as const },
							"as-of": { type: "string" as const },
							"policy-version": { type: "string" as const },
							"model-snapshot-digest": { type: "string" as const },
						}),
				"bridge-url": { type: "string" },
			},
		});
		const names = parsed.tokens
			.filter((t) => t.kind === "option")
			.map((t) => t.name);
		if (new Set(names).size !== names.length) return fail("duplicate_option");
		values = {};
		for (const [key, value] of Object.entries(parsed.values)) {
			if (value !== undefined && typeof value !== "string")
				return fail("invalid_query_option");
			values[key] = value;
		}
	} catch {
		return fail("invalid_statistics_options");
	}
	if (values.project !== "flywheel") return fail("invalid_project");
	if (
		operation === "show" &&
		(Boolean(values.question) === Boolean(values.id) ||
			(values.question ?? values.id ?? "").length >
				(values.question ? 200 : 240))
	)
		return fail("exactly_one_audit_selector_required");
	if (
		operation === "report" &&
		(!isUtc(values.from) ||
			!isUtc(values.to) ||
			values.from >= values.to ||
			(values["as-of"] !== undefined &&
				(!isUtc(values["as-of"]) || values.to > values["as-of"])) ||
			(values["policy-version"] !== undefined &&
				(!values["policy-version"] || values["policy-version"].length > 200)) ||
			(values["model-snapshot-digest"] !== undefined &&
				!/^[a-f0-9]{64}$/.test(values["model-snapshot-digest"])))
	)
		return fail("invalid_statistics_range");
	const env = deps.env ?? process.env;
	if (!env.TEAMLEAD_API_TOKEN) return fail("api_token_required");
	let url: URL;
	try {
		url = assertLoopbackCarrierUrl(
			`${(values["bridge-url"] ?? env.BRIDGE_URL ?? env.FLYWHEEL_BRIDGE_URL ?? "http://localhost:9876").replace(/\/+$/, "")}/api/ship-judgment/${operation}`,
		);
	} catch {
		return fail("loopback_bridge_required");
	}
	for (const [key, value] of Object.entries({
		project: values.project,
		question: values.question,
		id: values.id,
		from: values.from,
		to: values.to,
		asOf: values["as-of"],
		policyVersion: values["policy-version"],
		modelSnapshotDigest: values["model-snapshot-digest"],
	}))
		if (value !== undefined) url.searchParams.set(key, value);
	try {
		const response = await (deps.fetchImpl ?? fetch)(url.href, {
			method: "GET",
			redirect: "error",
			signal: AbortSignal.timeout(20000),
			headers: { Authorization: `Bearer ${env.TEAMLEAD_API_TOKEN}` },
		});
		if (!response.ok) {
			await response.body?.cancel();
			return fail(`bridge_http_${response.status}`);
		}
		const body = (await response.json()) as {
			schema_version?: unknown;
			policy?: unknown;
			source?: unknown;
			project?: unknown;
			questionId?: unknown;
			record?: { id?: unknown };
			records?: unknown;
			report?: { project?: unknown; range?: { from?: unknown; to?: unknown } };
		};
		if (
			body?.schema_version !== 1 ||
			typeof body.policy !== "string" ||
			(operation === "show"
				? body.project !== values.project ||
					typeof body.questionId !== "string" ||
					(values.id
						? body.record?.id !== values.id
						: body.questionId !== values.question ||
							!Array.isArray(body.records))
				: body.source !== "machine" ||
					body.report?.project !== values.project ||
					body.report.range?.from !== values.from ||
					body.report.range?.to !== values.to)
		)
			return fail("unexpected_statistics_response");
		log(JSON.stringify(body));
		return 0;
	} catch {
		return fail("statistics_read_failed");
	}
}
