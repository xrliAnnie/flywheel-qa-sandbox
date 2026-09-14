import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { parseEnv } from "node:util";
import {
	atomicJson,
	digest,
	discordJson,
	discordMessage,
	ensureDiscordProbe,
	type MigrationIO,
	readPrivate,
	withRayaDeployLock,
} from "./raya-migration-io.js";
import {
	buildCutoverSeed,
	type MigrationResolution,
} from "./raya-migration-manifest.js";

export async function probeConnection(
	home: string,
	manifest: Record<string, unknown>,
	io: MigrationIO,
) {
	const probe = manifest.window_probe as
		| { bot_token_env?: string; bot_user_id?: string; channel_id?: string }
		| undefined;
	if (
		!probe?.bot_token_env ||
		!/^[A-Z][A-Z0-9_]*$/.test(probe.bot_token_env) ||
		!probe.bot_user_id ||
		!/^[0-9]{17,20}$/.test(probe.bot_user_id) ||
		!probe.channel_id ||
		!/^[0-9]{17,20}$/.test(probe.channel_id)
	)
		throw new Error("probe-identity-invalid");
	const token = parseEnv(readPrivate(join(home, ".flywheel/.env")))[
		probe.bot_token_env
	];
	if (!token) throw new Error("probe-token-unavailable");
	const identity = (await discordJson(io, "/users/@me", token)) as {
		id?: string;
		bot?: boolean;
	};
	if (identity.id !== probe.bot_user_id || identity.bot !== true)
		throw new Error("probe-bot-mismatch");
	return { token, channelId: probe.channel_id, botId: probe.bot_user_id };
}

export async function readChannelHistory(
	io: MigrationIO,
	token: string,
	channel: string,
	cutoff: number,
	before?: string,
) {
	const messages: ReturnType<typeof discordMessage>[] = [];
	let cursor = before;
	for (let page = 0; page < 5; page++) {
		const raw = await discordJson(
			io,
			`/channels/${channel}/messages?limit=100${cursor ? `&before=${cursor}` : ""}`,
			token,
		);
		if (!Array.isArray(raw)) throw new Error("channel-history-invalid");
		const batch = raw.map(discordMessage);
		if (batch.some((message) => cursor && BigInt(message.id) >= BigInt(cursor)))
			throw new Error("channel-history-invalid");
		messages.push(...batch);
		if (batch.length < 100) return { messages, complete: true };
		cursor = batch.reduce(
			(min, message) => (BigInt(message.id) < BigInt(min) ? message.id : min),
			batch[0]!.id,
		);
		if (Number((BigInt(cursor) >> 22n) + 1420070400000n) < cutoff)
			return { messages, complete: false };
	}
	return { messages, complete: false };
}

export async function runShuttleStep(input: {
	home: string;
	flywheelDir: string;
	io: MigrationIO;
	step: string;
	lockOwner?: number;
}): Promise<Record<string, unknown>> {
	const raya = join(input.home, ".flywheel/raya"),
		folder = join(raya, "migrations/FLY-2445-standard-lead"),
		file = join(folder, "manifest.json");
	const work = async () => {
		const bytes = readPrivate(file),
			manifest = JSON.parse(bytes);
		const beforeStop = ["quiet-check", "prestop-probe"].includes(input.step);
		if (
			manifest.schemaVersion !== 1 ||
			manifest.checkpoint !== (beforeStop ? "P2" : "P3")
		)
			throw new Error("shuttle-checkpoint-invalid");
		const connection = await probeConnection(input.home, manifest, input.io);
		const { token, channelId, botId } = connection;
		const save = () => atomicJson(file, manifest, digest(bytes));
		if (input.step === "quiet-check") {
			const cutoff = input.io.now() - 15 * 60_000;
			const history = await readChannelHistory(
				input.io,
				token,
				channelId,
				cutoff,
			);
			const oldest = Math.min(
				...history.messages.map((message) =>
					Number((BigInt(message.id) >> 22n) + 1420070400000n),
				),
			);
			if (
				(!history.complete && oldest >= cutoff) ||
				history.messages.some(
					(message) =>
						message.author.bot !== true &&
						Number((BigInt(message.id) >> 22n) + 1420070400000n) >= cutoff,
				)
			)
				throw new Error("channel-active");
			return { status: "quiet" };
		}
		if (input.step === "prestop-probe" || input.step === "cutover-probe") {
			const prestop = input.step === "prestop-probe",
				intentFile = join(
					folder,
					prestop ? "prestop-probe.intent" : "cutover-probe.intent",
				);
			if (existsSync(intentFile)) {
				const prior = JSON.parse(readPrivate(intentFile));
				const reset = prestop
					? manifest.prestop_retry === true && Boolean(prior.message_id)
					: Array.isArray(manifest.probe_resets) &&
						manifest.probe_resets.some(
							(entry: { nonce: string }) => entry.nonce === prior.nonce,
						);
				if (reset) {
					if (
						typeof prior.nonce !== "string" ||
						!/^[a-zA-Z0-9-]+$/.test(prior.nonce)
					)
						throw new Error("probe-intent-invalid");
					renameSync(
						intentFile,
						join(
							folder,
							`${prestop ? "prestop" : "cutover"}-probe.retired-${prior.nonce}.json`,
						),
					);
					const fd = openSync(folder, "r");
					try {
						fsyncSync(fd);
					} finally {
						closeSync(fd);
					}
				}
			}
			if (!prestop && manifest.cutover_probe?.message_id) {
				const found = discordMessage(
					await discordJson(
						input.io,
						`/channels/${channelId}/messages/${manifest.cutover_probe.message_id}`,
						token,
					),
				);
				if (
					found.id !== manifest.cutover_probe.message_id ||
					found.channel_id !== channelId ||
					found.author.bot !== true ||
					found.author.id !== botId ||
					found.content !==
						`[FLY-2445 cutover window probe ${manifest.cutover_probe.intent?.nonce}] Raya，请回复一句确认收到。`
				)
					throw new Error("probe-message-mismatch");
				return { status: "probe-confirmed", message_id: found.id };
			}
			try {
				const probe = await ensureDiscordProbe({
					file: intentFile,
					...connection,
					prefix: prestop
						? "FLY-2496 prestop-check"
						: "FLY-2445 cutover window probe",
					text: prestop
						? "班车切换前检查，可忽略。"
						: "Raya，请回复一句确认收到。",
					io: input.io,
				});
				if (prestop && input.io.now() - Date.parse(probe.at) > 15 * 60_000)
					throw new Error("prestop-probe-stale");
				manifest[prestop ? "prestop_probe" : "cutover_probe"] = {
					intent: { nonce: probe.nonce, at: probe.at },
					message_id: probe.message_id,
					bot_user_id: botId,
					sent_at: new Date(
						Number((BigInt(probe.message_id) >> 22n) + 1420070400000n),
					).toISOString(),
				};
				if (prestop) manifest.prestop_retry = false;
				save();
				return { status: "probe-confirmed", message_id: probe.message_id };
			} catch (error) {
				if (!prestop) {
					manifest.unresolved = [
						...(manifest.unresolved ?? []).filter(
							(item: { reason: string }) =>
								item.reason !== "probe_delivery_ambiguous",
						),
						{ reason: "probe_delivery_ambiguous" },
					];
					save();
				}
				throw error;
			}
		}
		if (input.step !== "seed-boundary") throw new Error("shuttle-step-invalid");
		const probeId = manifest.cutover_probe?.message_id;
		if (typeof probeId !== "string" || !/^[0-9]{17,20}$/.test(probeId))
			throw new Error("cutover-probe-missing");
		const t0 = Math.min(
			...manifest.legacy_owner.map(
				(owner: { stop_started_at_ms: number }) => owner.stop_started_at_ms,
			),
		);
		let history: Awaited<ReturnType<typeof readChannelHistory>>;
		try {
			history = await readChannelHistory(
				input.io,
				token,
				channelId,
				t0 - 15 * 60_000,
				probeId,
			);
		} catch {
			manifest.unresolved = [
				...(manifest.unresolved ?? []).filter(
					(item: { reason: string }) => item.reason !== "lookback_exhausted",
				),
				{ reason: "lookback_exhausted" },
			];
			save();
			throw new Error("cutover-unresolved");
		}
		const manual = manifest.lookback_resolution?.boundary_message_id;
		if (manual) {
			const boundary = discordMessage(
				await discordJson(
					input.io,
					`/channels/${channelId}/messages/${manual}`,
					token,
				),
			);
			if (
				boundary.id !== manual ||
				boundary.channel_id !== channelId ||
				BigInt(manual) >= BigInt(probeId)
			)
				throw new Error("lookback-boundary-invalid");
			if (!history.messages.some((message) => message.id === manual))
				history.messages.push(boundary);
			history.complete = true;
		}
		const cursor = manifest.cursor;
		if (
			!cursor ||
			!isAbsolute(cursor.path) ||
			cursor.seed_input !== join(folder, "seed-input.json")
		)
			throw new Error("cursor-path-invalid");
		const result = buildCutoverSeed({
			migrationId: manifest.migration_id,
			channelId,
			probeMessageId: probeId,
			legacyOwners: manifest.legacy_owner,
			messages: history.messages,
			historyComplete: history.complete,
			resolutions: (manifest.resolutions ?? []).filter(
				(item: MigrationResolution) =>
					[
						"confirmed_processed",
						"confirmed_unprocessed",
						"side_effect_reconciled",
					].includes(item.as),
			),
			expectedBeforeSha256: existsSync(cursor.path)
				? digest(readPrivate(cursor.path))
				: null,
		});
		manifest.unresolved = result.unresolved;
		if (!result.seed) {
			save();
			throw new Error("cutover-unresolved");
		}
		if (
			manual &&
			result.boundaryMessageId &&
			BigInt(manual) < BigInt(result.boundaryMessageId)
		) {
			result.boundaryMessageId = manual;
			result.seed.channels = [{ channelId, lastConfirmedMessageId: manual }];
			delete result.seed.emptyChannels;
		}
		const state = (
			await input.io.run("bash", [
				join(input.flywheelDir, "packages/teamlead/scripts/codex-lead.sh"),
				"--print-state-dir",
				"raya",
				"raya",
			])
		).trim();
		if (join(state, "inbound-cursor.json") !== cursor.path)
			throw new Error("cursor-path-drift");
		mkdirSync(dirname(cursor.path), { recursive: true, mode: 0o700 });
		atomicJson(
			cursor.seed_input,
			result.seed,
			existsSync(cursor.seed_input)
				? digest(readPrivate(cursor.seed_input))
				: null,
		);
		manifest.cutover_probe.boundary_message_id = result.boundaryMessageId;
		manifest.baseline = {
			kind: "quiet15m",
			authorized_by_line: true,
			before_ms: t0,
		};
		save();
		return { status: "seed-ready" };
	};
	if (input.lockOwner !== undefined) {
		const lock = join(raya, "deploy.lock.d");
		if (!lstatSync(lock).isDirectory() || lstatSync(lock).isSymbolicLink())
			throw new Error("deploy-lock-owner-invalid");
		const part = (name: string) => {
			const path = join(lock, name),
				stat = lstatSync(path);
			if (!stat.isFile() || stat.isSymbolicLink())
				throw new Error("deploy-lock-owner-invalid");
			return readFileSync(path, "utf8").trim();
		};
		const start = part("start");
		if (
			input.lockOwner !== process.ppid ||
			part("pid") !== String(input.lockOwner) ||
			!start ||
			(
				await input.io.run("ps", [
					"-o",
					"lstart=",
					"-p",
					String(input.lockOwner),
				])
			).trim() !== start
		)
			throw new Error("deploy-lock-owner-invalid");
		return work();
	}
	return withRayaDeployLock(raya, input.io, work);
}
