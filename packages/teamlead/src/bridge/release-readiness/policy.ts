export function readReadinessPolicy(env: NodeJS.ProcessEnv = process.env) {
	const policy = {
		soakHours: 12,
		heartbeatFreshMin: 10,
		gapToleranceMin: 30,
		backlogAgeMaxS: 600,
		severeHold: 1,
		warningHold: 5,
		bugHold: 1,
		projects: ["flywheel", "machine"],
		ignoreKinds: [] as string[],
		bugLabel: "Bug",
		founderChannelConfigured: Boolean(
			env.FLYWHEEL_READINESS_REPORT_CHANNEL?.trim(),
		),
		policyDefaulted: [] as string[],
	};
	const numeric = {
		soakHours: "SOAK_HOURS",
		heartbeatFreshMin: "HEARTBEAT_FRESH_MIN",
		gapToleranceMin: "GAP_TOLERANCE_MIN",
		backlogAgeMaxS: "BACKLOG_AGE_MAX_S",
		severeHold: "SEVERE_HOLD",
		warningHold: "WARNING_HOLD",
		bugHold: "BUG_HOLD",
	} as const;
	for (const key of Object.keys(numeric) as (keyof typeof numeric)[]) {
		const name = `FLYWHEEL_READINESS_${numeric[key]}`;
		const raw = env[name]?.trim();
		if (raw === undefined) continue;
		const value = Number(raw);
		const allowsZero = key === "gapToleranceMin" || key === "backlogAgeMaxS";
		if (
			/^\d+(\.\d+)?$/.test(raw) &&
			Number.isFinite(value) &&
			(allowsZero ? value >= 0 : value > 0) &&
			(!key.endsWith("Hold") || Number.isSafeInteger(value))
		) {
			policy[key] = value;
		} else {
			policy.policyDefaulted.push(name);
		}
	}
	for (const key of ["projects", "ignoreKinds"] as const) {
		const name = `FLYWHEEL_READINESS_${key === "projects" ? "PROJECTS" : "IGNORE_KINDS"}`;
		if (env[name] === undefined) continue;
		const values = [
			...new Set(
				env[name]
					?.split(",")
					.map((v) => v.trim())
					.filter(Boolean),
			),
		];
		if (key === "projects" && values.length === 0) {
			policy.policyDefaulted.push(name);
		} else {
			policy[key] = values;
		}
	}
	if (env.FLYWHEEL_BUG_LABEL !== undefined) {
		if (env.FLYWHEEL_BUG_LABEL.trim()) {
			policy.bugLabel = env.FLYWHEEL_BUG_LABEL.trim();
		} else {
			policy.policyDefaulted.push("FLYWHEEL_BUG_LABEL");
		}
	}
	return policy;
}

export type ReadinessPolicy = ReturnType<typeof readReadinessPolicy>;
