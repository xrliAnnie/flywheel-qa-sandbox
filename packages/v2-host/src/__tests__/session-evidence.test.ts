import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	FileSessionEvidenceProbe,
	publishSessionProof,
} from "../session-evidence.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("session evidence", () => {
	it("hashes the full DAG session ref while retaining exact identity in the proof", () => {
		const root = mkdtempSync(join(tmpdir(), "flywheel-v2-proof-"));
		roots.push(root);
		const sessionId = "v2dag:attempt-1:1:activation-1";
		const path = publishSessionProof({
			root,
			sessionId,
			pid: 1234,
			pidStart: "test-start",
		});
		expect(path).toBe(
			join(
				root,
				`${createHash("sha256").update(sessionId).digest("hex")}.json`,
			),
		);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(new FileSessionEvidenceProbe(root).sessionOwner(sessionId)).toEqual({
			pid: 1234,
			pidStart: "test-start",
		});
	});
});
