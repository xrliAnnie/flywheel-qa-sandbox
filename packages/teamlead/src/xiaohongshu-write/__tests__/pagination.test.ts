import { afterEach, expect, it } from "vitest";
import { XhsMessagePagination } from "../pagination.js";
import { fixture } from "./store-fixture.js";

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.close();
});
const channel = "100000000000000001",
	base = 200000000000000000n;
const id = (n: number) => String(base + BigInt(n));
function setup(count: number) {
	const f = fixture();
	fixtures.push(f);
	const ids = Array.from({ length: count }, (_, n) => id(n + 1)).reverse();
	const handled: string[] = [];
	const source = {
		async page(before: string | null) {
			return ids
				.filter((value) => before === null || BigInt(value) < BigInt(before))
				.slice(0, 100);
		},
	};
	const process = async (value: string) => {
		handled.push(value);
	};
	return { f, source, handled, process };
}
it("bounds each scan to five pages and resumes the same backlog after restart without skipping", async () => {
	const t = setup(600);
	const first = new XhsMessagePagination(
		t.f.store,
		channel,
		id(0),
		t.source.page,
		t.process,
	);
	expect(await first.poll()).toEqual({
		scanned: 500,
		processed: 0,
		pending: 500,
	});
	expect(t.handled).toEqual([]);
	expect(t.f.store.observerState(channel, id(0)).cursor).toBe(id(0));
	t.f.restart();
	const resumed = new XhsMessagePagination(
		t.f.store,
		channel,
		id(0),
		t.source.page,
		t.process,
	);
	await resumed.poll();
	await resumed.poll();
	expect(t.handled).toEqual(Array.from({ length: 600 }, (_, n) => id(n + 1)));
	expect(t.f.store.observerState(channel, id(0)).cursor).toBe(id(600));
}, 30_000);
it("preserves the scan position after a page failure", async () => {
	const t = setup(250);
	let calls = 0;
	const page = async (before: string | null) => {
		if (++calls === 2) throw Error("429");
		return t.source.page(before);
	};
	const scanner = new XhsMessagePagination(
		t.f.store,
		channel,
		id(0),
		page,
		t.process,
	);
	await expect(scanner.poll()).rejects.toThrow("429");
	expect(t.handled).toEqual([]);
	expect(t.f.store.observerState(channel, id(0)).before).toBe(id(151));
	await scanner.poll();
	expect(t.handled).toHaveLength(250);
});
it("advances only through processed messages when a handler fails", async () => {
	const t = setup(5);
	let fail = true;
	const handler = async (value: string) => {
		if (value === id(3) && fail) throw Error("unavailable");
		await t.process(value);
	};
	const scanner = new XhsMessagePagination(
		t.f.store,
		channel,
		id(0),
		t.source.page,
		handler,
	);
	await expect(scanner.poll()).rejects.toThrow("unavailable");
	expect(t.f.store.observerState(channel, id(0)).cursor).toBe(id(2));
	fail = false;
	await scanner.poll();
	expect(t.handled).toEqual([id(1), id(2), id(3), id(4), id(5)]);
});
it("rejects unordered or repeated-page results without moving the cursor", async () => {
	const t = setup(0);
	const scanner = new XhsMessagePagination(
		t.f.store,
		channel,
		id(0),
		async () => [id(1), id(2)],
		t.process,
	);
	await expect(scanner.poll()).rejects.toThrow("observer_page_invalid");
	expect(t.f.store.observerState(channel, id(0)).cursor).toBe(id(0));
});
