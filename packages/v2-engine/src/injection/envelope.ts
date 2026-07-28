import type { InjectionShim } from "../types.js";

type InjectionMessage = Parameters<InjectionShim["deliver"]>[1];

export function encodeInjectionEnvelope(message: InjectionMessage): string {
	if (
		typeof message.messageUid !== "string" ||
		message.messageUid.length === 0 ||
		typeof message.attemptUid !== "string" ||
		message.attemptUid.length === 0 ||
		typeof message.payload !== "string"
	) {
		throw new TypeError("injection message fields are invalid");
	}
	return JSON.stringify({
		v: 1,
		kind: "flywheel-injection",
		messageUid: message.messageUid,
		attemptUid: message.attemptUid,
		payload: message.payload,
	});
}
