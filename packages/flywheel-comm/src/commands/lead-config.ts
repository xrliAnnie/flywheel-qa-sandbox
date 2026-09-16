import { randomUUID } from "node:crypto";
import { isAllowedLoopbackHostname } from "../lead-lease.js";
export interface LeadConfigCliDeps {
	env?: Record<string, string | undefined>;
	fetch?: (url: string, init: RequestInit) => Promise<Response>;
	log?: (line: string) => void;
	error?: (line: string) => void;
}
const usage =
	"lead-config set --project P --lead ID [--model ID] [--effort VALUE] --reason TEXT [--operation-id UUID] | rollback --operation-id OLD --reason TEXT | status --operation-id UUID";
function text(value: string | undefined, label: string, max = 1000): string {
	if (
		!value?.trim() ||
		value.length > max ||
		Array.from(value).some(
			(c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
		)
	)
		throw new Error(`invalid or missing ${label}`);
	return value;
}
function operationId(value: string | undefined) {
	const id = text(value, "operation ID", 36);
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
	)
		throw new Error("invalid operation ID");
	return id;
}
function outcome(value: unknown, expectedId: string): number {
	const result = value as {
		operation?: { input?: { operationId?: unknown } };
		effectiveStatus?: unknown;
	};
	if (result?.operation?.input?.operationId !== expectedId)
		throw new Error("operation receipt mismatch");
	const status = result.effectiveStatus;
	if (status === "applied" || status === "observed") return 0;
	if (
		[
			"prepared",
			"registry_committed",
			"pending_runtime",
			"unavailable",
			"drifted",
		].includes(String(status))
	)
		return 2;
	if (status === "conflict" || status === "superseded") return 1;
	throw new Error("invalid Bridge operation status");
}
export async function runLeadConfig(
	args: string[],
	deps: LeadConfigCliDeps = {},
): Promise<number> {
	const log = deps.log ?? console.log,
		error = deps.error ?? console.error;
	let recoveryId: string | undefined;
	try {
		const [action, ...rest] = args;
		if (!["set", "rollback", "status"].includes(action ?? ""))
			throw new Error(usage);
		const allowed = [
			"--bridge-url",
			"--operation-id",
			...(action === "status" ? [] : ["--reason"]),
			...(action === "set"
				? ["--project", "--lead", "--model", "--effort"]
				: []),
		];
		const options = new Map<string, string>();
		for (let i = 0; i < rest.length; i += 2) {
			const key = rest[i]!,
				value = rest[i + 1];
			if (
				!allowed.includes(key) ||
				options.has(key) ||
				value === undefined ||
				value.startsWith("--")
			)
				throw new Error(`invalid or duplicate option: ${key}`);
			options.set(key, value);
		}
		const env = deps.env ?? process.env;
		const base = new URL(
			options.get("--bridge-url") ??
				env.FLYWHEEL_BRIDGE_URL ??
				env.BRIDGE_URL ??
				"http://localhost:9876",
		);
		if (
			base.protocol !== "http:" ||
			!isAllowedLoopbackHostname(base.hostname.replace(/^\[|\]$/g, "")) ||
			base.username ||
			base.password ||
			base.pathname !== "/" ||
			base.search ||
			base.hash
		)
			throw new Error("Bridge URL must be an HTTP loopback origin");
		const request = async (path: string, body?: unknown) => {
			const response = await (deps.fetch ?? fetch)(
				`${base.origin}/api/lead-config${path}`,
				{
					method: body === undefined ? "GET" : "POST",
					redirect: "error",
					headers: { Origin: base.origin, "Content-Type": "application/json" },
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
					signal: AbortSignal.timeout(30000),
				},
			);
			const value: unknown = await response.json();
			if (!response.ok)
				throw new Error(
					`Bridge HTTP ${response.status}: ${JSON.stringify(value)}`,
				);
			return value;
		};
		if (action === "status") {
			const id = operationId(options.get("--operation-id"));
			const result = await request(`/operations/${id}`);
			log(JSON.stringify(result));
			return outcome(result, id);
		}
		const id =
			action === "rollback"
				? randomUUID()
				: operationId(options.get("--operation-id") ?? randomUUID());
		const candidate: Record<string, unknown> = {
			operationId: id,
			reason: text(options.get("--reason"), "reason"),
		};
		if (action === "rollback")
			candidate.rollbackOperationId = operationId(
				options.get("--operation-id"),
			);
		else {
			for (const [flag, key] of [
				["--project", "projectName"],
				["--lead", "leadId"],
			] as const) {
				const value = text(options.get(flag), flag, 128);
				if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value))
					throw new Error(`invalid ${flag}`);
				candidate[key] = value;
			}
			if (!options.has("--model") && !options.has("--effort"))
				throw new Error("set requires --model or --effort");
			if (options.has("--model"))
				candidate.model = text(options.get("--model"), "model", 256);
			if (options.has("--effort")) {
				const effort = options.get("--effort")!;
				if (!["low", "medium", "high", "xhigh", "max"].includes(effort))
					throw new Error("invalid effort");
				candidate.effort = effort;
			}
		}
		const staged = (await request("/stage", candidate)) as {
			canonical?: { intent?: { operationId?: unknown } };
			requestDigest?: unknown;
			confirmToken?: unknown;
		};
		if (
			staged?.canonical?.intent?.operationId !== id ||
			typeof staged.requestDigest !== "string" ||
			!/^[a-f0-9]{64}$/.test(staged.requestDigest) ||
			typeof staged.confirmToken !== "string" ||
			!staged.confirmToken
		)
			throw new Error("invalid Bridge stage response");
		recoveryId = id;
		log(
			JSON.stringify({
				operationId: id,
				requestDigest: staged.requestDigest,
				status: "staged",
			}),
		);
		const result = await request("/apply", staged);
		log(JSON.stringify(result));
		return outcome(result, id);
	} catch (cause) {
		error(cause instanceof Error ? cause.message : String(cause));
		if (recoveryId)
			error(
				`Check lead-config status --operation-id ${recoveryId}; do not silently re-stage after an uncertain apply response.`,
			);
		return 1;
	}
}
