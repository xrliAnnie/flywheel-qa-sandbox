import fs from "node:fs";
import path from "node:path";

const DEFAULTS = Object.freeze({
	schemaVersion: 1,
	checkEveryHours: 6,
	applyHour: 3,
	applyGraceHours: 2,
});

export function readSchedule(cfg) {
	try {
		const value = JSON.parse(
			fs.readFileSync(path.join(cfg.stateDir, "auto-update.json"), "utf8"),
		);
		if (
			!value ||
			Array.isArray(value) ||
			value.schemaVersion !== 1 ||
			![1, 2, 3, 4, 6, 8, 12, 24].includes(value.checkEveryHours) ||
			!Number.isInteger(value.applyHour) ||
			value.applyHour < 0 ||
			value.applyHour > 23 ||
			!Number.isInteger(value.applyGraceHours) ||
			value.applyGraceHours < 1 ||
			value.applyGraceHours > 6
		)
			return { ...DEFAULTS, invalid: true };
		return {
			schemaVersion: 1,
			checkEveryHours: value.checkEveryHours,
			applyHour: value.applyHour,
			applyGraceHours: value.applyGraceHours,
			invalid: false,
		};
	} catch (error) {
		return { ...DEFAULTS, invalid: error.code !== "ENOENT" };
	}
}

export function scheduleTicks(config) {
	return Array.from({ length: 24 / config.checkEveryHours }, (_, index) => ({
		hour: (config.applyHour + index * config.checkEveryHours) % 24,
		minute: 0,
	})).sort((a, b) => a.hour - b.hour);
}

export function inApplyWindow(config, now = new Date()) {
	const hours = now.getHours() + now.getMinutes() / 60;
	return (hours - config.applyHour + 24) % 24 < config.applyGraceHours;
}

function nextOccurrence(hours, now) {
	const candidates = [];
	for (const day of [0, 1, 2]) {
		for (const hour of hours) {
			const date = new Date(now);
			date.setDate(date.getDate() + day);
			date.setHours(hour, 0, 0, 0);
			if (date > now) candidates.push(date.getTime());
		}
	}
	return new Date(Math.min(...candidates)).toISOString();
}

export function nextApplyAt(config, now = new Date()) {
	return nextOccurrence([config.applyHour], now);
}

export function nextCheckAt(config, now = new Date()) {
	return nextOccurrence(
		scheduleTicks(config).map((tick) => tick.hour),
		now,
	);
}
