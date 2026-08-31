import { createHash } from "node:crypto";
import type { ModelCatalog, ModelSurface } from "flywheel-config";

export const MANAGEMENT_SCHEMA_VERSION = 1 as const;

export type ManagementSourceKind =
	| "projects_json"
	| "project_config"
	| "model_registry"
	| "workflow_catalog"
	| "flag_registry"
	| "launchd_plist"
	| "launchctl"
	| "extension";

export type ManagementTargetKind =
	| "lead"
	| "runner"
	| "dag"
	| "cron"
	| "flag"
	| "extension";

export type ManagementConsequence =
	| "hot"
	| "new-run"
	| "restart-bridge"
	| "restart-lead"
	| "reload-launchd"
	| "governance-readonly";

const SOURCE_KINDS: ReadonlySet<string> = new Set<ManagementSourceKind>([
	"projects_json",
	"project_config",
	"model_registry",
	"workflow_catalog",
	"flag_registry",
	"launchd_plist",
	"launchctl",
	"extension",
]);

const TARGET_KINDS: ReadonlySet<string> = new Set<ManagementTargetKind>([
	"lead",
	"runner",
	"dag",
	"cron",
	"flag",
	"extension",
]);

export interface SourceRef {
	kind: ManagementSourceKind;
	revision: string;
	/** Safe display-only hint. Never an authority accepted back from the client. */
	hint?: string;
}

export interface SourceStatus extends SourceRef {
	ok: boolean;
	error?: string;
}

export interface WriteCapability {
	writable: boolean;
	reason?: string;
	consequence: ManagementConsequence;
	requiresAcknowledgement: boolean;
}

export interface ManagedValue<T> {
	targetId: string;
	current: T;
	source: SourceRef;
	writeCapability: WriteCapability;
	error?: string;
}

export function makeManagedValue<T>(value: ManagedValue<T>): ManagedValue<T> {
	if (!parseTargetId(value.targetId))
		throw new Error("invalid managed target id");
	if (!SOURCE_KINDS.has(value.source.kind)) {
		throw new Error(`unknown source kind: ${value.source.kind}`);
	}
	return value;
}

function targetDigest(kind: ManagementTargetKind, identity: readonly string[]) {
	const digest = createHash("sha256")
		.update(JSON.stringify([kind, ...identity]))
		.digest("base64url")
		.slice(0, 32);
	return `${kind}_${digest}`;
}

/** Build an opaque target id from server-owned source identity only. */
export function buildTargetId(
	kind: ManagementTargetKind,
	identity: readonly string[],
): string {
	if (!TARGET_KINDS.has(kind)) throw new Error(`unknown target kind: ${kind}`);
	if (identity.length === 0 || identity.some((part) => part.length === 0)) {
		throw new Error("target identity must contain non-empty parts");
	}
	return targetDigest(kind, identity);
}

export function buildCronTargetId(
	canonicalPlistPath: string,
	label: string,
	field: "schedule" | "enabled" | "model",
): string {
	return buildTargetId("cron", [canonicalPlistPath, label, field]);
}

export function parseTargetId(
	targetId: string,
	throwOnInvalid = false,
): { kind: ManagementTargetKind; id: string } | null {
	const match = /^([a-z]+)_([A-Za-z0-9_-]{32})$/.exec(targetId);
	const kind = match?.[1];
	if (!kind || !TARGET_KINDS.has(kind)) {
		if (throwOnInvalid) throw new Error(`unknown target kind in ${targetId}`);
		return null;
	}
	return { kind: kind as ManagementTargetKind, id: targetId };
}

export function fileSourceRevision(bytes: Uint8Array): string {
	return `file:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function databaseSourceRevision(
	revision: number,
	digest: string,
): string {
	return `db:${revision}:${digest}`;
}

export function registrySourceRevision(version: string | number): string {
	return `registry:${version}`;
}

export interface ModelSelection {
	provider: string;
	model: string;
	effort?: string | null;
}

export interface ManagementLeadView {
	id: string;
	leadId: string;
	displayName: string;
	department?: string;
	presentationGroup: string;
	online: "online" | "offline" | "degraded" | "unknown";
	backend: string;
	backendWritable: false;
	backendDisabledReason: string;
	dispatch: ManagedValue<ModelSelection | null>;
}

export interface ManagementRunnerDefaultView {
	dispatch: ManagedValue<ModelSelection | null>;
}

export interface ManagementRoleView {
	id: string;
	name: string;
	department?: string;
	agentFile: string;
	sourceLink: string | null;
	error?: string;
}

export interface ManagementDagNodeView {
	id: string;
	nodeId: string;
	name: string;
	dispatch: ManagedValue<ModelSelection>;
}

export interface ManagementDagView {
	id: string;
	title: string;
	templateId: string;
	revision: number;
	digest: string;
	nodes: ManagementDagNodeView[];
	error?: string;
}

export interface WeeklySchedule {
	days: number[];
	times: Array<{ hour: number; minute: number }>;
	label: "每日" | "工作日" | "周末" | "自定义";
}

export interface ManagementCronView {
	id: string;
	label: string;
	projectName: string | null;
	sourceHint: string;
	schedule: ManagedValue<WeeklySchedule | null>;
	enabled: ManagedValue<boolean | null>;
	loaded: boolean | null;
	model?: ManagedValue<ModelSelection | null>;
	warnings: string[];
	error?: string;
}

export interface ManagementProjectView {
	id: string;
	name: string;
	presentationGroup: string;
	sourceRevision: string;
	leads: ManagementLeadView[];
	roles: ManagementRoleView[];
	dags: ManagementDagView[];
	crons: ManagementCronView[];
	runnerDefault?: ManagementRunnerDefaultView;
	error?: string;
}

export interface PresentationGroupView {
	id: string;
	label: string;
	projectIds: string[];
	leadIds: string[];
	derived: boolean;
}

export interface ManagementFlagView {
	id: string;
	name: string;
	description: string;
	category: string;
	global: ManagedValue<unknown>;
	projectOverrides: Array<{
		projectName: string;
		value: ManagedValue<unknown>;
	}>;
}

export type ExtensionFieldKind = "boolean" | "number" | "select" | "order_list";

export interface ManagementExtensionField {
	id: string;
	label: string;
	help?: string;
	kind: ExtensionFieldKind;
	options?: Array<{ id: string; label: string }>;
	value: ManagedValue<unknown>;
}

export interface ManagementExtensionSection {
	id: string;
	label: string;
	fields: ManagementExtensionField[];
}

export interface ManagementSnapshotV1 {
	schemaVersion: typeof MANAGEMENT_SCHEMA_VERSION;
	generatedAt: string;
	snapshotRevision: string;
	sources: SourceStatus[];
	modelCatalog: Partial<Record<ModelSurface, ModelCatalog>>;
	projects: ManagementProjectView[];
	presentationGroups: PresentationGroupView[];
	unassignedCrons: ManagementCronView[];
	flags: ManagementFlagView[];
	extensions: ManagementExtensionSection[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNoForbiddenKeys(value: unknown): void {
	if (Array.isArray(value)) {
		for (const item of value) assertNoForbiddenKeys(item);
		return;
	}
	if (!isRecord(value)) return;
	for (const [key, child] of Object.entries(value)) {
		if (key === "botToken" || key === "botTokenEnv" || key === "match") {
			throw new Error(`forbidden snapshot key: ${key}`);
		}
		assertNoForbiddenKeys(child);
	}
}

/** Runtime assertion at the HTTP serialization boundary. */
export function assertManagementSnapshot(
	value: unknown,
): asserts value is ManagementSnapshotV1 {
	if (!isRecord(value) || value.schemaVersion !== MANAGEMENT_SCHEMA_VERSION) {
		throw new Error("unsupported management snapshot schema version");
	}
	for (const key of [
		"sources",
		"projects",
		"presentationGroups",
		"unassignedCrons",
		"flags",
		"extensions",
	] as const) {
		if (!Array.isArray(value[key]))
			throw new Error(`snapshot ${key} must be an array`);
	}
	if (!isRecord(value.modelCatalog)) {
		throw new Error("snapshot modelCatalog must be an object");
	}
	if (
		typeof value.generatedAt !== "string" ||
		typeof value.snapshotRevision !== "string"
	) {
		throw new Error("snapshot timestamps and revision must be strings");
	}
	for (const source of value.sources as unknown[]) {
		if (!isRecord(source) || !SOURCE_KINDS.has(String(source.kind))) {
			throw new Error(
				`unknown source kind: ${isRecord(source) ? source.kind : "invalid"}`,
			);
		}
	}
	assertNoForbiddenKeys(value);
}
