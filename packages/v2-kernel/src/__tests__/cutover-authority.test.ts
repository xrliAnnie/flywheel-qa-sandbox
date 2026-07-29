import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	armCutoverAuthority,
	publishLiveCutoverAuthority,
	publishRollbackCutoverAuthority,
	readCutoverAuthority,
	requireLegacyWriterAllowed,
	requireLegacyWriterAllowedFromEnvironment,
	seedPreCutoverAuthority,
	writeRollbackReceipt,
} from "../cutover-authority.js";

describe("machine cutover authority", () => {
	let dir: string | undefined;

	function paths() {
		dir = mkdtempSync(join(tmpdir(), "flywheel-v2-authority-"));
		const stateDir = join(dir, ".flywheel");
		mkdirSync(stateDir, { recursive: true });
		return {
			authorityPath: join(stateDir, "v2-cutover-authority.json"),
			armedPath: join(stateDir, "v2-cutover-armed"),
			rollbackReceiptPath: join(stateDir, "rollback-receipt.json"),
		};
	}

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("keeps legacy behavior allowed before arming and rejects it after cutover", () => {
		const target = paths();
		expect(
			readCutoverAuthority({
				authorityPath: target.authorityPath,
				armedPath: target.armedPath,
			}),
		).toEqual({ mode: "legacy" });
		seedPreCutoverAuthority({
			...target,
			windowId: "window-a",
			epoch: 7,
			nowIso: "2026-07-28T00:00:00.000Z",
		});
		expect(requireLegacyWriterAllowed(target)).toEqual({ mode: "legacy" });

		armCutoverAuthority({
			...target,
			windowId: "window-a",
			epoch: 7,
			nowIso: "2026-07-28T00:01:00.000Z",
		});
		expect(() => requireLegacyWriterAllowed(target)).toThrow(
			/legacy writer is frozen.*window-a/i,
		);
		expect(
			readCutoverAuthority({
				...target,
				expectedWindowId: "window-a",
				expectedEpoch: 7,
			}),
		).toMatchObject({
			mode: "armed",
			authority: {
				window_id: "window-a",
				epoch: 7,
				state: "cutover",
				revision: 1,
			},
		});
	});

	it("replays an interrupted arm transition without reopening legacy writers", () => {
		const target = paths();
		seedPreCutoverAuthority({
			...target,
			windowId: "window-arm-replay",
			epoch: 9,
			nowIso: "2026-07-28T00:00:00.000Z",
		});
		const preBytes = readFileSync(target.authorityPath);
		armCutoverAuthority({
			...target,
			windowId: "window-arm-replay",
			epoch: 9,
			nowIso: "2026-07-28T00:01:00.000Z",
		});
		const cutoverBytes = readFileSync(target.authorityPath);
		const cutoverMarkerBytes = readFileSync(target.armedPath);

		writeFileSync(target.authorityPath, preBytes);
		writeFileSync(target.armedPath, cutoverMarkerBytes);
		writeFileSync(
			`${target.armedPath}.transition`,
			`${JSON.stringify({
				v: 1,
				window_id: "window-arm-replay",
				epoch: 9,
				from_state: "pre",
				from_revision: 0,
				from_authority_digest: createHash("sha256")
					.update(preBytes)
					.digest("hex"),
				to_authority: JSON.parse(cutoverBytes.toString("utf8")),
				to_marker: JSON.parse(cutoverMarkerBytes.toString("utf8")),
			})}\n`,
		);

		expect(() => readCutoverAuthority(target)).toThrow(
			/fail closed.*stale authority/i,
		);
		expect(
			armCutoverAuthority({
				...target,
				windowId: "window-arm-replay",
				epoch: 9,
				nowIso: "2026-07-28T00:02:00.000Z",
			}),
		).toMatchObject({ state: "cutover", revision: 1 });
		expect(readCutoverAuthority(target)).toMatchObject({
			mode: "armed",
			authority: { state: "cutover", revision: 1 },
		});
		expect(() => readFileSync(`${target.armedPath}.transition`)).toThrow();
	});

	it("replays an interrupted live publication from its durable transition", () => {
		const target = paths();
		seedPreCutoverAuthority({
			...target,
			windowId: "window-live-replay",
			epoch: 10,
			nowIso: "2026-07-28T00:00:00.000Z",
		});
		armCutoverAuthority({
			...target,
			windowId: "window-live-replay",
			epoch: 10,
			nowIso: "2026-07-28T00:01:00.000Z",
		});
		const cutoverBytes = readFileSync(target.authorityPath);
		const cutoverMarkerBytes = readFileSync(target.armedPath);
		publishLiveCutoverAuthority({
			...target,
			windowId: "window-live-replay",
			epoch: 10,
			nowIso: "2026-07-28T00:02:00.000Z",
		});
		const liveBytes = readFileSync(target.authorityPath);
		const liveMarkerBytes = readFileSync(target.armedPath);

		writeFileSync(target.authorityPath, liveBytes);
		writeFileSync(target.armedPath, cutoverMarkerBytes);
		writeFileSync(
			`${target.armedPath}.transition`,
			`${JSON.stringify({
				v: 1,
				window_id: "window-live-replay",
				epoch: 10,
				from_state: "cutover",
				from_revision: 1,
				from_authority_digest: createHash("sha256")
					.update(cutoverBytes)
					.digest("hex"),
				to_authority: JSON.parse(liveBytes.toString("utf8")),
				to_marker: JSON.parse(liveMarkerBytes.toString("utf8")),
			})}\n`,
		);

		expect(() => readCutoverAuthority(target)).toThrow(
			/fail closed.*stale authority/i,
		);
		expect(
			publishLiveCutoverAuthority({
				...target,
				windowId: "window-live-replay",
				epoch: 10,
				nowIso: "2026-07-28T00:03:00.000Z",
			}),
		).toMatchObject({ state: "live", revision: 2 });
		expect(readCutoverAuthority(target)).toMatchObject({
			mode: "armed",
			authority: { state: "live", revision: 2 },
		});
		expect(() => readFileSync(`${target.armedPath}.transition`)).toThrow();
	});

	it("resolves the machine authority from the isolated environment", () => {
		const target = paths();
		seedPreCutoverAuthority({
			...target,
			windowId: "window-env",
			epoch: 8,
			nowIso: "2026-07-28T00:00:00.000Z",
		});
		armCutoverAuthority({
			...target,
			windowId: "window-env",
			epoch: 8,
			nowIso: "2026-07-28T00:01:00.000Z",
		});
		expect(() =>
			requireLegacyWriterAllowedFromEnvironment({
				FLYWHEEL_CUTOVER_AUTHORITY_PATH: target.authorityPath,
				FLYWHEEL_CUTOVER_ARMED_PATH: target.armedPath,
			}),
		).toThrow(/legacy writer is frozen/);
	});

	it.each(["deleted", "truncated"] as const)(
		"fails closed when the armed authority is %s",
		(damage) => {
			const target = paths();
			seedPreCutoverAuthority({
				...target,
				windowId: "window-a",
				epoch: 7,
				nowIso: "2026-07-28T00:00:00.000Z",
			});
			armCutoverAuthority({
				...target,
				windowId: "window-a",
				epoch: 7,
				nowIso: "2026-07-28T00:01:00.000Z",
			});
			if (damage === "deleted") {
				unlinkSync(target.authorityPath);
			} else {
				writeFileSync(target.authorityPath, '{"v":1', "utf8");
			}
			expect(() => readCutoverAuthority(target)).toThrow(
				/cutover authority.*fail closed/i,
			);
		},
	);

	it("rejects stale rename and state rollback after live publication", () => {
		const target = paths();
		seedPreCutoverAuthority({
			...target,
			windowId: "window-a",
			epoch: 7,
			nowIso: "2026-07-28T00:00:00.000Z",
		});
		const preBytes = readFileSync(target.authorityPath);
		armCutoverAuthority({
			...target,
			windowId: "window-a",
			epoch: 7,
			nowIso: "2026-07-28T00:01:00.000Z",
		});
		const cutoverBytes = readFileSync(target.authorityPath);
		publishLiveCutoverAuthority({
			...target,
			windowId: "window-a",
			epoch: 7,
			nowIso: "2026-07-28T00:02:00.000Z",
		});

		writeFileSync(target.authorityPath, cutoverBytes);
		expect(() => readCutoverAuthority(target)).toThrow(
			/stale|digest|revision/i,
		);
		writeFileSync(target.authorityPath, preBytes);
		expect(() => readCutoverAuthority(target)).toThrow(
			/stale|digest|revision|rollback/i,
		);
	});

	it("accepts armed pre only through a matching durable rollback receipt", () => {
		const target = paths();
		seedPreCutoverAuthority({
			...target,
			windowId: "window-a",
			epoch: 7,
			nowIso: "2026-07-28T00:00:00.000Z",
		});
		armCutoverAuthority({
			...target,
			windowId: "window-a",
			epoch: 7,
			nowIso: "2026-07-28T00:01:00.000Z",
		});
		publishLiveCutoverAuthority({
			...target,
			windowId: "window-a",
			epoch: 7,
			nowIso: "2026-07-28T00:02:00.000Z",
		});
		writeRollbackReceipt({
			path: target.rollbackReceiptPath,
			windowId: "window-a",
			epoch: 7,
			fromRevision: 2,
			toRevision: 3,
			nowIso: "2026-07-28T00:03:00.000Z",
			nonce: "rollback-a",
		});
		publishRollbackCutoverAuthority({
			...target,
			windowId: "window-a",
			epoch: 7,
			nowIso: "2026-07-28T00:03:01.000Z",
		});

		expect(requireLegacyWriterAllowed(target)).toMatchObject({
			mode: "armed",
			authority: { state: "pre", revision: 3 },
		});
		writeFileSync(target.rollbackReceiptPath, "{}", "utf8");
		expect(() => readCutoverAuthority(target)).toThrow(
			/fail closed.*rollback receipt/i,
		);
	});

	it("rejects an unexpected window or epoch", () => {
		const target = paths();
		seedPreCutoverAuthority({
			...target,
			windowId: "window-a",
			epoch: 7,
			nowIso: "2026-07-28T00:00:00.000Z",
		});
		armCutoverAuthority({
			...target,
			windowId: "window-a",
			epoch: 7,
			nowIso: "2026-07-28T00:01:00.000Z",
		});

		expect(() =>
			readCutoverAuthority({
				...target,
				expectedWindowId: "window-b",
				expectedEpoch: 7,
			}),
		).toThrow(/window/i);
		expect(() =>
			readCutoverAuthority({
				...target,
				expectedWindowId: "window-a",
				expectedEpoch: 8,
			}),
		).toThrow(/epoch/i);
	});
});
