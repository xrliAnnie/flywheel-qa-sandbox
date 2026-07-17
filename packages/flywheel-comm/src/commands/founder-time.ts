import { parseArgs } from "node:util";
import {
	formatFounderLocal,
	founderLocalIso,
	founderOffsetMinutes,
	resolveFounderTimezone,
} from "flywheel-config";

export interface FounderTimeIo {
	now: () => Date;
	resolveTimezone: () => string;
	stdout: (line: string) => void;
}

const defaultIo: FounderTimeIo = {
	now: () => new Date(),
	resolveTimezone: resolveFounderTimezone,
	stdout: console.log,
};

function formatUtcOffset(offsetMinutes: number): string {
	const sign = offsetMinutes >= 0 ? "+" : "-";
	const absolute = Math.abs(offsetMinutes);
	return `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

export function founderTime(
	args: string[],
	io: FounderTimeIo = defaultIo,
): void {
	const { values } = parseArgs({
		args,
		options: {
			json: { type: "boolean", default: false },
		},
		allowPositionals: false,
	});
	const now = io.now();
	const timezone = io.resolveTimezone();
	const formatted = formatFounderLocal(now, timezone);
	const abbrev = formatted.slice(formatted.lastIndexOf(" ") + 1);
	const offsetMinutes = founderOffsetMinutes(now, timezone);

	if (values.json) {
		io.stdout(
			JSON.stringify({
				iso: founderLocalIso(now, timezone),
				tz: timezone,
				abbrev,
				offsetMinutes,
			}),
		);
		return;
	}

	io.stdout(
		`${formatted} — ${timezone} (UTC${formatUtcOffset(offsetMinutes)})`,
	);
}
