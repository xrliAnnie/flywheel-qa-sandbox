export type CodexQuotaManualReason =
	| "flag_disabled"
	| "readiness_receipt_missing"
	| "readiness_receipt_invalid"
	| "authority_unavailable"
	| "credential_not_shared"
	| "canonical_unavailable"
	| "runtime_unavailable"
	| "readiness_unchecked"
	| "manual_handoff"
	| "legacy_capacity_evidence_missing";

export type CodexQuotaAvailabilitySnapshot = {
	mode: "automatic" | "manual";
	reasons: CodexQuotaManualReason[];
	revision: number;
	checkedAt: string | null;
};

const REASON_PRIORITY: readonly CodexQuotaManualReason[] = [
	"readiness_receipt_missing",
	"readiness_receipt_invalid",
	"credential_not_shared",
	"canonical_unavailable",
	"authority_unavailable",
	"runtime_unavailable",
	"flag_disabled",
	"readiness_unchecked",
	"manual_handoff",
	"legacy_capacity_evidence_missing",
];

const REASON_COPY: Record<CodexQuotaManualReason, string> = {
	flag_disabled: "总开关关闭",
	readiness_receipt_missing: "readiness-receipt 不存在",
	readiness_receipt_invalid: "readiness-receipt 无效",
	authority_unavailable: "readiness 权威不可用",
	credential_not_shared: "运行凭据未共享",
	canonical_unavailable: "canonical 凭据不可用",
	runtime_unavailable: "自动切号运行时不可用",
	readiness_unchecked: "readiness 尚未完成",
	manual_handoff: "该轮额度事件已交 Lead 手工",
	legacy_capacity_evidence_missing: "容量证据缺失、已退回手工",
};

export function formatCodexQuotaManualReason(
	reason: CodexQuotaManualReason,
): string {
	return REASON_COPY[reason];
}

function orderReasons(
	reasons: Iterable<CodexQuotaManualReason>,
): CodexQuotaManualReason[] {
	const set = new Set(reasons);
	return REASON_PRIORITY.filter((reason) => set.has(reason));
}

export interface CodexQuotaAvailabilityOptions {
	enabled(): boolean;
	runtimeAvailable(): boolean;
	check(): Promise<{
		ready: boolean;
		failures: readonly { reason: CodexQuotaManualReason }[];
	}>;
	now?: () => number;
}

/**
 * One process-local decision point for every automatic quota side effect.
 * Readiness remains read-only; durable event disposition is owned by the store.
 */
export class CodexQuotaAvailability {
	private current: CodexQuotaAvailabilitySnapshot = {
		mode: "manual",
		reasons: ["readiness_unchecked"],
		revision: 0,
		checkedAt: null,
	};
	private inFlight: Promise<CodexQuotaAvailabilitySnapshot> | undefined;

	constructor(private readonly options: CodexQuotaAvailabilityOptions) {}

	snapshot(): CodexQuotaAvailabilitySnapshot {
		return { ...this.current, reasons: [...this.current.reasons] };
	}

	refresh(): Promise<CodexQuotaAvailabilitySnapshot> {
		if (this.inFlight) return this.inFlight;
		this.inFlight = this.run().finally(() => {
			this.inFlight = undefined;
		});
		return this.inFlight;
	}

	private async run(): Promise<CodexQuotaAvailabilitySnapshot> {
		let result:
			| {
					ready: boolean;
					failures: readonly { reason: CodexQuotaManualReason }[];
			  }
			| undefined;
		try {
			result = await this.options.check();
		} catch {
			result = {
				ready: false,
				failures: [{ reason: "authority_unavailable" }],
			};
		}
		const reasons = new Set<CodexQuotaManualReason>();
		if (!result.ready) {
			for (const failure of result.failures) reasons.add(failure.reason);
			if (!reasons.size) reasons.add("authority_unavailable");
		}
		// These values are deliberately read after the await. A stale success can
		// never authorize an automatic action after the switch/runtime changed.
		if (!this.options.runtimeAvailable()) reasons.add("runtime_unavailable");
		if (!this.options.enabled()) reasons.add("flag_disabled");
		const next: CodexQuotaAvailabilitySnapshot = {
			mode: reasons.size === 0 ? "automatic" : "manual",
			reasons: orderReasons(reasons),
			revision: this.current.revision + 1,
			checkedAt: new Date((this.options.now ?? Date.now)()).toISOString(),
		};
		this.current = next;
		return this.snapshot();
	}
}
