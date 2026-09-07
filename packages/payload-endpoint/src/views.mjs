// FLY-1062 PR3 · entitlement view mapping (plan §B0-4) — pure functions.
//
// The OUTPUT shape is the PR2 client contract, byte-for-byte:
//   { latest: string, versions: [{ver, sha256}] }
// internal  → latest = internal-beta,   versions = every status=active entry
// customer  → latest = customer-release, versions = release ∧ active only
// (a superseded-but-active old release stays visible = the documented
// `flywheel install <old>` window).
import {
	CHANNEL_OF_POINTER,
	ENTITLEMENT_POINTER,
} from "flywheel-release-contract";

export function visibleEntries(manifest, entitlement) {
	const out = new Map();
	for (const [ver, e] of Object.entries(manifest.versions ?? {})) {
		if (e?.status !== "active") continue;
		if (entitlement === "customer" && e.channel !== "release") continue;
		out.set(ver, e);
	}
	return out;
}

// manifestView → {empty:true} when the entitlement's channel has no current
// pointer (pre-activation ops state, plan §B0-4: served as 503).
export function manifestView(manifest, entitlement) {
	const pointer = ENTITLEMENT_POINTER[entitlement];
	const latest = manifest.channels?.[pointer]?.latest ?? null;
	if (latest === null) {
		const entryChannel = CHANNEL_OF_POINTER[pointer];
		const hasHistory = Object.values(manifest.versions ?? {}).some(
			(entry) => entry?.channel === entryChannel,
		);
		return {
			empty: true,
			reason: hasHistory ? "paused" : "never-activated",
		};
	}
	const versions = [...visibleEntries(manifest, entitlement)]
		.map(([ver, e]) => ({ ver, sha256: e.sha256 }))
		.sort((a, b) => (a.ver < b.ver ? -1 : a.ver > b.ver ? 1 : 0));
	return { empty: false, view: { latest, versions } };
}
