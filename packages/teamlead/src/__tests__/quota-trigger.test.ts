import { describe, expect, it } from "vitest";
import {
	aggregateQuotaTrigger,
	canonicalizeModels,
} from "../account-heal/quota-trigger.js";

describe("canonical model trigger aggregation", () => {
	it("normalizes, deduplicates, sorts, and rejects an empty model set", () => {
		expect(
			canonicalizeModels([" Sonnet   5 ", "Fable 5", "Sonnet 5", ""]),
		).toEqual(["Fable 5", "Sonnet 5"]);
		expect(canonicalizeModels([" ", "\n"])).toBeNull();
	});

	it("aggregates the same model from many panes once", () => {
		expect(
			aggregateQuotaTrigger({
				account: null,
				modelDetections: [
					{ paneKey: "socket:%2:200", model: "Fable 5" },
					{ paneKey: "socket:%1:100", model: "Fable 5" },
				],
			}),
		).toEqual({ kind: "model", models: ["Fable 5"] });
	});

	it("combines distinct pane models into one canonical switch cause independent of traversal order", () => {
		const first = aggregateQuotaTrigger({
			account: null,
			modelDetections: [
				{ paneKey: "socket:%2:200", model: "Sonnet 5" },
				{ paneKey: "socket:%1:100", model: "Fable 5" },
			],
		});
		const reverse = aggregateQuotaTrigger({
			account: null,
			modelDetections: [
				{ paneKey: "socket:%1:100", model: "Fable 5" },
				{ paneKey: "socket:%2:200", model: "Sonnet 5" },
			],
		});
		expect(first).toEqual({
			kind: "model",
			models: ["Fable 5", "Sonnet 5"],
		});
		expect(reverse).toEqual(first);
	});

	it("lets an account-level trigger dominate and discards the whole model set", () => {
		expect(
			aggregateQuotaTrigger({
				account: {
					kind: "account",
					scope: "weekly",
					resetAt: "2026-07-21T14:00:00.000Z",
				},
				modelDetections: [
					{ paneKey: "socket:%1:100", model: "Fable 5" },
					{ paneKey: "socket:%1:100", model: "Sonnet 5" },
				],
			}),
		).toEqual({
			kind: "account",
			scope: "weekly",
			resetAt: "2026-07-21T14:00:00.000Z",
		});
	});
});
