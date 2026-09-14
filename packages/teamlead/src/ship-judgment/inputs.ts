import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
	canonicalDigest,
	type FrozenPacket,
	frozenPacketSchema,
	POLICY_VERSION,
	type ShipJudgmentBinding,
	targetSetDigest,
} from "./contract.js";
import { ShipJudgmentJobs } from "./jobs.js";

const id = z.string().min(1).max(200);
export type FreezeResult =
	| { status: "created" | "existing"; inputId: string }
	| { status: "binding_changed" | "card_budget" | "input_budget_exceeded" };
export interface StoredInput extends FrozenPacket {
	inputId: string;
	semanticDigest: string;
	targetsDigest: string;
	ordinal: number;
	projectName: "flywheel";
	runId: string;
	cardMessageId: string;
	threadId: string;
}

/** Only freezes evidence; a caller's model output never establishes a card binding. */
export class ShipJudgmentInputs {
	constructor(
		private readonly db: Database.Database,
		private readonly readBinding: (
			questionId: string,
			channelId: string,
		) => ShipJudgmentBinding | undefined,
	) {}

	freeze(value: unknown, now: string): FreezeResult {
		const data = frozenPacketSchema.parse(value);
		z.string().datetime().parse(now);
		if (Buffer.byteLength(JSON.stringify(data)) > 98_304)
			return { status: "input_budget_exceeded" };
		const sourceIds = new Set(data.sources.map((source) => source.source_id));
		if (sourceIds.size !== data.sources.length)
			throw new Error("duplicate_source");
		if (
			new Set(
				data.requirements.map((requirement) => requirement.requirement_id),
			).size !== data.requirements.length
		)
			throw new Error("duplicate_requirement");
		if (
			new Set(
				data.files.map((file) =>
					canonicalDigest([file.repo_identity, file.path]),
				),
			).size !== data.files.length
		)
			throw new Error("duplicate_file");
		for (const requirement of data.requirements) {
			const source = data.sources.find(
				(source) => source.source_id === requirement.source_id,
			);
			if (
				!source ||
				requirement.quote_start >= requirement.quote_end ||
				requirement.quote_end > Array.from(source.text).length
			)
				throw new Error("invalid_requirement_source");
		}
		data.sources.sort((a, b) =>
			a.source_id < b.source_id ? -1 : a.source_id > b.source_id ? 1 : 0,
		);
		data.requirements.sort((a, b) =>
			a.requirement_id < b.requirement_id
				? -1
				: a.requirement_id > b.requirement_id
					? 1
					: 0,
		);
		const modelDigest = canonicalDigest(data.model);
		data.files.sort((a, b) => {
			const left = canonicalDigest([a.repo_identity, a.path]);
			const right = canonicalDigest([b.repo_identity, b.path]);
			return left < right ? -1 : left > right ? 1 : 0;
		});
		return this.db
			.transaction((): FreezeResult => {
				const binding = this.readBinding(data.questionId, data.channelId);
				if (!binding || canonicalDigest(binding) !== data.bindingDigest)
					return { status: "binding_changed" };
				const targetsDigest = targetSetDigest(
					data.targets,
					binding.manifestRevision,
				);
				const actual = data.targets
					.map((target) =>
						canonicalDigest([
							target.repo_identity,
							target.pr_number,
							target.head_sha,
						]),
					)
					.sort();
				const expected = binding.targets
					.map((target) =>
						canonicalDigest([
							target.repo_identity,
							target.pr_number,
							target.head_sha,
						]),
					)
					.sort();
				if (
					canonicalDigest(actual) !== canonicalDigest(expected) ||
					data.files.some(
						(file) =>
							!binding.targets.some(
								(target) => target.repo_identity === file.repo_identity,
							),
					)
				)
					return { status: "binding_changed" };
				const semanticDigest = canonicalDigest({
					targetsDigest,
					sources: data.sources,
					files: data.files,
					requirements: data.requirements,
					prompt: data.prompt,
				});
				const existing = this.db
					.prepare(`SELECT input_id,card_message_id,thread_id FROM ship_judgment_input
				WHERE question_id=? AND semantic_digest=? AND policy_version=? AND model_snapshot_digest=?`)
					.get(data.questionId, semanticDigest, POLICY_VERSION, modelDigest) as
					| { input_id: string; card_message_id: string; thread_id: string }
					| undefined;
				if (existing)
					return existing.card_message_id === binding.cardMessageId &&
						existing.thread_id === binding.threadId
						? { status: "existing", inputId: existing.input_id }
						: { status: "binding_changed" };
				const count = this.db
					.prepare(
						"SELECT COUNT(*) AS n FROM ship_judgment_input WHERE question_id=?",
					)
					.get(data.questionId) as { n: number };
				if (count.n >= 3) return { status: "card_budget" };
				const inputId = randomUUID();
				this.db
					.prepare(`INSERT INTO ship_judgment_input(input_id,project_name,run_id,question_id,card_message_id,thread_id,semantic_ordinal,
				targets_digest,targets_json,sources_json,requirements_json,semantic_digest,policy_version,model_snapshot_digest,model_snapshot_json,requested_at)
				VALUES (?,'flywheel',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
					.run(
						inputId,
						binding.runId,
						data.questionId,
						binding.cardMessageId,
						binding.threadId,
						count.n + 1,
						targetsDigest,
						JSON.stringify(data.targets),
						JSON.stringify({
							sources: data.sources,
							files: data.files,
							prompt: data.prompt,
							bindingDigest: data.bindingDigest,
							channelId: data.channelId,
						}),
						JSON.stringify(data.requirements),
						semanticDigest,
						POLICY_VERSION,
						modelDigest,
						JSON.stringify(data.model),
						now,
					);
				new ShipJudgmentJobs(this.db).enqueue(inputId);
				return { status: "created", inputId };
			})
			.immediate();
	}

	latestForQuestion(questionId: string): StoredInput | undefined {
		id.parse(questionId);
		const row = this.db
			.prepare(
				"SELECT input_id FROM ship_judgment_input WHERE question_id=? ORDER BY semantic_ordinal DESC LIMIT 1",
			)
			.get(questionId) as { input_id: string } | undefined;
		return row ? this.get(row.input_id) : undefined;
	}

	get(inputId: string): StoredInput | undefined {
		id.parse(inputId);
		const row = this.db
			.prepare("SELECT * FROM ship_judgment_input WHERE input_id=?")
			.get(inputId) as Record<string, unknown> | undefined;
		if (!row) return undefined;
		const packet = frozenPacketSchema.parse({
			questionId: row.question_id,
			targets: JSON.parse(String(row.targets_json)),
			...JSON.parse(String(row.sources_json)),
			requirements: JSON.parse(String(row.requirements_json)),
			model: JSON.parse(String(row.model_snapshot_json)),
		});
		if (
			row.project_name !== "flywheel" ||
			row.policy_version !== POLICY_VERSION
		)
			throw new Error("unsupported_input_policy");
		return {
			...packet,
			inputId,
			semanticDigest: String(row.semantic_digest),
			targetsDigest: String(row.targets_digest),
			ordinal: Number(row.semantic_ordinal),
			projectName: "flywheel",
			runId: String(row.run_id),
			cardMessageId: String(row.card_message_id),
			threadId: String(row.thread_id),
		};
	}
}
