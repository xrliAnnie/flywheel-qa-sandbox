import { InboxWriteValidationError } from "flywheel-comm/inbox-write-normalize";
import { describe, expect, it } from "vitest";
import {
	classifyLegacyRowError,
	LegacyRowPoisonError,
	parseLegacyEventPayload,
} from "../legacy-row-errors.js";

/**
 * FLY-1586 B — per-row isolation, classified by error TYPE.
 *
 * The dangerous shortcut here is a bare try/catch around the row body. That body
 * does far more than parse JSON: StateStore and CommDB reads/writes, owner-fenced
 * queue operations, a legacy filesystem probe. Catching everything would treat
 * `SQLITE_BUSY`, an I/O blip, or a lost owner lease as "deterministic poison" and
 * permanently discard a real notification.
 *
 * So the contract is: quarantine ONLY on types we minted deliberately at a known
 * narrow site. Everything else keeps throwing and uses the existing retry path.
 */

const LONE_HIGH = "\uD83C";

describe("parseLegacyEventPayload", () => {
	it("parses valid JSON unchanged", () => {
		expect(parseLegacyEventPayload('{"a":1}', 42)).toEqual({ a: 1 });
	});

	it("wraps a SyntaxError as typed poison, carrying the row seq", () => {
		try {
			parseLegacyEventPayload("not json at all", 56649);
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(LegacyRowPoisonError);
			const e = err as LegacyRowPoisonError;
			expect(e.reason).toBe("invalid_payload_json");
			expect(e.seq).toBe(56649);
		}
	});

	it("does NOT echo the raw payload in its message", () => {
		// Node's JSON errors quote the offending input verbatim. A malformed row
		// containing `ship FLY-1569` would otherwise carry that text into a log
		// line and into any alert rendered from it — which is precisely the
		// replay this issue exists to prevent.
		try {
			parseLegacyEventPayload("ship FLY-1569", 1);
			expect.unreachable("should have thrown");
		} catch (err) {
			expect((err as Error).message).not.toContain("ship FLY-1569");
			expect((err as Error).message).not.toContain("FLY-1569");
		}
	});

	it("does not swallow a non-SyntaxError thrown from the parse site", () => {
		// A reviver/proxy explosion is not 'this row is malformed'. Only the
		// SyntaxError shape means deterministic bad payload.
		const notAString = {
			toString() {
				throw new TypeError("boom");
			},
		} as unknown as string;
		expect(() => parseLegacyEventPayload(notAString, 1)).toThrow(TypeError);
	});
});

describe("classifyLegacyRowError", () => {
	it("quarantines typed poison", () => {
		expect(
			classifyLegacyRowError(
				new LegacyRowPoisonError("invalid_payload_json", 1),
			),
		).toBe("quarantine");
	});

	it("quarantines a rejected write validation (A's typed error)", () => {
		expect(
			classifyLegacyRowError(
				new InboxWriteValidationError("id", "lone_surrogate"),
			),
		).toBe("quarantine");
	});

	it("RETHROWS SQLITE_BUSY — a transient failure must retry, never quarantine", () => {
		const busy = Object.assign(new Error("database is locked"), {
			code: "SQLITE_BUSY",
		});
		expect(classifyLegacyRowError(busy)).toBe("rethrow");
	});

	it("RETHROWS any other SQLITE_* error", () => {
		const io = Object.assign(new Error("disk I/O error"), {
			code: "SQLITE_IOERR",
		});
		expect(classifyLegacyRowError(io)).toBe("rethrow");
	});

	it("RETHROWS an owner-fence loss", () => {
		expect(
			classifyLegacyRowError(new Error("owner fence lost during cutover")),
		).toBe("rethrow");
	});

	it("RETHROWS an unknown error — default is retry, not discard", () => {
		expect(
			classifyLegacyRowError(new Error("something nobody predicted")),
		).toBe("rethrow");
		expect(classifyLegacyRowError("a bare string")).toBe("rethrow");
		expect(classifyLegacyRowError(undefined)).toBe("rethrow");
	});

	it("classifies on TYPE, not on message text", () => {
		// A transient error whose message happens to mention JSON must still
		// retry. Text-matching is how a real notification gets thrown away.
		const busyMentioningJson = Object.assign(
			new Error("SQLITE_BUSY while writing invalid_payload_json column"),
			{ code: "SQLITE_BUSY" },
		);
		expect(classifyLegacyRowError(busyMentioningJson)).toBe("rethrow");

		// And a poison error keeps its verdict even with an innocuous message.
		const poison = new LegacyRowPoisonError("invalid_payload_json", 7);
		expect(classifyLegacyRowError(poison)).toBe("quarantine");
	});

	it("treats a lone surrogate in a routing key as poison, not as transient", () => {
		let caught: unknown;
		try {
			// This is what A throws when a routing key is corrupt.
			throw new InboxWriteValidationError("source", "lone_surrogate");
		} catch (err) {
			caught = err;
		}
		expect(classifyLegacyRowError(caught)).toBe("quarantine");
		expect((caught as InboxWriteValidationError).message).not.toContain(
			LONE_HIGH,
		);
	});
});
