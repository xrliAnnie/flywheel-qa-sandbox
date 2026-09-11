import { canonicalJsonString } from "flywheel-config";
import { describe, expect, it } from "vitest";
import { buildAttention, validAttentionSince } from "../attention.js";
import { applyAttentionBudget } from "../attention-budget.js";
import { generateAttentionEpicPage } from "../generate.js";
import { assertEpicPage, type EpicPageV2 } from "../model.js";
import {
	attentionFixture,
	candidate,
	sourceCell,
} from "./fixtures/attention.js";

describe("attention.v1 calculation", () => {
	it("merges exactly three independent sources without Epic scope", () => {
		const result = buildAttention(attentionFixture(), "2026-09-09T12:00:00Z");
		expect(result.attention).toHaveLength(3);
		expect(result.attention.map((x) => x.kind.value)).toEqual([
			"在等你按一下",
			"体在问你一句话",
			"你点过名要回来找你",
		]);
		expect(result.attention[0].thread_url.value).toBe(
			"https://discord.com/channels/123/456",
		);
		expect(result.attention_sources.identity.value).toEqual({
			resolved: 3,
			unresolved: 0,
		});
	});
	it("merges one canonical issue across sources and preserves distinct question evidence", () => {
		const input = attentionFixture();
		input.candidates[1].issue_id = input.candidates[0].issue_id;
		input.candidates[1].identifier = input.candidates[0].identifier;
		input.candidates[1].title = input.candidates[0].title;
		input.candidates.push({
			...input.candidates[1],
			sources: [
				{
					...input.candidates[1].sources[0],
					fact: sourceCell(
						{ id: "another-question", kind: "question", state: "open" },
						"commdb",
						"mailbox",
					),
				},
			],
		});
		const result = buildAttention(input, "2026-09-09T12:00:00Z");
		expect(result.attention).toHaveLength(2);
		expect(result.attention[0].sources).toHaveLength(3);
		expect(result.attention[0].kind.value).toBe("在等你按一下");
	});
	it("retains resolved/unresolved counts after a successful query with unknown orphans", () => {
		const input = attentionFixture();
		input.candidates[1].issue_id = {
			...input.candidates[1].issue_id,
			value: null,
			missing: { reason: "issue_identity_unknown" },
		};
		const result = buildAttention(input, "2026-09-09T12:00:00Z");
		expect(result.attention).toHaveLength(3);
		expect(result.attention.some((x) => x.key === "question:q2")).toBe(true);
		expect(result.attention_sources.identity.value).toEqual({
			resolved: 2,
			unresolved: 1,
		});
		expect(result.attention_sources.identity.missing).toBeUndefined();
	});

	it.each(["statestore", "linear"] as const)(
		"marks identity unavailable only when the actual %s query fails",
		(source) => {
			const input = attentionFixture();
			input.identityReads[source] = {
				...input.identityReads[source],
				value: null,
				missing: { reason: "source_unavailable" },
			};
			const result = buildAttention(input, "2026-09-09T12:00:00Z");
			expect(result.attention).toHaveLength(3);
			expect(result.attention_sources.identity.value).toBeNull();
			expect(result.attention_sources.identity.missing?.reason).toBe(
				"source_unavailable",
			);
			expect(result.attention_sources.identity.provenance).toMatchObject({
				kind: "derived",
				from: expect.arrayContaining([
					"/attention_sources/identity_reads/statestore",
					"/attention_sources/identity_reads/linear",
				]),
			});
		},
	);
	it("folds holder and mailbox evidence for one exact unresolved question, without discarding either source", () => {
		const input = attentionFixture();
		input.candidates = input.candidates.slice(0, 2);
		input.reads.founder_review.value = { count: 0 };
		for (const [index, item] of input.candidates.entries()) {
			item.key = `${index === 0 ? "holder" : "question"}:same-question`;
			item.issue_id = {
				...item.issue_id,
				value: null,
				missing: { reason: "issue_identity_unknown" },
			};
			const source = item.sources[0]!;
			source.fact.value!.id = "same-question";
			source.fact.value!.kind = "founder_gate";
			for (const cell of [source.fact, source.since, source.recipient_role])
				if (
					cell &&
					(cell.provenance.kind === "commdb" ||
						cell.provenance.kind === "statestore")
				)
					cell.provenance.key = { question_id: "same-question" };
		}
		const result = buildAttention(input, "2026-09-09T12:00:00Z");
		expect(result.attention).toHaveLength(1);
		expect(result.attention[0].key).toBe("question:same-question");
		expect(result.attention[0].sources).toHaveLength(2);
		expect(result.attention_sources.identity.value).toEqual({
			resolved: 0,
			unresolved: 1,
		});
		expect(result.attention_sources.gates.value).toEqual({ count: 1 });
		expect(result.attention_sources.questions.value).toEqual({ count: 1 });
		const page = generateAttentionEpicPage({
			snapshot: null,
			itemFacts: [],
			now: new Date("2026-09-09T12:00:00Z"),
			projectName: "example",
			trigger: "manual",
			scopeBinding: { team: "FLY" },
			attention: input,
		});
		expect(() => assertEpicPage(page)).not.toThrow();
	});
	it("does not merge one question across conflicting resolved issue identities", () => {
		const input = attentionFixture();
		input.candidates = input.candidates.slice(0, 2);
		for (const [index, item] of input.candidates.entries()) {
			item.key = `${index === 0 ? "holder" : "question"}:same-question`;
			item.sources[0]!.fact.value!.id = "same-question";
		}
		const result = buildAttention(input, "2026-09-09T12:00:00Z");
		expect(result.attention.map((item) => item.key)).toEqual([
			"issue:uuid-1",
			"issue:uuid-2",
		]);
	});

	it("keeps unknown kind and action, never invents a label application time", () => {
		const input = attentionFixture();
		input.candidates = [
			candidate(1, "novel_gate", "statestore", "workflow_gate_holder"),
		];
		const result = buildAttention(input, "2026-09-09T12:00:00Z");
		expect(result.attention[0].kind.value).toBe("novel_gate");
		expect(result.attention[0].action.value).toBe("不确定,去看一眼");
		expect(
			buildAttention(attentionFixture(), "2026-09-09T12:00:00Z").attention[2]
				.since.missing?.reason,
		).toBe("since_unknown");
	});
	it("does not borrow another action's wait time when the primary source time is missing", () => {
		const input = attentionFixture();
		input.candidates[0].sources[0].since = {
			...input.candidates[0].sources[0].since,
			value: null,
			missing: { reason: "since_unknown" },
		};
		input.candidates[0].sources.push(input.candidates[1].sources[0]);
		expect(
			buildAttention(input, "2026-09-09T12:00:00Z").attention[0].since.missing
				?.reason,
		).toBe("since_unknown");
	});
	it("disables URL for missing guild and conflicting bindings", () => {
		const input = attentionFixture();
		input.guildId = {
			...input.guildId,
			value: null,
			missing: { reason: "no_guild_configured" },
		};
		expect(
			buildAttention(input, "2026-09-09T12:00:00Z").attention[0].thread_url
				.missing?.reason,
		).toBe("no_guild_configured");
		const conflict = attentionFixture();
		conflict.candidates.push({
			...conflict.candidates[0],
			thread: sourceCell(
				{ thread_id: "789", channel_id: "321" },
				"statestore",
				"chat_threads",
			),
		});
		expect(
			buildAttention(conflict, "2026-09-09T12:00:00Z").attention[0].thread_url
				.missing?.reason,
		).toBe("thread_binding_conflict");
	});
	it.each([
		"2026-02-30T12:00:00Z",
		"2026-09-09 12:00:00",
		"2026-09-09T12:00:00+00:00",
		"bad",
	])("rejects invalid since %s", (timestamp) => {
		expect(validAttentionSince(timestamp)).toBe(false);
	});
	it("accepts real UTC timestamps", () => {
		expect(validAttentionSince("2026-09-09T12:00:00.123Z")).toBe(true);
	});
});

describe("attention document byte budget", () => {
	const page = () =>
		generateAttentionEpicPage({
			snapshot: null,
			itemFacts: [],
			now: new Date("2026-09-09T12:00:00Z"),
			projectName: "example",
			trigger: "manual",
			scopeBinding: { team: "FLY" },
			attention: attentionFixture(),
		});
	const html = (value: EpicPageV2) =>
		"<main>" +
		value.attention
			.map(
				(item) =>
					"<article>" +
					item.title.value!.replaceAll("&", "&amp;").replaceAll("<", "&lt;") +
					"</article>",
			)
			.join("") +
		(value.attention_sources.budget.missing ? "清单不完整" : "") +
		"</main>";
	it("keeps a full document when both real byte counts fit", () => {
		const original = page();
		expect(applyAttentionBudget(original, html)).toEqual(original);
	});
	it("retains whole rows and marks missing budget before emitting partial HTML", () => {
		const original = page();
		const result = applyAttentionBudget(original, html, { maxHtmlBytes: 100 });
		expect(result.attention.length).toBeLessThan(3);
		expect(result.attention_sources.budget.missing?.reason).toBe(
			"source_truncated",
		);
		expect(Buffer.byteLength(html(result))).toBeLessThanOrEqual(100);
		expect(result.items).toEqual(original.items);
		expect(result.header).toEqual(original.header);
		expect(() => assertEpicPage(result)).not.toThrow();
	});
	it("measures multibyte JSON and handles exact boundary versus one byte over", () => {
		const original = page();
		const bytes = Buffer.byteLength(canonicalJsonString(original));
		expect(
			applyAttentionBudget(original, html, { maxJsonBytes: bytes }).attention,
		).toHaveLength(3);
		const result = applyAttentionBudget(original, html, {
			maxJsonBytes: bytes - 1,
		});
		expect(result.attention.length).toBeLessThan(3);
		expect(Buffer.byteLength(canonicalJsonString(result))).toBeLessThanOrEqual(
			bytes - 1,
		);
	});
	it("rebuilds oldest-source pointers when the oldest row is omitted", () => {
		const original = page();
		original.attention[2].title.observed_at = "2020-01-01T00:00:00Z";
		const result = applyAttentionBudget(original, html, { maxHtmlBytes: 100 });
		expect(result.freshness.oldest_source.value?.path).not.toBe(
			"/attention/2/title",
		);
		expect(() => assertEpicPage(result)).not.toThrow();
	});
	it("fails if the original Epic and minimum warning cannot fit", () => {
		expect(() =>
			applyAttentionBudget(page(), html, { maxHtmlBytes: 1 }),
		).toThrow(/size|exceeds/);
	});
	it("preserves failed raw identity read health and its freshness through budget truncation", () => {
		const attention = attentionFixture();
		attention.identityReads.linear = {
			...attention.identityReads.linear,
			value: null,
			missing: { reason: "source_unavailable" },
			observed_at: "2020-01-01T00:00:00Z",
		};
		const original = generateAttentionEpicPage({
			snapshot: null,
			itemFacts: [],
			now: new Date("2026-09-09T12:00:00Z"),
			projectName: "example",
			trigger: "manual",
			scopeBinding: { team: "FLY" },
			attention,
		});
		const result = applyAttentionBudget(original, html, { maxHtmlBytes: 100 });
		expect(result.attention_sources.identity_reads).toEqual(
			original.attention_sources.identity_reads,
		);
		expect(result.attention_sources.identity.missing?.reason).toBe(
			"source_unavailable",
		);
		expect(result.freshness.oldest_source.value?.path).toBe(
			"/attention_sources/identity_reads/linear",
		);
		expect(result.attention_sources.identity.provenance).toMatchObject({
			from: expect.arrayContaining([
				"/attention_sources/identity_reads/statestore",
				"/attention_sources/identity_reads/linear",
			]),
		});
		expect(() => assertEpicPage(result)).not.toThrow();
	});
});
