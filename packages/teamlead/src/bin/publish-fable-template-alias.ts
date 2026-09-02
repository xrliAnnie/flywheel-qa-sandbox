#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SNAPSHOT_PATH = "/api/fleet/snapshot";
const STAGE_PATH = "/api/fleet/changes/stage";
const APPLY_PATH = "/api/fleet/changes/apply";
const DESIRED_MODEL = "fable";
const DESIRED_PROVIDER = "anthropic";
const MAX_CAS_ATTEMPTS = 3;

type Fetch = typeof fetch;

export interface PublishFableTemplateAliasInput {
	templateId: string;
	nodeId: string;
}

export type PublishFableTemplateAliasResult =
	| {
			status: "published";
			templateId: string;
			nodeId: string;
			revision: number;
			seedOwner: "founder";
			consequence: "new-run";
	  }
	| {
			status: "no_op";
			templateId: string;
			nodeId: string;
			revision: number;
			seedOwner: "founder";
			consequence: "new-run";
	  };

export interface PublishFableTemplateAliasDeps {
	env?: Record<string, string | undefined>;
	fetch?: Fetch;
}

interface DagTarget {
	templateId: string;
	nodeId: string;
	revision: number;
	seedOwner: "system" | "founder";
	targetId: string;
	observedRevision: string;
	current: { provider: string; model: string; effort: string | null };
}

class ManagementHttpError extends Error {
	constructor(
		readonly surface: "snapshot" | "stage" | "apply",
		readonly status: number,
		reason: string,
	) {
		super(`${surface} rejected (${status}): ${reason}`);
		this.name = "ManagementHttpError";
	}
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function nonempty(value: unknown, path: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${path} must be a non-empty string`);
	}
	return value.trim();
}

function bridgeOrigin(env: Record<string, string | undefined>): string {
	const configured =
		env.FLYWHEEL_BRIDGE_URL?.trim() || env.BRIDGE_URL?.trim() || undefined;
	const portText = env.TEAMLEAD_PORT?.trim() || "9876";
	if (!configured && !/^\d+$/.test(portText)) {
		throw new Error("TEAMLEAD_PORT must be an integer");
	}
	const port = Number(portText);
	if (!configured && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
		throw new Error("TEAMLEAD_PORT must be in 1..65535");
	}
	let base: URL;
	try {
		base = new URL(configured ?? `http://127.0.0.1:${port}`);
	} catch {
		throw new Error("Bridge URL is invalid");
	}
	if (base.protocol !== "http:" && base.protocol !== "https:") {
		throw new Error("Bridge URL must use HTTP(S)");
	}
	if (base.username || base.password) {
		throw new Error("Bridge URL must not contain credentials");
	}
	if (
		base.hostname !== "127.0.0.1" &&
		base.hostname !== "localhost" &&
		base.hostname !== "::1" &&
		base.hostname !== "[::1]"
	) {
		throw new Error("Bridge URL must resolve to a loopback host");
	}
	if ((base.pathname && base.pathname !== "/") || base.search || base.hash) {
		throw new Error("Bridge URL must contain only an origin");
	}
	return base.origin;
}

async function responseJson(
	response: Response,
	surface: "snapshot" | "stage" | "apply",
): Promise<unknown> {
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw new Error(`${surface} returned malformed JSON`);
	}
	if (!response.ok) {
		const parsed = record(body);
		const reason =
			typeof parsed?.error === "string"
				? parsed.error
				: "management request failed";
		throw new ManagementHttpError(surface, response.status, reason);
	}
	return body;
}

async function getJson(
	fetchImpl: Fetch,
	origin: string,
	path: string,
	surface: "snapshot",
): Promise<unknown> {
	let response: Response;
	try {
		response = await fetchImpl(`${origin}${path}`, {
			headers: { Origin: origin },
		});
	} catch (error) {
		throw new Error(
			`${surface} request failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return responseJson(response, surface);
}

async function postJson(
	fetchImpl: Fetch,
	origin: string,
	path: string,
	surface: "stage" | "apply",
	body: unknown,
): Promise<unknown> {
	let response: Response;
	try {
		response = await fetchImpl(`${origin}${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: origin,
			},
			body: JSON.stringify(body),
		});
	} catch (error) {
		const qualifier = surface === "apply" ? " with indeterminate outcome" : "";
		throw new Error(
			`${surface} request failed${qualifier}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return responseJson(response, surface);
}

function resolveDagTarget(
	snapshotValue: unknown,
	input: PublishFableTemplateAliasInput,
): DagTarget {
	const snapshot = record(snapshotValue);
	if (
		!snapshot ||
		snapshot.schemaVersion !== 1 ||
		!Array.isArray(snapshot.projects)
	) {
		throw new Error("management snapshot schema is unsupported");
	}
	const candidates = new Map<string, DagTarget>();
	for (const projectValue of snapshot.projects) {
		const project = record(projectValue);
		if (!project || !Array.isArray(project.dags)) continue;
		for (const dagValue of project.dags) {
			const dag = record(dagValue);
			if (!dag || dag.templateId !== input.templateId) continue;
			if (typeof dag.error === "string" && dag.error) {
				throw new Error(
					`template ${input.templateId} is unreadable: ${dag.error}`,
				);
			}
			if (!Number.isInteger(dag.revision) || Number(dag.revision) < 1) {
				throw new Error(`template ${input.templateId} revision is invalid`);
			}
			if (dag.seedOwner !== "system" && dag.seedOwner !== "founder") {
				throw new Error(`template ${input.templateId} seed owner is invalid`);
			}
			if (!Array.isArray(dag.nodes)) {
				throw new Error(`template ${input.templateId} nodes are invalid`);
			}
			for (const nodeValue of dag.nodes) {
				const node = record(nodeValue);
				if (!node || node.nodeId !== input.nodeId) continue;
				const dispatch = record(node.dispatch);
				const current = record(dispatch?.current);
				const source = record(dispatch?.source);
				const capability = record(dispatch?.writeCapability);
				if (
					!dispatch ||
					!current ||
					!source ||
					!capability ||
					capability.writable !== true ||
					capability.consequence !== "new-run" ||
					capability.requiresAcknowledgement !== true
				) {
					throw new Error(
						`template ${input.templateId}/${input.nodeId} is not a governed new-run writer`,
					);
				}
				const effort = current.effort;
				if (effort !== null && typeof effort !== "string") {
					throw new Error("workflow effort is malformed");
				}
				const target: DagTarget = {
					templateId: input.templateId,
					nodeId: input.nodeId,
					revision: Number(dag.revision),
					seedOwner: dag.seedOwner,
					targetId: nonempty(dispatch.targetId, "workflow target id"),
					observedRevision: nonempty(
						source.revision,
						"workflow source revision",
					),
					current: {
						provider: nonempty(current.provider, "workflow provider"),
						model: nonempty(current.model, "workflow model"),
						effort: effort as string | null,
					},
				};
				const prior = candidates.get(target.targetId);
				if (prior && JSON.stringify(prior) !== JSON.stringify(target)) {
					throw new Error("workflow target authority is ambiguous");
				}
				candidates.set(target.targetId, target);
			}
		}
	}
	if (candidates.size !== 1) {
		throw new Error(
			candidates.size === 0
				? `workflow target not found: ${input.templateId}/${input.nodeId}`
				: `workflow target is ambiguous: ${input.templateId}/${input.nodeId}`,
		);
	}
	return [...candidates.values()][0]!;
}

function validateInput(input: PublishFableTemplateAliasInput): void {
	if (!input.templateId.trim() || !input.nodeId.trim()) {
		throw new Error("templateId and nodeId are required");
	}
	if (input.templateId !== input.templateId.trim()) {
		throw new Error("templateId must not contain surrounding whitespace");
	}
	if (input.nodeId !== input.nodeId.trim()) {
		throw new Error("nodeId must not contain surrounding whitespace");
	}
}

function validateStagedBody(
	value: unknown,
	origin: string,
	targetId: string,
): { batch: Record<string, unknown>; confirmToken: string } {
	const body = record(value);
	const batch = record(body?.batch);
	if (
		!body ||
		!batch ||
		batch.schemaVersion !== 1 ||
		batch.origin !== origin ||
		!Array.isArray(batch.changes) ||
		!Array.isArray(batch.noOps) ||
		batch.changes.length !== 1 ||
		record(batch.changes[0])?.targetId !== targetId ||
		typeof body.confirmToken !== "string" ||
		!body.confirmToken
	) {
		throw new Error("stage returned an invalid canonical batch");
	}
	return { batch, confirmToken: body.confirmToken };
}

function validateAppliedBody(value: unknown, targetId: string): void {
	const body = record(value);
	if (!body || body.status !== "applied" || !Array.isArray(body.items)) {
		throw new Error("apply did not report a complete publication");
	}
	const item = body.items.find(
		(candidate) => record(candidate)?.targetId === targetId,
	);
	if (record(item)?.status !== "applied") {
		throw new Error("apply did not report the workflow target as applied");
	}
}

/**
 * Governed post-deploy publication. This function talks only to the Bridge
 * management API; StateStore and SQLite are intentionally absent.
 */
export async function publishFableTemplateAlias(
	input: PublishFableTemplateAliasInput,
	deps: PublishFableTemplateAliasDeps = {},
): Promise<PublishFableTemplateAliasResult> {
	validateInput(input);
	const origin = bridgeOrigin(deps.env ?? process.env);
	const fetchImpl = deps.fetch ?? fetch;

	for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt += 1) {
		const snapshot = await getJson(
			fetchImpl,
			origin,
			SNAPSHOT_PATH,
			"snapshot",
		);
		const target = resolveDagTarget(snapshot, input);
		if (
			target.current.provider === DESIRED_PROVIDER &&
			target.current.model === DESIRED_MODEL
		) {
			if (target.seedOwner !== "founder") {
				throw new Error(
					"Fable alias is published but seed ownership is not founder",
				);
			}
			return {
				status: "no_op",
				templateId: input.templateId,
				nodeId: input.nodeId,
				revision: target.revision,
				seedOwner: target.seedOwner,
				consequence: "new-run",
			};
		}

		const stageInput = {
			changes: [
				{
					targetId: target.targetId,
					desiredValue: {
						provider: DESIRED_PROVIDER,
						model: DESIRED_MODEL,
						effort: target.current.effort,
					},
					observedRevision: target.observedRevision,
				},
			],
			acknowledged: true,
		};

		let stagedValue: unknown;
		try {
			stagedValue = await postJson(
				fetchImpl,
				origin,
				STAGE_PATH,
				"stage",
				stageInput,
			);
		} catch (error) {
			if (
				error instanceof ManagementHttpError &&
				error.status === 409 &&
				attempt < MAX_CAS_ATTEMPTS
			) {
				continue;
			}
			throw error;
		}
		const staged = validateStagedBody(stagedValue, origin, target.targetId);

		let appliedValue: unknown;
		try {
			appliedValue = await postJson(fetchImpl, origin, APPLY_PATH, "apply", {
				batch: staged.batch,
				confirmToken: staged.confirmToken,
				acknowledged: true,
			});
		} catch (error) {
			if (
				error instanceof ManagementHttpError &&
				error.status === 409 &&
				attempt < MAX_CAS_ATTEMPTS
			) {
				continue;
			}
			throw error;
		}
		validateAppliedBody(appliedValue, target.targetId);

		const finalSnapshot = await getJson(
			fetchImpl,
			origin,
			SNAPSHOT_PATH,
			"snapshot",
		);
		const finalTarget = resolveDagTarget(finalSnapshot, input);
		if (
			finalTarget.current.provider !== DESIRED_PROVIDER ||
			finalTarget.current.model !== DESIRED_MODEL ||
			finalTarget.seedOwner !== "founder"
		) {
			throw new Error(
				"publication readback did not retain the Fable alias and founder ownership",
			);
		}
		return {
			status: "published",
			templateId: input.templateId,
			nodeId: input.nodeId,
			revision: finalTarget.revision,
			seedOwner: finalTarget.seedOwner,
			consequence: "new-run",
		};
	}
	throw new Error("workflow publication CAS retry limit exhausted");
}

function parseArgs(argv: readonly string[]): PublishFableTemplateAliasInput {
	let templateId: string | undefined;
	let nodeId: string | undefined;
	for (let index = 2; index < argv.length; index += 1) {
		const flag = argv[index];
		const value = argv[index + 1];
		if ((flag !== "--template" && flag !== "--node") || !value) {
			throw new Error(
				"usage: publish-fable-template-alias --template <id> --node <id>",
			);
		}
		if (flag === "--template") {
			if (templateId !== undefined) throw new Error("--template is duplicated");
			templateId = value;
		} else {
			if (nodeId !== undefined) throw new Error("--node is duplicated");
			nodeId = value;
		}
		index += 1;
	}
	if (!templateId || !nodeId) {
		throw new Error(
			"usage: publish-fable-template-alias --template <id> --node <id>",
		);
	}
	return { templateId, nodeId };
}

export async function runPublishFableTemplateAliasCli(
	argv: readonly string[],
	deps: PublishFableTemplateAliasDeps & {
		stdout?: Pick<NodeJS.WriteStream, "write">;
		stderr?: Pick<NodeJS.WriteStream, "write">;
	} = {},
): Promise<number> {
	const stdout = deps.stdout ?? process.stdout;
	const stderr = deps.stderr ?? process.stderr;
	try {
		const result = await publishFableTemplateAlias(parseArgs(argv), deps);
		stdout.write(`${JSON.stringify(result)}\n`);
		return 0;
	} catch (error) {
		stderr.write(
			`publish-fable-template-alias: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return 1;
	}
}

if (
	typeof process !== "undefined" &&
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	void runPublishFableTemplateAliasCli(process.argv).then((code) => {
		process.exitCode = code;
	});
}
