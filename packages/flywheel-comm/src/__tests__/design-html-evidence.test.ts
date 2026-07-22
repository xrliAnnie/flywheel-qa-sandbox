import {
	findDesignHtmlPaths,
	parseDesignHtmlEvidence,
} from "flywheel-comm/design-html-evidence";
import { describe, expect, it } from "vitest";

describe("founder design HTML evidence", () => {
	it("accepts HTML only inside this issue's doc folder", () => {
		expect(
			findDesignHtmlPaths(
				[
					"engineering/doc/FLY-1404-design-html/design.html",
					"engineering/doc/FLY-1404/design.HTML",
					"engineering/doc/FLY-14040-design-html/wrong.html",
					"engineering/doc/FLY-999-design-html/wrong.html",
					"site/design.html",
				],
				"FLY-1404",
			),
		).toEqual([
			"engineering/doc/FLY-1404-design-html/design.html",
			"engineering/doc/FLY-1404/design.HTML",
		]);
	});

	it("parses a complete versioned attestation", () => {
		expect(
			parseDesignHtmlEvidence({
				version: 1,
				issueIdentifier: "FLY-1404",
				paths: ["engineering/doc/FLY-1404-design-html/design.html"],
				headSha: "a".repeat(40),
			}),
		).toEqual({
			ok: true,
			issueIdentifier: "FLY-1404",
			paths: ["engineering/doc/FLY-1404-design-html/design.html"],
			headSha: "a".repeat(40),
		});
	});

	it.each([
		null,
		[],
		{},
		{
			version: 1,
			issueIdentifier: "FLY-1404",
			paths: ["engineering/doc/FLY-1404-x/design.html", 7],
			headSha: "a".repeat(40),
		},
		{
			version: 1,
			issueIdentifier: "FLY-1404",
			paths: ["engineering/doc/FLY-1404-x/design.html"],
			headSha: "A".repeat(40),
		},
	])("rejects malformed attestations without throwing (%j)", (value) => {
		expect(parseDesignHtmlEvidence(value)).toMatchObject({ ok: false });
	});

	it("rejects malformed path-list boundaries wholesale", () => {
		expect(
			findDesignHtmlPaths(
				["engineering/doc/FLY-1404-x/design.html", 7],
				"FLY-1404",
			),
		).toEqual([]);
		expect(findDesignHtmlPaths([], "[")).toEqual([]);
	});
});
