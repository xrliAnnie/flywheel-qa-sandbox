import { createHash } from "node:crypto";

export interface MigrationRow {
	name: string;
	scope: string;
	raw: "0" | "1";
}

export interface ConfigSnapshot {
	projectName: string;
	path: string;
	contentSha: string;
	config: Record<string, unknown>;
}

export const FLY2103_PROJECTS = [
	"flywheel",
	"geoforge3d",
	"growth",
	"joycon-typeless",
	"personal-assistant",
	"tidal-echo",
] as const;

export const FLY2103_PRE_CUTOVER_ROWS: readonly MigrationRow[] = [
	{ name: "doc_flow", scope: "flywheel", raw: "1" },
	{ name: "doc_flow", scope: "joycon-typeless", raw: "1" },
	{ name: "doc_flow", scope: "personal-assistant", raw: "1" },
	{ name: "doc_flow", scope: "tidal-echo", raw: "1" },
	{ name: "pipeline_dag", scope: "flywheel", raw: "1" },
	{ name: "pipeline_work_kind", scope: "flywheel", raw: "1" },
];

export const FLY2103_FINAL_ROWS: readonly MigrationRow[] = [
	...FLY2103_PRE_CUTOVER_ROWS,
	{ name: "ponytail", scope: "*", raw: "0" },
];

export const FLY2103_MIGRATED_FLAG_NAMES = new Set([
	"doc_flow",
	"pipeline_dag",
	"pipeline_work_kind",
	"proofshot",
	"xiaohongshu_learning",
	"ponytail",
	"skill_framework_split_participation",
]);

const RECEIPT_SCHEMA_VERSION = 1;
const ISSUE = "FLY-2103";

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sortedRecord(
	input: Readonly<Record<string, string>>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(input).sort(([left], [right]) => left.localeCompare(right)),
	);
}

export const FLY2103_MANIFEST_DIGEST = digest({
	schemaVersion: RECEIPT_SCHEMA_VERSION,
	issue: ISSUE,
	preCutoverRows: FLY2103_PRE_CUTOVER_ROWS,
	finalRows: FLY2103_FINAL_ROWS,
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: unknown, key: string): boolean {
	return isRecord(value) && Object.hasOwn(value, key);
}

function rowKey(row: Pick<MigrationRow, "name" | "scope">): string {
	return `${row.name}\u0000${row.scope}`;
}

function sortRows(rows: readonly MigrationRow[]): MigrationRow[] {
	return [...rows].sort((left, right) =>
		left.name === right.name
			? left.scope.localeCompare(right.scope)
			: left.name.localeCompare(right.name),
	);
}

function sameRows(
	left: readonly MigrationRow[],
	right: readonly MigrationRow[],
): boolean {
	return JSON.stringify(sortRows(left)) === JSON.stringify(sortRows(right));
}

function assertProjectRoster(snapshots: readonly ConfigSnapshot[]): void {
	const expected = [...FLY2103_PROJECTS].sort();
	const actual = snapshots.map((snapshot) => snapshot.projectName).sort();
	if (
		new Set(actual).size !== actual.length ||
		JSON.stringify(actual) !== JSON.stringify(expected)
	) {
		throw new Error(
			`FLY-2103 config roster mismatch: expected ${expected.join(", ")}; got ${actual.join(", ")}`,
		);
	}
	for (const snapshot of snapshots) {
		if (!/^[a-f0-9]{64}$/.test(snapshot.contentSha)) {
			throw new Error(
				`FLY-2103 config snapshot ${snapshot.projectName} has invalid content SHA`,
			);
		}
		if (!isRecord(snapshot.config)) {
			throw new Error(
				`FLY-2103 config ${snapshot.projectName} is not a YAML mapping`,
			);
		}
	}
}

function unexpectedLegacy(projectName: string, path: string): never {
	throw new Error(
		`FLY-2103 ${projectName}: ${path} has an unexpected legacy value`,
	);
}

export function auditLegacyConfigs(snapshots: readonly ConfigSnapshot[]): {
	configShas: Record<string, string>;
	derivedRows: readonly MigrationRow[];
} {
	assertProjectRoster(snapshots);
	const derivedRows: MigrationRow[] = [];
	for (const snapshot of snapshots) {
		const { projectName, config } = snapshot;
		const checkpoints = config.checkpoints;
		if (!isRecord(checkpoints) || Object.keys(checkpoints).length === 0) {
			throw new Error(
				`FLY-2103 ${projectName}: checkpoint legacy enabled ledger is missing`,
			);
		}
		for (const [name, value] of Object.entries(checkpoints)) {
			if (!isRecord(value) || value.enabled !== true) {
				throw new Error(
					`FLY-2103 ${projectName}: checkpoint ${name} legacy enabled must still be true`,
				);
			}
		}

		const docFlow = config.doc_flow;
		if (hasOwn(docFlow, "enabled")) {
			if ((docFlow as Record<string, unknown>).enabled !== true) {
				unexpectedLegacy(projectName, "doc_flow.enabled");
			}
			derivedRows.push({ name: "doc_flow", scope: projectName, raw: "1" });
		}

		if (Object.hasOwn(config, "pipeline")) {
			const pipeline = config.pipeline;
			if (!isRecord(pipeline)) unexpectedLegacy(projectName, "pipeline");
			for (const key of Object.keys(pipeline)) {
				if (key !== "dag" && key !== "work_kind") {
					unexpectedLegacy(projectName, `pipeline.${key}`);
				}
			}
			for (const [key, name] of [
				["dag", "pipeline_dag"],
				["work_kind", "pipeline_work_kind"],
			] as const) {
				if (Object.hasOwn(pipeline, key)) {
					if (pipeline[key] !== true) {
						unexpectedLegacy(projectName, `pipeline.${key}`);
					}
					derivedRows.push({ name, scope: projectName, raw: "1" });
				}
			}
		}

		const proofshot = isRecord(config.skills)
			? config.skills.proofshot
			: undefined;
		if (hasOwn(proofshot, "enabled")) {
			unexpectedLegacy(projectName, "skills.proofshot.enabled");
		}
		if (Object.hasOwn(config, "ponytail")) {
			unexpectedLegacy(projectName, "ponytail.enabled");
		}
		if (Object.hasOwn(config, "skill_framework")) {
			unexpectedLegacy(projectName, "skill_framework.split");
		}
		const learning = config.xiaohongshu_learning;
		if (hasOwn(learning, "enabled")) {
			unexpectedLegacy(projectName, "xiaohongshu_learning.enabled");
		}
		if (isRecord(learning) && Array.isArray(learning.collections)) {
			for (const [index, collection] of learning.collections.entries()) {
				if (hasOwn(collection, "auto_create")) {
					unexpectedLegacy(
						projectName,
						`xiaohongshu_learning.collections[${index}].auto_create`,
					);
				}
			}
		}
	}

	if (!sameRows(derivedRows, FLY2103_PRE_CUTOVER_ROWS)) {
		throw new Error(
			`FLY-2103 legacy-derived row exact-set mismatch: expected ${JSON.stringify(
				FLY2103_PRE_CUTOVER_ROWS,
			)}; got ${JSON.stringify(sortRows(derivedRows))}`,
		);
	}
	return {
		configShas: sortedRecord(
			Object.fromEntries(
				snapshots.map((snapshot) => [
					snapshot.projectName,
					snapshot.contentSha,
				]),
			),
		),
		derivedRows: FLY2103_PRE_CUTOVER_ROWS,
	};
}

function stalePostKey(projectName: string, path: string): never {
	throw new Error(
		`FLY-2103 ${projectName}: retired key ${path} is still present`,
	);
}

export function auditPostDeployConfigs(
	snapshots: readonly ConfigSnapshot[],
): void {
	assertProjectRoster(snapshots);
	for (const { projectName, config } of snapshots) {
		if (isRecord(config.checkpoints)) {
			for (const [name, checkpoint] of Object.entries(config.checkpoints)) {
				if (hasOwn(checkpoint, "enabled")) {
					stalePostKey(projectName, `checkpoints.${name}.enabled`);
				}
			}
		}
		if (hasOwn(config.doc_flow, "enabled")) {
			stalePostKey(projectName, "doc_flow.enabled");
		}
		if (Object.hasOwn(config, "pipeline"))
			stalePostKey(projectName, "pipeline");
		if (Object.hasOwn(config, "ponytail"))
			stalePostKey(projectName, "ponytail");
		if (Object.hasOwn(config, "skill_framework")) {
			stalePostKey(projectName, "skill_framework");
		}
		const proofshot = isRecord(config.skills)
			? config.skills.proofshot
			: undefined;
		if (hasOwn(proofshot, "enabled")) {
			stalePostKey(projectName, "skills.proofshot.enabled");
		}
		const learning = config.xiaohongshu_learning;
		if (hasOwn(learning, "enabled")) {
			stalePostKey(projectName, "xiaohongshu_learning.enabled");
		}
		if (isRecord(learning) && Array.isArray(learning.collections)) {
			for (const [index, collection] of learning.collections.entries()) {
				if (hasOwn(collection, "auto_create")) {
					stalePostKey(
						projectName,
						`xiaohongshu_learning.collections[${index}].auto_create`,
					);
				}
			}
		}
	}
}

export interface PreCutoverReceipt {
	schemaVersion: 1;
	issue: "FLY-2103";
	phase: "pre-cutover";
	status: "passed";
	manifestDigest: string;
	configShas: Record<string, string>;
	configDigest: string;
	dbRealpath: string;
	bridgeTarget: string;
	exactRows: readonly MigrationRow[];
	completedAt: string;
}

export function createPreCutoverReceipt(input: {
	configSnapshots: readonly ConfigSnapshot[];
	dbRealpath: string;
	bridgeTarget: string;
	completedAt: string;
}): PreCutoverReceipt {
	const { configShas } = auditLegacyConfigs(input.configSnapshots);
	return {
		schemaVersion: 1,
		issue: ISSUE,
		phase: "pre-cutover",
		status: "passed",
		manifestDigest: FLY2103_MANIFEST_DIGEST,
		configShas,
		configDigest: digest(configShas),
		dbRealpath: input.dbRealpath,
		bridgeTarget: input.bridgeTarget,
		exactRows: FLY2103_PRE_CUTOVER_ROWS,
		completedAt: input.completedAt,
	};
}

function receiptError(reason: string): never {
	throw new Error(`FLY-2103 receipt invalid: ${reason}`);
}

export function validatePreCutoverReceipt(
	value: unknown,
	expected: { dbRealpath: string; bridgeTarget: string },
): PreCutoverReceipt {
	if (!isRecord(value)) receiptError("not an object");
	if (
		value.schemaVersion !== RECEIPT_SCHEMA_VERSION ||
		value.issue !== ISSUE ||
		value.phase !== "pre-cutover" ||
		value.status !== "passed"
	) {
		receiptError("identity/status mismatch");
	}
	if (value.manifestDigest !== FLY2103_MANIFEST_DIGEST) {
		receiptError("manifest digest mismatch");
	}
	if (value.dbRealpath !== expected.dbRealpath)
		receiptError("DB realpath mismatch");
	if (value.bridgeTarget !== expected.bridgeTarget) {
		receiptError("Bridge target mismatch");
	}
	if (!isRecord(value.configShas)) receiptError("configShas missing");
	const configShas = sortedRecord(
		Object.fromEntries(
			Object.entries(value.configShas).map(([key, sha]) => [key, String(sha)]),
		),
	);
	if (
		JSON.stringify(Object.keys(configShas)) !==
			JSON.stringify([...FLY2103_PROJECTS].sort()) ||
		Object.values(configShas).some((sha) => !/^[a-f0-9]{64}$/.test(sha))
	) {
		receiptError("config SHA roster malformed");
	}
	if (value.configDigest !== digest(configShas)) {
		receiptError("config SHA digest mismatch");
	}
	if (!Array.isArray(value.exactRows)) receiptError("G1 exact rows missing");
	const exactRows = value.exactRows as unknown[];
	if (
		exactRows.some(
			(row) =>
				!isRecord(row) ||
				typeof row.name !== "string" ||
				typeof row.scope !== "string" ||
				(row.raw !== "0" && row.raw !== "1"),
		) ||
		!sameRows(exactRows as MigrationRow[], FLY2103_PRE_CUTOVER_ROWS)
	) {
		receiptError("G1 exact rows mismatch");
	}
	if (
		typeof value.completedAt !== "string" ||
		Number.isNaN(Date.parse(value.completedAt))
	) {
		receiptError("completion time malformed");
	}
	return value as unknown as PreCutoverReceipt;
}

export interface MigrationAction {
	row: MigrationRow;
	action: "skip" | "write";
}

interface HttpResponseLike {
	ok: boolean;
	status: number;
	json: () => Promise<unknown>;
}

type FetchLike = (
	url: string,
	init: {
		method: string;
		headers: Record<string, string>;
		body: string;
		signal?: AbortSignal;
	},
) => Promise<HttpResponseLike>;

function responseErrorBody(value: unknown): string {
	if (isRecord(value) && typeof value.error === "string") return value.error;
	return JSON.stringify(value);
}

export async function stageAndApplyMigrationRow(
	row: MigrationRow,
	bridgeTarget: string,
	fetchFn: FetchLike = fetch,
): Promise<void> {
	const headers = {
		"Content-Type": "application/json",
		Origin: new URL(bridgeTarget).origin,
	};
	const stagedResponse = await fetchFn(
		`${bridgeTarget.replace(/\/+$/, "")}/api/fleet/flag/stage`,
		{
			method: "POST",
			headers,
			signal: AbortSignal.timeout(15_000),
			body: JSON.stringify({
				name: row.name,
				to: row.raw === "1",
				project: row.scope,
				op: "set",
				reason: "FLY-2103 config.yaml flag migration",
			}),
		},
	);
	const stagedBody = await stagedResponse.json().catch(() => ({}));
	if (!stagedResponse.ok) {
		throw new Error(
			`FLY-2103 Bridge stage failed for ${row.name}/${row.scope} (${stagedResponse.status}): ${responseErrorBody(stagedBody)}`,
		);
	}
	if (
		!isRecord(stagedBody) ||
		!isRecord(stagedBody.canonical) ||
		typeof stagedBody.confirmToken !== "string" ||
		!stagedBody.confirmToken
	) {
		throw new Error(
			`FLY-2103 Bridge stage returned a malformed response for ${row.name}/${row.scope}`,
		);
	}
	const appliedResponse = await fetchFn(
		`${bridgeTarget.replace(/\/+$/, "")}/api/fleet/flag/apply`,
		{
			method: "POST",
			headers,
			signal: AbortSignal.timeout(15_000),
			body: JSON.stringify({
				canonical: stagedBody.canonical,
				confirmToken: stagedBody.confirmToken,
			}),
		},
	);
	const appliedBody = await appliedResponse.json().catch(() => ({}));
	if (!appliedResponse.ok) {
		throw new Error(
			`FLY-2103 Bridge apply failed for ${row.name}/${row.scope} (${appliedResponse.status}): ${responseErrorBody(appliedBody)}`,
		);
	}
}

function planSubset(
	currentRows: readonly MigrationRow[],
	targetRows: readonly MigrationRow[],
): MigrationAction[] {
	const target = new Map(targetRows.map((row) => [rowKey(row), row]));
	const current = new Map<string, MigrationRow>();
	for (const row of currentRows) {
		const key = rowKey(row);
		if (current.has(key))
			throw new Error(
				`FLY-2103 exact-set duplicate row ${row.name}/${row.scope}`,
			);
		const expected = target.get(key);
		if (!expected)
			throw new Error(
				`FLY-2103 exact-set has extra row ${row.name}/${row.scope}`,
			);
		if (row.raw !== expected.raw) {
			throw new Error(
				`FLY-2103 row conflict ${row.name}/${row.scope}: expected raw=${expected.raw}, got raw=${row.raw}`,
			);
		}
		current.set(key, row);
	}
	return targetRows.map((row) => ({
		row,
		action: current.has(rowKey(row)) ? "skip" : "write",
	}));
}

function assertExactRows(
	actual: readonly MigrationRow[],
	expected: readonly MigrationRow[],
): void {
	planSubset(actual, expected);
	if (!sameRows(actual, expected)) {
		throw new Error(
			`FLY-2103 exact-set mismatch: expected ${JSON.stringify(expected)}; got ${JSON.stringify(sortRows(actual))}`,
		);
	}
}

export async function runFly2103Migration(input: {
	phase: "pre-cutover" | "post-deploy";
	apply: boolean;
	configSnapshots: readonly ConfigSnapshot[];
	currentRows: readonly MigrationRow[];
	dbRealpath: string;
	bridgeTarget: string;
	receipt?: unknown;
	writeRow: (row: MigrationRow) => Promise<void>;
	readRows: () => Promise<readonly MigrationRow[]>;
	writeReceipt: (receipt: PreCutoverReceipt) => Promise<void>;
	now: () => Date;
}): Promise<{ actions: MigrationAction[]; receipt?: PreCutoverReceipt }> {
	if (input.phase === "pre-cutover") {
		auditLegacyConfigs(input.configSnapshots);
	} else {
		auditPostDeployConfigs(input.configSnapshots);
		validatePreCutoverReceipt(input.receipt, {
			dbRealpath: input.dbRealpath,
			bridgeTarget: input.bridgeTarget,
		});
	}

	const targetRows =
		input.phase === "pre-cutover"
			? FLY2103_PRE_CUTOVER_ROWS
			: FLY2103_FINAL_ROWS;
	const actions = planSubset(input.currentRows, targetRows);
	if (input.phase === "post-deploy") {
		const currentKeys = new Set(input.currentRows.map(rowKey));
		for (const row of FLY2103_PRE_CUTOVER_ROWS) {
			if (!currentKeys.has(rowKey(row))) {
				throw new Error(
					`FLY-2103 post-deploy G1 exact-set mismatch: missing ${row.name}/${row.scope}`,
				);
			}
		}
	}
	if (!input.apply) return { actions };

	for (const action of actions) {
		if (action.action === "write") await input.writeRow(action.row);
	}
	assertExactRows(await input.readRows(), targetRows);

	if (input.phase === "pre-cutover") {
		const receipt = createPreCutoverReceipt({
			configSnapshots: input.configSnapshots,
			dbRealpath: input.dbRealpath,
			bridgeTarget: input.bridgeTarget,
			completedAt: input.now().toISOString(),
		});
		await input.writeReceipt(receipt);
		return { actions, receipt };
	}
	return { actions };
}
