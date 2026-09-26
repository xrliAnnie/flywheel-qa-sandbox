/**
 * Log Promise failures without terminating the Bridge. Local catch/retry owners
 * remain responsible for operation outcomes. The historical module/export name
 * is retained for both source and packaged entrypoint compatibility.
 * Library imports have no process-global side effects.
 */
export function installLinearTransportRejectionGuard(): () => void {
	const onUnhandledRejection = (reason: unknown): void => {
		// SDK error messages/raw fields can contain request credentials or payloads.
		// Keep call-site frames only; non-Error reasons get an observation stack.
		let stack: string | undefined;
		try {
			if (reason instanceof Error) stack = reason.stack;
		} catch {
			// Even a hostile stack getter must not make the rejection handler throw.
		}
		const frames =
			typeof stack === "string"
				? stack
						.split("\n")
						.filter((line) => /^\s+at /.test(line))
						.join("\n")
				: "";
		console.warn(
			"[Bridge] unhandledRejection source=process\n" +
				(frames ||
					new Error("Rejection observed (original stack unavailable)").stack),
		);
	};
	const onUncaughtException = (
		error: Error,
		origin: NodeJS.UncaughtExceptionOrigin,
	): void => {
		// Strict mode promotes a rejection before emitting unhandledRejection.
		// Allow that event to run; genuine synchronous exceptions remain fatal.
		if (origin !== "unhandledRejection") throw error;
	};
	process.on("unhandledRejection", onUnhandledRejection);
	process.on("uncaughtException", onUncaughtException);
	return () => {
		process.removeListener("unhandledRejection", onUnhandledRejection);
		process.removeListener("uncaughtException", onUncaughtException);
	};
}
