export const GO_NO_GO_CHECKS = [
	{ id: "1", title: "旧 writer PID/tmux/daemon 全退出" },
	{ id: "2", title: "旧 API token 与旧 capability 被拒" },
	{ id: "3", title: "每 active task ≤1 active attempt" },
	{ id: "4", title: "actions effect_key 唯一且 invocation 派生合同成立" },
	{ id: "5", title: "已启动 action outcome 已结算或诚实 intended" },
	{ id: "6", title: "migrated gate 绑 exact head" },
	{ id: "7", title: "v2 DB 权限/integrity/FK/WAL backup" },
	{ id: "8", title: "双源冻结、canonical 迁移对账及 journal 清账" },
	{ id: "9", title: "旧信箱只读归档且原路径 fence 就位" },
	{ id: "10", title: "实弹测试" },
	{ id: "namespace", title: "围栏路径与新路径不相交" },
	{ id: "github", title: "GitHub required-checks 且 actor 非 admin/bypass" },
] as const;

export interface GoNoGoObservation {
	legacyWritersStopped: boolean;
	oldCredentialsRejected: boolean;
	activeAttemptUniqueness: boolean;
	actionEffectKeyContract: boolean;
	actionOutcomesSettled: boolean;
	gatesBindExactHead: boolean;
	databaseContract: boolean;
	migrationConservation: boolean;
	journalsDrained: boolean;
	archivesAndTombstones: boolean;
	liveFirePassed: boolean;
	namespacesDisjoint: boolean;
	githubLanePassed: boolean;
	evidence: Record<string, string>;
}

export interface GoNoGoReport {
	v: 1;
	status: "go" | "no-go";
	observedAt: string;
	checks: Array<{
		id: string;
		title: string;
		status: "pass" | "fail";
		evidence: string | null;
	}>;
}

export function evaluateGoNoGo(
	observation: GoNoGoObservation,
	observedAt: string,
): GoNoGoReport {
	const parsed = Date.parse(observedAt);
	if (
		!Number.isFinite(parsed) ||
		new Date(parsed).toISOString() !== observedAt
	) {
		throw new TypeError("observedAt must be canonical UTC ISO-8601");
	}
	const values: Record<string, boolean> = {
		"1": observation.legacyWritersStopped,
		"2": observation.oldCredentialsRejected,
		"3": observation.activeAttemptUniqueness,
		"4": observation.actionEffectKeyContract,
		"5": observation.actionOutcomesSettled,
		"6": observation.gatesBindExactHead,
		"7": observation.databaseContract,
		"8": observation.migrationConservation && observation.journalsDrained,
		"9": observation.archivesAndTombstones,
		"10": observation.liveFirePassed,
		namespace: observation.namespacesDisjoint,
		github: observation.githubLanePassed,
	};
	const checks = GO_NO_GO_CHECKS.map((check) => {
		const evidence = observation.evidence[check.id] ?? null;
		const pass = values[check.id] === true && evidence !== null;
		return {
			id: check.id,
			title: check.title,
			status: pass ? ("pass" as const) : ("fail" as const),
			evidence,
		};
	});
	return {
		v: 1,
		status: checks.every((check) => check.status === "pass") ? "go" : "no-go",
		observedAt,
		checks,
	};
}
