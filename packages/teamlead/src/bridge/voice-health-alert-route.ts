import { createHash } from "node:crypto";
import type { ProjectEntry } from "../ProjectConfig.js";
import {
	assertShuttleSendPermissions,
	resolveShuttleAlertRoutes,
} from "./shuttle-alert-route.js";

const VOICE_ORIGIN_PROJECT = "flywheel";

export interface VoiceHealthAlertRoute {
	routeKey: "primary";
	deliveryProject: string;
	leadId: string;
	channelId: string;
	tokenEnv?: string;
	botUserId?: string;
	bindingDigest: string;
}

/**
 * Voice health uses the same single engineering-primary identity as the
 * shuttle alert lane, but deliberately has no per-project copy route.
 */
export function resolveVoiceHealthAlertRoute(
	projects: ProjectEntry[],
): VoiceHealthAlertRoute {
	const primary = resolveShuttleAlertRoutes(
		projects,
		VOICE_ORIGIN_PROJECT,
	).primary;
	const stable = {
		schemaVersion: 1 as const,
		originProject: VOICE_ORIGIN_PROJECT,
		route: primary,
	};
	return {
		...primary,
		routeKey: "primary",
		bindingDigest: createHash("sha256")
			.update(JSON.stringify(stable))
			.digest("hex"),
	};
}

/** Fail closed before sending when the selected bot cannot see or post. */
export function assertVoiceHealthSendPermissions(permissions: bigint): void {
	assertShuttleSendPermissions(permissions);
}
