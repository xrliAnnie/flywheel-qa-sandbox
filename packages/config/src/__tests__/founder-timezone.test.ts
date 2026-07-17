import { describe, expect, it, vi } from "vitest";
import {
	createFounderTimezoneResolver,
	formatFounderLocal,
	founderLocalIso,
	founderOffsetMinutes,
} from "../founder-timezone.js";

function resolverIo(
	overrides: Partial<Parameters<typeof createFounderTimezoneResolver>[0]> = {},
) {
	return {
		env: {} as Record<string, string | undefined>,
		readlinkSync: () => "/var/db/timezone/zoneinfo/America/Los_Angeles",
		nowMs: () => 0,
		intlTimezone: () => "America/Los_Angeles",
		warn: vi.fn(),
		...overrides,
	};
}

describe("FLY-1319 founder timezone resolver", () => {
	it("prefers a valid env override and reads it on every call", () => {
		const env: Record<string, string | undefined> = {
			FLYWHEEL_FOUNDER_TZ: "Asia/Tokyo",
		};
		const readlinkSync = vi.fn(
			() => "/var/db/timezone/zoneinfo/America/Los_Angeles",
		);
		const resolver = createFounderTimezoneResolver(
			resolverIo({ env, readlinkSync }),
		);

		expect(resolver.resolveFounderTimezone()).toBe("Asia/Tokyo");
		env.FLYWHEEL_FOUNDER_TZ = "Europe/Paris";
		expect(resolver.resolveFounderTimezone()).toBe("Europe/Paris");
		expect(readlinkSync).not.toHaveBeenCalled();
	});

	it.each([
		[
			"macOS absolute symlink",
			"/var/db/timezone/zoneinfo/America/Los_Angeles",
			"America/Los_Angeles",
		],
		[
			"Linux absolute symlink",
			"/usr/share/zoneinfo/Europe/Berlin",
			"Europe/Berlin",
		],
		["relative symlink", "../usr/share/zoneinfo/Asia/Tokyo", "Asia/Tokyo"],
	] as const)("parses the host timezone from a %s", (_name, link, expected) => {
		const resolver = createFounderTimezoneResolver(
			resolverIo({ readlinkSync: () => link }),
		);

		expect(resolver.resolveFounderTimezone()).toBe(expected);
	});

	it("caches only the host probe for 60 seconds", () => {
		let now = 0;
		let link = "/usr/share/zoneinfo/Asia/Tokyo";
		const readlinkSync = vi.fn(() => link);
		const resolver = createFounderTimezoneResolver(
			resolverIo({ readlinkSync, nowMs: () => now }),
		);

		expect(resolver.resolveFounderTimezone()).toBe("Asia/Tokyo");
		link = "/usr/share/zoneinfo/Europe/Paris";
		now = 59_999;
		expect(resolver.resolveFounderTimezone()).toBe("Asia/Tokyo");
		now = 60_000;
		expect(resolver.resolveFounderTimezone()).toBe("Europe/Paris");
		expect(readlinkSync).toHaveBeenCalledTimes(2);
	});

	it("warns once for an invalid env override and falls back to the host", () => {
		const warn = vi.fn();
		const resolver = createFounderTimezoneResolver(
			resolverIo({
				env: { FLYWHEEL_FOUNDER_TZ: "Not/AZone" },
				warn,
			}),
		);

		expect(resolver.resolveFounderTimezone()).toBe("America/Los_Angeles");
		expect(resolver.resolveFounderTimezone()).toBe("America/Los_Angeles");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("Not/AZone"));
	});

	it("falls back from a failed host probe to the injected Intl timezone", () => {
		const resolver = createFounderTimezoneResolver(
			resolverIo({
				readlinkSync: () => {
					throw new Error("not a symlink");
				},
				intlTimezone: () => "Asia/Tokyo",
			}),
		);

		expect(resolver.resolveFounderTimezone()).toBe("Asia/Tokyo");
	});

	it("rejects invalid host and Intl candidates before using the LA fallback", () => {
		const resolver = createFounderTimezoneResolver(
			resolverIo({
				readlinkSync: () => "/tmp/not-zoneinfo/Not/AZone",
				intlTimezone: () => "Also/Invalid",
			}),
		);

		expect(resolver.resolveFounderTimezone()).toBe("America/Los_Angeles");
	});
});

describe("FLY-1319 founder-local formatters", () => {
	it("formats founder local wall time with an unambiguous timezone abbreviation", () => {
		expect(
			formatFounderLocal(
				new Date("2026-07-17T02:23:05.000Z"),
				"America/Los_Angeles",
			),
		).toBe("2026-07-16 19:23 PDT");
	});

	it("renders midnight as 00 and preserves seconds in ISO-with-offset", () => {
		const instant = new Date("2026-07-16T07:05:09.000Z");

		expect(formatFounderLocal(instant, "America/Los_Angeles")).toBe(
			"2026-07-16 00:05 PDT",
		);
		expect(founderLocalIso(instant, "America/Los_Angeles")).toBe(
			"2026-07-16T00:05:09-07:00",
		);
	});

	it.each([
		["spring before", "2026-03-08T09:59:00.000Z", -480, "PST"],
		["spring after", "2026-03-08T10:01:00.000Z", -420, "PDT"],
		["fall before", "2026-11-01T08:59:00.000Z", -420, "PDT"],
		["fall after", "2026-11-01T09:01:00.000Z", -480, "PST"],
	] as const)(
		"uses the correct LA offset at the %s DST boundary",
		(_name, iso, expectedOffset, expectedAbbrev) => {
			const instant = new Date(iso);
			expect(founderOffsetMinutes(instant, "America/Los_Angeles")).toBe(
				expectedOffset,
			);
			expect(
				formatFounderLocal(instant, "America/Los_Angeles").endsWith(
					expectedAbbrev,
				),
			).toBe(true);
		},
	);

	it("uses east-positive offset minutes for a non-whole-hour timezone", () => {
		const instant = new Date("2026-07-16T12:00:00.000Z");

		expect(founderOffsetMinutes(instant, "Asia/Kolkata")).toBe(330);
		expect(founderLocalIso(instant, "Asia/Kolkata")).toBe(
			"2026-07-16T17:30:00+05:30",
		);
	});
});
