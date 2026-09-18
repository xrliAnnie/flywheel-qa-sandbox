import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OperationStore } from "./operation-store.js";

const roots: string[] = [];
function workspace() {
	const root = mkdtempSync(join(tmpdir(), "raya-operations-"));
	roots.push(root);
	return root;
}
const digest = createHash("sha256").update("input").digest("hex");
const operation = {
	operationId: "summary:../round/一",
	inputDigest: digest,
	kind: "summary",
	stage: "prepared",
	sourceRefs: ["summary:round-1"],
	material: { head: "abc", unknown: true },
};
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("OperationStore", () => {
	it("reopens hashed identities and refuses stale revisions without losing material", () => {
		const root = workspace();
		const store = new OperationStore(root);
		const first = store.commit(operation, 0);
		expect(first).toMatchObject({ schemaVersion: 2, revision: 1 });
		const reopened = new OperationStore(root);
		expect(reopened.read(operation.operationId)).toEqual(first);
		const second = reopened.commit({ ...operation, stage: "unknown" }, 1);
		expect(second.revision).toBe(2);
		expect(() => store.commit({ ...operation, stage: "complete" }, 1)).toThrow(
			/revision conflict/,
		);
		expect(store.read(operation.operationId)).toEqual(second);
	});
	it("freezes input binding across revisions", () => {
		const store = new OperationStore(workspace());
		store.commit(operation, 0);
		expect(() =>
			store.commit({ ...operation, inputDigest: "a".repeat(64) }, 1),
		).toThrow(/binding/);
		expect(() => store.commit({ ...operation, kind: "report" }, 1)).toThrow(
			/binding/,
		);
	});
	it("preserves corrupt state instead of returning an empty operation", () => {
		const root = workspace();
		const store = new OperationStore(root);
		store.commit(operation, 0);
		const file = join(
			root,
			"state/cos/operations",
			`${createHash("sha256").update(operation.operationId).digest("hex")}.json`,
		);
		writeFileSync(file, "{broken");
		expect(() => store.read(operation.operationId)).toThrow();
		expect(() => store.commit(operation, 0)).toThrow();
		expect(readFileSync(file, "utf8")).toBe("{broken");
	});
	it("does not steal or remove a leftover lock", () => {
		const root = workspace();
		const store = new OperationStore(root);
		const lock = join(root, "state/cos/operations/.lock");
		writeFileSync(lock, JSON.stringify({ owner: "previous-owner" }));
		expect(() => store.commit(operation, 0)).toThrow(/locked/);
		expect(JSON.parse(readFileSync(lock, "utf8"))).toEqual({
			owner: "previous-owner",
		});
	});
	it("rejects symlinked state directories and operation files", () => {
		const root = workspace();
		const outside = workspace();
		symlinkSync(outside, join(root, "state"));
		expect(() => new OperationStore(root)).toThrow(/symlink/);
		rmSync(join(root, "state"));
		const store = new OperationStore(root);
		const target = join(outside, "payload");
		writeFileSync(target, "unchanged");
		symlinkSync(
			target,
			join(
				root,
				"state/cos/operations",
				`${createHash("sha256").update(operation.operationId).digest("hex")}.json`,
			),
		);
		expect(() => store.read(operation.operationId)).toThrow();
		expect(() => store.commit(operation, 0)).toThrow();
		expect(readFileSync(target, "utf8")).toBe("unchanged");
	});
	it("rejects a replaced state parent after construction", () => {
		const root = workspace();
		const outside = workspace();
		const store = new OperationStore(root);
		rmSync(join(root, "state"), { recursive: true });
		mkdirSync(join(outside, "cos/operations"), { recursive: true });
		symlinkSync(outside, join(root, "state"));
		expect(() => store.commit(operation, 0)).toThrow(/symlink/);
	});
});
