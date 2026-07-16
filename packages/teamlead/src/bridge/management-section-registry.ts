import { createHash } from "node:crypto";
import { canonicalJsonString } from "flywheel-config";
import {
	buildTargetId,
	type ExtensionFieldKind,
	type ManagementConsequence,
	type ManagementExtensionField,
	type ManagementExtensionSection,
} from "./management-console-contract.js";
import type { ManagementSnapshotProvider } from "./management-console-snapshot.js";
import {
	type ManagementPreparedChange,
	type ManagementResolvedTarget,
	type ManagementWriter,
	type ManagementWriterResult,
	preparedChange,
	rejectedPreflight,
} from "./management-writer.js";

const SUPPORTED_KINDS = new Set<ExtensionFieldKind>([
	"boolean",
	"number",
	"select",
	"order_list",
]);
const SAFE_SECTION_ID = /^[a-z][a-z0-9-]*$/;
const SAFE_FIELD_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;

export interface ManagementSectionFieldDefinition {
	id: string;
	label: string;
	help?: string;
	kind: ExtensionFieldKind;
	options?: Array<{ id: string; label: string }>;
	writable?: boolean;
	readonlyReason?: string;
	consequence?: ManagementConsequence;
	requiresAcknowledgement?: boolean;
}

export interface ManagementSectionReadResult {
	revision: string;
	values: Record<string, unknown>;
}

export interface ManagementSectionApplyInput {
	expectedRevision: string;
	previousValues: Readonly<Record<string, unknown>>;
	proposedValues: Readonly<Record<string, unknown>>;
	changes: readonly ManagementPreparedChange[];
}

export interface ManagementSectionProvider {
	id: string;
	label: string;
	fields: readonly ManagementSectionFieldDefinition[];
	read(): ManagementSectionReadResult;
	validate?(proposedValues: Readonly<Record<string, unknown>>): string | null;
	apply(
		input: ManagementSectionApplyInput,
	): ManagementWriterResult | Promise<ManagementWriterResult>;
	rollback?(
		input: ManagementSectionApplyInput & { result: ManagementWriterResult },
	): ManagementWriterResult | Promise<ManagementWriterResult>;
}

interface ResolvedField {
	provider: ManagementSectionProvider;
	field: ManagementSectionFieldDefinition;
	read: ManagementSectionReadResult;
	target: ManagementResolvedTarget;
}

function assertFieldDefinition(
	providerId: string,
	field: ManagementSectionFieldDefinition,
): void {
	if (!SAFE_FIELD_ID.test(field.id)) {
		throw new Error(`invalid extension field id: ${providerId}/${field.id}`);
	}
	if (!field.label.trim()) {
		throw new Error(
			`extension field label is required: ${providerId}/${field.id}`,
		);
	}
	if (!SUPPORTED_KINDS.has(field.kind)) {
		throw new Error(`unsupported field kind: ${String(field.kind)}`);
	}
	if (field.kind === "select" || field.kind === "order_list") {
		if (!field.options?.length) {
			throw new Error(`field options are required: ${providerId}/${field.id}`);
		}
		const optionIds = new Set<string>();
		for (const option of field.options) {
			if (!SAFE_FIELD_ID.test(option.id) || !option.label.trim()) {
				throw new Error(`invalid field option: ${providerId}/${field.id}`);
			}
			if (optionIds.has(option.id)) {
				throw new Error(`duplicate field option: ${providerId}/${field.id}`);
			}
			optionIds.add(option.id);
		}
	} else if (field.options) {
		throw new Error(`field options not allowed: ${providerId}/${field.id}`);
	}
}

function validateValue(
	field: ManagementSectionFieldDefinition,
	value: unknown,
): string | null {
	if (field.kind === "boolean") {
		return typeof value === "boolean" ? null : "must be boolean";
	}
	if (field.kind === "number") {
		return typeof value === "number" && Number.isFinite(value)
			? null
			: "must be a finite number";
	}
	const allowed = new Set((field.options ?? []).map((option) => option.id));
	if (field.kind === "select") {
		return typeof value === "string" && allowed.has(value)
			? null
			: "must be a registered option";
	}
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		return "must be an ordered string list";
	}
	const order = value as string[];
	return order.length === allowed.size &&
		new Set(order).size === order.length &&
		order.every((item) => allowed.has(item))
		? null
		: "must contain each registered option exactly once";
}

/**
 * Typed extension seam reserved for FLY-1256 quota parameters and FLY-1259
 * dispatch parameters. Providers own source discovery, validation and mutation;
 * this registry deliberately does not expose a generic JSON/config editor.
 */
export class ManagementSectionRegistry {
	private readonly providers = new Map<string, ManagementSectionProvider>();

	constructor(providers: readonly ManagementSectionProvider[] = []) {
		for (const provider of providers) this.register(provider);
	}

	register(provider: ManagementSectionProvider): void {
		if (!SAFE_SECTION_ID.test(provider.id)) {
			throw new Error(`invalid extension section id: ${provider.id}`);
		}
		if (!provider.label.trim()) {
			throw new Error(`extension section label is required: ${provider.id}`);
		}
		if (this.providers.has(provider.id)) {
			throw new Error(`duplicate section: ${provider.id}`);
		}
		const fields = new Set<string>();
		for (const field of provider.fields) {
			assertFieldDefinition(provider.id, field);
			if (fields.has(field.id)) {
				throw new Error(`duplicate field: ${provider.id}/${field.id}`);
			}
			fields.add(field.id);
		}
		this.providers.set(provider.id, provider);
	}

	private resolveField(targetId: string): ResolvedField | null {
		for (const provider of this.providers.values()) {
			const read = provider.read();
			if (!read.revision)
				throw new Error(`empty extension revision: ${provider.id}`);
			for (const field of provider.fields) {
				const serverTarget = buildTargetId("extension", [
					provider.id,
					field.id,
				]);
				if (serverTarget !== targetId) continue;
				if (!(field.id in read.values)) {
					throw new Error(
						`extension value missing: ${provider.id}/${field.id}`,
					);
				}
				const invalid = validateValue(field, read.values[field.id]);
				if (invalid) {
					throw new Error(
						`invalid current extension value ${field.id}: ${invalid}`,
					);
				}
				const writable = field.writable !== false;
				return {
					provider,
					field,
					read,
					target: {
						targetId,
						kind: "extension",
						currentValue: read.values[field.id],
						sourceRevision: read.revision,
						writeCapability: {
							writable,
							reason: writable
								? undefined
								: (field.readonlyReason ?? "extension field is readonly"),
							consequence: writable
								? (field.consequence ?? "new-run")
								: "governance-readonly",
							requiresAcknowledgement:
								writable && field.requiresAcknowledgement === true,
						},
					},
				};
			}
		}
		return null;
	}

	private section(
		provider: ManagementSectionProvider,
	): ManagementExtensionSection {
		const read = provider.read();
		const fields: ManagementExtensionField[] = provider.fields.map((field) => {
			const targetId = buildTargetId("extension", [provider.id, field.id]);
			const resolved = this.resolveField(targetId);
			if (!resolved)
				throw new Error(`extension field did not resolve: ${field.id}`);
			return {
				id: field.id,
				label: field.label,
				help: field.help,
				kind: field.kind,
				options: field.options ? [...field.options] : undefined,
				value: {
					targetId,
					current: read.values[field.id],
					source: {
						kind: "extension",
						revision: read.revision,
						hint: `${provider.id}/${field.id}`,
					},
					writeCapability: resolved.target.writeCapability,
				},
			};
		});
		return { id: provider.id, label: provider.label, fields };
	}

	snapshotProvider(): ManagementSnapshotProvider {
		return {
			id: "management-extensions",
			sourceKind: "extension",
			read: () => {
				const sections = [...this.providers.values()].map((provider) =>
					this.section(provider),
				);
				return {
					revision: `extension:${createHash("sha256")
						.update(canonicalJsonString(sections))
						.digest("hex")}`,
					hint: "registered management extension providers",
					fragment: { extensions: sections },
				};
			},
		};
	}

	private providerChanges(changes: readonly ManagementPreparedChange[]): Array<{
		provider: ManagementSectionProvider;
		read: ManagementSectionReadResult;
		changes: ManagementPreparedChange[];
		proposed: Record<string, unknown>;
	}> {
		const grouped = new Map<
			string,
			{
				provider: ManagementSectionProvider;
				read: ManagementSectionReadResult;
				changes: ManagementPreparedChange[];
			}
		>();
		for (const change of changes) {
			const resolved = this.resolveField(change.targetId);
			if (!resolved)
				throw new Error(`extension target disappeared: ${change.targetId}`);
			const group = grouped.get(resolved.provider.id) ?? {
				provider: resolved.provider,
				read: resolved.read,
				changes: [],
			};
			if (group.read.revision !== resolved.read.revision) {
				throw new Error(
					`extension source changed during validation: ${resolved.provider.id}`,
				);
			}
			group.changes.push(change);
			grouped.set(resolved.provider.id, group);
		}
		return [...grouped.values()].map((group) => {
			const proposed = { ...group.read.values };
			for (const change of group.changes) {
				const resolved = this.resolveField(change.targetId)!;
				proposed[resolved.field.id] = change.newValue;
			}
			return { ...group, proposed };
		});
	}

	writer(): ManagementWriter {
		const writer: ManagementWriter = {
			id: "management-extension-registry-v1",
			kind: "extension",
			resolve: (targetId) => this.resolveField(targetId)?.target ?? null,
			preflight: (target, desiredValue, observedRevision) => {
				const resolved = this.resolveField(target.targetId);
				if (!resolved)
					return rejectedPreflight(
						"unknown_target",
						"extension target not found",
					);
				if (observedRevision !== resolved.read.revision) {
					return rejectedPreflight(
						"stale_source",
						"extension source changed since view",
					);
				}
				if (!resolved.target.writeCapability.writable) {
					return rejectedPreflight(
						"readonly",
						resolved.target.writeCapability.reason ??
							"extension field is readonly",
					);
				}
				const invalid = validateValue(resolved.field, desiredValue);
				if (invalid) {
					return rejectedPreflight(
						"invalid_desired_value",
						`${resolved.field.id} ${invalid}`,
					);
				}
				return preparedChange({
					writer,
					target: resolved.target,
					newValue: desiredValue,
				});
			},
			validateGroup: (changes) => {
				try {
					for (const group of this.providerChanges(changes)) {
						const error = group.provider.validate?.(group.proposed) ?? null;
						if (error) {
							return {
								ok: false,
								code: "invalid_desired_value",
								reason: error,
							};
						}
					}
					return { ok: true };
				} catch (error) {
					return {
						ok: false,
						code: "stale_source",
						reason: error instanceof Error ? error.message : String(error),
					};
				}
			},
			apply: async (change) => (await writer.applyGroup!([change]))[0]!,
			applyGroup: async (changes) => {
				const results = new Map<string, ManagementWriterResult>();
				for (const group of this.providerChanges(changes)) {
					const validation = group.provider.validate?.(group.proposed) ?? null;
					let result: ManagementWriterResult = validation
						? { status: "rejected", reason: validation }
						: await group.provider.apply({
								expectedRevision: group.read.revision,
								previousValues: group.read.values,
								proposedValues: group.proposed,
								changes: group.changes,
							});
					if (result.status === "partial" && group.provider.rollback) {
						result = await group.provider.rollback({
							expectedRevision: group.read.revision,
							previousValues: group.read.values,
							proposedValues: group.proposed,
							changes: group.changes,
							result,
						});
					}
					for (const change of group.changes) {
						results.set(change.targetId, structuredClone(result));
					}
				}
				return changes.map(
					(change) =>
						results.get(change.targetId) ?? {
							status: "rejected",
							reason: "extension provider produced no result",
						},
				);
			},
		};
		return writer;
	}
}
