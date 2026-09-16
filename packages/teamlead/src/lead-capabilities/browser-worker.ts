import { createHash, randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { BrowserWorkerSpecInput } from "./browser-config.js";
import type { BrowserEgressPolicy } from "./browser-egress.js";
import { verifyBrowserHostIdentity } from "./browser-host-identity.js";
import { buildBrowserSandboxSpec } from "./browser-sandbox.js";
import { BROWSER_TOOL_SCHEMAS, BrowserToolPolicy } from "./browser-tools.js";
import { BrowserStdioTransport } from "./browser-transport.js";

const lost = () => new Error("browser_lost");
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => [k, canonical(v)]),
		);
	return value;
}
/** Trusted manifest capture and observed tools/list use the same stable schema digest. */
export function browserUpstreamSchemaDigest(
	tools: readonly { name: string; inputSchema: unknown }[],
): string {
	return createHash("sha256")
		.update(
			JSON.stringify(
				canonical(
					[...tools]
						.map((t) => ({ name: t.name, inputSchema: t.inputSchema }))
						.sort((a, b) => a.name.localeCompare(b.name)),
				),
			),
		)
		.digest("hex");
}
export interface BrowserWorkerOptions {
	input: BrowserWorkerSpecInput;
	artifactRoot: string;
	expectedUpstreamSchemaDigest: string;
	assertCurrent(): void;
	egress?: () => BrowserEgressPolicy;
	/** Mandatory trusted host verifier. Must bind actual OS canaries to this launch.
	 * Production assembly must never substitute config validation or a constant callback. */
	verifyIsolation(
		launch: ReturnType<typeof buildBrowserSandboxSpec>,
	): Promise<void>;
}
/** One activation owns one persistent upstream MCP session and Chrome CDP pipe.
 * This is an internal parent API. Its raw result MUST pass output/artifact projection
 * before a façade returns anything to the model. It never auto-recovers old pages. */
export class BrowserWorker {
	private client?: Client;
	private transport?: BrowserStdioTransport;
	private readonly generation = randomUUID();
	private status: "new" | "starting" | "ready" | "lost" | "closed" = "new";
	private busy = false;
	private readonly policy: BrowserToolPolicy;
	constructor(private readonly options: BrowserWorkerOptions) {
		if (!/^[a-f0-9]{64}$/.test(options.expectedUpstreamSchemaDigest))
			throw lost();
		this.policy = new BrowserToolPolicy({
			artifactRoot: options.artifactRoot,
			assertCurrent: () => this.options.assertCurrent(),
			egress: options.egress,
		});
	}
	async start(): Promise<string> {
		if (this.status !== "new") throw lost();
		this.status = "starting";
		try {
			this.options.assertCurrent();
			verifyBrowserHostIdentity(this.options.input);
			const launch = buildBrowserSandboxSpec(this.options.input);
			await this.options.verifyIsolation(launch);
			this.options.assertCurrent();
			if (this.status !== "starting") throw lost();
			const transport = new BrowserStdioTransport(launch),
				client = new Client({ name: "flywheel-browser-parent", version: "2" });
			this.client = client;
			this.transport = transport;
			client.onclose = () => {
				if (this.status !== "closed") this.status = "lost";
			};
			client.onerror = () => {
				this.status = "lost";
				void transport.close();
			};
			await client.connect(transport, { timeout: 15000 });
			const inventory = await client.listTools(undefined, { timeout: 15000 });
			if (
				inventory.nextCursor ||
				inventory.tools.length > 128 ||
				browserUpstreamSchemaDigest(inventory.tools) !==
					this.options.expectedUpstreamSchemaDigest
			)
				throw lost();
			const names = new Set(inventory.tools.map((t) => t.name));
			if (
				names.size !== inventory.tools.length ||
				Object.keys(BROWSER_TOOL_SCHEMAS).some((n) => !names.has(n))
			)
				throw lost();
			for (const [name, schema] of Object.entries(BROWSER_TOOL_SCHEMAS)) {
				const upstream = inventory.tools.find((tool) => tool.name === name)
					?.inputSchema as { required?: unknown } | undefined;
				const required = upstream?.required;
				if (
					required !== undefined &&
					(!Array.isArray(required) ||
						required.some(
							(key) =>
								typeof key !== "string" || !Object.hasOwn(schema.shape, key),
						))
				)
					throw lost();
			}
			this.options.assertCurrent();
			if (this.status !== "starting") throw lost();
			this.status = "ready";
			return this.generation;
		} catch {
			this.status = "lost";
			await this.transport?.close();
			throw lost();
		}
	}
	async call(
		generation: string,
		name: string,
		input: unknown,
		signal?: AbortSignal,
	) {
		if (
			this.status !== "ready" ||
			generation !== this.generation ||
			!this.client
		)
			throw lost();
		if (this.busy) throw new Error("browser_busy");
		this.busy = true;
		try {
			const prepared = await this.policy.prepare(name, input, signal);
			if (this.status !== "ready") throw lost();
			this.options.assertCurrent();
			let result: Awaited<ReturnType<Client["callTool"]>>;
			try {
				result = await this.client.callTool(
					{ name: prepared.name, arguments: prepared.arguments },
					undefined,
					{ timeout: 15000, signal },
				);
				this.options.assertCurrent();
			} catch (error) {
				if (
					this.status === "ready" &&
					(signal?.aborted ||
						(error instanceof McpError &&
							error.code === ErrorCode.RequestTimeout))
				)
					throw new Error("browser_operation_interrupted");
				this.status = "lost";
				await this.transport?.close();
				throw lost();
			}
			if (this.status !== "ready") throw lost();
			return { result, artifact: prepared.artifact };
		} finally {
			this.busy = false;
		}
	}
	async close() {
		this.status = "closed";
		await this.transport?.close();
	}
}
