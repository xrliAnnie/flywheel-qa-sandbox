import { describe, expect, it } from "vitest";
import {
	decodeSenderRef,
	encodeSenderRef,
	processedFenceFromSenderRef,
} from "../sender-ref.js";

describe("FLY-1572 sender_ref v1", () => {
	it("encodes all six provenance fields in one deterministic value", () => {
		expect(
			encodeSenderRef({
				senderLeaseKey: "flywheel:lead-a",
				senderGeneration: 7,
				senderHolderPid: 123,
				senderHolderStart: "2026-08-05T00:00:00.000Z",
				writerPid: 456,
				writerStart: "2026-08-05T00:00:01.000Z",
			}),
		).toBe(
			'{"v":1,"lease_key":"flywheel:lead-a","generation":7,"holder_pid":123,"holder_start":"2026-08-05T00:00:00.000Z","writer_pid":456,"writer_start":"2026-08-05T00:00:01.000Z"}',
		);
	});

	it("records an unprotected writer explicitly instead of using SQL NULL", () => {
		const encoded = encodeSenderRef({
			writerPid: 456,
			writerStart: "proc-start",
		});
		expect(encoded).toBe(
			'{"v":1,"authority":"unprotected","writer_pid":456,"writer_start":"proc-start"}',
		);
		expect(decodeSenderRef(encoded)).toEqual({
			v: 1,
			authority: "unprotected",
			writer_pid: 456,
			writer_start: "proc-start",
		});
	});

	it("preserves the lease then writer then unprotected fence ladder", () => {
		expect(
			processedFenceFromSenderRef(
				encodeSenderRef({
					senderLeaseKey: "lead-key",
					senderGeneration: 3,
					writerPid: 99,
				}),
			),
		).toEqual({ lease_key: "lead-key", lease_generation: 3 });
		expect(
			processedFenceFromSenderRef(encodeSenderRef({ writerPid: 99 })),
		).toEqual({ writer_pid: 99 });
		expect(processedFenceFromSenderRef(encodeSenderRef())).toEqual({
			authority: "lead_write_unprotected",
		});
		expect(processedFenceFromSenderRef(null)).toEqual({
			authority: "lead_write_unprotected",
		});
	});

	it.each([
		["missing lease key", { senderGeneration: 1 }],
		["missing generation", { senderLeaseKey: "lead-key" }],
		[
			"unsafe generation",
			{ senderLeaseKey: "lead-key", senderGeneration: 1e30 },
		],
		["invalid pid", { writerPid: -1 }],
	] as const)("rejects %s", (_label, provenance) => {
		expect(() => encodeSenderRef(provenance)).toThrow();
	});

	it.each([
		"not-json",
		'{"v":2,"authority":"unprotected"}',
		'{"v":1,"authority":"other"}',
		'{"v":1,"authority":"unprotected","extra":true}',
		'{"v":1,"lease_key":"lead-key"}',
		'{"v":1,"lease_key":"lead-key","generation":1.5}',
	])("fails closed for malformed or unknown sender_ref %s", (encoded) => {
		expect(() => decodeSenderRef(encoded)).toThrow(/sender_ref/);
		expect(() => processedFenceFromSenderRef(encoded)).toThrow(/sender_ref/);
	});
});
