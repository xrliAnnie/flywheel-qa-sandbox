import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readFileSync,
} from "node:fs";
import { isAllowedLoopbackHostname } from "../lead-lease.js";

export interface WorkflowTemplateCliDeps {
	env?: Record<string, string | undefined>;
	fetch?: (url: string, init: RequestInit) => Promise<Response>;
	log?: (line: string) => void;
	error?: (line: string) => void;
}
const USAGE =
	"workflow-template publish --template ID --from seed|file [--file PATH] --reason TEXT | rollback --template ID --revision N --reason TEXT | status --operation-id UUID";
function required(options: Map<string, string>, name: string): string {
	const value = options.get(name);
	if (!value?.trim()) throw new Error(`${name} is required`);
	return value;
}
function positiveInteger(value: string): number {
	if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
		throw new Error("revision must be a positive safe integer");
	return Number(value);
}
function readManifest(path: string): unknown {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > 512 * 1024)
			throw new Error("manifest must be a regular file of at most 512KiB");
		const bytes = readFileSync(fd);
		if (bytes.length > 512 * 1024) throw new Error("manifest exceeds 512KiB");
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} finally {
		closeSync(fd);
	}
}

export async function runWorkflowTemplate(
	args: string[],
	deps: WorkflowTemplateCliDeps = {},
): Promise<number> {
	const log = deps.log ?? console.log;
	const error = deps.error ?? console.error;
	let recoveryId: string | undefined;
	try {
		const [action, ...rest] = args;
		if (!action || !["publish", "rollback", "status"].includes(action))
			throw new Error(USAGE);
		const common = ["--bridge-url", "--operation-id"];
		const allowed =
			action === "status"
				? common
				: [
						...common,
						"--template",
						"--reason",
						"--expected-revision",
						"--expected-digest",
						...(action === "publish" ? ["--from", "--file"] : ["--revision"]),
					];
		const options = new Map<string, string>();
		for (let i = 0; i < rest.length; i += 2) {
			const key = rest[i]!;
			const value = rest[i + 1];
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
			const response = await (deps.fetch ?? fetch)(`${base.origin}${path}`, {
				method: body === undefined ? "GET" : "POST",
				redirect: "error",
				headers: { Origin: base.origin, "Content-Type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(15_000),
			});
			const value: unknown = await response.json();
			if (!response.ok)
				throw new Error(
					`Bridge HTTP ${response.status}: ${JSON.stringify(value)}`,
				);
			return value;
		};
		const op =
			action === "status"
				? required(options, "--operation-id")
				: (options.get("--operation-id") ?? randomUUID());
		if (
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
				op,
			)
		)
			throw new Error("invalid operation ID");
		if (action === "status") {
			log(JSON.stringify(await request(`/api/workflow/publications/${op}`)));
			return 0;
		}
		const template = required(options, "--template");
		if (!/^[a-zA-Z0-9_-]{1,128}$/.test(template))
			throw new Error("invalid template ID");
		const reason = required(options, "--reason");
		if (
			reason.length > 1000 ||
			Array.from(reason).some(
				(c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
			)
		)
			throw new Error("invalid reason");
		const candidate: Record<string, unknown> = { operationId: op, reason };
		if (options.has("--expected-revision") !== options.has("--expected-digest"))
			throw new Error("expected revision and digest must be supplied together");
		if (options.has("--expected-revision")) {
			candidate.expectedRevision = positiveInteger(
				required(options, "--expected-revision"),
			);
			const expected = required(options, "--expected-digest");
			if (!/^[a-f0-9]{64}$/.test(expected))
				throw new Error("invalid expected digest");
			candidate.expectedDigest = expected;
		}
		if (action === "rollback") {
			candidate.from = "rollback";
			candidate.revision = positiveInteger(required(options, "--revision"));
		} else {
			candidate.from = required(options, "--from");
			if (candidate.from === "file")
				candidate.manifest = readManifest(required(options, "--file"));
			else if (candidate.from !== "seed" || options.has("--file"))
				throw new Error("use --from seed or --from file --file PATH");
		}
		const path = `/api/workflow/templates/${template}/publish`;
		const staged = (await request(`${path}/stage`, candidate)) as {
			canonical?: { operationId?: unknown };
			requestDigest?: unknown;
			confirmToken?: unknown;
		};
		if (
			typeof staged?.canonical?.operationId !== "string" ||
			typeof staged.requestDigest !== "string" ||
			typeof staged.confirmToken !== "string"
		)
			throw new Error("invalid Bridge stage response");
		recoveryId = staged.canonical.operationId;
		log(
			JSON.stringify({
				operationId: recoveryId,
				requestDigest: staged.requestDigest,
				status: "staged",
			}),
		);
		// Never silently re-stage after a lost apply response: its CAS baseline is frozen.
		log(JSON.stringify(await request(`${path}/apply`, staged)));
		return 0;
	} catch (cause) {
		error(
			`workflow-template: ${cause instanceof Error ? cause.message : String(cause)}${recoveryId ? `; inspect workflow-template status --operation-id ${recoveryId} before another publication` : ""}`,
		);
		return 1;
	}
}
