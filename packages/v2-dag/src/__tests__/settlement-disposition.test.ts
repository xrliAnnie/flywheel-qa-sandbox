import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	CLASSIFIED_MAILBOX_KINDS,
	settlementDisposition,
} from "../settlement-disposition.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * FLY-1547 §2.3 roll-call: every literal mailbox kind appended anywhere in this
 * package must be classified. A new append site with an unclassified kind
 * turns this red instead of wedging production mail as "unknown".
 */
function appendedKinds(): Set<string> {
	const kinds = new Set<string>();
	for (const file of readdirSync(SRC)) {
		if (!file.endsWith(".ts")) continue;
		const text = readFileSync(join(SRC, file), "utf8");
		// Each appendMailboxTx / appendLifecycleTx call carries a `kind:` line
		// within its argument object. Capture literal kinds and the
		// `${input.kind}_repeat` template family.
		const calls = text.split(/append(?:Mailbox|Lifecycle)Tx\(/).slice(1);
		for (const call of calls) {
			const head = call.slice(0, 800);
			for (const match of head.matchAll(/kind:\s*"([a-z_]+)"/g)) {
				kinds.add(match[1] as string);
			}
			for (const match of head.matchAll(
				/kind:\s*`\$\{input\.kind\}(_repeat)`/g,
			)) {
				// The template expands over the closed input.kind union declared in
				// dispatch.ts; resolve it from the union type literally.
				void match;
				const union = readFileSync(join(SRC, "dispatch.ts"), "utf8").match(
					/kind: ("task_contract_invalid" \| "task_dispatch_invalid")/,
				);
				expect(union).not.toBeNull();
				kinds.add("task_contract_invalid_repeat");
				kinds.add("task_dispatch_invalid_repeat");
			}
		}
	}
	return kinds;
}

describe("settlement disposition", () => {
	it("classifies every mailbox kind appended by this package", () => {
		const appended = appendedKinds();
		expect(appended.size).toBeGreaterThan(5);
		for (const kind of appended) {
			// Parametric passthrough sites (outbox input.kind) resolve to the
			// lifecycle kinds asserted individually below.
			if (kind === "input") continue;
			expect(
				CLASSIFIED_MAILBOX_KINDS.has(kind),
				`mailbox kind "${kind}" is appended but not classified in settlement-disposition.ts`,
			).toBe(true);
		}
	});

	it("classifies the host-side enqueue vocabulary", () => {
		for (const kind of [
			"runner_ask",
			"instruction",
			"ask_response",
			"task_assignment",
		]) {
			expect(CLASSIFIED_MAILBOX_KINDS.has(kind)).toBe(true);
		}
	});

	it("splits runner_ask by validated ask_kind", () => {
		const payload = (askKind: unknown) =>
			JSON.stringify({ v: 1, ask_kind: askKind, uid: "u", body: "b" });
		expect(
			settlementDisposition({
				kind: "runner_ask",
				payload: payload("progress"),
			}),
		).toEqual({ chapter: "fyi" });
		expect(
			settlementDisposition({ kind: "runner_ask", payload: payload("ask") }),
		).toEqual({ chapter: "actionable" });
		expect(
			settlementDisposition({
				kind: "runner_ask",
				payload: payload("blocked"),
			}),
		).toEqual({ chapter: "actionable" });
	});

	it("fails loud on malformed runner_ask payloads", () => {
		expect(
			settlementDisposition({ kind: "runner_ask", payload: "not json" })
				.chapter,
		).toBe("unknown");
		expect(
			settlementDisposition({
				kind: "runner_ask",
				payload: JSON.stringify({ ask_kind: "urgent" }),
			}).chapter,
		).toBe("unknown");
	});

	it("fails loud on unclassified kinds", () => {
		const result = settlementDisposition({
			kind: "brand_new_kind",
			payload: "{}",
		});
		expect(result.chapter).toBe("unknown");
	});

	it("keeps task_assignment out of any auto-ack path", () => {
		expect(
			settlementDisposition({ kind: "task_assignment", payload: "{}" }),
		).toEqual({ chapter: "actionable" });
	});
});
