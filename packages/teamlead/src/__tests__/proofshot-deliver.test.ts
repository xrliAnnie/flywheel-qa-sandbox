/**
 * GEO-151 A6 — proofshot-deliver (Lead instruction formatter) tests.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LeadEventEnvelope } from "../bridge/lead-runtime.js";
import { formatArtifactDelivery } from "../bridge/proofshot-deliver.js";

function envelope(
	payload: Partial<LeadEventEnvelope["event"]> = {},
): LeadEventEnvelope {
	return {
		seq: 42,
		event: {
			event_type: "artifact_delivery",
			execution_id: "exec-1",
			issue_id: "issue-1",
			issue_identifier: "GEO-151",
			project_name: "GeoForge3D",
			kind: "ui",
			paths: [],
			chat_thread_id: "1234567890",
			dedup_key: "exec-1|test|ui",
			attempt: 1,
			size_cap_bytes: 25 * 1024 * 1024,
			file_count_cap: 10,
			oversize_fallback_text: "📎 See GitHub PR for oversized files.",
			...payload,
		},
		sessionKey: "flywheel:GEO-151",
		leadId: "product-lead",
		timestamp: "2026-05-21T00:00:00Z",
	};
}

describe("formatArtifactDelivery (GEO-151 A6)", () => {
	let tmpDir: string;
	let smallPng: string;
	let bigPng: string;

	beforeEach(() => {
		tmpDir = join(tmpdir(), `psd-${Date.now()}-${Math.random()}`);
		mkdirSync(tmpDir, { recursive: true });
		smallPng = join(tmpDir, "step-00.png");
		writeFileSync(smallPng, Buffer.alloc(100));
		bigPng = join(tmpDir, "huge.webm");
		writeFileSync(bigPng, Buffer.alloc(30 * 1024 * 1024));
	});

	afterEach(() => {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {}
	});

	it("renders Discord MCP reply call with chat_id + files array", () => {
		const md = formatArtifactDelivery(envelope({ paths: [smallPng] }));
		expect(md).toContain("mcp__plugin_discord_discord__reply");
		expect(md).toContain('chat_id: "1234567890"');
		expect(md).toContain(`"${smallPng}"`);
		expect(md).toContain("[Event #42]");
		expect(md).toContain("artifact_delivery");
		expect(md).toContain("Issue: GEO-151");
		expect(md).toContain("Dedup-Key: exec-1|test|ui");
		expect(md).toContain("Attempt: 1");
	});

	it("UI vs 3D label in body", () => {
		const ui = formatArtifactDelivery(
			envelope({ kind: "ui", paths: [smallPng] }),
		);
		expect(ui).toContain("UI capture");
		const threeD = formatArtifactDelivery(
			envelope({ kind: "3d", paths: [smallPng] }),
		);
		expect(threeD).toContain("3D capture");
	});

	it("oversized files (> size_cap_bytes) listed separately, omitted from files[]", () => {
		const md = formatArtifactDelivery(
			envelope({
				paths: [smallPng, bigPng],
				size_cap_bytes: 25 * 1024 * 1024,
				oversize_fallback_text: "see PR for big files",
			}),
		);
		// small one in files array
		expect(md).toContain(`"${smallPng}"`);
		// big one NOT in files array but listed in body
		expect(md).not.toContain(
			`files: [${JSON.stringify([smallPng, bigPng]).slice(1, -1)}]`,
		);
		expect(md).toContain("huge.webm");
		expect(md).toMatch(/exceed.*cap/);
	});

	it("> file_count_cap warns about batch sending", () => {
		// 11 small files exceeds default cap of 10
		const paths: string[] = [];
		for (let i = 0; i < 11; i++) {
			const p = join(tmpDir, `s-${i}.png`);
			writeFileSync(p, Buffer.alloc(10));
			paths.push(p);
		}
		const md = formatArtifactDelivery(envelope({ paths }));
		expect(md).toMatch(/exceed Discord's 10-files-per-message cap/);
		expect(md).toMatch(/batches of 10/);
	});

	it("missing chat_thread_id renders sentinel string (Lead can detect)", () => {
		const md = formatArtifactDelivery(
			envelope({ chat_thread_id: undefined, paths: [smallPng] }),
		);
		expect(md).toContain("no chat_thread_id resolved");
	});

	it("missing files (empty paths) renders with 0 attachable + no files[] entries", () => {
		const md = formatArtifactDelivery(envelope({ paths: [] }));
		expect(md).toContain("0 个文件");
		expect(md).toContain("files: []");
	});

	it("file with statSync failure (deleted between manifest + delivery) treated as 0 bytes", () => {
		const gonePath = join(tmpDir, "gone.png");
		// not creating the file → statSync throws
		const md = formatArtifactDelivery(envelope({ paths: [gonePath] }));
		// 0 bytes is not over cap so it should still appear in files[]
		expect(md).toContain(`"${gonePath}"`);
	});
});
