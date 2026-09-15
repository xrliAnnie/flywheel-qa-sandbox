import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openVoiceCommDb } from "../voice-comm-scope.js";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "fly2563-voice-comm-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});
function count() {
	return readdirSync(
		process.platform === "linux" ? "/proc/self/fd" : "/dev/fd",
	).filter((name) => /^\d+$/.test(name)).length;
}
it("holds no owned fd between gate calls or across a post-write wait", async () => {
	const path = join(root, "comm.db");
	const owner = new CommDB(path);
	const id = owner.insertQuestion("exec", "lead", "gate", {
		checkpoint: "approve_to_ship",
	});
	owner.close();
	const baseline = count();
	const db = openVoiceCommDb(path);
	try {
		expect(count()).toBeLessThanOrEqual(baseline);
		expect(db.getMessageById(id)).toMatchObject({
			checkpoint: "approve_to_ship",
		});
		expect(count()).toBeLessThanOrEqual(baseline);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(db.getResponse(id)).toBeUndefined();
		expect(count()).toBeLessThanOrEqual(baseline);
		const other = new CommDB(path);
		other.insertResponse(id, "lead", "answer");
		other.close();
		expect(db.getResponse(id)).toMatchObject({ content: "answer" });
		expect(count()).toBeLessThanOrEqual(baseline);
	} finally {
		if (db instanceof CommDB) db.close();
	}
});
it("rejects an unavailable database at factory admission", () => {
	expect(() => openVoiceCommDb(join(root, "missing.db"))).toThrow();
});
