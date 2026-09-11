import { canonicalJsonString } from "flywheel-config";
import type { Cell, MissingReason, RuleId } from "./model.js";
import { EpicPageSchemaError } from "./schema-error.js";

export const ATTENTION_V1 = {
	ruleId: "attention.v1" satisfies RuleId,
	kinds: {
		ship: {
			kind: "ship 卡在你手里",
			action: "去 thread 里点 :cool: 或说停。",
			priority: 0,
		},
		founder_gate: {
			kind: "在等你按一下",
			action: "去 thread 里回一句「同意」或「打回」。",
			priority: 1,
		},
		question: {
			kind: "体在问你一句话",
			action: "去 thread 里回答它的问题。",
			priority: 2,
		},
		founder_named: {
			kind: "你点过名要回来找你",
			action: "去看一眼,决定继续还是停。",
			priority: 3,
		},
	},
	unknownAction: "不确定,去看一眼",
} as const;
export interface AttentionSource {
	fact: Cell<{
		id: string;
		kind: string;
		state: string;
		authority_mode?: string;
	}>;
	recipient_role?: Cell<"lead" | "bridge" | "runner">;
	since: Cell<string>;
}
export interface AttentionCandidate {
	key: string;
	issue_id: Cell<string>;
	identifier: Cell<string>;
	title: Cell<string>;
	sources: AttentionSource[];
	thread: Cell<{ thread_id: string; channel_id: string }>;
}
export interface AttentionItem extends AttentionCandidate {
	kind: Cell<string>;
	action: Cell<string>;
	since: Cell<string>;
	thread_url: Cell<string>;
}
export interface AttentionInput {
	guildId: Cell<string>;
	identityReads: {
		statestore: Cell<{ available: true }>;
		linear: Cell<{ available: true }>;
	};
	reads: {
		gates: Cell<{ count: number }>;
		questions: Cell<{ count: number }>;
		founder_review: Cell<{ count: number }>;
	};
	candidates: AttentionCandidate[];
}
export interface AttentionExtension {
	discord: { guild_id: Cell<string> };
	attention_sources: AttentionInput["reads"] & {
		identity_reads: AttentionInput["identityReads"];
		identity: Cell<{ resolved: number; unresolved: number }>;
		budget: Cell<{ retained: number }>;
	};
	attention: AttentionItem[];
}
export const ATTENTION_READ_PATHS = [
	"/attention_sources/gates",
	"/attention_sources/questions",
	"/attention_sources/founder_review",
];
export function validAttentionSince(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
	)
		return false;
	const date = new Date(value);
	return (
		Number.isFinite(date.getTime()) &&
		date.toISOString() ===
			value.replace(
				/(?:\.(\d{1,3}))?Z$/,
				(_, fraction: string | undefined) =>
					`.${(fraction ?? "").padEnd(3, "0")}Z`,
			)
	);
}
export function validDiscordId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[1-9][0-9]{0,19}$/.test(value) &&
		BigInt(value) <= 18446744073709551615n
	);
}
function derived<T>(
	value: T | null,
	from: string[],
	at: string,
	reason?: MissingReason,
): Cell<T> {
	return {
		value,
		provenance: { kind: "derived", rule: ATTENTION_V1.ruleId, from },
		observed_at: at,
		...(value === null
			? { missing: { reason: reason ?? "source_unavailable" } }
			: {}),
	};
}
function registry(kind: string) {
	return Object.hasOwn(ATTENTION_V1.kinds, kind)
		? ATTENTION_V1.kinds[kind as keyof typeof ATTENTION_V1.kinds]
		: { kind, action: ATTENTION_V1.unknownAction, priority: 4 };
}
export function attentionActions(sources: AttentionSource[]): string[] {
	return [
		...new Set(
			[...sources]
				.sort(
					(a, b) =>
						registry(a.fact.value?.kind ?? "").priority -
						registry(b.fact.value?.kind ?? "").priority,
				)
				.map((s) => registry(s.fact.value?.kind ?? "不知道").action),
		),
	];
}
function selectedSources(sources: AttentionSource[]): AttentionSource[] {
	const order = [...sources].sort(
		(a, b) =>
			registry(a.fact.value?.kind ?? "").priority -
				registry(b.fact.value?.kind ?? "").priority ||
			(a.fact.value?.kind ?? "").localeCompare(b.fact.value?.kind ?? ""),
	);
	return order.filter(
		(source) => source.fact.value?.kind === order[0]?.fact.value?.kind,
	);
}
function derivedItem(
	candidate: AttentionCandidate,
	index: number,
	guild: Cell<string>,
	at: string,
): AttentionItem {
	const base = `/attention/${index}`;
	const facts = candidate.sources.map((_, i) => `${base}/sources/${i}/fact`);
	const selected = selectedSources(candidate.sources);
	const primary = registry(selected[0]?.fact.value?.kind ?? "不知道");
	const sinceSources = selected.map(
		(source) => `${base}/sources/${candidate.sources.indexOf(source)}/since`,
	);
	let since: Cell<string>;
	const missing = selected.find((source) => source.since.value === null);
	if (missing)
		since = derived<string>(
			null,
			sinceSources,
			at,
			missing.since.missing?.reason ?? "since_unknown",
		);
	else if (
		selected.some(
			(source) =>
				!validAttentionSince(source.since.value) ||
				Date.parse(source.since.value!) > Date.parse(at),
		)
	)
		since = derived<string>(null, sinceSources, at, "invalid_since");
	else
		since = derived(
			selected
				.map((s) => s.since.value!)
				.sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null,
			sinceSources,
			at,
			"since_unknown",
		);
	const linkSources = ["/discord/guild_id", `${base}/thread`];
	const thread = candidate.thread.value;
	const linkMissing =
		guild.value === null
			? (guild.missing?.reason ?? "no_guild_configured")
			: !validDiscordId(guild.value)
				? "invalid_guild_config"
				: thread === null
					? (candidate.thread.missing?.reason ?? "no_thread_binding")
					: !validDiscordId(thread.thread_id) ||
							!validDiscordId(thread.channel_id)
						? "invalid_discord_id"
						: null;
	return {
		...candidate,
		kind: derived(primary.kind, facts, at),
		action: derived(primary.action, facts, at),
		since,
		thread_url: linkMissing
			? derived<string>(null, linkSources, at, linkMissing)
			: derived(
					`https://discord.com/channels/${guild.value}/${thread!.thread_id}`,
					linkSources,
					at,
				),
	};
}
export function rebuildAttention(
	extension: AttentionExtension,
	candidates: AttentionCandidate[],
	at: string,
	truncated = false,
): AttentionExtension {
	const attention = candidates.map((candidate, i) =>
		derivedItem(candidate, i, extension.discord.guild_id, at),
	);
	const identityFrom = [
		...ATTENTION_READ_PATHS,
		"/attention_sources/identity_reads/statestore",
		"/attention_sources/identity_reads/linear",
		...attention.map((_, i) => `/attention/${i}/issue_id`),
	];
	const unresolved = attention.filter(
		(item) => item.issue_id.value === null,
	).length;
	const identityReadFailed =
		extension.attention_sources.identity_reads.statestore.value === null ||
		extension.attention_sources.identity_reads.linear.value === null;
	const identity = identityReadFailed
		? derived<{ resolved: number; unresolved: number }>(
				null,
				identityFrom,
				at,
				"source_unavailable",
			)
		: derived(
				{ resolved: attention.length - unresolved, unresolved },
				identityFrom,
				at,
			);
	return {
		...extension,
		attention,
		attention_sources: {
			...extension.attention_sources,
			identity,
			budget: derived(
				truncated ? null : { retained: attention.length },
				[...ATTENTION_READ_PATHS, "/attention_sources/identity"],
				at,
				truncated ? "source_truncated" : undefined,
			),
		},
	};
}
export function buildAttention(
	input: AttentionInput,
	at: string,
): AttentionExtension {
	if (
		!input?.reads ||
		!Array.isArray(input.candidates) ||
		!input.guildId ||
		!input.identityReads
	)
		throw new EpicPageSchemaError("attention input is required");

	// Only exact question identities shared by the two authoritative record kinds
	// may collapse unresolved rows. Never use this index to promote an unresolved
	// identity into an issue, or merge two different resolved issues.
	const orphanKinds = new Map<string, Set<string>>();
	for (const candidate of input.candidates) {
		if (candidate.issue_id.value !== null) continue;
		const match = /^(holder|question):(.+)$/.exec(candidate.key);
		if (!match) continue;
		const [, kind, id] = match;
		const matches = candidate.sources.some(
			(source) =>
				source.fact.value?.id === id &&
				(kind === "holder"
					? source.fact.provenance.kind === "statestore" &&
						source.fact.provenance.table === "workflow_gate_holder"
					: source.fact.provenance.kind === "commdb" &&
						source.fact.provenance.table === "mailbox"),
		);
		if (!matches) continue;
		const kinds = orphanKinds.get(id!) ?? new Set<string>();
		kinds.add(kind!);
		orphanKinds.set(id!, kinds);
	}
	const grouped = new Map<string, AttentionCandidate>();
	for (const raw of input.candidates) {
		const candidate = structuredClone(raw);
		const orphanMatch = /^(holder|question):(.+)$/.exec(candidate.key);
		const orphanQuestion = orphanMatch?.[2];
		const key = candidate.issue_id.value
			? `issue:${candidate.issue_id.value}`
			: orphanQuestion && orphanKinds.get(orphanQuestion)?.size === 2
				? `question:${orphanQuestion}`
				: candidate.key;
		candidate.key = key;
		if (candidate.issue_id.value === null)
			candidate.thread = {
				...candidate.thread,
				value: null,
				missing: { reason: "issue_identity_unknown" },
			};
		for (const source of candidate.sources)
			if (
				source.since.value !== null &&
				!validAttentionSince(source.since.value)
			)
				source.since = {
					...source.since,
					value: null,
					missing: { reason: "invalid_since" },
				};

		const prior = grouped.get(key);
		if (!prior) {
			grouped.set(key, candidate);
			continue;
		}
		const seen = new Set(
			prior.sources.map(
				(source) =>
					canonicalJsonString(source.fact.provenance) +
					"\0" +
					source.fact.value?.id,
			),
		);
		for (const source of candidate.sources) {
			const identity =
				canonicalJsonString(source.fact.provenance) +
				"\0" +
				source.fact.value?.id;
			if (!seen.has(identity)) {
				prior.sources.push(source);
				seen.add(identity);
			}
		}
		if (
			canonicalJsonString(prior.thread.value) !==
				canonicalJsonString(candidate.thread.value) ||
			prior.thread.missing?.reason !== candidate.thread.missing?.reason
		) {
			prior.thread = {
				...prior.thread,
				value: null,
				missing: { reason: "thread_binding_conflict" },
			};
		}
	}
	const candidates = [...grouped.values()].sort(
		(a, b) =>
			(a.identifier.value === null ? 1 : 0) -
				(b.identifier.value === null ? 1 : 0) ||
			(a.identifier.value ?? "").localeCompare(b.identifier.value ?? "", "en", {
				numeric: true,
			}) ||
			a.key.localeCompare(b.key),
	);
	const shell: AttentionExtension = {
		discord: { guild_id: structuredClone(input.guildId) },
		attention_sources: {
			...structuredClone(input.reads),
			identity_reads: structuredClone(input.identityReads),
			identity: derived(
				{ resolved: 0, unresolved: 0 },
				ATTENTION_READ_PATHS,
				at,
			),
			budget: derived({ retained: 0 }, ATTENTION_READ_PATHS, at),
		},
		attention: [],
	};
	return rebuildAttention(shell, candidates, at);
}

function fail(path: string): never {
	throw new EpicPageSchemaError(`${path}: invalid attention.v1 value`);
}
function exact(
	value: unknown,
	keys: string[],
	optional: string[] = [],
	path = "attention",
): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(path);
	const actual = Object.keys(value);
	if (
		keys.some((key) => !actual.includes(key)) ||
		actual.some((key) => ![...keys, ...optional].includes(key))
	)
		fail(path);
}
/** The model provides the shared strict Cell/provenance validator to avoid a runtime import cycle. */
export function assertAttention(
	extension: unknown,
	at: string,
	assertCell: (cell: unknown, path: string) => void,
): asserts extension is AttentionExtension {
	const root = extension as AttentionExtension;
	exact(root.discord, ["guild_id"], [], "/discord");
	assertCell(root.discord.guild_id, "/discord/guild_id");
	if (
		root.discord.guild_id.provenance.kind !== "statestore" ||
		root.discord.guild_id.provenance.table !== "discord_config"
	)
		fail("/discord/guild_id/provenance");
	if (
		root.discord.guild_id.value !== null &&
		!validDiscordId(root.discord.guild_id.value)
	)
		fail("/discord/guild_id");
	exact(
		root.attention_sources,
		[
			"gates",
			"questions",
			"founder_review",
			"identity_reads",
			"identity",
			"budget",
		],
		[],
		"/attention_sources",
	);

	exact(
		root.attention_sources.identity_reads,
		["statestore", "linear"],
		[],
		"/attention_sources/identity_reads",
	);
	for (const name of ["statestore", "linear"] as const) {
		const path = `/attention_sources/identity_reads/${name}`;
		const read = root.attention_sources.identity_reads[name];
		assertCell(read, path);
		if (read.provenance.kind !== name) fail(`${path}/provenance`);
		if (read.value !== null) {
			exact(read.value, ["available"], [], `${path}/value`);
			if (read.value.available !== true) fail(`${path}/value`);
		} else if (
			!["source_unavailable", "source_truncated", "statestore_error"].includes(
				read.missing?.reason ?? "",
			)
		)
			fail(`${path}/missing`);
	}
	for (const name of [
		"gates",
		"questions",
		"founder_review",
		"identity",
		"budget",
	] as const) {
		const cell = root.attention_sources[name];
		assertCell(cell, `/attention_sources/${name}`);
		if (cell.value !== null) {
			const keys =
				name === "identity"
					? ["resolved", "unresolved"]
					: name === "budget"
						? ["retained"]
						: ["count"];
			exact(cell.value, keys, [], `/attention_sources/${name}/value`);
			for (const value of Object.values(cell.value))
				if (!Number.isSafeInteger(value) || Number(value) < 0)
					fail(`/attention_sources/${name}`);
		}
	}
	if (
		root.attention_sources.gates.provenance.kind !== "statestore" &&
		root.attention_sources.gates.provenance.kind !== "commdb"
	)
		fail("/attention_sources/gates");
	if (
		root.attention_sources.questions.provenance.kind !== "commdb" ||
		root.attention_sources.founder_review.provenance.kind !== "linear"
	)
		fail("/attention_sources");
	if (!Array.isArray(root.attention)) fail("/attention");
	const keys = new Set<string>();
	const sourceCounts = {
		gates: new Set<string>(),
		questions: new Set<string>(),
		founder_review: new Set<string>(),
	};
	for (const [i, item] of root.attention.entries()) {
		const path = `/attention/${i}`;
		exact(
			item,
			[
				"key",
				"issue_id",
				"identifier",
				"title",
				"sources",
				"kind",
				"action",
				"since",
				"thread",
				"thread_url",
			],
			[],
			path,
		);
		if (typeof item.key !== "string" || !item.key || keys.has(item.key))
			fail(`${path}/key`);
		keys.add(item.key);
		for (const leaf of [
			"issue_id",
			"identifier",
			"title",
			"kind",
			"action",
			"since",
			"thread",
			"thread_url",
		] as const) {
			assertCell(item[leaf], `${path}/${leaf}`);
			if (
				leaf !== "thread" &&
				item[leaf].value !== null &&
				(typeof item[leaf].value !== "string" || item[leaf].value === "")
			)
				fail(`${path}/${leaf}`);
		}
		if (
			item.issue_id.value !== null
				? item.key !== `issue:${item.issue_id.value}`
				: !/^(question|holder):.+$/.test(item.key)
		)
			fail(`${path}/key`);
		if (
			item.issue_id.value === null &&
			item.issue_id.missing?.reason !== "issue_identity_unknown"
		)
			fail(`${path}/issue_id`);
		if (item.issue_id.value !== null)
			for (const leaf of ["issue_id", "identifier", "title"] as const) {
				const provenance = item[leaf].provenance;
				if (
					provenance.kind !== "linear" ||
					provenance.id !== item.issue_id.value
				)
					fail(`${path}/${leaf}/provenance`);
			}
		if (
			item.thread.provenance.kind !== "statestore" ||
			item.thread.provenance.table !== "chat_threads"
		)
			fail(`${path}/thread/provenance`);
		if (item.thread.value !== null) {
			exact(
				item.thread.value,
				["thread_id", "channel_id"],
				[],
				`${path}/thread/value`,
			);
			if (
				!validDiscordId(item.thread.value.thread_id) ||
				!validDiscordId(item.thread.value.channel_id)
			)
				fail(`${path}/thread`);
		}
		if (item.issue_id.value === null && item.thread.value !== null)
			fail(`${path}/thread`);
		if (!Array.isArray(item.sources) || item.sources.length === 0)
			fail(`${path}/sources`);
		const sourceKeys = new Set<string>();
		for (const [j, source] of item.sources.entries()) {
			const sourcePath = `${path}/sources/${j}`;
			exact(source, ["fact", "since"], ["recipient_role"], sourcePath);
			assertCell(source.fact, `${sourcePath}/fact`);
			assertCell(source.since, `${sourcePath}/since`);
			exact(
				source.fact.value,
				["id", "kind", "state"],
				["authority_mode"],
				`${sourcePath}/fact/value`,
			);
			if (
				Object.values(source.fact.value!).some(
					(value) => typeof value !== "string" || !value,
				) ||
				source.fact.value!.kind.length > 256
			)
				fail(`${sourcePath}/fact`);
			if (
				source.fact.provenance.kind === "derived" ||
				source.since.provenance.kind === "derived"
			)
				fail(sourcePath);
			const identity =
				canonicalJsonString(source.fact.provenance) +
				"\0" +
				source.fact.value!.id;
			if (sourceKeys.has(identity)) fail(sourcePath);
			sourceKeys.add(identity);
			const provenance = source.fact.provenance;
			const bucket =
				provenance.kind === "linear"
					? "founder_review"
					: provenance.kind === "commdb"
						? "questions"
						: "gates";
			sourceCounts[bucket].add(identity);
			if (
				["declared_blocked", "run_held", "runner_stopped"].includes(
					source.fact.value!.kind,
				)
			)
				fail(`${sourcePath}/fact/kind`);
			if (
				provenance.kind === "linear" &&
				(source.fact.value!.kind !== "founder_named" ||
					provenance.id !== item.issue_id.value ||
					source.fact.value!.id !== item.issue_id.value ||
					["completed", "canceled"].includes(source.fact.value!.state))
			)
				fail(`${sourcePath}/fact`);

			if (
				source.since.value !== null &&
				!validAttentionSince(source.since.value)
			)
				fail(`${sourcePath}/since`);
			const mailbox =
				source.fact.provenance.kind === "commdb" &&
				source.fact.provenance.table === "mailbox";

			const holder =
				source.fact.provenance.kind === "statestore" &&
				source.fact.provenance.table === "workflow_gate_holder";
			if (mailbox || holder) {
				const factProvenance = source.fact.provenance;
				const sinceProvenance = source.since.provenance;
				if (
					(factProvenance.kind !== "commdb" &&
						factProvenance.kind !== "statestore") ||
					factProvenance.key.question_id !== source.fact.value!.id ||
					sinceProvenance.kind !== factProvenance.kind ||
					sinceProvenance.table !== factProvenance.table ||
					sinceProvenance.key.question_id !== source.fact.value!.id
				)
					fail(`${sourcePath}/since/provenance`);
			}
			if (mailbox) {
				if (!source.recipient_role) fail(`${sourcePath}/recipient_role`);
				assertCell(source.recipient_role, `${sourcePath}/recipient_role`);
				if (
					source.recipient_role.provenance.kind !== "commdb" ||
					source.recipient_role.provenance.table !== "mailbox" ||
					source.recipient_role.provenance.key.question_id !==
						source.fact.value!.id ||
					(source.recipient_role.value !== null &&
						!["lead", "bridge", "runner"].includes(source.recipient_role.value))
				)
					fail(`${sourcePath}/recipient_role`);
			} else if (source.recipient_role !== undefined)
				fail(`${sourcePath}/recipient_role`);
			if (
				source.fact.value!.kind === "founder_named" &&
				source.since.value !== null
			)
				fail(`${sourcePath}/since`);
		}
		const expected = derivedItem(item, i, root.discord.guild_id, at);
		for (const leaf of ["kind", "action", "since", "thread_url"] as const)
			if (
				canonicalJsonString(item[leaf]) !== canonicalJsonString(expected[leaf])
			)
				fail(`${path}/${leaf}`);
	}
	for (const bucket of ["gates", "questions", "founder_review"] as const) {
		const value = root.attention_sources[bucket].value;
		if (
			value &&
			(root.attention_sources.budget.value === null
				? value.count < sourceCounts[bucket].size
				: value.count !== sourceCounts[bucket].size)
		)
			fail(`/attention_sources/${bucket}`);
	}
	const budgetTruncated = root.attention_sources.budget.value === null;
	if (
		budgetTruncated &&
		root.attention_sources.budget.missing?.reason !== "source_truncated"
	)
		fail("/attention_sources/budget");
	const expected = rebuildAttention(root, root.attention, at, budgetTruncated);
	for (const leaf of ["identity", "budget"] as const)
		if (
			canonicalJsonString(root.attention_sources[leaf]) !==
			canonicalJsonString(expected.attention_sources[leaf])
		)
			fail(`/attention_sources/${leaf}`);
}
