import type Database from "better-sqlite3";
/** Test-only seed for a previously authenticated activation. Never imported by production. */
export function seedReleaseActivation(
	db: Database.Database,
	input: {
		founderId: string;
		policyRevision: string;
		audience: string;
		now: number;
	},
): void {
	const identity = {
		projectId: "flywheel",
		founderId: input.founderId,
		policyRevision: input.policyRevision,
		audience: input.audience,
		endpoint: "https://fixture.example",
		identityDigest: "d".repeat(64),
		botTokenSha256: "b".repeat(64),
		decisionTokenSha256: "c".repeat(64),
	};
	db.prepare(
		"INSERT INTO customer_release_activation VALUES ('flywheel',1,?,1,'enable-1',?)",
	).run(JSON.stringify(identity), "e".repeat(64));
	db.prepare(
		"INSERT INTO customer_release_activation_events VALUES ('enable-1','flywheel',1,'enabled',?,?)",
	).run(JSON.stringify({ actorId: input.founderId }), input.now);
}
