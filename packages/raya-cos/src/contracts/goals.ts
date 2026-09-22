export const GOALS_FILE_HEADER =
	"# Raya goals(阶段一:她说的;append-only,撤销用状态行,不删)";

export type GoalStatus = "active" | "withdrawn";

export interface Goal {
	kind?: "inference" | "commitment";
	projects?: string[];
	revision?: number;
	supersedes?: string;
	id: string;
	operationId: string;
	recordedAt: string;
	sourceUrl: string;
	status: GoalStatus;
	text: string;
	withdrawnAt?: string;
	withdrawnSourceUrl?: string;
	withdrawOperationId?: string;
}

export type GoalOperation =
	| { kind: "record"; text: string; sourceUrl: string }
	| { kind: "withdraw"; goalId: string; sourceUrl: string };

export class GoalsFileCorrupt extends Error {
	constructor(message: string) {
		super(`goals file corrupt: ${message}`);
		this.name = "GoalsFileCorrupt";
	}
}

const GOAL_ID = /^g-(\d{8})-(\d{2})$/;
const DISCORD_SOURCE = /^https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+$/;

function operationId(value: string, kind: "record" | "withdraw"): string {
	if (!new RegExp(`^\\d{17,20}:${kind}:\\d+$`).test(value)) {
		throw new GoalsFileCorrupt("invalid operation id");
	}
	return value;
}

function field(line: string, label: string): string {
	const prefix = `- ${label}: `;
	if (!line.startsWith(prefix)) {
		throw new GoalsFileCorrupt(`missing ${label}`);
	}
	const value = line.slice(prefix.length);
	if (value.length === 0) throw new GoalsFileCorrupt(`empty ${label}`);
	return value;
}

function timestamp(value: string, label: string): string {
	if (
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
			value,
		)
	) {
		throw new GoalsFileCorrupt(`invalid ${label}`);
	}
	return value;
}

function sourceUrl(value: string, label: string): string {
	if (!DISCORD_SOURCE.test(value)) {
		throw new GoalsFileCorrupt(`invalid ${label}`);
	}
	return value;
}

function goalMetadata(
	value: unknown,
): Pick<Goal, "kind" | "projects" | "revision" | "supersedes"> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new GoalsFileCorrupt("invalid goal metadata");
	const v = value as Record<string, unknown>;
	if (
		Object.keys(v).some(
			(key) => !["kind", "projects", "revision", "supersedes"].includes(key),
		) ||
		!["inference", "commitment"].includes(String(v.kind)) ||
		!Array.isArray(v.projects) ||
		v.projects.length < 1 ||
		v.projects.length > 100 ||
		v.projects.some(
			(p) => typeof p !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(p),
		) ||
		new Set(v.projects).size !== v.projects.length ||
		!Number.isSafeInteger(v.revision) ||
		Number(v.revision) < 1 ||
		(v.supersedes !== undefined &&
			(typeof v.supersedes !== "string" || !GOAL_ID.test(v.supersedes)))
	)
		throw new GoalsFileCorrupt("invalid goal metadata");
	return {
		kind: v.kind as "inference" | "commitment",
		projects: v.projects as string[],
		revision: Number(v.revision),
		...(v.supersedes === undefined ? {} : { supersedes: String(v.supersedes) }),
	};
}
function parseSection(originalLines: string[]): Goal {
	const lines = [...originalLines];
	let metadata: Pick<Goal, "kind" | "projects" | "revision" | "supersedes"> =
		{};
	if (lines.at(-1)?.startsWith("- 业务元数据: ")) {
		try {
			metadata = goalMetadata(
				JSON.parse(field(lines.pop() ?? "", "业务元数据")),
			);
		} catch {
			throw new GoalsFileCorrupt("invalid goal metadata");
		}
	}

	const heading = lines[0] ?? "";
	const id = heading.startsWith("## ") ? heading.slice(3) : "";
	if (!GOAL_ID.test(id)) throw new GoalsFileCorrupt("invalid goal id");
	if (lines.length < 6) throw new GoalsFileCorrupt(`missing fields for ${id}`);
	const recordedOperationId = operationId(
		field(lines[1] ?? "", "操作"),
		"record",
	);
	const recordedAt = timestamp(field(lines[2] ?? "", "记于"), "记于");
	const source = sourceUrl(field(lines[3] ?? "", "来源"), "来源");
	const status = field(lines[4] ?? "", "状态");
	if (status !== "active" && status !== "withdrawn") {
		throw new GoalsFileCorrupt(`invalid 状态 for ${id}`);
	}
	const textLine = field(
		lines[5] ?? "",
		metadata.kind === "inference" ? "提炼" : "原话",
	);
	if (!textLine.startsWith("「") || !textLine.endsWith("」")) {
		throw new GoalsFileCorrupt(`invalid 原话 for ${id}`);
	}
	const text = textLine.slice(1, -1);
	if (Array.from(text).length < 1 || Array.from(text).length > 500) {
		throw new GoalsFileCorrupt(`invalid 原话 for ${id}`);
	}
	if (status === "active") {
		if (lines.length !== 6) {
			throw new GoalsFileCorrupt(`unexpected fields for ${id}`);
		}
		return {
			id,
			operationId: recordedOperationId,
			recordedAt,
			sourceUrl: source,
			status,
			text,
			...metadata,
		};
	}
	if (lines.length !== 9) {
		throw new GoalsFileCorrupt(`missing withdrawn fields for ${id}`);
	}
	return {
		id,
		operationId: recordedOperationId,
		recordedAt,
		sourceUrl: source,
		status,
		text,
		...metadata,
		withdrawnAt: timestamp(field(lines[6] ?? "", "撤于"), "撤于"),
		withdrawnSourceUrl: sourceUrl(
			field(lines[7] ?? "", "撤销来源"),
			"撤销来源",
		),
		withdrawOperationId: operationId(
			field(lines[8] ?? "", "撤销操作"),
			"withdraw",
		),
	};
}

export function parseGoalsFile(text: string): Goal[] {
	const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
	const blocks = normalized.split("\n\n");
	if (blocks.shift() !== GOALS_FILE_HEADER) {
		throw new GoalsFileCorrupt("missing header");
	}
	const goals = blocks.map((block) => parseSection(block.split("\n")));
	const ids = new Set<string>();
	const operations = new Set<string>();
	for (const goal of goals) {
		if (ids.has(goal.id)) throw new GoalsFileCorrupt("duplicate goal id");
		ids.add(goal.id);
		for (const operationId of [goal.operationId, goal.withdrawOperationId]) {
			if (!operationId) continue;
			if (operations.has(operationId)) {
				throw new GoalsFileCorrupt("duplicate operation id");
			}
			operations.add(operationId);
		}
	}
	return goals;
}

export function renderGoalsFile(goals: Goal[]): string {
	const sections = goals.map((goal) => {
		if (/[\r\n]/.test(goal.text))
			throw new GoalsFileCorrupt("multi-line goal text");
		const metadata =
			goal.kind === undefined &&
			goal.projects === undefined &&
			goal.revision === undefined &&
			goal.supersedes === undefined
				? undefined
				: goalMetadata({
						kind: goal.kind,
						projects: goal.projects,
						revision: goal.revision,
						...(goal.supersedes === undefined
							? {}
							: { supersedes: goal.supersedes }),
					});
		const lines = [
			`## ${goal.id}`,
			`- 操作: ${goal.operationId}`,
			`- 记于: ${goal.recordedAt}`,
			`- 来源: ${goal.sourceUrl}`,
			`- 状态: ${goal.status}`,
			`- ${goal.kind === "inference" ? "提炼" : "原话"}: 「${goal.text}」`,
		];
		if (goal.status === "withdrawn") {
			if (
				!goal.withdrawnAt ||
				!goal.withdrawnSourceUrl ||
				!goal.withdrawOperationId
			) {
				throw new GoalsFileCorrupt(`missing withdrawn fields for ${goal.id}`);
			}
			lines.push(
				`- 撤于: ${goal.withdrawnAt}`,
				`- 撤销来源: ${goal.withdrawnSourceUrl}`,
				`- 撤销操作: ${goal.withdrawOperationId}`,
			);
		}
		if (metadata) lines.push(`- 业务元数据: ${JSON.stringify(metadata)}`);
		return lines.join("\n");
	});
	return `${[GOALS_FILE_HEADER, ...sections].join("\n\n")}\n`;
}

export function nextGoalId(goals: Goal[], date: string): string {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		throw new Error("goal date must be YYYY-MM-DD");
	}
	const compact = date.replaceAll("-", "");
	const highest = goals.reduce((current, goal) => {
		const match = GOAL_ID.exec(goal.id);
		return match?.[1] === compact
			? Math.max(current, Number(match[2]))
			: current;
	}, 0);
	if (highest >= 99) throw new Error("daily goal id limit reached");
	return `g-${compact}-${String(highest + 1).padStart(2, "0")}`;
}

export function findByOperationId(
	goals: Goal[],
	operationId: string,
): Goal | undefined {
	return goals.find(
		(goal) =>
			goal.operationId === operationId ||
			goal.withdrawOperationId === operationId,
	);
}

export function operationMatches(
	goal: Goal,
	operation: GoalOperation,
): boolean {
	if (operation.kind === "record") {
		return (
			goal.text === operation.text && goal.sourceUrl === operation.sourceUrl
		);
	}
	return (
		goal.id === operation.goalId &&
		goal.withdrawnSourceUrl === operation.sourceUrl
	);
}
