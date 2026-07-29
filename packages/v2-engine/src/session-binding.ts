import { FenceViolation } from "flywheel-v2-kernel";
import type { SessionBinding } from "./types.js";

interface StoredSessionBinding {
	v: 1;
	host_epoch: string;
	session_id: string;
	pid: number;
	pid_start: string;
}

function requireNonEmpty(value: string, name: string): void {
	if (value.trim().length === 0) {
		throw new FenceViolation(`${name} must not be empty`);
	}
}

export function validateSessionBinding(binding: SessionBinding): void {
	if (binding.v !== 1) {
		throw new FenceViolation("session binding version must be 1");
	}
	requireNonEmpty(binding.hostEpoch, "session binding hostEpoch");
	requireNonEmpty(binding.sessionId, "session binding sessionId");
	if (!Number.isSafeInteger(binding.pid) || binding.pid <= 0) {
		throw new FenceViolation(
			"session binding pid must be a positive safe integer",
		);
	}
	requireNonEmpty(binding.pidStart, "session binding pidStart");
}

export function serializeSessionBinding(binding: SessionBinding): string {
	validateSessionBinding(binding);
	const stored: StoredSessionBinding = {
		v: 1,
		host_epoch: binding.hostEpoch,
		session_id: binding.sessionId,
		pid: binding.pid,
		pid_start: binding.pidStart,
	};
	return JSON.stringify(stored);
}

export function parseSessionBinding(value: string): SessionBinding {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		throw new FenceViolation(
			`session binding contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		Array.isArray(parsed) ||
		Object.keys(parsed).sort().join(",") !==
			"host_epoch,pid,pid_start,session_id,v"
	) {
		throw new FenceViolation("session binding shape is malformed");
	}
	const stored = parsed as Record<string, unknown>;
	const binding: SessionBinding = {
		v: stored.v as 1,
		hostEpoch: stored.host_epoch as string,
		sessionId: stored.session_id as string,
		pid: stored.pid as number,
		pidStart: stored.pid_start as string,
	};
	validateSessionBinding(binding);
	return binding;
}

export function sessionBindingsEqual(
	left: SessionBinding,
	right: SessionBinding,
): boolean {
	return serializeSessionBinding(left) === serializeSessionBinding(right);
}
