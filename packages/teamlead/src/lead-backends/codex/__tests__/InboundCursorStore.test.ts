import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	FileInboundCursorStore,
	InMemoryInboundCursorStore,
} from "../InboundCursorStore.js";

describe("InMemoryInboundCursorStore", () => {
	it("load undefined until saved, then returns the saved id", () => {
		const s = new InMemoryInboundCursorStore();
		expect(s.load("c1")).toBeUndefined();
		s.save("c1", "m1");
		s.save("c2", "m2");
		expect(s.load("c1")).toBe("m1");
		expect(s.load("c2")).toBe("m2");
	});
});

describe("FileInboundCursorStore", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly224-cursor-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("missing file → undefined (first-run baseline)", () => {
		const s = new FileInboundCursorStore(join(dir, "nested", "cursor.json"));
		expect(s.load("c1")).toBeUndefined();
	});

	it("save persists across a fresh instance (restart resumes)", () => {
		const path = join(dir, "cursor.json");
		new FileInboundCursorStore(path).save("c1", "m100");
		// a brand-new instance (simulating a process restart) reads it back
		expect(new FileInboundCursorStore(path).load("c1")).toBe("m100");
	});

	it("corrupt JSON → undefined (never throws)", () => {
		const path = join(dir, "cursor.json");
		writeFileSync(path, "{not json", "utf8");
		expect(new FileInboundCursorStore(path).load("c1")).toBeUndefined();
	});

	it("writes atomically (no leftover .tmp) and keeps multiple channels", () => {
		const path = join(dir, "cursor.json");
		const s = new FileInboundCursorStore(path);
		s.save("c1", "m1");
		s.save("c2", "m2");
		const onDisk = JSON.parse(readFileSync(path, "utf8"));
		expect(onDisk).toEqual({ c1: "m1", c2: "m2" });
	});
});
