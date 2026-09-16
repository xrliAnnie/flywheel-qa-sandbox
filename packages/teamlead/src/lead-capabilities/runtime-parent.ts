import {
	lstatSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";
import {
	buildCodexLeadMcpArgv,
	type CodexLeadMcpResult,
} from "../lead-backends/codex/buildCodexLeadMcpArgv.js";
import type { HttpPost } from "../lead-backends/codex/CodexOutboundSender.js";
import { validateLeadCapabilityManifest } from "../lead-backends/codex/lead-capability-proxy.js";
import type { SqliteJournalStore } from "../lead-backends/codex/SqliteJournalStore.js";
import { LeadCapabilityBroker, type LeadOperationHandler } from "./broker.js";
import { LeadCapabilitySocket } from "./broker-socket.js";
import { ensureLeadCapabilityHome } from "./capability-home.js";
import { getLeadCapability } from "./catalog.js";
import {
	leadCredentialAliases,
	pinLeadCredentialPaths,
} from "./credential-paths.js";
import type { LeadCapabilityManifest } from "./manifest.js";
import { readManifestInstructions } from "./manifest-instructions.js";
import { installManifestSkills } from "./manifest-skills.js";
import { buildLeadModelEnv, type LeadModelEnvPins } from "./model-env.js";
import { verifyModelIsolation } from "./model-isolation.js";
import {
	assertLeadPermissionProfile,
	LEAD_PERMISSION_PROFILE,
	type LeadPermissionProfileSpec,
	leadModelWritableRoot,
} from "./permission-profile.js";

export interface LeadCapabilityParent {
	readonly codexPath: string;
	readonly skillGaps?: LeadCapabilityManifest["skillGaps"];
	readonly skillSources?: {
		configured: ReturnType<typeof installManifestSkills>["receipts"];
		native: ReturnType<typeof installManifestSkills>["nativeReceipts"];
	};
	readonly pins: LeadModelEnvPins;
	readonly baseInstructions: string;
	readonly mcp: CodexLeadMcpResult;
	readonly permissionArgv: readonly string[];
	readonly outboundPost: HttpPost;
	enterDeliveryContext(entryId: string): () => void;
	assertCurrent(): Promise<void>;
	verifyEffectiveConfig(config: unknown): Promise<void>;
	verifyEffectiveSkills?(actual: unknown, cwd: string): Promise<void>;
	close(): Promise<void>;
}
export interface LeadCapabilityParentOptions {
	manifest: LeadCapabilityManifest;
	journal: SqliteJournalStore;
	activationRoot: string;
	codexHome: string;
	artifactRoot: string;
	modelTempRoot: string;
	nodePath: string;
	codexPath: string;
	/** Observed from the deployment-pinned executable by the factory. */
	codexVersion?: string;
	/** Parent environment is washed by the model verifier before subprocess launch. */
	modelEnv?: NodeJS.ProcessEnv;
	/** Trusted abort-aware adapter; no direct Discord fallback when absent. */
	outboundTransport?: HttpPost;
	proxyEntryPath: string;
	handlers: ReadonlyMap<string, LeadOperationHandler>;
	secrets: readonly string[];
	permissionProfile: Omit<
		LeadPermissionProfileSpec,
		"brokerSocket" | "artifactRoot"
	>;
	/** Re-read current registry, carrier and activation policy; manifest is not authority. */
	assertCurrent(): Promise<void>;
	/** Verify actual deployed home/effective permissions and required isolation evidence. */
	verifyDeployment(input: {
		pins: LeadModelEnvPins;
		mcp: CodexLeadMcpResult;
		permissionProfile: LeadPermissionProfileSpec;
	}): Promise<void>;
	/** Own only this activation's already-prepared providers/browser. */
	closeProviders(): Promise<void>;
}
/** Parent-owned transport/receipt lifecycle. The outer runtime owns the shared journal. */
export async function startLeadCapabilityParent(
	options: LeadCapabilityParentOptions,
): Promise<LeadCapabilityParent> {
	let skills: ReturnType<typeof installManifestSkills> | undefined;
	let directory: string | undefined;
	let credentials: ReturnType<typeof pinLeadCredentialPaths> | undefined;
	const credentialEnv = Object.freeze({ ...(options.modelEnv ?? process.env) });
	let aliases: readonly string[] | undefined;
	let broker: LeadCapabilityBroker | undefined;
	let socket: LeadCapabilitySocket | undefined;
	let closing: Promise<void> | undefined;
	let closed = false;
	const outbound = new Map<AbortController, Promise<unknown>>();
	const outboundTransport = options.outboundTransport;
	let delivery: { id: string; assertCurrent(): void } | undefined;
	const enterDeliveryContext = (entryId: string) => {
		if (
			closed ||
			delivery ||
			options.journal.getById(entryId)?.state !== "dispatching"
		)
			throw new Error("delivery_context_not_current");
		const binding = Object.freeze({
			id: entryId,
			assertCurrent: () => {
				const state = options.journal.getById(entryId)?.state;
				if (
					closed ||
					delivery !== binding ||
					!state ||
					![
						"dispatching",
						"dispatched",
						"model_completed",
						"output_pending",
					].includes(state)
				)
					throw new Error("delivery_context_not_current");
			},
		});
		delivery = binding;
		return () => {
			if (delivery === binding) delivery = undefined;
		};
	};
	const close = () => {
		if (closing) return closing;
		closed = true;
		delivery = undefined;
		for (const controller of outbound.keys()) controller.abort();
		closing = (async () => {
			try {
				await Promise.allSettled([...outbound.values()]);
				await socket?.close();
			} finally {
				try {
					await broker?.close();
				} finally {
					try {
						await options.closeProviders();
					} finally {
						try {
							skills?.close();
						} finally {
							if (directory)
								rmSync(directory, { recursive: true, force: true });
						}
					}
				}
			}
		})();
		return closing;
	};
	const current = async () => {
		if (closed) throw new Error("capability_parent_closed");
		await options.assertCurrent();
		credentials?.assertCurrent();
		skills?.assertCurrent();
		if (
			aliases &&
			JSON.stringify(
				leadCredentialAliases(credentialEnv, options.codexHome),
			) !== JSON.stringify(aliases)
		)
			throw new Error("credential_source_changed");
		if (closed) throw new Error("capability_parent_closed");
	};
	const outboundPost: HttpPost = (request) => {
		if (closed || !outboundTransport)
			return Promise.reject(new Error("capability_outbound_unavailable"));
		const controller = new AbortController();
		const signal = request.signal
			? AbortSignal.any([request.signal, controller.signal])
			: controller.signal;
		const task = (async () => {
			try {
				await current();
				signal.throwIfAborted();
				const result = await outboundTransport({ ...request, signal });
				await current();
				signal.throwIfAborted();
				return result;
			} finally {
				outbound.delete(controller);
			}
		})();
		outbound.set(controller, task);
		return task;
	};
	try {
		aliases = leadCredentialAliases(credentialEnv, options.codexHome);
		credentials = pinLeadCredentialPaths([
			...aliases,
			...options.permissionProfile.credentialPaths,
			join(options.permissionProfile.deploymentRoot, ".env"),
			join(options.permissionProfile.deploymentRoot, "packages/teamlead/.env"),
		]);
		await current();
		const manifest = validateLeadCapabilityManifest(options.manifest);
		const sourceInstructions = readManifestInstructions(
			manifest.ruleSources,
			options.secrets,
		);
		const skillGaps = manifest.skillGaps ?? [];
		const baseInstructions =
			sourceInstructions +
			(skillGaps.length
				? `\n\nPersona skill source gaps (startup receipt):\n${skillGaps.map((gap) => `${gap.sourceId}: ${gap.reason}`).join("\n")}\nUse the canonical manual fallback for these skills; do not claim their instructions are loaded. For runner_workflow_not_lead_capability, dispatch the authorized Runner workflow rather than running its lease, checkpoint, scheduler or video helpers in the Lead. For authenticated_research_not_available and research_provider_not_admitted, delegate to an authorized Runner or interactive research; do not present public browsing as subscription Deep Research or run unadmitted provider helpers.`
				: "");
		skills = installManifestSkills({
			codexHome: options.codexHome,
			sources: manifest.skillSources,
			secrets: options.secrets,
			nativeBaseline: manifest.nativeSkillBaseline,
			codexVersion: options.codexVersion,
		});
		const publicJson = JSON.stringify(manifest);
		if (options.secrets.some((s) => s.length > 0 && publicJson.includes(s)))
			throw new Error("unsafe_capability_manifest");
		const handlers = new Map(options.handlers);
		for (const id of manifest.operationIds)
			if (
				!getLeadCapability(id)!.unconditionalDenial &&
				!handlers.has(getLeadCapability(id)!.handlerKey!)
			)
				throw new Error("capability_handler_missing");
		const root = lstatSync(options.activationRoot);
		if (
			!root.isDirectory() ||
			root.isSymbolicLink() ||
			realpathSync(options.activationRoot) !== options.activationRoot ||
			(root.mode & 0o077) !== 0 ||
			root.uid !== process.getuid?.()
		)
			throw new Error("capability_parent_root_invalid");
		directory = mkdtempSync(join(options.activationRoot, "run-"));
		const pins: LeadModelEnvPins = Object.freeze({
			codexHome: options.codexHome,
			brokerSocket: join(directory, "broker.sock"),
			manifestPath: join(directory, "manifest.json"),
			artifactRoot: options.artifactRoot,
			modelTempRoot: options.modelTempRoot,
			projectName: manifest.projectName,
			leadId: manifest.leadId,
			activationId: manifest.activationId,
		});
		const writableRoot = leadModelWritableRoot(options.permissionProfile);
		if (
			!pins.modelTempRoot.startsWith(`${writableRoot}/`) ||
			realpathSync(pins.modelTempRoot) !== pins.modelTempRoot ||
			!lstatSync(pins.modelTempRoot).isDirectory()
		)
			throw new Error("model_temp_outside_workspace");
		buildLeadModelEnv({}, pins);
		const mcp = buildCodexLeadMcpArgv({
			capabilityV2: {
				nodePath: options.nodePath,
				proxyEntryPath: options.proxyEntryPath,
				socketPath: pins.brokerSocket,
				manifestPath: pins.manifestPath,
				manifest,
			},
		});
		const expectedMcp = parse(
			mcp.argv.filter((_, index) => index % 2 === 1).join("\n"),
		).mcp_servers as Record<string, Record<string, unknown>>;
		writeFileSync(pins.manifestPath, publicJson, { mode: 0o400, flag: "wx" });
		const permissionProfile = structuredClone({
			...options.permissionProfile,
			credentialPaths: [...credentials.paths],
			artifactRoot: pins.artifactRoot,
			brokerSocket: pins.brokerSocket,
		});
		await ensureLeadCapabilityHome({
			codexHome: pins.codexHome,
			activationRoot: options.activationRoot,
			permissionProfile,
			assertCurrent: current,
		});
		await verifyModelIsolation({
			codexExecutable: options.codexPath,
			nodeExecutable: options.nodePath,
			pins,
			projectRoot: permissionProfile.projectRoot,
			deploymentRoot: permissionProfile.deploymentRoot,
			credentialProbePath: join(options.codexHome, "auth.json"),
			proxyPort: permissionProfile.proxyPort,
			env: options.modelEnv ?? process.env,
			assertCurrent: current,
		});
		await options.verifyDeployment({
			pins,
			mcp,
			permissionProfile: structuredClone(permissionProfile),
		});
		await current();
		// The lifecycle owner has acquired this Lead's carrier before parent startup.
		// Recover before admitting requests; prior activations may only reconcile.
		options.journal.operationReceipts.recoverInterruptedParent({
			projectName: manifest.projectName,
			leadId: manifest.leadId,
			now: Date.now(),
		});
		broker = new LeadCapabilityBroker({
			projectName: manifest.projectName,
			leadId: manifest.leadId,
			activationId: manifest.activationId,
			receipts: options.journal.operationReceipts,
			allowedOperationIds: () => new Set(manifest.operationIds),
			assertCurrent: current,
			handlers,
			secrets: options.secrets,
			deliveryContext: () => delivery,
		});
		socket = new LeadCapabilitySocket({
			socketPath: pins.brokerSocket,
			dispatch: (raw) => broker!.execute(raw),
		});
		await socket.listen();
		await current();
		return Object.freeze({
			codexPath: options.codexPath,
			skillGaps,
			skillSources: {
				configured: skills.receipts,
				native: skills.nativeReceipts,
			},
			baseInstructions,
			outboundPost,
			enterDeliveryContext,
			pins,
			mcp,
			permissionArgv: Object.freeze([
				"-c",
				`default_permissions=${JSON.stringify(LEAD_PERMISSION_PROFILE)}`,
			]),
			assertCurrent: current,
			verifyEffectiveSkills: async (actual: unknown, cwd: string) => {
				await current();
				skills!.assertDiscovery(actual, cwd);
				await current();
			},
			verifyEffectiveConfig: async (config: unknown) => {
				await current();
				assertLeadPermissionProfile(config, permissionProfile);
				const actualMcp = (config as Record<string, unknown>).mcp_servers;
				if (
					!actualMcp ||
					typeof actualMcp !== "object" ||
					!isDeepStrictEqual(
						Object.keys(actualMcp).sort(),
						Object.keys(expectedMcp).sort(),
					)
				)
					throw new Error("capability_effective_mcp_mismatch");
				for (const [name, expected] of Object.entries(expectedMcp)) {
					const actual = (actualMcp as Record<string, Record<string, unknown>>)[
						name
					];
					if (
						!actual ||
						Object.entries(expected).some(
							([key, value]) => !isDeepStrictEqual(actual[key], value),
						) ||
						[
							"url",
							"cwd",
							"bearer_token_env_var",
							"http_headers",
							"env_http_headers",
						].some((key) => actual[key] != null) ||
						(actual.env_vars != null && !isDeepStrictEqual(actual.env_vars, []))
					)
						throw new Error("capability_effective_mcp_mismatch");
				}

				await current();
			},
			close,
		});
	} catch (error) {
		try {
			await close();
		} catch {
			/* Preserve the initial failure after best-effort cleanup. */
		}
		throw error;
	}
}
