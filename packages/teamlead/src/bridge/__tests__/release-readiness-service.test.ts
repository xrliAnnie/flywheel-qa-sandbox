import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import { readReadinessPolicy } from "../release-readiness/policy.js";
import {
	ReleaseReadinessService,
	scanReadinessOutbox,
} from "../release-readiness/service.js";

const at = "2026-09-11T12:00:00.000Z";
const sha = "a".repeat(40);
const gap = {
	eventIdHint: null,
	kind: "deploy_failed",
	severity: "severe",
	projectName: "flywheel",
	leadId: "updater",
	sourceCommit: sha,
	baseVersion: "1.56.0",
	observedAt: at,
	reason: "shell_preflight",
};

describe("readiness outbox scan", () => {
	it("requires published message evidence and rejects nonfiles and invalid attribution", () => {
		const root = mkdtempSync(join(tmpdir(), "readiness-validation-"));
		try {
			mkdirSync(join(root, "gaps"));
			mkdirSync(join(root, "publications"));
			const publication = {
				publicationId: "rp-test",
				day: "2026-09-11",
				subjectCommit: sha,
				baseVersion: "1.56.0",
				status: "published",
				channelId: "123",
				messageId: "456",
				intentAt: at,
				publishedAt: at,
				lastScanOkAt: at,
			};
			writeFileSync(
				join(root, "publications", "valid.json"),
				JSON.stringify(publication),
			);
			writeFileSync(
				join(root, "publications", "missing-message.json"),
				JSON.stringify({ ...publication, messageId: null }),
			);
			writeFileSync(
				join(root, "gaps", "invalid-sha.json"),
				JSON.stringify({ ...gap, sourceCommit: "main" }),
			);
			symlinkSync(
				join(root, "publications", "valid.json"),
				join(root, "gaps", "link.json"),
			);
			mkdirSync(join(root, "gaps", "unexpected"));
			const scan = scanReadinessOutbox(root);
			expect(scan.counts).toMatchObject({
				gapsPending: 3,
				gapsInvalid: 3,
				publicationsPending: 2,
				publicationsInvalid: 1,
			});
			expect(scan.publications).toHaveLength(1);
			expect(scan.publications[0]?.value).not.toHaveProperty("lastScanOkAt");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("rechecks the filesystem on every evaluation and stores the resulting reason", async () => {
		const root = mkdtempSync(join(tmpdir(), "readiness-service-"));
		const store = await StateStore.create(":memory:");
		try {
			mkdirSync(join(root, "gaps"));
			mkdirSync(join(root, "publications"));
			const deployedShaPath = join(root, "deployed-sha");
			writeFileSync(deployedShaPath, sha);
			const subject = { baseVersion: "1.56.0", sourceCommit: sha };
			store.upsertReleaseDeploymentAnchor(
				{
					sourceCommit: sha,
					episodeFrom: "2026-08-22T12:00:00.000Z",
					episodeTo: null,
				},
				at,
			);
			const service = new ReleaseReadinessService(store, {
				outboxRoot: root,
				deployedShaPath,
				policy: readReadinessPolicy({}),
			});
			expect(service.collect(subject, at).outbox.gapsPending).toBe(0);
			writeFileSync(join(root, "gaps", "new.json"), JSON.stringify(gap));
			const verdict = service.evaluate(subject, at);
			expect(verdict.state).toBe("unknown");
			expect(verdict.reasons.map((r) => r.code)).toContain("outbox_pending");
			expect(verdict.evidence.window.from).toBe("2026-08-28T12:00:00.000Z");
			expect(store.getReleaseReadinessVerdicts(sha)[0]).toEqual(verdict);
			writeFileSync(deployedShaPath, "b".repeat(40));
			expect(service.collect(subject, at).localDeployedSha).toBe(
				"b".repeat(40),
			);
		} finally {
			store.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("counts pending and invalid files synchronously and fails closed on unreadable directories", () => {
		const root = mkdtempSync(join(tmpdir(), "readiness-outbox-"));
		try {
			expect(scanReadinessOutbox(root).counts.readErrors).toHaveLength(2);
			mkdirSync(join(root, "gaps", "landed"), { recursive: true });
			mkdirSync(join(root, "publications"));
			writeFileSync(join(root, "gaps", "gap.intent.json"), JSON.stringify(gap));
			writeFileSync(join(root, "gaps", "broken.json"), "{");
			writeFileSync(join(root, "gaps", "landed", "ignored.json"), "{");
			writeFileSync(
				join(root, "publications", "invalid.json"),
				JSON.stringify({ status: "published" }),
			);
			const scan = scanReadinessOutbox(root);
			expect(scan.counts).toMatchObject({
				gapsPending: 2,
				gapsInvalid: 1,
				publicationsPending: 1,
				publicationsInvalid: 1,
				readErrors: [],
			});
			expect(scan.gaps[0]?.value).toEqual(gap);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
