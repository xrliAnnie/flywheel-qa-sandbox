import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import {
	atomicJson,
	digest,
	discordJson,
	discordMessage,
	type MigrationIO,
	readPrivate,
	withRayaDeployLock,
} from "./raya-migration-io.js";

export async function resolveMigration(input: {
	home: string;
	io: MigrationIO;
	messageId: string;
	as: string;
	evidence: string;
	quietWindow?: boolean;
	boundaryMessageId?: string;
}): Promise<Record<string, unknown>> {
	const recovery = [
		"lookback_confirmed",
		"probe_message-id",
		"probe_not_delivered",
	].includes(input.as);
	if (
		(!recovery && !/^[0-9]{17,20}$/.test(input.messageId)) ||
		!input.evidence.trim() ||
		(!recovery &&
			![
				"confirmed_processed",
				"confirmed_unprocessed",
				"side_effect_reconciled",
			].includes(input.as))
	)
		throw new Error("resolution-arguments-invalid");
	if (input.quietWindow && input.as === "side_effect_reconciled")
		throw new Error("quiet-window-ruling-invalid");
	const reason = input.quietWindow ? "quiet-window-violated" : "stop-window";
	const raya = join(input.home, ".flywheel/raya");
	return withRayaDeployLock(raya, input.io, async () => {
		const file = join(raya, "migrations/FLY-2445-standard-lead/manifest.json");
		const bytes = readPrivate(file);
		const manifest = JSON.parse(bytes);
		const postActivationRecovery =
			manifest.checkpoint === "P4b" &&
			["probe_message-id", "probe_not_delivered"].includes(input.as) &&
			manifest.cursor?.status === "preexisting" &&
			Number.isFinite(Date.parse(manifest.activated_at)) &&
			Number.isFinite(Date.parse(manifest.lead_restart_installed_at)) &&
			typeof manifest.seed_probe?.intent?.nonce === "string" &&
			/^[a-zA-Z0-9-]+$/.test(manifest.seed_probe.intent.nonce) &&
			typeof manifest.seed_probe?.message_id === "string" &&
			/^[0-9]{17,20}$/.test(manifest.seed_probe.message_id) &&
			Array.isArray(manifest.probe_resets) &&
			manifest.probe_resets.some(
				(entry: { nonce?: string }) =>
					entry.nonce === manifest.seed_probe.intent.nonce,
			);
		if (
			manifest.schemaVersion !== 1 ||
			(manifest.checkpoint !== "P3" && !postActivationRecovery) ||
			!Array.isArray(manifest.unresolved) ||
			(manifest.resolutions !== undefined &&
				!Array.isArray(manifest.resolutions))
		)
			throw new Error("resolution-ledger-invalid");
		if (recovery) {
			if (input.quietWindow) throw new Error("quiet-window-ruling-invalid");
			return resolveRecovery(input, manifest, file, bytes);
		}
		const resolutions: Array<{ target: string; as: string; evidence: string }> =
			manifest.resolutions ?? [];
		const previous = resolutions.find(
			(resolution) => resolution.target === input.messageId,
		);
		if (previous) {
			if (previous.as === input.as && previous.evidence === input.evidence)
				return { status: "already-resolved" };
			throw new Error("resolution-immutable");
		}
		const unresolved: Array<{ message_id?: string; reason: string }> =
			manifest.unresolved;
		if (
			!unresolved.some(
				(item) => item.reason === reason && item.message_id === input.messageId,
			)
		)
			throw new Error("resolution-message-unknown");
		if (
			input.as !== "confirmed_unprocessed" &&
			unresolved.some(
				(item) =>
					["stop-window", "quiet-window-violated"].includes(item.reason) &&
					item.message_id &&
					BigInt(item.message_id) < BigInt(input.messageId),
			)
		)
			throw new Error("resolution-earlier-gap-unresolved");
		const next = {
			target: input.messageId,
			as: input.as,
			evidence: input.evidence,
			at: new Date(input.io.now()).toISOString(),
			by: "flywheel-eng-lead",
			reason,
		};
		const ordered = [...resolutions, next]
			.filter((resolution) =>
				[
					"confirmed_processed",
					"confirmed_unprocessed",
					"side_effect_reconciled",
				].includes(resolution.as),
			)
			.sort((left, right) =>
				BigInt(left.target) < BigInt(right.target) ? -1 : 1,
			);
		let gap = false;
		for (const resolution of ordered) {
			if (resolution.as === "confirmed_unprocessed") gap = true;
			else if (gap) throw new Error("resolution-non-contiguous");
		}
		manifest.resolutions = [...resolutions, next];
		manifest.unresolved = unresolved.filter(
			(item) =>
				!(item.reason === reason && item.message_id === input.messageId),
		);
		atomicJson(file, manifest, digest(bytes));
		return { status: "resolved", unresolved_count: manifest.unresolved.length };
	});
}

async function resolveRecovery(
	input: {
		home: string;
		io: MigrationIO;
		messageId: string;
		boundaryMessageId?: string;
		as: string;
		evidence: string;
	},
	manifest: Record<string, unknown>,
	file: string,
	bytes: string,
): Promise<Record<string, unknown>> {
	const unresolved = manifest.unresolved as Array<{ reason: string }>;
	const reason =
		input.as === "lookback_confirmed"
			? "lookback_exhausted"
			: "probe_delivery_ambiguous";
	if (!unresolved.some((item) => item.reason === reason))
		throw new Error("recovery-target-absent");
	const receipt = {
		as: input.as,
		at: new Date(input.io.now()).toISOString(),
		by: "flywheel-eng-lead",
		evidence: input.evidence,
	};
	let target: string;
	if (input.as === "probe_not_delivered") {
		const intent = JSON.parse(
			readPrivate(join(dirname(file), "cutover-probe.intent")),
		);
		if (
			typeof intent.nonce !== "string" ||
			!/^[0-9a-f-]{36}$/.test(intent.nonce)
		)
			throw new Error("probe-intent-invalid");
		target = intent.nonce;
		manifest.probe_resets = [
			...((manifest.probe_resets as unknown[]) ?? []),
			{ ...receipt, nonce: target },
		];
	} else {
		const probe = manifest.window_probe as
			| { bot_token_env?: string; bot_user_id?: string; channel_id?: string }
			| undefined;
		if (
			!probe?.bot_token_env ||
			!/^[A-Z][A-Z0-9_]*$/.test(probe.bot_token_env) ||
			!probe.bot_user_id ||
			!probe.channel_id ||
			!/^[0-9]{17,20}$/.test(probe.channel_id)
		)
			throw new Error("probe-identity-invalid");
		const token = parseEnv(readPrivate(join(input.home, ".flywheel/.env")))[
			probe.bot_token_env
		];
		if (!token) throw new Error("probe-token-unavailable");
		const identity = (await discordJson(input.io, "/users/@me", token)) as {
			id?: string;
			bot?: boolean;
		};
		if (identity.id !== probe.bot_user_id || identity.bot !== true)
			throw new Error("probe-bot-mismatch");
		target =
			input.as === "lookback_confirmed"
				? (input.boundaryMessageId ?? "")
				: input.messageId;
		if (!/^[0-9]{17,20}$/.test(target))
			throw new Error("recovery-message-invalid");
		const message = discordMessage(
			await discordJson(
				input.io,
				`/channels/${probe.channel_id}/messages/${target}`,
				token,
			),
		);
		if (message.id !== target || message.channel_id !== probe.channel_id)
			throw new Error("recovery-message-invalid");
		if (input.as === "lookback_confirmed") {
			const cutover = manifest.cutover_probe as
				| { message_id?: string }
				| undefined;
			if (!cutover?.message_id || BigInt(target) >= BigInt(cutover.message_id))
				throw new Error("lookback-boundary-invalid");
			manifest.lookback_resolution = {
				...receipt,
				boundary_message_id: target,
			};
		} else {
			const intent = JSON.parse(
				readPrivate(join(dirname(file), "cutover-probe.intent")),
			);
			if (
				message.author.id !== probe.bot_user_id ||
				intent.prefix !== "FLY-2445 cutover window probe" ||
				message.content !== `[${intent.prefix} ${intent.nonce}] ${intent.text}`
			)
				throw new Error("probe-message-mismatch");
			if (
				manifest.checkpoint === "P4b" &&
				Number((BigInt(message.id) >> 22n) + 1420070400000n) <
					Date.parse(manifest.activated_at as string)
			)
				throw new Error("activation-probe-before-activation");
			manifest.cutover_probe = {
				intent: { nonce: intent.nonce, at: intent.at },
				message_id: message.id,
				bot_user_id: probe.bot_user_id,
				sent_at: new Date(
					Number((BigInt(message.id) >> 22n) + 1420070400000n),
				).toISOString(),
			};
		}
	}
	manifest.resolutions = [
		...((manifest.resolutions as unknown[]) ?? []),
		{ ...receipt, target },
	];
	manifest.unresolved = unresolved.filter((item) => item.reason !== reason);
	atomicJson(file, manifest, digest(bytes));
	return {
		status: "resolved",
		unresolved_count: (manifest.unresolved as unknown[]).length,
	};
}
