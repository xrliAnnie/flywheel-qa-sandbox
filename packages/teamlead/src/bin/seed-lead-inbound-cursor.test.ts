import {
	lstatSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedLeadInboundCursor } from "./seed-lead-inbound-cursor.js";

const roots: string[] = [];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "seed-lead-cursor-"));
	roots.push(root);
	return { root, path: join(root, "inbound-cursor.json") };
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

const seed = {
	schemaVersion: 1 as const,
	migrationId: "fly-2445-test",
	expectedBeforeSha256: null,
	writerStopped: true,
	unresolved: [] as string[],
	channels: [
		{
			channelId: "12345678901234567",
			lastConfirmedMessageId: "22345678901234567",
		},
		{
			channelId: "32345678901234567",
			lastConfirmedMessageId: "42345678901234567",
		},
	],
};

describe("seedLeadInboundCursor", () => {
	it("writes the exact owner-only standard cursor and is idempotent", () => {
		const { path } = fixture();
		const first = seedLeadInboundCursor({ path, seed });
		const bytes = readFileSync(path, "utf8");
		expect(first).toMatchObject({
			status: "seeded",
			migrationId: "fly-2445-test",
		});
		expect(JSON.parse(bytes)).toEqual({
			"12345678901234567": "22345678901234567",
			"32345678901234567": "42345678901234567",
		});
		expect(lstatSync(path).mode & 0o777).toBe(0o600);
		expect(seedLeadInboundCursor({ path, seed })).toMatchObject({
			status: "already_seeded",
		});
		expect(readFileSync(path, "utf8")).toBe(bytes);
	});

	it("never moves a cursor backwards after the new owner advanced", () => {
		const { path } = fixture();
		writeFileSync(
			path,
			JSON.stringify({
				"12345678901234567": "22345678901234568",
				"32345678901234567": "42345678901234569",
			}),
			{ mode: 0o600 },
		);
		expect(seedLeadInboundCursor({ path, seed })).toMatchObject({
			status: "already_advanced",
		});
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			"12345678901234567": "22345678901234568",
			"32345678901234567": "42345678901234569",
		});
	});

	it.each([
		[{ ...seed, writerStopped: false }, "writer"],
		[{ ...seed, unresolved: ["unknown-side-effect"] }, "unresolved"],
		[
			{
				...seed,
				channels: [
					{ channelId: "1", lastConfirmedMessageId: "90071992547409930" },
				],
			},
			"snowflake",
		],
	])("fails closed for invalid migration evidence", (candidate, message) => {
		const { path } = fixture();
		expect(() => seedLeadInboundCursor({ path, seed: candidate })).toThrow(
			message,
		);
	});

	it("refuses a symlink target", () => {
		const { root, path } = fixture();
		const other = join(root, "other.json");
		writeFileSync(other, "{}", { mode: 0o600 });
		symlinkSync(other, path);
		expect(() => seedLeadInboundCursor({ path, seed })).toThrow("symlink");
	});
});
