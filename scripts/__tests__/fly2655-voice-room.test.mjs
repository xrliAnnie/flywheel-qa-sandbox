import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { migrateSummaryRegistry } from "../../packages/flywheel-comm/dist/summary-registry-migration.js";
import {
	buildVoiceFixtureArtifacts,
	finalizeVoiceFixtureReceipt,
	PRODUCTION_GENERAL_VOICE_CHANNEL_ID,
	parseVoiceFixture,
} from "../lib/fly2655-voice-fixture.mjs";
import {
	acquireVoiceRoomLease,
	assertQaIdentityDisjoint,
	buildVoiceProcessEnv,
	loadSlot,
	releaseVoiceRoomLease,
	releaseVoiceRoomLeasesForSlot,
	summarizeVoiceEvidence,
	validateDiscordThreadPermissions,
	validateDiscordVoicePermissions,
	validateDiscordVoiceTarget,
	validatePreparedTopology,
} from "../qa/fly2655-voice-room.mjs";

const snowflake = (last) => `12345678901234567${last}`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fixture = () => ({
	schemaVersion: 1,
	guildId: snowflake("1"),
	voiceChannelId: snowflake("2"),
	qaCategoryId: snowflake("3"),
	founderUserId: snowflake("4"),
	allowUserIds: [snowflake("4"), snowflake("5")],
});
const projects = () => [
	{
		projectName: "test-slot-2",
		projectRoot: "/tmp/flywheel-test-slot-2/repo",
		leads: [
			{
				agentId: "flywheel-test-2",
				botUserId: snowflake("6"),
				botTokenEnv: "TEST_BOT_TOKEN_2",
			},
		],
	},
];

test("public voice fixture is exact and rejects production General", () => {
	assert.deepEqual(parseVoiceFixture(fixture()), fixture());
	assert.throws(
		() =>
			parseVoiceFixture({
				...fixture(),
				voiceChannelId: PRODUCTION_GENERAL_VOICE_CHANNEL_ID,
			}),
		/production_general_rejected/,
	);
	assert.throws(
		() => parseVoiceFixture({ ...fixture(), secret: "must-not-exist" }),
		/unknown_key/,
	);
	assert.throws(
		() => parseVoiceFixture({ ...fixture(), allowUserIds: [snowflake("5")] }),
		/founder_not_allowlisted/,
	);
});

test("artifact builder installs one final registry and slot-private configs", () => {
	const slotDir = mkdtempSync(join(tmpdir(), "flywheel-test-slot-"));
	const result = buildVoiceFixtureArtifacts({
		fixture: fixture(),
		projects: projects(),
		slotDir,
		projectName: "test-slot-2",
		leadId: "flywheel-test-2",
		botUserId: snowflake("6"),
		botTokenEnv: "TEST_BOT_TOKEN_2",
	});
	assert.deepEqual(result.projects[0].voiceRoom, {
		guildId: snowflake("1"),
		voiceChannelId: snowflake("2"),
	});
	assert.deepEqual(result.projects[0].leads[0].voiceModes, {
		meeting: true,
		rg: true,
	});
	assert.equal("codexVoiceActions" in result.projects[0].leads[0], false);
	assert.deepEqual(JSON.parse(readFileSync(result.voiceHostPath, "utf8")), {
		schemaVersion: 1,
		qaVoiceChannelIds: [snowflake("2")],
		qaAllowUserIds: [snowflake("4"), snowflake("5")],
		evidenceRoots: [join(slotDir, "state", "voice-evidence")],
	});
	assert.equal(statSync(result.voiceHostPath).mode & 0o777, 0o600);
	assert.equal(statSync(result.codexHome).mode & 0o777, 0o700);
	assert.match(
		readFileSync(result.meetingNotesPath, "utf8"),
		new RegExp(`meetingStateDir: ${slotDir}/state/meetings`),
	);
	assert.equal(
		result.commDbPath,
		join(slotDir, "state/comm/test-slot-2/comm.db"),
	);
	const activated = projects();
	activated[0].leads[0].codexVoiceActions = true;
	assert.throws(
		() =>
			buildVoiceFixtureArtifacts({
				fixture: fixture(),
				projects: activated,
				slotDir,
				projectName: "test-slot-2",
				leadId: "flywheel-test-2",
				botUserId: snowflake("6"),
				botTokenEnv: "TEST_BOT_TOKEN_2",
			}),
		/model_voice_actions_must_remain_default_off/,
	);
});

test("canonical macOS slot root accepts manifests written through the /tmp alias", () => {
	const slotId = `${process.pid}${Date.now()}`;
	const slotDir = `/tmp/flywheel-test-slot-${slotId}`;
	const canonicalSlotDir = `/private/tmp/flywheel-test-slot-${slotId}`;
	const head = "a".repeat(40);
	const aliasTopology = {
		slotDir: canonicalSlotDir,
		buildSha: head,
		expectedHead: head,
		projectName: "test-slot-2",
		leadId: "flywheel-test-2",
		founderUserId: snowflake("4"),
		discordOwnerUserId: snowflake("4"),
		guildId: snowflake("1"),
		voiceChannelId: snowflake("2"),
		qaCategoryId: snowflake("3"),
		qaVoiceChannelIds: [snowflake("2")],
		commDbPath: `${slotDir}/state/comm/test-slot-2/comm.db`,
	};
	assert.equal(validatePreparedTopology(aliasTopology), aliasTopology);
	assert.throws(
		() =>
			validatePreparedTopology({
				...aliasTopology,
				commDbPath: `/tmp/flywheel-test-slot-${slotId}9/state/comm/test-slot-2/comm.db`,
			}),
		/comm_db_outside_slot/,
	);

	mkdirSync(slotDir, { mode: 0o700 });
	try {
		const built = buildVoiceFixtureArtifacts({
			fixture: fixture(),
			projects: projects(),
			slotDir,
			projectName: "test-slot-2",
			leadId: "flywheel-test-2",
			botUserId: snowflake("6"),
			botTokenEnv: "TEST_BOT_TOKEN_2",
		});
		const projectsJson = JSON.stringify(built.projects);
		const projectsPath = `${slotDir}/flywheel-projects.json`;
		const repoRoot = realpathSync(new URL("../..", import.meta.url));
		writeFileSync(projectsPath, `${projectsJson}\n`, { mode: 0o600 });
		finalizeVoiceFixtureReceipt({
			receiptPath: built.receiptPath,
			projectsPath,
		});
		writeFileSync(
			`${slotDir}/bridge-launch.json`,
			`${JSON.stringify({
				repoRoot,
				environment: [
					`FLYWHEEL_PROJECTS=${projectsJson}`,
					`FLYWHEEL_PROJECTS_FILE=${projectsPath}`,
					`DISCORD_OWNER_USER_ID=${fixture().founderUserId}`,
				],
			})}\n`,
			{ mode: 0o600 },
		);
		writeFileSync(
			`${slotDir}/room-info.json`,
			`${JSON.stringify({
				slot: Number(slotId),
				projectName: "test-slot-2",
				agentId: "flywheel-test-2",
				flywheelRepo: repoRoot,
				flywheelProjectsFile: projectsPath,
				buildSha: head,
			})}\n`,
			{ mode: 0o600 },
		);

		const loaded = loadSlot(realpathSync(slotDir), head);
		assert.equal(loaded.topology.slotDir, realpathSync(slotDir));
		assert.equal(
			loaded.projectsPath,
			`${realpathSync(slotDir)}/flywheel-projects.json`,
		);
		assert.equal(
			loadSlot(slotDir, head).projectsPath,
			`${realpathSync(slotDir)}/flywheel-projects.json`,
		);

		const projectsLink = `${slotDir}/flywheel-projects-link.json`;
		symlinkSync(projectsPath, projectsLink);
		writeFileSync(
			`${slotDir}/room-info.json`,
			`${JSON.stringify({
				slot: Number(slotId),
				projectName: "test-slot-2",
				agentId: "flywheel-test-2",
				flywheelRepo: repoRoot,
				flywheelProjectsFile: projectsLink,
				buildSha: head,
			})}\n`,
			{ mode: 0o600 },
		);
		assert.throws(
			() => loadSlot(realpathSync(slotDir), head),
			/slot_symlink_rejected/,
		);
	} finally {
		rmSync(slotDir, { recursive: true, force: true });
	}
});

test("loadSlot accepts the final registry bytes produced by the summary migrator", () => {
	const slotId = `${process.pid}${Date.now()}`;
	const slotDir = `/tmp/flywheel-test-slot-${slotId}`;
	const head = "b".repeat(40);
	mkdirSync(slotDir, { mode: 0o700 });
	try {
		const built = buildVoiceFixtureArtifacts({
			fixture: fixture(),
			projects: projects(),
			slotDir,
			projectName: "test-slot-2",
			leadId: "flywheel-test-2",
			botUserId: snowflake("6"),
			botTokenEnv: "TEST_BOT_TOKEN_2",
		});
		const projectsPath = join(slotDir, "flywheel-projects.json");
		const sourceBytes = `${JSON.stringify(built.projects)}\n`;
		writeFileSync(projectsPath, sourceBytes, { mode: 0o600 });

		const summaryHome = join(slotDir, "summary-home");
		mkdirSync(join(summaryHome, ".flywheel"), { recursive: true });
		writeFileSync(
			join(summaryHome, ".flywheel", "summary-config.json"),
			JSON.stringify({
				granularity: "per-lead",
				setBy: "founder",
				setAt: "2026-09-18T00:00:00.000Z",
			}),
			{ mode: 0o600 },
		);
		const assignmentsPath = join(slotDir, "summary-assignments.json");
		const migrationReceiptPath = join(slotDir, "summary-receipt.json");
		writeFileSync(
			assignmentsPath,
			JSON.stringify({
				assignments: [
					{
						projectName: "test-slot-2",
						leadId: "flywheel-test-2",
						summaryRole: "exempt",
					},
				],
			}),
			{ mode: 0o600 },
		);
		const migration = migrateSummaryRegistry(
			{
				projectsPath,
				assignmentsPath,
				receiptPath: migrationReceiptPath,
				expectedSha256: sha256(sourceBytes),
				homeDir: summaryHome,
			},
			{
				validateTeamleadCandidate: () => undefined,
				now: () => "2026-09-18T00:01:00.000Z",
			},
		);
		const migratedBytes = readFileSync(projectsPath);
		const migratedProjects = JSON.parse(migratedBytes.toString("utf8"));
		const compactProjects = JSON.stringify(migratedProjects);
		assert.notEqual(migratedBytes.toString("utf8").trim(), compactProjects);
		assert.equal(sha256(migratedBytes), migration.postImageSha256);

		const finalized = spawnSync(
			process.execPath,
			[
				fileURLToPath(
					new URL("../lib/fly2655-voice-fixture.mjs", import.meta.url),
				),
				"finalize",
				"--receipt",
				built.receiptPath,
				"--projects",
				projectsPath,
			],
			{ encoding: "utf8" },
		);
		assert.equal(finalized.status, 0, finalized.stderr);
		const fixtureReceipt = JSON.parse(readFileSync(built.receiptPath, "utf8"));
		assert.equal(fixtureReceipt.projectsSha256, migration.postImageSha256);

		const repoRoot = realpathSync(new URL("../..", import.meta.url));
		writeFileSync(
			join(slotDir, "bridge-launch.json"),
			`${JSON.stringify({
				repoRoot,
				environment: [
					`FLYWHEEL_PROJECTS=${compactProjects}`,
					`FLYWHEEL_PROJECTS_FILE=${projectsPath}`,
					`DISCORD_OWNER_USER_ID=${fixture().founderUserId}`,
				],
			})}\n`,
			{ mode: 0o600 },
		);
		writeFileSync(
			join(slotDir, "room-info.json"),
			`${JSON.stringify({
				slot: 2,
				projectName: "test-slot-2",
				agentId: "flywheel-test-2",
				flywheelRepo: repoRoot,
				flywheelProjectsFile: projectsPath,
				buildSha: head,
			})}\n`,
			{ mode: 0o600 },
		);

		const loaded = loadSlot(slotDir, head);
		assert.deepEqual(JSON.parse(loaded.projectsJson), migratedProjects);
		assert.equal(
			loaded.fixtureReceipt.projectsSha256,
			migration.postImageSha256,
		);
	} finally {
		rmSync(slotDir, { recursive: true, force: true });
	}
});

test("voice process env is an allowlist and binds the slot registry and CommDB", () => {
	const slotDir = "/tmp/flywheel-test-slot-2";
	const env = buildVoiceProcessEnv({
		slotDir,
		repoRoot: "/work/flywheel",
		bridgeUrl: "http://127.0.0.1:9202",
		apiToken: "slot-master",
		botTokenEnv: "TEST_BOT_TOKEN_2",
		botToken: "test-bot-secret",
		openAiApiKey: "realtime-secret",
		projectsPath: `${slotDir}/flywheel-projects.json`,
		projectsJson: '[{"projectName":"test-slot-2"}]',
		projectName: "test-slot-2",
		buildSha: "a".repeat(40),
		voiceHostPath: `${slotDir}/state/voice-host.json`,
		meetingNotesPath: `${slotDir}/state/meeting-notes.yaml`,
		baseEnv: {
			PATH: "/usr/bin",
			HOME: "/Users/qa",
			FLYWHEEL_EXECUTION_ID: "must-be-scrubbed",
			FLYWHEEL_ACTIVATION_ID: "must-be-scrubbed",
			DISCORD_BOT_TOKEN: "production-token",
		},
	});
	assert.equal(
		env.FLYWHEEL_COMM_DB,
		`${slotDir}/state/comm/test-slot-2/comm.db`,
	);
	assert.equal(env.FLYWHEEL_PROJECTS, '[{"projectName":"test-slot-2"}]');
	assert.equal(env.FLYWHEEL_VOICE_BUILD_SHA, "a".repeat(40));
	assert.equal(env.TEST_BOT_TOKEN_2, "test-bot-secret");
	assert.equal(env.DISCORD_BOT_TOKEN, undefined);
	assert.equal(env.FLYWHEEL_EXECUTION_ID, undefined);
	assert.equal(env.FLYWHEEL_ACTIVATION_ID, undefined);
	assert.deepEqual(
		Object.keys(env).sort(),
		[
			"BRIDGE_URL",
			"FLYWHEEL_BRIDGE_URL",
			"FLYWHEEL_COMM_CLI",
			"FLYWHEEL_COMM_DB",
			"FLYWHEEL_DIR",
			"FLYWHEEL_MEETING_NOTES_CONFIG",
			"FLYWHEEL_PROJECTS",
			"FLYWHEEL_PROJECTS_FILE",
			"FLYWHEEL_STATE_DIR",
			"FLYWHEEL_VOICE_CODEX_HOME",
			"FLYWHEEL_VOICE_BUILD_SHA",
			"FLYWHEEL_VOICE_HOST_CONFIG",
			"FLYWHEEL_VOICE_STATE_DIR",
			"HOME",
			"OPENAI_API_KEY",
			"PATH",
			"TEAMLEAD_API_TOKEN",
			"TEST_BOT_TOKEN_2",
			"TMPDIR",
		].sort(),
	);
});

test("prepared topology and Discord channel checks fail closed", () => {
	const base = {
		slotDir: "/tmp/flywheel-test-slot-2",
		buildSha: "a".repeat(40),
		expectedHead: "a".repeat(40),
		projectName: "test-slot-2",
		leadId: "flywheel-test-2",
		founderUserId: snowflake("4"),
		discordOwnerUserId: snowflake("4"),
		guildId: snowflake("1"),
		voiceChannelId: snowflake("2"),
		qaCategoryId: snowflake("3"),
		qaVoiceChannelIds: [snowflake("2")],
		commDbPath: "/tmp/flywheel-test-slot-2/state/comm/test-slot-2/comm.db",
	};
	assert.equal(validatePreparedTopology(base), base);
	assert.throws(
		() =>
			validatePreparedTopology({ ...base, discordOwnerUserId: snowflake("5") }),
		/founder_identity_mismatch/,
	);
	assert.throws(
		() => validatePreparedTopology({ ...base, commDbPath: "/tmp/comm.db" }),
		/comm_db_outside_slot/,
	);
	assert.deepEqual(
		validateDiscordVoiceTarget(
			{
				id: snowflake("2"),
				guild_id: snowflake("1"),
				parent_id: snowflake("3"),
				type: 2,
			},
			base,
		),
		{
			id: snowflake("2"),
			guild_id: snowflake("1"),
			parent_id: snowflake("3"),
			type: 2,
		},
	);
	assert.throws(
		() =>
			validateDiscordVoiceTarget(
				{
					id: snowflake("2"),
					guild_id: snowflake("1"),
					parent_id: snowflake("5"),
					type: 2,
				},
				base,
			),
		/qa_category_mismatch/,
	);
});

test("test-deploy keeps the voice fixture opt-in and installs it before Lead start", () => {
	const source = readFileSync(
		new URL("../test-deploy.sh", import.meta.url),
		"utf8",
	);
	assert.equal(
		[...source.matchAll(/"FLYWHEEL_COMM_DB=/g)].length,
		1,
		"the launcher-owned Lead CommDB assignment must not be redeclared",
	);
	const install = source.indexOf('fly2655-voice-fixture.mjs" install');
	const registryWrite = source.indexOf(
		'echo "$FLYWHEEL_PROJECTS" > "$FLYWHEEL_PROJECTS_FILE"',
	);
	const receiptMint = source.indexOf("qa_multilead_mint_summary_receipt");
	const receiptFinalize = source.indexOf('fly2655-voice-fixture.mjs" finalize');
	const leadStart = source.indexOf("LEAD_LAUNCH_RECORD=$(qa_slot_start_lead");
	assert.ok(
		install > 0 &&
			install < registryWrite &&
			registryWrite < receiptMint &&
			receiptMint < receiptFinalize &&
			receiptFinalize < leadStart,
		"voice fixture must bind the migrated registry before the Lead starts",
	);
	assert.match(source, /--voice-fixture requires --generalized --mode slot/);
	assert.match(source, /--voice-fixture requires --expect-head/);
	assert.match(source, /--voice-fixture requires a real Lead/);
	assert.match(source, /BRIDGE_ENV_UNSET_ARGS\+=\(-u OPENAI_API_KEY\)/);
	assert.match(
		source,
		/QA1189_OWNER_OVERRIDE="\$VOICE_FIXTURE_FOUNDER_USER_ID"/,
	);
	const voiceFixtureEnvBlock = source.slice(
		source.indexOf("VOICE_FIXTURE_COMM_DB="),
		source.indexOf("# Launch specs are intentionally single-line"),
	);
	const bridgeEnv = voiceFixtureEnvBlock.match(
		/BRIDGE_EXTRA_ENV\+=\(\n([\s\S]*?)\n {2}\)/,
	)?.[1];
	const leadEnv = voiceFixtureEnvBlock.match(
		/LEAD_EXTRA_ENV\+=\(\n([\s\S]*?)\n {2}\)/,
	)?.[1];
	assert.ok(bridgeEnv, "voice fixture Bridge env block must exist");
	assert.ok(leadEnv, "voice fixture Lead env block must exist");
	assert.doesNotMatch(bridgeEnv, /FLYWHEEL_COMM_DB=/);
	assert.doesNotMatch(leadEnv, /FLYWHEEL_COMM_DB=/);
	const contract = JSON.parse(
		readFileSync(new URL("../lib/qa-slot-env-contract.json", import.meta.url)),
	);
	assert.deepEqual(
		contract.find((entry) => entry.name === "FLYWHEEL_COMM_DB"),
		{
			name: "FLYWHEEL_COMM_DB",
			disposition: "clear",
			boot: "mustBeAbsent",
		},
	);
	for (const name of [
		"FLYWHEEL_VOICE_HOST_CONFIG",
		"FLYWHEEL_MEETING_NOTES_CONFIG",
		"FLYWHEEL_VOICE_STATE_DIR",
		"FLYWHEEL_VOICE_CODEX_HOME",
	]) {
		assert.deepEqual(
			contract.find((entry) => entry.name === name),
			{ name, disposition: "clear", boot: "mustBeUnderRootIfSet" },
		);
	}
});

test("voice room lease is same-slot idempotent and never releases a foreign owner", () => {
	const suffix = String(process.pid).padStart(6, "0").slice(-6);
	const root = mkdtempSync(join(tmpdir(), "fly2867-voice-lease-"));
	// FLY-2867: a live owner is one whose 529 slot directory still exists.
	const liveOwnerSlot = `/tmp/flywheel-test-slot-2655${suffix}`;
	mkdirSync(liveOwnerSlot);
	const topology = {
		guildId: `999999999999${suffix}`,
		voiceChannelId: `888888888888${suffix}`,
		slotDir: liveOwnerSlot,
		projectName: "test-slot-2655",
		leadId: "flywheel-test-2655",
	};
	try {
		assert.equal(acquireVoiceRoomLease(topology, { root }).created, true);
		assert.equal(acquireVoiceRoomLease(topology, { root }).created, false);
		assert.throws(
			() =>
				acquireVoiceRoomLease(
					{ ...topology, slotDir: "/tmp/flywheel-test-slot-2656" },
					{ root },
				),
			/voice_room_lease_conflict/,
		);
		assert.equal(releaseVoiceRoomLease(topology, { root }), true);
		assert.equal(releaseVoiceRoomLease(topology, { root }), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(liveOwnerSlot, { recursive: true, force: true });
	}
});

function fly2867LeaseTopology(slotDir) {
	const suffix = String(process.pid).padStart(6, "0").slice(-6);
	return {
		guildId: `999999999999${suffix}`,
		voiceChannelId: `777777777777${suffix}`,
		slotDir,
		projectName: "test-slot-2867",
		leadId: "flywheel-test-2867",
	};
}

function fly2867Owner(root, topology) {
	return JSON.parse(
		readFileSync(
			join(
				root,
				`flywheel-voice-room-${topology.guildId}-${topology.voiceChannelId}.lock`,
				"owner.json",
			),
			"utf8",
		),
	);
}

function fly2867WriteLease(root, name, owner) {
	mkdirSync(join(root, name), { mode: 0o700 });
	writeFileSync(join(root, name, "owner.json"), `${JSON.stringify(owner)}\n`);
}

function fly2867LiveDaemon() {
	const child = spawnSync("sh", ["-c", "sleep 30 >/dev/null 2>&1 & echo $!"], {
		encoding: "utf8",
	});
	const pid = Number(child.stdout.trim());
	const identity = spawnSync(
		"ps",
		["-o", "lstart=,command=", "-p", String(pid)],
		{
			encoding: "utf8",
		},
	).stdout.trim();
	return { pid, processIdentity: identity };
}

test("FLY-2867 a lease whose owner slot directory is gone is reclaimed atomically", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2867-voice-lease-"));
	const gone = `/tmp/flywheel-test-slot-2867${process.pid}`;
	const next = `/tmp/flywheel-test-slot-2868${process.pid}`;
	try {
		assert.equal(
			acquireVoiceRoomLease(fly2867LeaseTopology(gone), { root }).created,
			true,
		);
		// The owner's room was torn down without `stop`: its slot dir is gone.
		const claimed = acquireVoiceRoomLease(fly2867LeaseTopology(next), { root });
		assert.equal(claimed.created, true);
		assert.equal(fly2867Owner(root, fly2867LeaseTopology(next)).slotDir, next);
		assert.deepEqual(
			readdirSync(root).filter((name) => name.includes(".stale-")),
			[],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("FLY-2867 a gone owner with a live recorded daemon, or a non-slot owner, is never reclaimed", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2867-voice-lease-"));
	const daemon = fly2867LiveDaemon();
	const gone = `/tmp/flywheel-test-slot-2869${process.pid}`;
	const topology = fly2867LeaseTopology(gone);
	const name = `flywheel-voice-room-${topology.guildId}-${topology.voiceChannelId}.lock`;
	try {
		fly2867WriteLease(root, name, { schemaVersion: 1, slotDir: gone, daemon });
		assert.throws(
			() =>
				acquireVoiceRoomLease(
					fly2867LeaseTopology(`/tmp/flywheel-test-slot-2870${process.pid}`),
					{ root },
				),
			/voice_room_lease_conflict/,
		);
		rmSync(join(root, name), { recursive: true });
		fly2867WriteLease(root, name, {
			schemaVersion: 1,
			slotDir: "/Users/someone/room",
		});
		assert.throws(
			() =>
				acquireVoiceRoomLease(
					fly2867LeaseTopology(`/tmp/flywheel-test-slot-2870${process.pid}`),
					{ root },
				),
			/voice_room_lease_conflict/,
		);
	} finally {
		process.kill(daemon.pid, "SIGTERM");
		rmSync(root, { recursive: true, force: true });
	}
});

test("FLY-2867 teardown releases only its own slot's leases and keeps one with a live daemon", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2867-voice-lease-"));
	const daemon = fly2867LiveDaemon();
	const slot = `/tmp/flywheel-test-slot-2871${process.pid}`;
	const other = `/tmp/flywheel-test-slot-2872${process.pid}`;
	try {
		// The owner record carries the canonical /private/tmp spelling.
		fly2867WriteLease(root, "flywheel-voice-room-1-11.lock", {
			schemaVersion: 1,
			slotDir: `/private${slot}`,
		});
		fly2867WriteLease(root, "flywheel-voice-room-1-12.lock", {
			schemaVersion: 1,
			slotDir: slot,
			daemon,
		});
		fly2867WriteLease(root, "flywheel-voice-room-1-13.lock", {
			schemaVersion: 1,
			slotDir: other,
		});
		mkdirSync(join(root, "flywheel-voice-room-unrelated"));
		const result = releaseVoiceRoomLeasesForSlot(slot, { root });
		assert.deepEqual(result.released, [
			join(root, "flywheel-voice-room-1-11.lock"),
		]);
		assert.deepEqual(result.retained, [
			join(root, "flywheel-voice-room-1-12.lock"),
		]);
		assert.deepEqual(readdirSync(root).sort(), [
			"flywheel-voice-room-1-12.lock",
			"flywheel-voice-room-1-13.lock",
			"flywheel-voice-room-unrelated",
		]);
		assert.throws(
			() => releaseVoiceRoomLeasesForSlot("/Users/someone/room", { root }),
			/529_slot_directory_required/,
		);
	} finally {
		process.kill(daemon.pid, "SIGTERM");
		rmSync(root, { recursive: true, force: true });
	}
});

test("FLY-2867 release-slot-leases CLI needs only the slot directory", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2867-voice-lease-"));
	const slot = `/tmp/flywheel-test-slot-2873${process.pid}`;
	try {
		fly2867WriteLease(root, "flywheel-voice-room-2-21.lock", {
			schemaVersion: 1,
			slotDir: slot,
		});
		const run = spawnSync(
			process.execPath,
			[
				fileURLToPath(new URL("../qa/fly2655-voice-room.mjs", import.meta.url)),
				"release-slot-leases",
				"--slot-dir",
				slot,
				"--lease-root",
				root,
			],
			{ encoding: "utf8" },
		);
		assert.equal(run.status, 0, run.stderr);
		assert.deepEqual(JSON.parse(run.stdout.trim().split("\n").at(-1)), {
			released: [join(root, "flywheel-voice-room-2-21.lock")],
			retained: [],
		});
		assert.deepEqual(readdirSync(root), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// FLY-2876: the same slot redeployed after a teardown that never ran `stop`
// finds its own old lease; only a lease nothing alive stands behind is reclaimed.
function fly2876Room() {
	const root = mkdtempSync(join(tmpdir(), "fly2876-voice-lease-"));
	const slot = realpathSync(mkdtempSync(join(tmpdir(), "fly2876-slot-")));
	const topology = fly2867LeaseTopology(slot);
	const name = `flywheel-voice-room-${topology.guildId}-${topology.voiceChannelId}.lock`;
	const cleanup = () => {
		rmSync(root, { recursive: true, force: true });
		rmSync(slot, { recursive: true, force: true });
	};
	return { root, slot, topology, name, cleanup };
}

function fly2876DeadPid() {
	return Number(
		spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim(),
	);
}

function fly2876WriteReceipt(slot, run) {
	writeFileSync(
		join(slot, "voice-run-receipt.json"),
		`${JSON.stringify({ schemaVersion: 1, ...run })}\n`,
	);
}

test("FLY-2876 a same-slot lease nothing alive stands behind is reclaimed", () => {
	const room = fly2876Room();
	const dead = fly2876DeadPid();
	try {
		// The incident: the old lease has no process record and the run
		// receipt went away with the torn-down slot directory.
		fly2867WriteLease(room.root, room.name, {
			schemaVersion: 1,
			slotDir: room.slot,
		});
		const claimed = acquireVoiceRoomLease(room.topology, { root: room.root });
		assert.equal(claimed.created, true);
		const owner = fly2867Owner(room.root, room.topology);
		assert.equal(owner.slotDir, room.slot);
		assert.equal(owner.holder.pid, process.pid);
		assert.equal(owner.daemon, undefined);
		assert.deepEqual(
			readdirSync(room.root).filter((name) => name.includes(".stale-")),
			[],
		);

		// A voice session that ended naturally: its daemon exited while the
		// receipt still says STARTED.
		rmSync(join(room.root, room.name), { recursive: true });
		fly2867WriteLease(room.root, room.name, {
			schemaVersion: 1,
			slotDir: room.slot,
			holder: { pid: dead, processIdentity: "gone start" },
			daemon: { pid: dead, processIdentity: "gone daemon" },
		});
		fly2876WriteReceipt(room.slot, {
			status: "STARTED",
			pid: dead,
			processIdentity: "gone daemon",
		});
		assert.equal(
			acquireVoiceRoomLease(room.topology, { root: room.root }).created,
			true,
		);
		assert.equal(
			fly2867Owner(room.root, room.topology).holder.pid,
			process.pid,
		);
	} finally {
		room.cleanup();
	}
});

test("FLY-2876 a same-slot lease with a live start, daemon, or STARTED receipt is kept", () => {
	const room = fly2876Room();
	const live = fly2867LiveDaemon();
	const leasePath = join(room.root, room.name);
	const owners = [
		// A concurrent `start` is still between lease creation and spawn.
		{ schemaVersion: 1, slotDir: room.slot, holder: live },
		{ schemaVersion: 1, slotDir: room.slot, daemon: live },
		// A lease from before daemon records existed, still backed by its run.
		{ schemaVersion: 1, slotDir: room.slot },
	];
	try {
		for (const [index, owner] of owners.entries()) {
			rmSync(leasePath, { recursive: true, force: true });
			rmSync(join(room.slot, "voice-run-receipt.json"), { force: true });
			if (index === 2) {
				fly2876WriteReceipt(room.slot, {
					status: "STARTED",
					pid: live.pid,
					processIdentity: live.processIdentity,
				});
			}
			fly2867WriteLease(room.root, room.name, owner);
			assert.equal(
				acquireVoiceRoomLease(room.topology, { root: room.root }).created,
				false,
				`owner ${index} must keep its lease`,
			);
			assert.deepEqual(fly2867Owner(room.root, room.topology), owner);
		}
	} finally {
		process.kill(live.pid, "SIGTERM");
		room.cleanup();
	}
});

test("FLY-2876 an unreadable or symlinked run receipt keeps the same-slot lease", () => {
	const room = fly2876Room();
	const outside = mkdtempSync(join(tmpdir(), "fly2876-outside-"));
	const owner = { schemaVersion: 1, slotDir: room.slot };
	try {
		fly2867WriteLease(room.root, room.name, owner);
		writeFileSync(join(room.slot, "voice-run-receipt.json"), "{not json");
		assert.equal(
			acquireVoiceRoomLease(room.topology, { root: room.root }).created,
			false,
		);
		rmSync(join(room.slot, "voice-run-receipt.json"));
		writeFileSync(join(outside, "receipt.json"), '{"status":"STOPPED"}\n');
		symlinkSync(
			join(outside, "receipt.json"),
			join(room.slot, "voice-run-receipt.json"),
		);
		assert.equal(
			acquireVoiceRoomLease(room.topology, { root: room.root }).created,
			false,
		);
		assert.deepEqual(fly2867Owner(room.root, room.topology), owner);
	} finally {
		rmSync(outside, { recursive: true, force: true });
		room.cleanup();
	}
});

test("verification summarizes transcript and thread-mirror evidence without text", () => {
	assert.deepEqual(
		summarizeVoiceEvidence(
			[
				{
					kind: "voice_receive_runtime",
					buildSha: "a".repeat(40),
					voiceVersion: "0.19.2",
					daveyVersion: "0.1.12",
					nodeVersion: "v22.0.0",
					arch: "arm64",
					daveEncryption: true,
					decryptionFailureTolerance: 36,
					debug: true,
				},
				{ kind: "realtime_input_terminal", status: "delivered" },
				{ kind: "realtime_output_validated", speechId: "speech-1" },
				{ kind: "realtime_playback_submitted", speechId: "speech-1" },
				{
					kind: "uplink_gate_utterance",
					utteranceId: "utterance-1",
					framesPassed: 12,
				},
			],
			[
				{ kind: "mirrored", messageId: snowflake("7") },
				{ kind: "ingested", deliveryId: "chat:test:1" },
			],
		),
		{
			receiveRuntime: {
				buildSha: "a".repeat(40),
				voiceVersion: "0.19.2",
				daveyVersion: "0.1.12",
				nodeVersion: "v22.0.0",
				arch: "arm64",
				daveEncryption: true,
				decryptionFailureTolerance: 36,
				debug: true,
			},
			framesPassed: 12,
			framesEvidence: "known",
			userTranscriptCount: 1,
			assistantTranscriptCount: 1,
			playbackSubmittedCount: 1,
			mirroredCount: 1,
			ingestedCount: 1,
		},
	);
});

test("voice evidence sums unique utterances and ignores legacy zero-frame noise", () => {
	const summary = summarizeVoiceEvidence(
		[
			...[
				["a", 98],
				["b", 105],
				["c", 77],
			].map(([utteranceId, framesPassed]) => ({
				kind: "uplink_gate_utterance",
				utteranceId,
				framesPassed,
			})),
			{
				kind: "uplink_gate_utterance",
				openAtMs: undefined,
				framesPassed: 0,
			},
		],
		[],
	);
	assert.equal(summary.framesPassed, 280);
	assert.equal(summary.framesEvidence, "known");
});

test("voice evidence marks conflicting IDs and unidentifiable positive legacy rows unknown", () => {
	for (const events of [
		[
			{ kind: "uplink_gate_utterance", utteranceId: "same", framesPassed: 12 },
			{ kind: "uplink_gate_utterance", utteranceId: "same", framesPassed: 13 },
		],
		[{ kind: "uplink_gate_utterance", framesPassed: 12 }],
	]) {
		const summary = summarizeVoiceEvidence(events, []);
		assert.equal(summary.framesPassed, null);
		assert.equal(summary.framesEvidence, "unknown");
	}
});

test("Discord preflight requires View Channel, Connect, and Speak", () => {
	const topology = { guildId: snowflake("1") };
	const member = { user: { id: snowflake("6") }, roles: [] };
	const channel = { permission_overwrites: [] };
	assert.equal(
		validateDiscordVoicePermissions(
			channel,
			member,
			[
				{
					id: snowflake("1"),
					permissions: String(1_024 + 1_048_576 + 2_097_152),
				},
			],
			topology,
		),
		true,
	);
	assert.throws(
		() =>
			validateDiscordVoicePermissions(
				channel,
				member,
				[{ id: snowflake("1"), permissions: String(1_024 + 1_048_576) }],
				topology,
			),
		/discord_voice_permissions_missing/,
	);
});

test("Discord preflight uses the bot-compatible guild member endpoint", () => {
	const source = readFileSync(
		new URL("../qa/fly2655-voice-room.mjs", import.meta.url),
		"utf8",
	);
	assert.doesNotMatch(source, /\/users\/@me\/guilds\//);
	assert.match(
		source,
		/`\/guilds\/\$\{context\.topology\.guildId\}\/members\/\$\{bot\.id\}`/,
	);
});

test("claimed session thread requires View Channel and Send Messages in Threads", () => {
	const topology = { guildId: snowflake("1"), threadId: snowflake("7") };
	const member = { user: { id: snowflake("6") }, roles: [] };
	const channel = {
		id: snowflake("7"),
		guild_id: snowflake("1"),
		parent_id: snowflake("8"),
		type: 11,
		permission_overwrites: [],
	};
	const parent = {
		id: snowflake("8"),
		guild_id: snowflake("1"),
		permission_overwrites: [],
	};
	const allowed = String((1n << 10n) | (1n << 38n));
	assert.equal(
		validateDiscordThreadPermissions(
			channel,
			member,
			[{ id: snowflake("1"), permissions: allowed }],
			topology,
			parent,
		),
		true,
	);
	assert.throws(
		() =>
			validateDiscordThreadPermissions(
				channel,
				member,
				[{ id: snowflake("1"), permissions: String(1n << 10n) }],
				topology,
				parent,
			),
		/discord_thread_permissions_missing/,
	);
});

test("QA bot and voice room must be absent from the production registry", () => {
	const topology = { voiceChannelId: snowflake("2") };
	assert.equal(
		assertQaIdentityDisjoint(
			[
				{
					voiceRoom: { voiceChannelId: snowflake("9") },
					leads: [{ botUserId: snowflake("8") }],
				},
			],
			topology,
			snowflake("6"),
		),
		true,
	);
	assert.throws(
		() =>
			assertQaIdentityDisjoint(
				[{ voiceRoom: { voiceChannelId: snowflake("2") }, leads: [] }],
				topology,
				snowflake("6"),
			),
		/qa_identity_overlaps_production/,
	);
	assert.throws(
		() =>
			assertQaIdentityDisjoint(
				[{ leads: [{ botUserId: snowflake("6") }] }],
				topology,
				snowflake("6"),
			),
		/qa_identity_overlaps_production/,
	);
});
