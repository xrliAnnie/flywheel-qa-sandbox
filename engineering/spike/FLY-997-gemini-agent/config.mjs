// FLY-997 spike config — pinned per plan §4 (model ids re-verified against
// ListModels on 2026-07-08; see evidence/s1-environment.md).
export const CONFIG = {
	models: {
		// pro tier: newest pro preview (deep-brain candidate, research §3.3)
		pro: "gemini-3.1-pro-preview",
		// flash tier: newest GA flash — what a build would default to.
		// (BFCL anchor model gemini-3.1-flash-lite also exists; recorded in evidence.)
		flash: "gemini-3.5-flash",
		// live tier (S3 only): track-A mouth/ears model
		live: "gemini-3.1-flash-live-preview",
	},
	mock: {
		host: "127.0.0.1",
		port: 47997,
	},
	loop: {
		maxSteps: 12,
	},
	budget: {
		// plan §4: total matrix ≤ ~200 model sessions; smoke-first.
		maxSessions: 200,
		// consecutive 429s before the harness halts (plan: no retry loops)
		quotaHaltAfter: 3,
	},
	paths: {
		outDir: new URL("./out/", import.meta.url).pathname,
		evidenceDir: new URL("./evidence/", import.meta.url).pathname,
	},
};
