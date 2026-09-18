import type {
	CanonicalCommit,
	CheckoutCommit,
	PortfolioSnapshot,
	ProjectReading,
	Reading,
} from "./types.js";

function escapeInline(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function display<T>(reading: Reading<T>, format: (value: T) => string): string {
	return reading.ok
		? format(reading.value)
		: `读不到:${escapeInline(reading.reason)}`;
}

function refLine<T>(
	label: string,
	reading: Reading<T>,
	ref: string,
	format: (value: T) => string,
): string {
	return `- ${label}: ${display(reading, format)} (ref: ${ref})`;
}

function checkoutCommit(value: CheckoutCommit): string {
	return `${value.sha7} · committed ${value.committedAt} · authored ${value.authoredAt} · ${escapeInline(value.author)} · ${escapeInline(value.subject)}`;
}

function canonicalCommit(value: CanonicalCommit): string {
	return `${value.sha7} · ${value.committedAt} · ${escapeInline(value.subject)}`;
}

function missingSources(project: ProjectReading): string[] {
	const sources: Array<[string, Reading<unknown>[]]> = [
		["Git", Object.values(project.checkoutHead)],
		[
			"GitHub",
			[
				...Object.values(project.canonical),
				...Object.values(project.prActivity),
				...Object.values(project.openPrs),
			],
		],
		["Linear", Object.values(project.linear)],
	];
	return sources
		.filter(([, readings]) => readings.every((reading) => !reading.ok))
		.map(([name]) => name);
}

function renderProject(project: ProjectReading): string {
	const prefix = project.projectName;
	const lines = [
		`## ${prefix}`,
		`- 仓库: ${project.repo ? escapeInline(project.repo) : "未配置"}`,
		refLine(
			"checkout 分支",
			project.checkoutHead.branch,
			`${prefix}.checkoutHead.branch`,
			escapeInline,
		),
		refLine(
			"checkout 最近提交",
			project.checkoutHead.lastCommit,
			`${prefix}.checkoutHead.lastCommit`,
			checkoutCommit,
		),
		refLine(
			"checkout 最近非 chore 提交",
			project.checkoutHead.lastNonChoreCommit,
			`${prefix}.checkoutHead.lastNonChoreCommit`,
			(value) => (value ? checkoutCommit(value) : "无"),
		),
		`- checkout 近 30 天提交: ${display(project.checkoutHead.commits30d, String)}；非 chore: ${display(project.checkoutHead.nonChoreCommits30d, String)}`,
		`- checkout 工作区: dirty ${display(project.checkoutHead.dirtyCount, String)} 项；worktree ${display(project.checkoutHead.worktreeCount, String)} 个`,
		`- GitHub 默认分支: ${display(project.canonical.defaultBranch, escapeInline)}`,
		refLine(
			"GitHub 默认分支最近提交",
			project.canonical.lastCommit,
			`${prefix}.canonical.lastCommit`,
			canonicalCommit,
		),
		refLine(
			"全仓最近 PR 更新时间",
			project.prActivity.updatedAt,
			`${prefix}.prActivity.updatedAt`,
			(value) => value ?? "从未有 PR",
		),
		refLine(
			"开放 PR 数",
			project.openPrs.returnedCount,
			`${prefix}.openPrs.returnedCount`,
			String,
		),
		refLine(
			"开放 PR 最新更新时间",
			project.openPrs.newestUpdatedAt,
			`${prefix}.openPrs.newestUpdatedAt`,
			(value) => value ?? "无开放 PR",
		),
		`- Linear 项目状态: ${display(project.linear.projectState, escapeInline)}；项目更新时间: ${display(project.linear.projectUpdatedAt, escapeInline)}`,
		refLine(
			"Linear 活跃 issue",
			project.linear.activeIssues,
			`${prefix}.linear.activeIssues`,
			(value) =>
				`${value.returnedCount}${value.truncated ? "+" : ""} 个；最近更新 ${value.latestUpdatedAt ?? "无"}`,
		),
		`- 部署 checkout 里的 summary 文件，不代表未读或已读: ${display(project.deployedCheckoutSummaryFiles.count, String)} 个；最近日期 ${display(project.deployedCheckoutSummaryFiles.latestDate, (value) => value ?? "无")}；checkout ${display(project.deployedCheckoutSummaryFiles.checkoutSha, escapeInline)}`,
		refLine(
			"距最近可观测活动",
			project.activity.daysSinceLatestObservedActivity,
			`${prefix}.activity.daysSinceLatestObservedActivity`,
			(value) => `${value} 天`,
		),
	];
	return lines.join("\n");
}

export function renderSnapshot(snapshot: PortfolioSnapshot): string {
	const missing = snapshot.projects
		.map((project) => ({
			projectName: project.projectName,
			sources: missingSources(project),
		}))
		.filter(({ sources }) => sources.length > 0);
	const summary =
		missing.length === 0
			? "- 无"
			: missing
					.map(
						({ projectName, sources }) =>
							`- ${projectName}: ${sources.join("、")}`,
					)
					.join("\n");
	return [
		`# 各仓实读（snapshot ${snapshot.snapshotId}，采样于 ${snapshot.sampledAt}）`,
		`来源总览: Git=${snapshot.all.git}；GitHub=${snapshot.all.gh}；Linear=${snapshot.all.linear}`,
		...snapshot.projects.map(renderProject),
		"## 读不到的项目/来源",
		summary,
	].join("\n\n");
}
