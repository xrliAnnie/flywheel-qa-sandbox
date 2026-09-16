import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { parseCustomerReleaseConfig } from "flywheel-config";
import { deriveBetaCandidate } from "flywheel-release-contract";
import { parse } from "yaml";
import { readLocalDeployedSha } from "../release-readiness/subject.js";
import { CustomerReleaseAccountingPump } from "./accounting-pump.js";
import { ReleaseCandidateActions } from "./actions.js";
import { CustomerReleaseAdvance } from "./advance.js";
import { CustomerReleaseAuthority } from "./authority.js";
import { ReleaseControlDelivery } from "./control-delivery.js";
import {
	ReleaseControlTrigger,
	readReleaseControlRequest,
} from "./control-trigger.js";
import { ReleaseActivationActions } from "./controls.js";
import { CustomerReleaseNoticeDelivery } from "./delivery.js";
import { ReleaseDiscordClient } from "./discord.js";
import { CustomerReleaseDispatch } from "./dispatch.js";
import { readReleaseActivationEvidence } from "./evidence.js";
import { CustomerReleaseMailbox } from "./executor.js";
import { CustomerReleaseFenceRecovery } from "./fence-recovery.js";
import { CustomerReleaseGitHub } from "./github.js";
import { ReleaseInteractionGateway } from "./interaction-gateway.js";
import type { ManualReleaseDelivery } from "./manual.js";
import { ManualReleaseCardDelivery } from "./manual-delivery.js";
import { ManualReleaseExecutor } from "./manual-executor.js";
import { ManualReleaseIntake } from "./manual-intake.js";
import { ManualReleasePreparation } from "./manual-preparation.js";
import { CustomerReleaseDecisionPump } from "./pump.js";
import { CustomerReleaseRuntime } from "./runtime.js";
import { CustomerReleaseSource } from "./source.js";
import type { CustomerReleaseStore } from "./store.js";

interface Options {
	store: () => CustomerReleaseStore;
	projects: () => {
		projectName: string;
		projectRoot: string;
		projectRepo?: string;
	}[];
	founderId: () => string | null;
	env: Readonly<Record<string, string | undefined>>;
	codeSha: () => string | null;
	flag: () => boolean;
	evaluate: (
		subject: { sourceCommit: string; baseVersion: string },
		at: string,
	) => { verdictId: string; state: string };
	fetch?: typeof fetch;
	now?: () => number;
	onError?: (code: string) => void;
	bugLabel?: () => string;
	recordBugSourceHealth?: (input: {
		activationEpoch: number;
		label: string;
		ok: boolean;
		error?: string;
		at: string;
	}) => void;
}
const hash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
function valid(value: unknown): asserts value {
	if (!value) throw new Error("release host configuration unavailable");
}
function deployment(options: Options) {
	const text = options.env.FW_CUSTOMER_RELEASE_RUNTIME_JSON;
	if (!text) return null;
	valid(text.length <= 16384);
	const raw = JSON.parse(text);
	const keys = [
		"endpoint",
		"audience",
		"environment",
		"evidenceDirectory",
		"prepareWorkflowId",
		"reviewedWorkflowSha",
		"githubTokenEnv",
		"payloadReadTokenEnv",
	];
	valid(
		raw &&
			typeof raw === "object" &&
			!Array.isArray(raw) &&
			Object.keys(raw).length === keys.length &&
			keys.every((k) => Object.hasOwn(raw, k)),
	);
	for (const key of ["githubTokenEnv", "payloadReadTokenEnv"])
		valid(
			typeof raw[key] === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(raw[key]),
		);
	valid(
		Number.isSafeInteger(raw.prepareWorkflowId) &&
			raw.prepareWorkflowId > 0 &&
			/^[a-f0-9]{40}$/.test(raw.reviewedWorkflowSha),
	);
	valid(
		typeof raw.evidenceDirectory === "string" &&
			raw.evidenceDirectory.startsWith("/") &&
			typeof raw.environment === "string",
	);
	valid(typeof raw.endpoint === "string" && typeof raw.audience === "string");
	const codeSha = options.codeSha();
	valid(codeSha && /^[a-f0-9]{40}$/.test(codeSha));
	const githubToken = options.env[raw.githubTokenEnv],
		payloadReadToken = options.env[raw.payloadReadTokenEnv];
	valid(
		githubToken &&
			payloadReadToken &&
			!/[\r\n]/.test(githubToken + payloadReadToken),
	);
	return {
		...raw,
		codeSha,
		githubToken,
		payloadReadToken,
		digest: hash([raw, codeSha, hash(githubToken), hash(payloadReadToken)]),
	};
}
function configured(options: Options) {
	const projects = options
		.projects()
		.filter((p) => p.projectName === "flywheel");
	valid(projects.length === 1);
	const project = projects[0]!,
		root = realpathSync(project.projectRoot);
	const file = realpathSync(join(root, ".flywheel/config.yaml"));
	valid(file.startsWith(root + sep) && statSync(file).size <= 2 * 1024 * 1024);
	const raw = parse(readFileSync(file, "utf8"));
	valid(raw && typeof raw === "object" && !Array.isArray(raw));
	return { project, config: parseCustomerReleaseConfig(raw.customer_release) };
}
/** Actual Bridge composition root. Each retained session owns its original
 * mailbox credentials until unresolved decisions drain; replacement never
 * hands an old permit to a new endpoint or credential set. */
export function createCustomerReleaseHost(options: Options) {
	const now = options.now ?? Date.now;
	let running = false,
		timer: ReturnType<typeof setTimeout> | null = null,
		flight: Promise<void> | null = null;
	type Session = ReturnType<typeof createSession>;
	let session: Session | null = null;
	let lastError: string | null = null;
	function report(code: string) {
		if (lastError !== code) options.onError?.(code);
		lastError = code;
	}

	const accounting = new CustomerReleaseAccountingPump({
		...options,
		onError: report,
	});
	function read() {
		if (
			!options.projects().some((project) => project.projectName === "flywheel")
		)
			return null;
		const entry = configured(options);
		if (entry.config.mode === "off" && !entry.config.bot_token_env) return null;
		const deploy = deployment(options);
		valid(deploy);
		const input = {
			config: entry.config,
			founderId: options.founderId(),
			endpoint: deploy.endpoint,
			audience: deploy.audience,
			env: options.env,
			deploymentDigest: deploy.digest,
		};
		return { ...entry, deploy, input };
	}
	function createSession(current: NonNullable<ReturnType<typeof read>>) {
		const store = options.store(),
			fixed = current,
			controller = new AbortController();
		let gateway: ReleaseInteractionGateway;
		const authority = new CustomerReleaseAuthority({
			store,
			input: () => {
				const value = read();
				valid(value);
				return value.input;
			},
			flag: options.flag,
			healthy: () => gateway?.healthy() ?? false,
			now,
			evidence: (identity) => {
				const value = read();
				valid(value);
				return (
					readReleaseActivationEvidence(
						value.deploy.evidenceDirectory,
						{
							environment: value.deploy.environment,
							endpoint: identity.endpoint,
							codeSha: value.deploy.codeSha,
							policyRevision: identity.policyRevision,
							identityDigest: identity.identityDigest,
						},
						now(),
					)?.digest ?? null
				);
			},
		});
		const snapshot = () => {
			const value = authority.read();
			valid(value);
			return value;
		};
		const initial = snapshot(),
			stamp = initial.identity.identityDigest,
			epoch = initial.target.epoch;
		const target = () => {
			const value = snapshot();
			valid(
				value.identity.identityDigest === stamp && value.target.epoch === epoch,
			);
			return value.target;
		};
		const manualDelivery = new Map<string, ManualReleaseDelivery>();
		const candidates = new ReleaseCandidateActions({
			store,
			target,
			now,
			manualDelivery: (id) => manualDelivery.get(id) ?? null,
		});
		const controls = new ReleaseActivationActions({
			store,
			target,
			now,
			evidenceDigest: () => snapshot().evidenceDigest,
		});
		const token = fixed.input.env[initial.config.bot_token_env!];
		valid(token);
		gateway = new ReleaseInteractionGateway({
			...initial.target,
			token,
			founderId: () => options.founderId(),
			epoch: () => snapshot().target.epoch,
			commit: (event) =>
				event.action === "enable" || event.action === "disable"
					? controls.commit(event)
					: candidates.commit(event),
			invalidate: (reason) => store.invalidateRuntime(reason, now()),
			fetch: options.fetch,
		});
		const discord = new ReleaseDiscordClient({
			token,
			target,
			healthy: () => gateway.healthy(),
			now,
			fetch: options.fetch,
		});
		const manualCards = new ManualReleaseCardDelivery({
			store,
			target,
			timezone: () => {
				target();
				const timezone = snapshot().config.timezone;
				valid(timezone);
				return timezone;
			},
			now,
			cache: manualDelivery,
			transport: discord,
		});

		const controlTrigger = new ReleaseControlTrigger({
			snapshot: () => {
				target();
				return snapshot();
			},
			read: () => readReleaseControlRequest(fixed.deploy.evidenceDirectory),
			delivery: new ReleaseControlDelivery({
				store,
				target,
				evidenceDigest: () => snapshot().evidenceDigest,
				transport: discord,
				now,
			}),
			now,
		});

		const decisionToken = fixed.input.env[initial.config.decision_token_env!];
		valid(decisionToken);
		const source = new CustomerReleaseSource({
			endpoint: fixed.deploy.endpoint,
			decisionToken,
			payloadReadToken: fixed.deploy.payloadReadToken,
			now,
			fetch: options.fetch,
		});
		const mailbox = new CustomerReleaseMailbox({
			endpoint: fixed.deploy.endpoint,
			token: decisionToken,
			audience: fixed.deploy.audience,
			activationEpoch: epoch,
			fetch: options.fetch,
		});
		const delivery = new CustomerReleaseNoticeDelivery({
			store,
			transport: discord,
			now,
		});
		const dispatch = new CustomerReleaseDispatch({
			store,
			transport: new CustomerReleaseGitHub({
				token: fixed.deploy.githubToken,
				fetch: options.fetch,
			}),
			now,
		});
		const prepareWorkflow = {
			repository: fixed.project.projectRepo!,
			repositoryId: initial.config.executor_repository_id!,
			workflowId: fixed.deploy.prepareWorkflowId,
			workflowPath: ".github/workflows/payload-promote.yml",
			reviewedSha: fixed.deploy.reviewedWorkflowSha,
		};
		const executorWorkflow = {
			...prepareWorkflow,
			workflowId: initial.config.executor_workflow_id!,
			workflowPath: ".github/workflows/payload-auto-release.yml",
		};
		const manualIntake = new ManualReleaseIntake({
			store,
			snapshot: () => {
				target();
				return snapshot();
			},
			read: () =>
				readReleaseControlRequest(
					fixed.deploy.evidenceDirectory,
					"intake.json",
				),
			source,
			localDeployedSha: () =>
				readLocalDeployedSha(options.env.FLYWHEEL_DEPLOYED_SHA_FILE),
			now,
		});

		const manualPreparation = new ManualReleasePreparation({
			store,
			snapshot: () => {
				target();
				return snapshot();
			},
			read: () =>
				readReleaseControlRequest(
					fixed.deploy.evidenceDirectory,
					"manual.json",
				) ?? manualIntake.preparedRequest(),
			source,
			dispatch,
			workflow: prepareWorkflow,
			now,
		});

		const evaluate = (subject: { sourceCommit: string; baseVersion: string }) =>
			options.evaluate(subject, new Date(now()).toISOString()).verdictId;
		const recovery = new CustomerReleaseFenceRecovery({
			store,
			mailbox,
			dispatch,
			workflow: executorWorkflow,
			now,
		});

		const manualAuthority = () => {
			const current = snapshot();
			target();
			return {
				founderId: current.identity.founderId,
				projectId: "flywheel",
				audience: current.identity.audience,
				activationEpoch: epoch,
				policyRevision: current.identity.policyRevision,
				executionEnabled:
					current.config.mode !== "observe" && gateway.healthy(),
			};
		};
		const manualExecutor = new ManualReleaseExecutor({
			store,
			authority: manualAuthority,
			workflow: executorWorkflow,
			dispatch,
			now,
		});

		const pump = new CustomerReleaseDecisionPump({
			store,
			mailbox: {
				pending: mailbox.pending.bind(mailbox),
				observe: mailbox.observe.bind(mailbox),
				deliverPermit: mailbox.deliverPermit.bind(mailbox),
				requestFence: recovery.requestFence.bind(recovery),
			},
			now,
			readActivation: () => {
				target();
				return snapshot().activation;
			},
			evaluate: (cycle) =>
				evaluate({
					sourceCommit: cycle.frozenBeta.sourceCommit,
					baseVersion: cycle.frozenBeta.baseVersion,
				}),
			probe: async (attempt) => {
				const manifest = await source.manifest(controller.signal),
					receipt = await delivery.probe(attempt.cycleId, controller.signal);
				target();
				valid(receipt);
				return { manifest: manifest.manifest, receipt };
			},
			manual: {
				readAuthority: manualAuthority,
				evaluate: (request) =>
					evaluate({
						sourceCommit: request.binding.sourceCommit,
						baseVersion: request.binding.releaseVersion,
					}),
				probe: async (_attempt, request) => {
					const manifest = await source.manifest(controller.signal);
					await source.prepared(
						manifest.manifest,
						request.binding.releaseId,
						deriveBetaCandidate(manifest.manifest, request.binding.betaVersion),
						controller.signal,
					);
					target();
					return manifest.manifest;
				},
			},
		});
		const advance = new CustomerReleaseAdvance({
			store,
			source,
			dispatch,
			delivery,
			readiness: { evaluate: options.evaluate },
			context: () => {
				target();
				const current = snapshot();
				return {
					config: current.config,
					founderId: current.identity.founderId,
					flagEnabled: current.activation.enabled,
					prepareWorkflow,
					executorWorkflow,
				};
			},
			localDeployedSha: () =>
				readLocalDeployedSha(options.env.FLYWHEEL_DEPLOYED_SHA_FILE),
			now,
		});
		const runtime = new CustomerReleaseRuntime({
			store,
			pump,
			now,
			advance: (signal) =>
				gateway.healthy() ? advance.tick(signal) : Promise.resolve(),
		});
		return {
			store,
			stamp,
			epoch,
			authority,
			gateway,
			pump,
			runtime,
			controller,
			controlTrigger,
			manualCards,
			manualExecutor,
			manualPreparation,
			manualIntake,
			draining: false,
		};
	}
	async function tick() {
		try {
			options.store().accounting.capture(now());
		} catch {
			report("accounting_capture_pending");
		}

		let current: ReturnType<typeof read> = null;
		try {
			current = read();
		} catch {
			report("configuration_invalid");
		}
		if (!session && !current) {
			options
				.store()
				.activation.revoke("host_configuration_unavailable", now());
			return;
		}
		if (session) {
			const existing = session;
			let fresh: ReturnType<CustomerReleaseAuthority["read"]> = null;
			try {
				fresh = existing.authority.read();
			} catch {
				report("authority_unavailable");
			}
			if (
				existing.store !== options.store() ||
				!current ||
				!fresh ||
				fresh.identity.identityDigest !== existing.stamp ||
				fresh.target.epoch !== existing.epoch ||
				existing.draining
			) {
				if (!existing.draining) {
					existing.draining = true;
					existing.controller.abort();
					const stopping = existing.runtime.stop();
					try {
						existing.gateway.stop();
					} finally {
						await stopping;
					}
				} else await existing.pump.tick();
				if (existing.store.unresolvedDecision("flywheel")) return;
				session = null;
			}
		}
		if (!session && current && running) {
			try {
				session = createSession(current);
				await session.gateway.start();
				if (running) session.runtime.start();
			} catch {
				session?.gateway.stop();
				session = null;
				options.store().activation.revoke("host_start_failed", now());
				report("session_unavailable");
			}
		}
		if (session && !session.draining && session.gateway.healthy() && running) {
			await session.controlTrigger.tick(session.controller.signal);
			if (session.authority.read()?.config.mode !== "observe") {
				await session.manualIntake.tick(session.controller.signal);
				await session.manualPreparation.tick(session.controller.signal);
				await session.manualCards.tick(session.controller.signal);
				await session.manualExecutor.tick(session.controller.signal);
			}
		}
	}
	function schedule() {
		if (!running) return;
		timer = setTimeout(() => {
			timer = null;
			flight = tick()
				.catch(() => report("host_tick_failed"))
				.finally(() => {
					flight = null;
					schedule();
				});
		}, 1000);
		timer.unref?.();
	}
	return {
		start() {
			if (running) return;
			running = true;
			accounting.start();
			schedule();
		},
		async stop() {
			running = false;
			const accountingStopped = accounting.stop();
			if (timer) clearTimeout(timer);
			timer = null;
			if (session) {
				session.controller.abort();
				session.pump.pauseClaims();
				const stopping = session.runtime.stop();
				try {
					session.gateway.stop();
				} finally {
					await stopping;
				}
			}
			await flight;
			await accountingStopped;
			if (session) await session.runtime.stop();
		},
	};
}
