export function parseSqliteUtc(value) {
	if (typeof value !== "string") {
		throw new TypeError("SQLite timestamp must be a string");
	}
	const normalized = value.includes("T") ? value : value.replace(" ", "T");
	const parsed = Date.parse(
		normalized.endsWith("Z") ? normalized : `${normalized}Z`,
	);
	if (!Number.isFinite(parsed)) {
		throw new TypeError(`Invalid SQLite UTC timestamp: ${value}`);
	}
	return parsed;
}

const formatterCache = new Map();

function zonedParts(epochMs, timezone) {
	let formatter = formatterCache.get(timezone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-CA", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hourCycle: "h23",
		});
		formatterCache.set(timezone, formatter);
	}
	return Object.fromEntries(
		formatter
			.formatToParts(new Date(epochMs))
			.filter((part) => part.type !== "literal")
			.map((part) => [part.type, Number(part.value)]),
	);
}

export function zonedDateTimeToMs(parts, timezone) {
	const target = Date.UTC(
		parts.year,
		parts.month - 1,
		parts.day,
		parts.hour ?? 0,
		parts.minute ?? 0,
		parts.second ?? 0,
	);
	let candidate = target;
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const rendered = zonedParts(candidate, timezone);
		const renderedAsUtc = Date.UTC(
			rendered.year,
			rendered.month - 1,
			rendered.day,
			rendered.hour,
			rendered.minute,
			rendered.second,
		);
		const correction = target - renderedAsUtc;
		candidate += correction;
		if (correction === 0) return candidate;
	}
	return candidate;
}

export function buildNightOverlays(startMs, endMs, timezone) {
	const intervals = [];
	const scanStart = new Date(startMs - 2 * 86_400_000);
	const scanEnd = new Date(endMs + 2 * 86_400_000);
	for (
		let day = Date.UTC(
			scanStart.getUTCFullYear(),
			scanStart.getUTCMonth(),
			scanStart.getUTCDate(),
		);
		day <= scanEnd.getTime();
		day += 86_400_000
	) {
		const date = new Date(day);
		const next = new Date(day + 86_400_000);
		const nightStart = zonedDateTimeToMs(
			{
				year: date.getUTCFullYear(),
				month: date.getUTCMonth() + 1,
				day: date.getUTCDate(),
				hour: 23,
			},
			timezone,
		);
		const nightEnd = zonedDateTimeToMs(
			{
				year: next.getUTCFullYear(),
				month: next.getUTCMonth() + 1,
				day: next.getUTCDate(),
				hour: 8,
			},
			timezone,
		);
		const clipped = {
			start_ms: Math.max(startMs, nightStart),
			end_ms: Math.min(endMs, nightEnd),
		};
		if (clipped.end_ms > clipped.start_ms) intervals.push(clipped);
	}
	return intervals.filter(
		(item, index) =>
			index === 0 ||
			item.start_ms !== intervals[index - 1].start_ms ||
			item.end_ms !== intervals[index - 1].end_ms,
	);
}

function mergeBuckets(buckets) {
	const merged = [];
	for (const bucket of [...buckets].sort((a, b) => a.start_ms - b.start_ms)) {
		const previous = merged.at(-1);
		if (previous && previous.end_ms >= bucket.start_ms)
			previous.end_ms = Math.max(previous.end_ms, bucket.end_ms);
		else merged.push({ ...bucket });
	}
	return merged;
}

export function parseSystemHealthLog(logText, timezone) {
	const values = new Map();
	let pendingAt = null;
	for (const line of logText.split(/\r?\n/)) {
		const timestamp = line.match(
			/^(?:=+\s*)?(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/,
		);
		if (timestamp) {
			pendingAt = zonedDateTimeToMs(
				{
					year: Number(timestamp[1]),
					month: Number(timestamp[2]),
					day: Number(timestamp[3]),
					hour: Number(timestamp[4]),
					minute: Number(timestamp[5]),
					second: Number(timestamp[6]),
				},
				timezone,
			);
		}
		const load = line.match(/load averages?:\s*([\d.]+)/i);
		if (pendingAt !== null && load) {
			values.set(pendingAt, Number(load[1]));
			pendingAt = null;
		}
	}
	return [...values.entries()]
		.map(([at_ms, load_1m]) => ({ at_ms, load_1m }))
		.sort((a, b) => a.at_ms - b.at_ms);
}

export function buildLoadOverlays(
	logText,
	{ start_ms, end_ms, timezone, threshold },
) {
	const known = [];
	const saturated = [];
	for (const record of parseSystemHealthLog(logText, timezone)) {
		const interval = {
			start_ms: Math.max(start_ms, record.at_ms),
			end_ms: Math.min(end_ms, record.at_ms + 60_000),
		};
		if (interval.end_ms <= interval.start_ms) continue;
		known.push(interval);
		if (record.load_1m > threshold) saturated.push(interval);
	}
	const unknown = [];
	let cursor = start_ms;
	for (const interval of mergeBuckets(known)) {
		if (interval.start_ms > cursor)
			unknown.push({ start_ms: cursor, end_ms: interval.start_ms });
		cursor = Math.max(cursor, interval.end_ms);
	}
	if (cursor < end_ms) unknown.push({ start_ms: cursor, end_ms });
	return [
		{ kind: "load_unknown", intervals: mergeBuckets(unknown) },
		{ kind: "load_saturated", intervals: mergeBuckets(saturated) },
	].filter((overlay) => overlay.intervals.length > 0);
}
