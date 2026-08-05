import { describe, expect, it } from "vitest";
import { buildWorkflowRunSnapshotV1 } from "../workflow-run-snapshot.js";
import {
	computeSubmissionExpiry,
	credentialWindowForNode,
} from "../workflow-submission-expiry.js";
import { loadBundledWorkflowSeeds } from "../workflow-template.js";

describe("workflow submission expiry", () => {
	it("reserves the configured window and clamps it to the absolute deadline", () => {
		const now = Date.parse("2026-07-27T12:00:00.000Z");
		expect(computeSubmissionExpiry(now, 180, now + 24 * 60 * 60_000)).toBe(
			Date.parse("2026-07-27T15:00:00.000Z"),
		);
		expect(computeSubmissionExpiry(now, 2_000, now + 24 * 60 * 60_000)).toBe(
			Date.parse("2026-07-28T12:00:00.000Z"),
		);
	});

	it.each([0, -1, 1.5, Number.NaN])(
		"rejects an invalid configured window (%s)",
		(windowMinutes) => {
			expect(() =>
				computeSubmissionExpiry(Date.now(), windowMinutes, Date.now() + 1),
			).toThrow(/positive integer/);
		},
	);

	it("uses the live QA default only for verdict-topology decision nodes", () => {
		const manifest = structuredClone(
			loadBundledWorkflowSeeds().find(
				(candidate) => candidate.templateId === "tpl_eng_heavy",
			)!.manifest,
		);
		const qa = manifest.nodes.find((node) => node.id === "qa");
		if (!qa) throw new Error("QA node missing");
		delete qa.submissionWindowMinutes;
		const snapshot = buildWorkflowRunSnapshotV1({
			template: { id: "ttl-default-fixture", revision: 1 },
			manifest,
		});
		const now = new Date("2026-08-05T00:00:00.000Z");

		expect(credentialWindowForNode(snapshot, "qa", now)).toEqual({
			expiresAt: "2026-08-05T06:00:00.000Z",
			absoluteDeadlineAt: "2026-08-06T00:00:00.000Z",
		});
		expect(credentialWindowForNode(snapshot, "design", now)).toEqual({
			expiresAt: "2026-08-05T01:00:00.000Z",
			absoluteDeadlineAt: "2026-08-06T00:00:00.000Z",
		});
	});

	it("keeps an explicit manifest window ahead of the live registry default", () => {
		const manifest = loadBundledWorkflowSeeds().find(
			(candidate) => candidate.templateId === "tpl_eng_heavy",
		)!.manifest;
		const snapshot = buildWorkflowRunSnapshotV1({
			template: { id: "ttl-explicit-fixture", revision: 1 },
			manifest,
		});

		expect(
			credentialWindowForNode(
				snapshot,
				"qa",
				new Date("2026-08-05T00:00:00.000Z"),
			),
		).toEqual({
			expiresAt: "2026-08-05T03:00:00.000Z",
			absoluteDeadlineAt: "2026-08-06T00:00:00.000Z",
		});
	});
});
