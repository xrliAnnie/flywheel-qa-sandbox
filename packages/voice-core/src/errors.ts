/** Normalize raw process errors into VoiceError codes (shared by TTS / brain). */
import { AbortError, TimeoutError } from "./process.js";
import { VoiceError } from "./types.js";

export function mapProcessError(err: unknown, component: string): VoiceError {
	if (err instanceof VoiceError) return err;
	if (err instanceof AbortError) {
		return new VoiceError("cancelled", `${component} cancelled`, err);
	}
	if (err instanceof TimeoutError) {
		return new VoiceError(
			"timeout",
			`${component} timed out after ${err.timeoutMs}ms`,
			err,
		);
	}
	const e = err as NodeJS.ErrnoException;
	if (e?.code === "ENOENT") {
		return new VoiceError(
			"component-missing",
			`${component} not found / not executable (ENOENT)`,
			err,
		);
	}
	return new VoiceError(
		"subprocess-failed",
		`${component} failed: ${String(e?.message ?? err)}`,
		err,
	);
}
