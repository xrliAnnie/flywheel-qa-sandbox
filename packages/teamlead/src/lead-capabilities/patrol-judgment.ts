import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fsyncSync,
	lstatSync,
	openSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getLeadCapability } from "./catalog.js";
import { readManifestMarkdown } from "./manifest-instructions.js";
import { runPatrolCompletionGates } from "./patrol-completion-gates.js";
import { mergePatrolMechanisms } from "./patrol-schema2.js";

const invalid = () => new Error("patrol_judgment_invalid");
/** Trusted report registration comes from the snapshot handler, never model paths.
 * Caller owns broker UUID dedup and reconciles uncertain writes from report receipts. */
export function applyPatrolJudgment(
	options: Omit<Parameters<typeof runPatrolCompletionGates>[0], "report"> & {
		report: {
			path: string;
			sha256: string;
			tickId: string;
			evidenceHandle: string;
		};
		input: Record<string, unknown>;
	},
) {
	const input = getLeadCapability("patrol.judgment.record")!.inputSchema.parse(
		options.input,
	);
	if (
		input.tickId !== options.report.tickId ||
		input.evidenceHandle !== options.report.evidenceHandle
	)
		throw invalid();
	options.assertCurrent();
	readManifestMarkdown([options.source], options.secrets);
	const path = options.report.path;
	const stat = lstatSync(path),
		parent = lstatSync(dirname(path));
	if (
		realpathSync(path) !== path ||
		!stat.isFile() ||
		stat.nlink !== 1 ||
		stat.uid !== process.getuid?.() ||
		(stat.mode & 0o077) !== 0 ||
		!parent.isDirectory() ||
		parent.uid !== process.getuid?.() ||
		(parent.mode & 0o022) !== 0
	)
		throw invalid();
	const original = readManifestMarkdown([options.report], options.secrets)[0]!;
	const step = String(input.step),
		judgment = input.judgment;
	const findings = (input.findings ?? []) as Array<{
		id: string;
		category: string;
		disposition?: string;
		repairIssue?: string;
		repairReceipt?: string;
		dispositionRef?: string;
		bridgeProblem: boolean;
		result: string;
		evidence: string;
		owner: string;
		next: string;
		epic: string;
		epicMarker: string;
	}>;
	// FLY-2914: only a root-cause scheduling incident may reference its disposition.
	const rootCauseIncident = (f: (typeof findings)[number]) =>
		f.category === "incident" &&
		step === "6" &&
		f.evidence.startsWith("rootcause:") &&
		f.dispositionRef === f.evidence;
	if (
		new Set(findings.map((f) => f.id)).size !== findings.length ||
		findings.some((f) => {
			const fields = [
				f.disposition,
				f.repairIssue,
				f.repairReceipt,
				f.dispositionRef,
			];
			return f.category === "incident"
				? (rootCauseIncident(f) ? fields.slice(0, 3) : fields).some(
						(v) => v !== undefined,
					)
				: fields.some((v) => v === undefined);
		})
	)
		throw invalid();
	// Snapshot pre-filled root-cause findings survive unless this request re-states them.
	const preserved =
		step === "6"
			? original
					.split("\n")
					.filter(
						(line) =>
							line.startsWith("FINDING ") &&
							line.split(" ").includes("step=6") &&
							/ evidence=rootcause:[0-9a-f]{64} /.test(line) &&
							!findings.some((f) => line.split(" ").includes(`id=${f.id}`)),
					)
			: [];
	const unavailable = input.unavailable as
		| { class: string; token: string }
		| undefined;
	const panes = (input.paneResults ?? []) as Array<{
		pane: string;
		action: string;
		result: string;
	}>;
	if (
		(judgment === "unknown") !== !!unavailable ||
		(judgment === "unhealthy") !== findings.length + preserved.length > 0 ||
		(panes.length > 0 && input.step !== 2) ||
		new Set(panes.map((p) => p.pane)).size !== panes.length
	)
		throw invalid();
	const status =
		judgment === "healthy"
			? "OK"
			: judgment === "unhealthy"
				? "FINDING"
				: `UNAVAILABLE(${unavailable!.class}: ${unavailable!.token})`;
	const lines = mergePatrolMechanisms(original.split("\n"), input);
	const cause = unavailable
		? `UNAVAILABLE_CAUSE step=${step} class=${unavailable.class} token=${unavailable.token}`
		: undefined;
	if (lines.filter((line) => line.startsWith(`STEP ${step}: `)).length !== 1)
		throw invalid();
	const seen = new Set<string>();
	const output = lines
		.filter(
			(line) =>
				!(
					line.startsWith("FINDING ") &&
					line.split(" ").includes(`step=${step}`)
				),
		)
		.flatMap((line) => {
			if (line.startsWith(`STEP ${step}: `))
				return [
					`STEP ${step}: ${status}`,
					...(cause && !lines.includes(cause) ? [cause] : []),
					...preserved,
					...findings.map(
						(f) =>
							`FINDING id=${f.id} category=${f.category} step=${step} bridge_problem=${f.bridgeProblem ? "yes" : "no"} result=${f.result} evidence=${f.evidence} owner=${f.owner} next=${f.next} epic=${f.epic} epic_marker=${f.epicMarker}${f.category === "mechanism_defect" ? ` disposition=${f.disposition} repair_issue=${f.repairIssue} repair_receipt=${f.repairReceipt} disposition_ref=${f.dispositionRef}` : rootCauseIncident(f) ? ` disposition_ref=${f.dispositionRef}` : ""}`,
					),
				];
			if (line.startsWith("PANE_EVIDENCE ")) {
				const update = panes.find((p) =>
					line.split(" ").includes(`pane=${p.pane}`),
				);
				if (update) {
					if (
						seen.has(update.pane) ||
						!line.split(" ").includes(`exec=${input.executionId}`) ||
						!/ action=[^ ]+/.test(line) ||
						!/ result=[^ ]+/.test(line)
					)
						throw invalid();
					seen.add(update.pane);
					return [
						line
							.replace(/ action=[^ ]+/, ` action=${update.action}`)
							.replace(/ result=[^ ]+/, ` result=${update.result}`),
					];
				}
			}
			return [line];
		})
		.join("\n");
	if (
		seen.size !== panes.length ||
		Buffer.byteLength(output) > 1024 * 1024 ||
		options.secrets.some((s) => s.length > 0 && output.includes(s))
	)
		throw invalid();
	const sha256 = createHash("sha256").update(output).digest("hex");
	const temporary = join(dirname(path), `.patrol-${randomUUID()}.tmp`);
	let fd: number | undefined;
	try {
		fd = openSync(
			temporary,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				constants.O_NOFOLLOW,
			0o600,
		);
		writeFileSync(fd, output);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		options.assertCurrent();
		readManifestMarkdown([options.report], options.secrets);
		const latest = lstatSync(path);
		if (latest.dev !== stat.dev || latest.ino !== stat.ino) throw invalid();
		renameSync(temporary, path);
	} finally {
		if (fd !== undefined) closeSync(fd);
		rmSync(temporary, { force: true });
	}
	return runPatrolCompletionGates({ ...options, report: { path, sha256 } });
}
