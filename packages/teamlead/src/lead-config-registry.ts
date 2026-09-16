import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { compileLeadIdentityRows } from "flywheel-comm/lead-identity";
import {
	readRegularFileNoFollow,
	writeAtomic,
} from "flywheel-comm/lead-registry-file-io";
import { readSummaryGranularity } from "flywheel-comm/summary-config";
import { verifySummaryRegistryActivation } from "flywheel-comm/summary-registry-migration";
import {
	canonicalSubmissionDigest,
	type ModelConfigSnapshot,
} from "flywheel-config";
import { withMigrationConfigLock } from "./bin/backend-migration-config-lock.js";
import { validateProjectsText } from "./bin/validate-projects.js";
import { planLeadConfigChange } from "./lead-config-plan.js";
import type { LeadConfigOperationInput, StateStore } from "./StateStore.js";

function sha(value: string) {
	return createHash("sha256").update(value).digest("hex");
}
function same(a: unknown, b: unknown) {
	return canonicalSubmissionDigest(a) === canonicalSubmissionDigest(b);
}
export interface LeadConfigRegistryIntent extends LeadConfigOperationInput {
	externalPriorDigest?: string;
	sourceReceiptSha: string;
	resolved: { model: string; effort: string };
}
/** Local file transaction only. Runtime admission must happen before plan/commit; network work stays outside the lock. */
export class LeadConfigRegistryWriter {
	private baseline = new Map<
		string,
		Pick<
			LeadConfigRegistryIntent,
			"identityDigest" | "configDigest" | "postimage" | "sourceReceiptSha"
		>
	>();
	private latest(leadKey: string) {
		return this.deps.store
			.listLeadConfigOperations(leadKey)
			.filter((op) => op.status !== "conflict")
			.at(-1);
	}
	/** The first untracked read establishes a baseline; it does not invent an editor or historical change. */
	externalCandidates(): LeadConfigRegistryIntent[] {
		const current = this.read(),
			snapshot = this.deps.modelSnapshot(),
			out: LeadConfigRegistryIntent[] = [];
		for (const row of compileLeadIdentityRows(
			JSON.parse(current.source),
			current.identityOptions,
		)) {
			if (row.identity.backend !== "codex-app-server") continue;
			// Directly deleting defaults has no verified native resolution here.
			// Tracked operations remain unavailable via assertCurrent rather than inventing defaults.
			if (
				typeof row.lead.model !== "string" ||
				typeof row.lead.effort !== "string"
			)
				continue;
			const latest = this.latest(row.identity.leadKey);
			if (latest?.status === "prepared") continue;
			const fields = Object.fromEntries(
				["model", "effort"]
					.filter((key) => Object.hasOwn(row.lead, key))
					.map((key) => [key, row.lead[key]]),
			);
			const planned = planLeadConfigChange({
				source: current.source,
				projectName: row.identity.projectName,
				leadId: row.identity.leadId,
				restore: fields,
				identityOptions: current.identityOptions,
				modelSnapshot: snapshot,
			});
			const prior =
				(latest?.input as LeadConfigRegistryIntent | undefined) ??
				this.baseline.get(row.identity.leadKey);
			if (!prior) {
				this.baseline.set(row.identity.leadKey, {
					identityDigest: row.identity.identityDigest,
					configDigest: planned.configDigest,
					postimage: planned.postimage,
					sourceReceiptSha: current.sourceReceiptSha,
				});
				continue;
			}
			if (
				prior.identityDigest !== row.identity.identityDigest ||
				prior.sourceReceiptSha !== current.sourceReceiptSha
			)
				throw new Error("external_lead_identity_changed");
			if (same(prior.postimage, planned.postimage)) continue;
			const intent = {
				operationId: randomUUID(),
				projectName: row.identity.projectName,
				leadId: row.identity.leadId,
				leadKey: row.identity.leadKey,
				identityDigest: row.identity.identityDigest,
				summaryAssignmentDigest: current.receipt.summaryAssignmentDigest,
				actor: "external_registry_change",
				reason:
					"Validated registry tuning changed outside the managed writer; editor unverified",
				preProjectsSha: sha(current.source),
				postProjectsSha: sha(current.source),
				preimage: prior.postimage,
				postimage: planned.postimage,
				resolved: planned.resolved,
				sourceReceiptSha: current.sourceReceiptSha,
				configDigest: planned.configDigest,
				modelRegistryRevision: snapshot.revision,
				externalPriorDigest: prior.configDigest,
			};
			out.push({ ...intent, requestDigest: canonicalSubmissionDigest(intent) });
		}
		return out;
	}
	/** Adopt observed bytes only; never normalize, rewrite or roll back another editor's file. */
	async adoptExternal(intent: LeadConfigRegistryIntent) {
		this.validateIntent(intent);
		if (intent.actor !== "external_registry_change")
			throw new Error("not_external_intent");
		const source = this.read();
		let result = this.deps.store.getLeadConfigOperation(intent.operationId);
		await withMigrationConfigLock(
			{
				home: this.deps.home,
				root: this.deps.root,
				lockPath: source.lockPath,
				assertWindow: () => {},
			},
			(assertHeld) => {
				const current = this.read();
				if (
					current.lockPath !== source.lockPath ||
					sha(current.source) !== intent.postProjectsSha ||
					intent.preProjectsSha !== intent.postProjectsSha
				)
					throw new Error("external_registry_changed");
				this.assertCurrent(intent);
				const planned = planLeadConfigChange({
					source: current.source,
					projectName: intent.projectName,
					leadId: intent.leadId,
					restore: intent.postimage,
					identityOptions: current.identityOptions,
					modelSnapshot: this.deps.modelSnapshot(),
				});
				if (planned.configDigest !== intent.configDigest)
					throw new Error("external_registry_changed");
				const latest = this.latest(intent.leadKey);
				if (latest?.status === "prepared")
					throw new Error("lead_registry_recovery_required");
				if (latest?.input.configDigest === intent.configDigest) {
					result = latest;
					return;
				}
				if (latest && latest.input.configDigest !== intent.externalPriorDigest)
					throw new Error("external_registry_changed");
				assertHeld();
				this.deps.store.prepareLeadConfigOperation(intent);
				result = this.deps.store.transitionLeadConfigOperation(
					intent.operationId,
					"prepared",
					"registry_committed",
					{
						external: true,
						editorVerified: false,
						projectsSha: intent.postProjectsSha,
						beforeConfigDigest: intent.externalPriorDigest,
						afterConfigDigest: intent.configDigest,
					},
				);
			},
		);
		if (!result) throw new Error("external_adoption_missing");
		return result;
	}

	constructor(
		private readonly deps: {
			store: StateStore;
			projectsPath: string;
			receiptPath: string;
			home: string;
			root: string;
			modelSnapshot: () => ModelConfigSnapshot;
			env?: NodeJS.ProcessEnv;
			afterRename?: () => void;
		},
	) {}
	private read() {
		if ((this.deps.env ?? process.env).FLYWHEEL_PROJECTS)
			throw new Error("registry_source_env_pinned");
		if (
			!isAbsolute(this.deps.projectsPath) ||
			!isAbsolute(this.deps.receiptPath)
		)
			throw new Error("registry_path_invalid");
		const source = readRegularFileNoFollow(
			this.deps.projectsPath,
			"projects registry",
		);
		const projectsPath = realpathSync(this.deps.projectsPath);
		const lockPath = `${projectsPath}.cfglock`;
		const env = this.deps.env ?? process.env;
		for (const key of ["FLEET_CONFIG_LOCK_FILE", "FLYWHEEL_CONFIG_LOCK_FILE"])
			if (env[key] !== undefined && env[key] !== lockPath)
				throw new Error("config_lock_path_conflict");
		if (existsSync(`${this.deps.receiptPath}.lead-registry-intent.json`))
			throw new Error("lead_registry_recovery_required");
		const receiptBytes = readRegularFileNoFollow(
			this.deps.receiptPath,
			"summary receipt",
		);
		const receipt = verifySummaryRegistryActivation(
			{
				projectsPath,
				receiptPath: this.deps.receiptPath,
				homeDir: this.deps.home,
			},
			{
				validateTeamleadCandidate: (path) => {
					const result = validateProjectsText(
						readRegularFileNoFollow(path, "projects candidate"),
					);
					if (result.code !== 0) throw new Error("projects_schema_invalid");
				},
			},
		);
		const identityOptions = {
			homeDir: this.deps.home,
			summarySelection: readSummaryGranularity({ homeDir: this.deps.home }),
		};
		if (
			readRegularFileNoFollow(projectsPath, "projects registry") !== source ||
			readRegularFileNoFollow(this.deps.receiptPath, "summary receipt") !==
				receiptBytes
		)
			throw new Error("registry_source_changed_during_validation");
		return {
			source,
			projectsPath,
			lockPath,
			receipt,
			sourceReceiptSha: sha(receiptBytes),
			identityOptions,
		};
	}
	plan(input: {
		operationId: string;
		projectName: string;
		leadId: string;
		reason: string;
		patch?: unknown;
		restore?: unknown;
		defaults?: { model: string; effort: string };
	}): LeadConfigRegistryIntent {
		if (
			!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
				input.operationId,
			) ||
			!input.reason.trim() ||
			input.reason.length > 1000 ||
			Array.from(input.reason).some(
				(c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
			)
		)
			throw new Error("invalid_operation_metadata");
		const source = this.read();
		const planned = planLeadConfigChange({
			...input,
			source: source.source,
			identityOptions: source.identityOptions,
			modelSnapshot: this.deps.modelSnapshot(),
		});
		if (validateProjectsText(planned.candidate).code !== 0)
			throw new Error("projects_schema_invalid");
		const intent = {
			operationId: input.operationId,
			projectName: input.projectName,
			leadId: input.leadId,
			leadKey: planned.identity.leadKey,
			identityDigest: planned.identity.identityDigest,
			summaryAssignmentDigest: source.receipt.summaryAssignmentDigest,
			actor: "bridge-local-operator",
			reason: input.reason,
			preProjectsSha: planned.preProjectsSha,
			postProjectsSha: planned.postProjectsSha,
			preimage: planned.preimage,
			postimage: planned.postimage,
			resolved: planned.resolved,
			sourceReceiptSha: source.sourceReceiptSha,
			configDigest: planned.configDigest,
			modelRegistryRevision: planned.modelRegistryRevision,
		};
		return { ...intent, requestDigest: canonicalSubmissionDigest(intent) };
	}
	private conflict(operationId: string, reason: string) {
		return this.deps.store.transitionLeadConfigOperation(
			operationId,
			"prepared",
			"conflict",
			{ reason },
		);
	}
	private validateIntent(intent: LeadConfigRegistryIntent) {
		const { requestDigest, ...canonical } = intent;
		if (
			requestDigest !== canonicalSubmissionDigest(canonical) ||
			!["bridge-local-operator", "external_registry_change"].includes(
				intent.actor,
			)
		)
			throw new Error("lead_config_intent_invalid");
	}
	/** Revalidate the desired fields before any runtime push; unrelated file edits are retained. */
	assertCurrent(intent: LeadConfigRegistryIntent): void {
		this.validateIntent(intent);
		const current = this.read();
		const target = this.assertEvidence(current, intent);
		const fields = Object.fromEntries(
			["model", "effort"]
				.filter((key) => Object.hasOwn(target.lead, key))
				.map((key) => [key, target.lead[key]]),
		);
		if (
			canonicalSubmissionDigest(fields) !==
			canonicalSubmissionDigest(intent.postimage)
		)
			throw new Error("target_postimage_conflict");
		if (this.deps.modelSnapshot().revision !== intent.modelRegistryRevision)
			throw new Error("model_registry_changed");
	}

	async commit(intent: LeadConfigRegistryIntent) {
		if (intent.actor === "external_registry_change")
			throw new Error("external_intent_requires_adoption");
		this.validateIntent(intent);
		const prior = this.deps.store.getLeadConfigOperation(intent.operationId);
		if (prior) {
			if (prior.input.requestDigest !== intent.requestDigest)
				throw new Error("operation_id_conflict");
			if (prior.status !== "prepared") return prior;
		}
		const source = this.read();
		if (!prior) this.deps.store.prepareLeadConfigOperation(intent);
		await withMigrationConfigLock(
			{
				home: this.deps.home,
				root: this.deps.root,
				lockPath: source.lockPath,
				assertWindow: () => {},
			},
			(assertHeld) => {
				if (
					this.deps.store.getLeadConfigOperation(intent.operationId)?.status !==
					"prepared"
				)
					return;
				const current = this.read();
				if (current.lockPath !== source.lockPath)
					throw new Error("registry_path_changed");
				if (sha(current.source) !== intent.preProjectsSha) {
					if (prior) {
						this.reconcileUnderLock(current, intent, assertHeld);
						return;
					}
					this.conflict(intent.operationId, "projects_source_changed");
					throw new Error("projects_source_changed");
				}
				this.assertEvidence(current, intent);
				const snapshot = this.deps.modelSnapshot();
				if (snapshot.revision !== intent.modelRegistryRevision)
					throw new Error("model_registry_changed");
				const planned = planLeadConfigChange({
					source: current.source,
					projectName: intent.projectName,
					leadId: intent.leadId,
					restore: intent.postimage,
					defaults: intent.resolved,
					identityOptions: current.identityOptions,
					modelSnapshot: snapshot,
				});
				if (
					planned.postProjectsSha !== intent.postProjectsSha ||
					planned.configDigest !== intent.configDigest
				)
					throw new Error("lead_config_candidate_changed");
				if (validateProjectsText(planned.candidate).code !== 0)
					throw new Error("projects_schema_invalid");
				assertHeld();
				writeAtomic(current.projectsPath, planned.candidate);
				this.deps.afterRename?.();
				assertHeld();
				const written = this.read();
				this.assertEvidence(written, intent);
				if (sha(written.source) !== intent.postProjectsSha)
					throw new Error("projects_postimage_changed");
				this.deps.store.transitionLeadConfigOperation(
					intent.operationId,
					"prepared",
					"registry_committed",
					{ projectsSha: intent.postProjectsSha, rebased: false },
				);
			},
		);
		return this.deps.store.getLeadConfigOperation(intent.operationId)!;
	}
	private assertEvidence(
		current: ReturnType<LeadConfigRegistryWriter["read"]>,
		intent: LeadConfigRegistryIntent,
	) {
		if (
			current.sourceReceiptSha !== intent.sourceReceiptSha ||
			current.receipt.summaryAssignmentDigest !== intent.summaryAssignmentDigest
		)
			throw new Error("summary_receipt_changed");
		const target = compileLeadIdentityRows(
			JSON.parse(current.source),
			current.identityOptions,
		).find(
			(row) =>
				row.identity.projectName === intent.projectName &&
				row.identity.leadId === intent.leadId,
		);
		if (
			!target ||
			target.identity.identityDigest !== intent.identityDigest ||
			target.identity.leadKey !== intent.leadKey
		)
			throw new Error("lead_identity_changed");
		return target;
	}
	private reconcileUnderLock(
		current: ReturnType<LeadConfigRegistryWriter["read"]>,
		intent: LeadConfigRegistryIntent,
		assertHeld: () => void,
	) {
		const operationId = intent.operationId;
		const target = this.assertEvidence(current, intent);
		const currentSha = sha(current.source);
		if (
			currentSha === intent.preProjectsSha &&
			intent.preProjectsSha !== intent.postProjectsSha
		) {
			this.conflict(operationId, "prepared_not_written");
			return;
		}
		const fields = Object.fromEntries(
			["model", "effort"]
				.filter((key) => Object.hasOwn(target.lead, key))
				.map((key) => [key, target.lead[key]]),
		);
		if (
			canonicalSubmissionDigest(fields) !==
			canonicalSubmissionDigest(intent.postimage)
		) {
			this.conflict(operationId, "target_postimage_conflict");
			return;
		}
		assertHeld();
		this.deps.store.transitionLeadConfigOperation(
			operationId,
			"prepared",
			"registry_committed",
			{
				projectsSha: currentSha,
				rebased: currentSha !== intent.postProjectsSha,
				recovered: true,
			},
		);
	}

	async recover(operationId: string) {
		const operation = this.deps.store.getLeadConfigOperation(operationId);
		if (!operation) throw new Error("lead_config_operation_not_found");
		if (operation.status !== "prepared") return operation;
		const intent = operation.input as LeadConfigRegistryIntent;
		this.validateIntent(intent);
		const source = this.read();
		await withMigrationConfigLock(
			{
				home: this.deps.home,
				root: this.deps.root,
				lockPath: source.lockPath,
				assertWindow: () => {},
			},
			(assertHeld) => {
				const current = this.read();
				if (current.lockPath !== source.lockPath)
					throw new Error("registry_path_changed");
				if (
					this.deps.store.getLeadConfigOperation(operationId)?.status !==
					"prepared"
				)
					return;
				this.reconcileUnderLock(current, intent, assertHeld);
			},
		);
		return this.deps.store.getLeadConfigOperation(operationId)!;
	}
}
