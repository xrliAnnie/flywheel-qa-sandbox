import type { ProfileIdentityResult } from "./account-identity.js";
import type { AccountUsageResult } from "./quota-usage-api.js";

export type AccountLiveness =
	| { verdict: "dead"; reason: string }
	| { verdict: "alive" }
	| { verdict: "unknown"; reason: string };

const ORGANIZATION_DISABLED_CODE = "oauth_not_allowed_for_organization";

export function classifyAccountLiveness(
	usage: AccountUsageResult,
	profile: ProfileIdentityResult,
): AccountLiveness {
	if ("ok" in usage) return { verdict: "alive" };

	if (
		usage.error === "forbidden" &&
		usage.errorCode === ORGANIZATION_DISABLED_CODE
	) {
		return {
			verdict: "dead",
			reason: `usage_forbidden:${ORGANIZATION_DISABLED_CODE}`,
		};
	}

	if ("error" in profile || profile.subscription === undefined) {
		return usage.error === "forbidden"
			? { verdict: "unknown", reason: "forbidden_unconfirmed" }
			: { verdict: "unknown", reason: "profile_missing" };
	}

	const { status, organizationType } = profile.subscription;
	if (status === "canceled") {
		return { verdict: "dead", reason: "profile_canceled" };
	}
	if (status === "active" || status === "trialing") {
		return organizationType === "claude_free"
			? { verdict: "unknown", reason: "free_org_unconfirmed" }
			: { verdict: "alive" };
	}
	return { verdict: "unknown", reason: `profile_${status}` };
}
