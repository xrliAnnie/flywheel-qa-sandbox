import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { parseEnv } from "node:util";
import {
	atomicJson,
	digest,
	discordJson,
	ensureDiscordProbe,
	LEAD_LIVE_VERIFY_TIMEOUT_MS,
	type MigrationIO,
	readPrivate,
	withRayaDeployLock,
} from "./raya-migration-io.js";
import {
	standingMigrationAuthorization,
	verifyMigrationAuthorization,
	verifyStoredFounderMigrationAuthorization,
} from "./raya-migration-manifest.js";
import { rayaRegistryIdentity } from "./raya-registry-identity.js";
import { readLeadInboundCursor } from "./seed-lead-inbound-cursor.js";

const ID = /^[0-9]{17,20}$/;
const SHA = /^[0-9a-f]{40}$/;

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("identity-invalid");
	return value as Record<string, unknown>;
}
export function readRegular(path: string): string {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink())
		throw new Error("identity-file-invalid");
	return readFileSync(path, "utf8");
}
function directory(path: string): void {
	if (
		!isAbsolute(path) ||
		!lstatSync(path).isDirectory() ||
		lstatSync(path).isSymbolicLink()
	)
		throw new Error("directory-invalid");
}
function overlaps(a: string, b: string): boolean {
	const within = (root: string, child: string) => {
		const rel = relative(root, child);
		return !rel || (!rel.startsWith("..") && !isAbsolute(rel));
	};
	return within(a, b) || within(b, a);
}

export interface LegacyOwner {
	label: string;
	plist_sha256: string;
	loaded: boolean;
	pid: number | null;
	start: string | null;
	stop_started_at_ms?: number;
	stopped_at_ms?: number;
}

export async function inspectLegacyOwners(
	home: string,
	io: MigrationIO,
): Promise<LegacyOwner[]> {
	const owners: LegacyOwner[] = [];
	const raya = join(home, ".flywheel/raya"),
		code = join(raya, "code");
	for (const app of ["brain", "voice"]) {
		const label = `com.xrli.raya.${app}`,
			path = join(home, `Library/LaunchAgents/${label}.plist`);
		const bytes = readRegular(path);
		const plist = record(
			JSON.parse(await io.run("plutil", ["-convert", "json", "-o", "-", path])),
		);
		const argv = plist.ProgramArguments;
		if (
			plist.Label !== label ||
			plist.WorkingDirectory !== code ||
			!Array.isArray(argv) ||
			argv.length !== 3 ||
			typeof argv[0] !== "string" ||
			argv[1] !== join(code, `apps/${app}/dist/cli.js`) ||
			argv[2] !== "run" ||
			record(plist.EnvironmentVariables).RAYA_ENV_FILE !==
				join(raya, "raya.env")
		)
			throw new Error("legacy-plist-invalid");
		const executable = lstatSync(argv[0]);
		if (
			!executable.isFile() ||
			executable.isSymbolicLink() ||
			!(executable.mode & 0o111)
		)
			throw new Error("legacy-executable-invalid");
		const owner: LegacyOwner = {
			label,
			plist_sha256: digest(bytes),
			loaded: false,
			pid: null,
			start: null,
		};
		let output: string;
		try {
			output = await io.run("launchctl", [
				"print",
				`gui/${process.getuid!()}/${label}`,
			]);
		} catch (error) {
			if (
				/Could not find service|service not found/i.test(
					String((error as { stderr?: string }).stderr ?? ""),
				)
			) {
				owners.push(owner);
				continue;
			}
			throw new Error("legacy-probe-failed");
		}
		const pids = [...output.matchAll(/^\s*pid = ([1-9][0-9]*)\s*$/gm)];
		const states = [...output.matchAll(/^\s*state = ([^\r\n]+?)\s*$/gm)];
		if (pids.length === 0 && states[0]?.[1]?.trim() === "not running") {
			owner.loaded = true;
			owners.push(owner);
			continue;
		}
		if (pids.length !== 1) throw new Error("legacy-pid-invalid");
		owner.pid = Number(pids[0]![1]);
		owner.loaded = true;
		owner.start = (
			await io.run("ps", ["-o", "lstart=", "-p", String(owner.pid)])
		).trim();
		if (!owner.start || !Number.isSafeInteger(owner.pid))
			throw new Error("legacy-pid-invalid");
		owners.push(owner);
	}
	return owners;
}

export interface InitializeMigrationInput {
	home: string;
	flywheelDir: string;
	targetRayaSha: string;
	authorizationMessageId?: string;
	authorizationChannelId?: string;
	standingAuthority?: boolean;
	probeBotTokenEnv: string;
	io: MigrationIO;
	dryRun?: boolean;
	resumeFromFailed?: boolean;
}

export function migrateMigrationToStandingAuthority(input: {
	home: string;
	expectedManifestDigest: string;
}): Record<string, unknown> {
	if (!/^[a-f0-9]{64}$/.test(input.expectedManifestDigest))
		throw new Error("migration-cas-invalid");
	const file = join(
		input.home,
		".flywheel/raya/migrations/FLY-2445-standard-lead/manifest.json",
	);
	const bytes = readPrivate(file);
	const before = digest(bytes);
	if (before !== input.expectedManifestDigest)
		throw new Error("migration-cas-conflict");
	const manifest = record(JSON.parse(bytes));
	const owners = manifest.legacy_owner;
	if (
		manifest.schemaVersion !== 1 ||
		manifest.checkpoint !== "P2" ||
		manifest.old_stopped_at ||
		manifest.prestop_probe !== undefined ||
		!Array.isArray(owners) ||
		(manifest.authorization_history !== undefined &&
			!Array.isArray(manifest.authorization_history)) ||
		owners.some((owner) => {
			const value = record(owner);
			return (
				value.stop_started_at_ms !== undefined ||
				value.stopped_at_ms !== undefined
			);
		})
	)
		throw new Error("migration-standing-transition-unsafe");
	const legacyAuthorization = verifyStoredFounderMigrationAuthorization(
		String(manifest.target_raya_sha ?? ""),
		manifest.authorization,
	);
	const authorization = standingMigrationAuthorization(input.home);
	manifest.authorization_history = [
		...(Array.isArray(manifest.authorization_history)
			? manifest.authorization_history
			: []),
		legacyAuthorization,
	];
	manifest.authorization = authorization;
	manifest.authority_migration = {
		from: "founder-per-sha",
		to: authorization.entry_id,
		previous_manifest_digest: before,
	};
	atomicJson(file, manifest, before);
	return {
		status: "migrated",
		entryId: authorization.entry_id,
		beforeDigest: before,
		afterDigest: digest(readPrivate(file)),
	};
}

export async function initializeMigration(
	input: InitializeMigrationInput,
): Promise<Record<string, unknown>> {
	const { io, home } = input;
	const founderAuthorization =
		typeof input.authorizationMessageId === "string" &&
		ID.test(input.authorizationMessageId) &&
		typeof input.authorizationChannelId === "string" &&
		ID.test(input.authorizationChannelId);
	if (
		!SHA.test(input.targetRayaSha) ||
		(input.standingAuthority === true) === founderAuthorization ||
		(input.standingAuthority === true &&
			(input.authorizationMessageId !== undefined ||
				input.authorizationChannelId !== undefined)) ||
		!/^[A-Z][A-Z0-9_]*$/.test(input.probeBotTokenEnv) ||
		input.probeBotTokenEnv === "RAYA_BOT_TOKEN"
	)
		throw new Error("init-arguments-invalid");
	const root = join(home, ".flywheel"),
		raya = join(root, "raya"),
		folder = join(raya, "migrations/FLY-2445-standard-lead");
	const manifestFile = join(folder, "manifest.json");
	const work = async () => {
		let before: string | null = null;
		let old: Record<string, unknown> | undefined;
		if (existsSync(folder)) {
			directory(folder);
			if (existsSync(manifestFile)) {
				const bytes = readPrivate(manifestFile);
				before = digest(bytes);
				old = record(JSON.parse(bytes));
				if (
					!input.resumeFromFailed ||
					old.checkpoint !== "P2" ||
					old.old_stopped_at ||
					!Array.isArray(old.legacy_owner) ||
					old.legacy_owner.some(
						(owner) =>
							record(owner).stopped_at_ms !== undefined ||
							record(owner).stop_started_at_ms !== undefined,
					)
				)
					throw new Error("migration-already-initialized");
			} else if (readdirSync(folder).some((name) => name !== "precheck.intent"))
				throw new Error("migration-directory-exists");
		}
		const canonicalBytes = readRegular(join(root, "manifests/raya-raya.json"));
		const canonical = record(JSON.parse(canonicalBytes));
		if (
			canonical.projectName !== "raya" ||
			canonical.leadId !== "raya" ||
			record(canonical.leadBackend).backendId !== "codex-app-server" ||
			typeof canonical.projectDir !== "string"
		)
			throw new Error("canonical-manifest-invalid");
		const workspace = canonical.projectDir;
		directory(workspace);
		if (
			overlaps(workspace, root) ||
			overlaps(workspace, join(home, ".codex-raya"))
		)
			throw new Error("workspace-overlap");
		const registryBytes = readRegular(join(root, "projects.json"));
		const registry: unknown = JSON.parse(registryBytes);
		if (!Array.isArray(registry)) throw new Error("registry-invalid");
		const projects = registry
			.map(record)
			.filter((project) => project.projectName === "raya");
		if (
			projects.length !== 1 ||
			projects[0]!.projectRoot !== workspace ||
			!Array.isArray(projects[0]!.leads)
		)
			throw new Error("registry-identity-invalid");
		const leads = (projects[0]!.leads as unknown[])
			.map(record)
			.filter((lead) => lead.agentId === "raya");
		if (leads.length !== 1) throw new Error("registry-identity-invalid");
		const lead = leads[0]!;
		if (
			typeof lead.botUserId !== "string" ||
			!ID.test(lead.botUserId) ||
			lead.botTokenEnv !== "RAYA_BOT_TOKEN" ||
			typeof lead.chatChannel !== "string" ||
			!ID.test(lead.chatChannel) ||
			typeof lead.alertChannel !== "string" ||
			!ID.test(lead.alertChannel)
		)
			throw new Error("registry-identity-invalid");
		const envFile = join(root, ".env"),
			env = parseEnv(readPrivate(envFile));
		const token = env.RAYA_BOT_TOKEN,
			probeToken = env[input.probeBotTokenEnv],
			apiToken = env.FLYWHEEL_API_TOKEN ?? env.TEAMLEAD_API_TOKEN;
		if (!token || !probeToken || !apiToken)
			throw new Error("token-unavailable");
		const bridgeUrl =
			env.FLYWHEEL_BRIDGE_URL ?? env.BRIDGE_URL ?? "http://localhost:9876";
		let nudge: Response;
		try {
			nudge = await io.fetch(
				`${bridgeUrl.replace(/\/$/, "")}/api/lead-inbox/nudge`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ leadId: "raya", project: "raya" }),
					signal: AbortSignal.timeout(5000),
				},
			);
		} catch {
			throw new Error("bridge-nudge-failed");
		}
		if (nudge.status !== 202) throw new Error("bridge-nudge-failed");
		const rayaIdentity = record(await discordJson(io, "/users/@me", token));
		if (rayaIdentity.id !== lead.botUserId || rayaIdentity.bot !== true)
			throw new Error("bridge-bot-mismatch");
		const authorization = input.standingAuthority
			? standingMigrationAuthorization(home)
			: verifyMigrationAuthorization({
					targetRayaSha: input.targetRayaSha,
					messageId: input.authorizationMessageId!,
					channelId: input.authorizationChannelId!,
					founder: { processEnv: {}, dotenvPath: envFile },
					message: await discordJson(
						io,
						`/channels/${input.authorizationChannelId}/messages/${input.authorizationMessageId}`,
						probeToken,
					),
				});
		const probeIdentity = record(
			await discordJson(io, "/users/@me", probeToken),
		);
		if (
			typeof probeIdentity.id !== "string" ||
			!ID.test(probeIdentity.id) ||
			probeIdentity.bot !== true ||
			probeIdentity.id === lead.botUserId ||
			(authorization.granted_by === "founder" &&
				probeIdentity.id === authorization.evidence_author_id)
		)
			throw new Error("probe-bot-invalid");
		const legacyOwners = await inspectLegacyOwners(home, io);
		const state = (
			await io.run("bash", [
				join(input.flywheelDir, "packages/teamlead/scripts/codex-lead.sh"),
				"--print-state-dir",
				"raya",
				"raya",
			])
		).trim();
		if (!isAbsolute(state)) throw new Error("state-directory-invalid");
		let existingStateParent = state;
		while (!existsSync(existingStateParent)) {
			// A dangling symlink is not an uncreated directory.
			try {
				lstatSync(existingStateParent);
				throw new Error("state-directory-invalid");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			existingStateParent = dirname(existingStateParent);
		}
		directory(existingStateParent);
		const cursorPath = join(state, "inbound-cursor.json");
		let cursorStatus: "preexisting" | null = null;
		let cursorExists = false;
		try {
			lstatSync(cursorPath);
			cursorExists = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (cursorExists) {
			if (!input.resumeFromFailed) throw new Error("cursor-already-exists");
			readLeadInboundCursor(cursorPath);
			await io.run(
				"bash",
				[
					join(root, "bin/flywheel-lead.sh"),
					"verify",
					"--stage",
					"live",
					join(root, "manifests/raya-raya.json"),
				],
				LEAD_LIVE_VERIFY_TIMEOUT_MS,
			);
			cursorStatus = "preexisting";
		}
		const summaryBytes = readRegular(
			join(root, "state/summary-registry/migration-receipt.json"),
		);
		if (input.dryRun) return { status: "dry-run", probe_send: "not-run" };
		mkdirSync(folder, { recursive: true, mode: 0o700 });
		const precheck = await ensureDiscordProbe({
			file: join(folder, "precheck.intent"),
			channelId: lead.chatChannel,
			botId: probeIdentity.id,
			token: probeToken,
			prefix: "FLY-2496 pre-check",
			text: "激活前发信能力检查，可忽略。",
			io,
		});
		// Freeze identity bytes across the asynchronous network checks.
		if (
			readRegular(join(root, "projects.json")) !== registryBytes ||
			readRegular(join(root, "manifests/raya-raya.json")) !== canonicalBytes ||
			readRegular(
				join(root, "state/summary-registry/migration-receipt.json"),
			) !== summaryBytes
		)
			throw new Error("identity-changed-during-init");
		const manifest = {
			schemaVersion: 1,
			migration_id:
				old?.migration_id ?? `FLY-2445-standard-lead-${precheck.nonce}`,
			checkpoint: "P2",
			unresolved: [],
			target_raya_sha: input.targetRayaSha,
			authorization,
			lead_bot_user_id: lead.botUserId,
			registry_digest: digest(registryBytes),
			// FLY-2654 QA2 rework: the shuttle and the proof compare this
			// Raya-scoped projection, never the whole-file digest above.
			registry_identity: rayaRegistryIdentity(JSON.parse(registryBytes)),
			summary_receipt_digest: digest(summaryBytes),
			canonical_manifest_digest: digest(canonicalBytes),
			bridge: {
				token_env: "RAYA_BOT_TOKEN",
				token_resolved: true,
				bot_user_id: lead.botUserId,
				alert_channel_id: lead.alertChannel,
			},
			cursor: {
				path: cursorPath,
				seed_input: join(folder, "seed-input.json"),
				status: cursorStatus,
				sha256: null,
			},
			window_probe: {
				bot_token_env: input.probeBotTokenEnv,
				bot_user_id: probeIdentity.id,
				channel_id: lead.chatChannel,
				precheck_message_id: precheck.message_id,
			},
			legacy_owner: legacyOwners,
		};
		atomicJson(manifestFile, manifest, before);
		return {
			status: "initialized",
			migration_id: manifest.migration_id,
			path: manifestFile,
		};
	};
	return input.dryRun ? work() : withRayaDeployLock(raya, io, work);
}
