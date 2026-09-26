import type { ResidentVoiceLease } from "../resident-voice-session.js";

export interface GlawLeaseHeartbeat {
	assertHealthy(): void;
	stop(): void;
}

/** Keep the cross-process room fence alive for the whole /glaw meeting. */
export function startGlawLeaseHeartbeat(opts: {
	lease: ResidentVoiceLease;
	onLost(error: Error): Promise<void> | void;
	log?: (line: string) => void;
}): GlawLeaseHeartbeat {
	let stopped = false;
	let lost: Error | undefined;
	const stopRenewing = opts.lease.startRenewing((error) => {
		lost = error;
		if (stopped) return;
		opts.log?.(`glaw resident lease lost: ${error.message}`);
		void Promise.resolve()
			.then(() => opts.onLost(error))
			.catch((teardownError: unknown) => {
				opts.log?.(
					`glaw resident lease-loss teardown failed: ${String((teardownError as Error).message ?? teardownError)}`,
				);
			});
	});

	return {
		assertHealthy: () => {
			if (lost) throw lost;
			opts.lease.assertActive();
		},
		stop: () => {
			if (stopped) return;
			stopped = true;
			stopRenewing();
		},
	};
}
