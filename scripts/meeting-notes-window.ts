/** Deterministic FLY-2033 note-taker input extractor (trusted config only). */

import { lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	loadMeetingNotesConfig,
	loadTrustedMeetingInputs,
} from "../packages/teamlead/dist/meeting-notes-config.js";
import { selectMeetingTranscript } from "../packages/teamlead/dist/meeting-notes-scheduler.js";

function args(argv: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (!key?.startsWith("--") || !value) {
			throw new Error(
				"usage: meeting-notes-window --meeting-id UUID --expected-lead ID --expected-scheduled-at ISO --expected-topic TEXT --output FILE",
			);
		}
		out[key.slice(2)] = value;
	}
	return out;
}

function briefingStatus(
	text: string | null,
	now = new Date(),
): { status: "missing" | "invalid" | "expired" | "included"; text?: string } {
	if (text === null) return { status: "missing" };
	const [preparedLine, validLine] = text.split("\n");
	const preparedAt = preparedLine?.match(/^preparedAt:\s*(\S+)\s*$/)?.[1];
	const validUntil = validLine?.match(/^validUntil:\s*(\S+)\s*$/)?.[1];
	if (
		!preparedAt ||
		!validUntil ||
		!Number.isFinite(Date.parse(preparedAt)) ||
		!Number.isFinite(Date.parse(validUntil)) ||
		Date.parse(preparedAt) > Date.parse(validUntil)
	) {
		return { status: "invalid" };
	}
	if (Date.parse(validUntil) < now.getTime()) return { status: "expired" };
	return { status: "included", text };
}

function prepareOutput(path: string): void {
	try {
		const info = lstatSync(path);
		if (info.isSymbolicLink() || !info.isFile()) {
			throw new Error("--output must not be a symlink or non-file");
		}
		let previous: unknown;
		try {
			previous = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			throw new Error("--output exists and is not a previous meeting window");
		}
		if (
			typeof previous !== "object" ||
			previous === null ||
			(previous as { schemaVersion?: unknown }).schemaVersion !== 1 ||
			typeof (previous as { meeting?: unknown }).meeting !== "object" ||
			(previous as { meeting?: unknown }).meeting === null ||
			typeof (previous as { transcript?: unknown }).transcript !== "object" ||
			(previous as { transcript?: unknown }).transcript === null
		) {
			throw new Error("--output exists and is not a previous meeting window");
		}
		unlinkSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function main(): void {
	const input = args(process.argv.slice(2));
	for (const required of [
		"meeting-id",
		"expected-lead",
		"expected-scheduled-at",
		"expected-topic",
		"output",
	]) {
		if (!input[required]) throw new Error(`--${required} is required`);
	}
	const output = resolve(input.output!);
	prepareOutput(output);
	const repoRoot = resolve(process.env.FLYWHEEL_DIR ?? process.cwd());
	const config = loadMeetingNotesConfig(
		resolve(
			process.env.FLYWHEEL_MEETING_NOTES_CONFIG ??
				`${repoRoot}/.flywheel/meeting-notes.yaml`,
		),
	);
	const trusted = loadTrustedMeetingInputs(config, input["meeting-id"]!);
	const displayMismatch =
		trusted.meeting.leadId !== input["expected-lead"] ||
		trusted.meeting.scheduledAt !== input["expected-scheduled-at"] ||
		trusted.meeting.topic !== input["expected-topic"];
	if (displayMismatch) {
		throw new Error(
			"issue display fields do not match the immutable meeting archive",
		);
	}
	const selection = selectMeetingTranscript({
		meeting: trusted.meeting,
		signal: trusted.signal,
		evidenceText: trusted.evidenceText,
	});
	writeFileSync(
		output,
		`${JSON.stringify(
			{
				schemaVersion: 1,
				meeting: trusted.meeting,
				transcript: selection,
				briefing: briefingStatus(trusted.briefing),
			},
			null,
			2,
		)}\n`,
		{ flag: "wx", mode: 0o600 },
	);
}

try {
	main();
} catch (error) {
	console.error(
		`[meeting-notes-window] ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exitCode = 1;
}
