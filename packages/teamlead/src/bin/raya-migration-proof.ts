import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import { readRegular } from "./raya-migration-init.js";
import {
	atomicJson,
	digest,
	discordJson,
	LEAD_LIVE_VERIFY_TIMEOUT_MS,
	type MigrationIO,
	migrationIO,
	readPrivate,
	withRayaDeployLock,
} from "./raya-migration-io.js";
import {
	readAlertEvidence,
	readChatEvidence,
	readSummaryEvidence,
	readTuiEvidence,
} from "./raya-migration-proof-evidence.js";

const ID = /^[0-9]{17,20}$/,
	SHA = /^[0-9a-f]{64}$/;
const frozenCheck =
	'export HOME="$2" FLYWHEEL_DIR="$1" UPDATE_FLYWHEEL_SOURCED=0; source "$1/scripts/lib/updater-raya-deploy.sh"; raya_configure_runtime_paths; raya_verify_frozen_source';

export async function collectMigrationProof(input: {
	home: string;
	flywheelDir: string;
	io: MigrationIO;
	textMessageId: string;
}): Promise<Record<string, unknown>> {
	if (!ID.test(input.textMessageId)) throw new Error("text-message-id-invalid");
	const { home, flywheelDir, io } = input,
		root = join(home, ".flywheel"),
		raya = join(root, "raya");
	const folder = join(raya, "migrations/FLY-2445-standard-lead"),
		file = join(folder, "manifest.json"),
		proofFile = join(folder, "proof.json");
	return withRayaDeployLock(raya, io, async () => {
		const bytes = readPrivate(file),
			manifest = JSON.parse(bytes);
		const previousProof = existsSync(proofFile)
			? digest(readPrivate(proofFile))
			: null;
		if (
			manifest.schemaVersion !== 1 ||
			manifest.checkpoint !== "P5" ||
			!Array.isArray(manifest.unresolved) ||
			manifest.unresolved.length ||
			!Number.isFinite(Date.parse(manifest.activated_at)) ||
			typeof manifest.migration_id !== "string" ||
			!manifest.migration_id
		)
			throw new Error("proof-checkpoint-invalid");
		const canonicalPath = join(root, "manifests/raya-raya.json"),
			registryPath = join(root, "projects.json"),
			summaryPath = join(root, "state/summary-registry/migration-receipt.json");
		const canonicalBytes = readRegular(canonicalPath),
			registryBytes = readRegular(registryPath),
			summaryBytes = readRegular(summaryPath);
		const verifyBindings = () => {
			if (
				readPrivate(file) !== bytes ||
				readRegular(canonicalPath) !== canonicalBytes ||
				readRegular(registryPath) !== registryBytes ||
				readRegular(summaryPath) !== summaryBytes ||
				digest(canonicalBytes) !== manifest.canonical_manifest_digest ||
				digest(registryBytes) !== manifest.registry_digest ||
				digest(summaryBytes) !== manifest.summary_receipt_digest ||
				readRegular(join(root, "deployed-sha")).trim() !==
					manifest.flywheel_deployed_sha
			)
				throw new Error("proof-binding-drift");
		};
		verifyBindings();
		const canonical = JSON.parse(canonicalBytes),
			registry = JSON.parse(registryBytes);
		if (
			canonical.projectName !== "raya" ||
			canonical.leadId !== "raya" ||
			canonical.leadBackend?.backendId !== "codex-app-server" ||
			typeof canonical.projectDir !== "string" ||
			!isAbsolute(canonical.projectDir) ||
			canonical.projectDir !== manifest.artifact?.workspace ||
			!Array.isArray(registry)
		)
			throw new Error("proof-identity-invalid");
		const projects = registry.filter(
			(project) => project.projectName === "raya",
		);
		if (
			projects.length !== 1 ||
			projects[0].projectRoot !== canonical.projectDir ||
			!Array.isArray(projects[0].leads)
		)
			throw new Error("proof-identity-invalid");
		const leads = projects[0].leads.filter(
			(lead: { agentId?: string }) => lead.agentId === "raya",
		);
		if (
			leads.length !== 1 ||
			leads[0].botTokenEnv !== "RAYA_BOT_TOKEN" ||
			leads[0].botUserId !== manifest.lead_bot_user_id ||
			!ID.test(leads[0].botUserId) ||
			!ID.test(leads[0].chatChannel)
		)
			throw new Error("proof-identity-invalid");
		const lead = leads[0],
			envBytes = readPrivate(join(root, ".env")),
			env = parseEnv(envBytes),
			token = env.RAYA_BOT_TOKEN;
		if (!token) throw new Error("proof-token-unavailable");
		const bot = (await discordJson(io, "/users/@me", token)) as {
			id?: string;
			bot?: boolean;
		};
		if (bot.id !== lead.botUserId || bot.bot !== true)
			throw new Error("proof-bot-mismatch");
		const comm = join(flywheelDir, "packages/flywheel-comm/dist/index.js");
		const identity = JSON.parse(
			await io.run(process.execPath, [
				comm,
				"lead-identity",
				"resolve",
				"--projects-file",
				registryPath,
				"--project",
				"raya",
				"--lead",
				"raya",
			]),
		);
		if (
			identity.backend !== "codex-app-server" ||
			identity.leadKey !== "raya-raya" ||
			identity.projectName !== "raya" ||
			identity.leadId !== "raya" ||
			identity.botUserId !== bot.id ||
			!SHA.test(identity.identityDigest)
		)
			throw new Error("proof-identity-invalid");
		await io.run("bash", ["-c", frozenCheck, "_", flywheelDir, home]);
		const launcher = join(root, "bin/flywheel-lead.sh");
		await io.run("bash", [launcher, "preflight", canonicalPath]);
		await io.run(
			"bash",
			[launcher, "verify", "--stage", "live", canonicalPath],
			LEAD_LIVE_VERIFY_TIMEOUT_MS,
		);
		const state = (
			await io.run("bash", [
				join(flywheelDir, "packages/teamlead/scripts/codex-lead.sh"),
				"--print-state-dir",
				"raya",
				"raya",
			])
		).trim();
		if (
			!isAbsolute(state) ||
			manifest.cursor?.path !== join(state, "inbound-cursor.json") ||
			manifest.cursor.seed_input !== join(folder, "seed-input.json")
		)
			throw new Error("proof-state-path-invalid");
		const thread = readRegular(join(state, "thread-id")).trim();
		const readOwner = async () => {
			const loaded = await io.run("launchctl", [
				"print",
				`gui/${process.getuid!()}/com.flywheel.lead.raya-raya`,
			]);
			const pids = [
				...loaded.matchAll(/^\s*pid\s*=\s*([1-9][0-9]*)\s*$/gm),
			].map((match) => match[1]!);
			if (pids.length !== 1 || !Number.isSafeInteger(Number(pids[0])))
				throw new Error("proof-owner-invalid");
			const started = Date.parse(
				(await io.run("ps", ["-o", "lstart=", "-p", pids[0]!])).trim(),
			);
			if (!Number.isFinite(started)) throw new Error("proof-owner-invalid");
			return { pid: Number(pids[0]), started: new Date(started).toISOString() };
		};
		const owner = await readOwner();
		const disabled = await io.run("launchctl", [
			"print-disabled",
			`gui/${process.getuid!()}`,
		]);
		for (const app of ["brain", "voice"]) {
			const label = `com.xrli.raya.${app}`;
			const entries = disabled
				.split("\n")
				.map((line) => line.trim().split(/\s+/))
				.filter((parts) => parts[0] === `"${label}"`);
			if (
				entries.length !== 1 ||
				entries[0]?.[1] !== "=>" ||
				(entries[0]?.[2] !== "disabled" && entries[0]?.[2] !== "true")
			)
				throw new Error("legacy-owner-not-disabled");

			try {
				await io.run("launchctl", [
					"print",
					`gui/${process.getuid!()}/com.xrli.raya.${app}`,
				]);
			} catch (error) {
				if (
					/Could not find (specified )?service/.test(
						String((error as { stderr?: string }).stderr ?? ""),
					)
				)
					continue;
				throw new Error("legacy-owner-indeterminate");
			}
			throw new Error("legacy-owner-present");
		}
		const processes = await io.run("ps", ["-axo", "command="]);
		if (/apps\/(brain|voice)\/dist\/cli\.js\s+run/.test(processes))
			throw new Error("legacy-owner-present");
		const tui = await readTuiEvidence({
			home,
			flywheelDir,
			io,
			workspace: canonical.projectDir,
			threadId: thread,
			processStartedAt: owner.started,
		});
		const chatInput = {
			home,
			flywheelDir,
			stateDir: state,
			io,
			channelId: lead.chatChannel,
			botId: lead.botUserId,
			token,
			activatedAt: manifest.activated_at,
		};
		const text = await readChatEvidence({
			...chatInput,
			messageId: input.textMessageId,
		});
		if (
			manifest.window_probe?.channel_id !== lead.chatChannel ||
			!ID.test(manifest.window_probe?.bot_user_id ?? "")
		)
			throw new Error("window-probe-identity-invalid");
		const window = await readChatEvidence({
			...chatInput,
			messageId: manifest.cutover_probe?.message_id,
			windowProbeAuthorId: manifest.window_probe.bot_user_id,
			windowProbeNonce: manifest.cutover_probe?.intent?.nonce,
		});
		const summary = readSummaryEvidence(
			join(root, "comm/raya/comm.db"),
			manifest.activated_at,
		);
		const seed = JSON.parse(readPrivate(manifest.cursor.seed_input)),
			currentCursor = JSON.parse(readPrivate(manifest.cursor.path));
		if (
			seed.schemaVersion !== 1 ||
			seed.migrationId !== manifest.migration_id ||
			!Array.isArray(seed.channels) ||
			seed.writerStopped !== (manifest.cursor.status !== "preexisting") ||
			!Array.isArray(seed.unresolved) ||
			seed.unresolved.length ||
			(seed.expectedBeforeSha256 !== null &&
				!SHA.test(seed.expectedBeforeSha256))
		)
			throw new Error("seed-evidence-invalid");
		const seeded: Record<string, string> = {};
		for (const item of seed.channels) {
			if (
				!ID.test(item.channelId) ||
				!ID.test(item.lastConfirmedMessageId) ||
				seeded[item.channelId] !== undefined
			)
				throw new Error("seed-evidence-invalid");
			seeded[item.channelId] = item.lastConfirmedMessageId;
		}
		for (const channelId of seed.emptyChannels ?? []) {
			if (!ID.test(channelId) || seeded[channelId] !== undefined)
				throw new Error("seed-evidence-invalid");
			seeded[channelId] = "0";
		}
		const ordered = Object.fromEntries(
			Object.entries(seeded).sort(([a], [b]) =>
				BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0,
			),
		);
		if (
			!Object.keys(ordered).length ||
			digest(`${JSON.stringify(ordered)}\n`) !== manifest.cursor.sha256 ||
			Object.entries(ordered).some(
				([channelId, boundary]) =>
					typeof currentCursor[channelId] !== "string" ||
					!/^[0-9]+$/.test(currentCursor[channelId]) ||
					BigInt(currentCursor[channelId]) < BigInt(boundary),
			)
		)
			throw new Error("seed-evidence-invalid");
		const alertChannel =
			env.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID ||
			lead.alertChannel ||
			(lead.alertFallbackToCore === true ? projects[0].generalChannel : "");
		const sender = env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV;
		const alertToken = sender
			? env[sender]
			: (lead.alertBotTokenEnv ? env[lead.alertBotTokenEnv] : undefined) ||
				token;
		if (!ID.test(alertChannel ?? "") || !alertToken)
			throw new Error("alert-identity-invalid");
		const alertBot = (await discordJson(io, "/users/@me", alertToken)) as {
			id?: string;
			bot?: boolean;
		};
		if (!alertBot.id || !ID.test(alertBot.id) || alertBot.bot !== true)
			throw new Error("alert-identity-invalid");
		const alert = await readAlertEvidence({
			io,
			flywheelDir,
			migrationId: manifest.migration_id,
			channelId: alertChannel,
			botId: alertBot.id,
			token: alertToken,
			activatedAt: manifest.activated_at,
		});
		const activationId = `${manifest.migration_id}:${manifest.activated_at}`;
		const proof = {
			migration_id: manifest.migration_id,
			raya_sha: manifest.raya_sha,
			flywheel_deployed_sha: manifest.flywheel_deployed_sha,
			lead: {
				project: "raya",
				id: "raya",
				key: "raya-raya",
				identity_digest: identity.identityDigest,
				registry_digest: manifest.registry_digest,
				summary_receipt_digest: manifest.summary_receipt_digest,
				manifest_digest: manifest.canonical_manifest_digest,
				pid: owner.pid,
				process_started_at: owner.started,
				activation_id: activationId,
				thread_id: thread,
				tui_visible: true,
				pane_pid: tui.panePid,
				pane_started_at: tui.paneStartedAt,
			},
			business: {
				source_sha: manifest.raya_sha,
				artifact_digest: manifest.artifact.digest,
				persona_digest: manifest.artifact.persona_digest,
				workspace: canonical.projectDir,
				state_schema_version: manifest.artifact.state_schema_version,
			},
			checks: {
				preflight: true,
				unique_owner: true,
				pump: true,
				text_delivery_id: text.deliveryId,
				outbound_message_id: text.outboundMessageId,
				summary_round_id: summary.roundId,
				summary_delivery_id: summary.deliveryId,
				mailbox_acked: true,
				bridge_sent: true,
				bridge_identity_verified: true,
				alert_channel_id: alertChannel,
				alert_delivery_id: alert.discord_message_id,
				discord_message_id: alert.discord_message_id,
				alert_reachable: true,
			},
			cutover: {
				seed_digest: manifest.cursor.sha256,
				seeded_at: manifest.cursor.seeded_at,
				old_stopped_at: manifest.old_stopped_at,
				activated_at: manifest.activated_at,
				activation_id: activationId,
				channels: Object.entries(ordered).map(([channel_id, seeded_after]) => ({
					channel_id,
					seeded_after,
				})),
				window_message_id: manifest.cutover_probe.message_id,
				window_delivery_id: window.deliveryId,
				window_outbound_message_id: window.outboundMessageId,
				unresolved_count: 0,
			},
		};
		const candidate = join(folder, `.proof-${randomUUID()}.json`),
			merged = `${candidate}.manifest`;
		try {
			atomicJson(candidate, proof, null);
			atomicJson(merged, { ...manifest, ...proof, checkpoint: "P6" }, null);
			await io.run("bash", [
				"-c",
				'source "$1/scripts/lib/updater-raya-deploy.sh"; RAYA_MIGRATION_MANIFEST="$2"; raya_validate_proof "$3" && raya_p6_evidence_valid "$4"',
				"_",
				flywheelDir,
				file,
				candidate,
				merged,
			]);
			await io.run("bash", ["-c", frozenCheck, "_", flywheelDir, home]);
			await io.run(
				"bash",
				[launcher, "verify", "--stage", "live", canonicalPath],
				LEAD_LIVE_VERIFY_TIMEOUT_MS,
			);
			const finalTui = await readTuiEvidence({
				home,
				flywheelDir,
				io,
				workspace: canonical.projectDir,
				threadId: thread,
				processStartedAt: owner.started,
			});
			if (
				finalTui.panePid !== tui.panePid ||
				finalTui.paneStartedAt !== tui.paneStartedAt
			)
				throw new Error("proof-pane-drift");
			const finalOwner = await readOwner();
			if (
				finalOwner.pid !== owner.pid ||
				finalOwner.started !== owner.started ||
				readRegular(join(state, "thread-id")).trim() !== thread ||
				readPrivate(join(root, ".env")) !== envBytes
			)
				throw new Error("proof-process-drift");
			verifyBindings();
			atomicJson(proofFile, proof, previousProof);
		} finally {
			rmSync(candidate, { force: true });
			rmSync(merged, { force: true });
		}
		return {
			status: "proof-collected",
			activation_id: activationId,
			path: proofFile,
		};
	});
}

if (
	process.argv[1] &&
	pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
	Promise.resolve()
		.then(async () => {
			const args = parseArgs({
				args: process.argv.slice(2),
				allowPositionals: true,
				options: { "text-message-id": { type: "string" } },
			});
			if (
				args.positionals.length !== 1 ||
				args.positionals[0] !== "collect" ||
				!args.values["text-message-id"]
			)
				throw new Error("proof-command-invalid");
			return collectMigrationProof({
				home: homedir(),
				flywheelDir:
					process.env.FLYWHEEL_DIR ?? join(homedir(), "Dev/flywheel"),
				io: migrationIO,
				textMessageId: args.values["text-message-id"],
			});
		})
		.then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
		.catch((error: unknown) => {
			const message = error instanceof Error ? error.message : "";
			process.stderr.write(
				`${/^[a-z][a-z0-9-]+$/.test(message) ? message : "proof-operation-failed"}\n`,
			);
			process.exitCode = 1;
		});
}
