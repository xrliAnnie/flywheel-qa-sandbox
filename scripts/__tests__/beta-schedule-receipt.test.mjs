import assert from "node:assert/strict";
import test from "node:test";
import {
	betaInvocation,
	betaScheduleReceipt,
} from "../release/beta-schedule-receipt.mjs";

const env = {
	GITHUB_EVENT_NAME: "workflow_dispatch",
	GITHUB_REF: "refs/heads/main",
	FW_BETA_SCHEDULER_OWNER: "bridge",
	FW_ENDPOINT: "https://endpoint.example",
	EXPECTED_PROJECT_KEY: "flywheel",
	PROJECT_KEY: "flywheel",
	SCHEDULE_KEY: "a".repeat(64),
	SOURCE_COMMIT: "b".repeat(40),
};
test("receiver accepts only complete bound Bridge inputs with current bridge ownership", () => {
	assert.deepEqual(betaInvocation(env), {
		eligible: true,
		activated: true,
		bridge: true,
	});
	for (const patch of [
		{ PROJECT_KEY: "other" },
		{ SCHEDULE_KEY: "short" },
		{ SOURCE_COMMIT: "" },
		{ RELEASE_ID_INPUT: "force" },
		{ GITHUB_REF: "refs/heads/topic" },
		{ FW_BETA_SCHEDULER_OWNER: "invalid" },
		{ FW_BETA_SCHEDULER_OWNER: "legacy" },
	])
		assert.throws(() => betaInvocation({ ...env, ...patch }));
});
test("legacy 6h, paused and manual paths remain explicit and unactivated Bridge yields no publication", () => {
	const base = {
		GITHUB_EVENT_NAME: "schedule",
		GITHUB_REF: "refs/heads/main",
		EXPECTED_PROJECT_KEY: "flywheel",
	};
	assert.deepEqual(betaInvocation(base), {
		eligible: true,
		activated: false,
		bridge: false,
	});
	assert.equal(
		betaInvocation({ ...base, FW_BETA_SCHEDULER_OWNER: "bridge" }).eligible,
		false,
	);
	assert.equal(
		betaInvocation({ ...base, FW_BETA_SCHEDULER_OWNER: "paused" }).eligible,
		false,
	);
	assert.equal(
		betaInvocation({
			...base,
			GITHUB_EVENT_NAME: "workflow_dispatch",
			FW_BETA_SCHEDULER_OWNER: "bridge",
			RELEASE_ID_INPUT: "force",
		}).eligible,
		true,
	);
	assert.equal(
		betaInvocation({
			...base,
			GITHUB_EVENT_NAME: "workflow_dispatch",
			FW_BETA_SCHEDULER_OWNER: "paused",
		}).eligible,
		false,
	);
	assert.equal(betaInvocation({ ...env, FW_ENDPOINT: "" }).activated, false);
});
test("receipt has exact run identity and never invents publication fields for not_activated", () => {
	const identity = {
		projectName: "flywheel",
		scheduleKey: env.SCHEDULE_KEY,
		sourceCommit: env.SOURCE_COMMIT,
		repositoryId: 1,
		workflowId: 2,
		runId: 3,
	};
	const result = {
		outcome: "published",
		publishedVersion: "1.0.0-beta.1",
		publishedSourceCommit: env.SOURCE_COMMIT,
		publishedAt: "2026-09-11T00:00:00.000Z",
	};
	assert.deepEqual(betaScheduleReceipt(identity, result), {
		schemaVersion: 1,
		...identity,
		...result,
	});
	assert.throws(() =>
		betaScheduleReceipt(identity, {
			...result,
			publishedSourceCommit: "c".repeat(40),
		}),
	);
	assert.throws(() => betaScheduleReceipt({ ...identity, runId: 0 }, result));
	assert.deepEqual(
		betaScheduleReceipt(identity, {
			outcome: "not_activated",
			publishedVersion: null,
			publishedSourceCommit: null,
			publishedAt: null,
		}),
		{
			schemaVersion: 1,
			...identity,
			outcome: "not_activated",
			publishedVersion: null,
			publishedSourceCommit: null,
			publishedAt: null,
		},
	);
});
test("a queued frozen commit remains publishable after main advances, with no pointer rollback", async () => {
	const { assessBetaSource } = await import(
		"../release/beta-schedule-receipt.mjs"
	);
	const { fixtureManifest, emptyManifest } = await import(
		"../../packages/payload-endpoint/__tests__/harness.mjs"
	);
	const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { execFileSync } = await import("node:child_process");
	const root = mkdtempSync(join(tmpdir(), "beta-ancestry-"));
	const git = (...args) =>
		execFileSync("git", ["-C", root, ...args], {
			encoding: "utf8",
			timeout: 10000,
		}).trim();
	try {
		git("init", "-q", "-b", "main");
		writeFileSync(join(root, "file"), "a");
		git("add", ".");
		git(
			"-c",
			"user.name=test",
			"-c",
			"user.email=test@example.com",
			"commit",
			"-qm",
			"a",
		);
		const a = git("rev-parse", "HEAD");
		writeFileSync(join(root, "file"), "b");
		git("add", ".");
		git(
			"-c",
			"user.name=test",
			"-c",
			"user.email=test@example.com",
			"commit",
			"-qm",
			"b",
		);
		const b = git("rev-parse", "HEAD");
		const opts = {
			repoRoot: root,
			sourceCommit: a,
			defaultRef: "refs/heads/main",
		};
		assert.equal(
			await assessBetaSource({ ...opts, manifest: emptyManifest() }),
			null,
		);
		const m = fixtureManifest({ withRelease: false });
		const version = m.channels["internal-beta"].latest;
		m.versions[version].sourceCommit = b;
		m.releaseOps["op-beta-1"].sourceCommit = b;
		assert.equal(
			(await assessBetaSource({ ...opts, manifest: m })).outcome,
			"covered_by_newer",
		);
		assert.equal(
			(await assessBetaSource({ ...opts, sourceCommit: b, manifest: m }))
				.outcome,
			"no_change",
		);
		m.versions[version].sourceCommit = a;
		m.releaseOps["op-beta-1"].sourceCommit = a;
		assert.equal(
			await assessBetaSource({ ...opts, sourceCommit: b, manifest: m }),
			null,
		);
		git("checkout", "--orphan", "other");
		writeFileSync(join(root, "file"), "other");
		git("add", ".");
		git(
			"-c",
			"user.name=test",
			"-c",
			"user.email=test@example.com",
			"commit",
			"-qm",
			"other",
		);
		const unrelated = git("rev-parse", "HEAD");
		await assert.rejects(
			assessBetaSource({ ...opts, sourceCommit: unrelated, manifest: m }),
			/beta_source_unreachable/,
		);
		assert.equal(m.channels["internal-beta"].latest, version);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
