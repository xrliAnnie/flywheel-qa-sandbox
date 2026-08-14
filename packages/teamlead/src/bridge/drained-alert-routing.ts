import {
	type AlertPayload,
	isInformationalKind,
} from "../LeadAlertNotifier.js";

export interface DeliveredAlert {
	payload: AlertPayload;
	channelId: string;
	messageId: string;
}

export interface DeliveredAlertHub {
	attachThreadForDelivered(
		payload: AlertPayload,
		channelId: string,
		messageId: string,
	): Promise<void>;
}

/** Stale suppression is expected product behavior, never a delivery failure. */
export function shouldReportDeadLetteredDrain(result: {
	deadLettered: number;
	staleSuppressed: number;
}): boolean {
	return result.deadLettered > 0;
}

/**
 * Feed actionable drained roots into the Hub. Informational roots are already
 * fully delivered and intentionally stop here: no thread, active row, or ARC.
 */
export async function attachDeliveredAlertLifecycles(
	delivered: readonly DeliveredAlert[],
	hub: DeliveredAlertHub,
	logger: (message: string) => void = console.warn,
): Promise<void> {
	for (const item of delivered) {
		if (isInformationalKind(item.payload.eventType)) continue;
		try {
			await hub.attachThreadForDelivered(
				item.payload,
				item.channelId,
				item.messageId,
			);
		} catch (err) {
			logger(`drained-thread attach failed: ${(err as Error).message}`);
		}
	}
}
