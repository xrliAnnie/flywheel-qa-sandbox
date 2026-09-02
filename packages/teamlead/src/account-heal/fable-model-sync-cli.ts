#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type SyncFableModelAuthorityOptions,
	type SyncFableModelAuthorityResult,
	syncFableModelAuthority,
} from "./fable-model-sync.js";

export interface FableModelUpdateNotice {
	previousCanonical: string;
	canonical: string;
	source: "anthropic_models_api";
}

interface FableModelSyncCliDeps {
	argv?: string[];
	sync?: (
		opts: SyncFableModelAuthorityOptions,
	) => Promise<SyncFableModelAuthorityResult>;
	notify?: (notice: FableModelUpdateNotice) => void;
	log?: (message: string) => void;
	warn?: (message: string) => void;
}

const OPERATOR_WARNING_REASONS = new Set<
	SyncFableModelAuthorityResult["reason"]
>([
	"unsafe_authority",
	"invalid_authority",
	"unsupported_1m",
	"write_failed",
	"verification_failed",
]);

function option(argv: string[], name: string): string | undefined {
	const index = argv.indexOf(name);
	if (index < 0) return undefined;
	const value = argv[index + 1];
	if (!value || value.startsWith("--"))
		throw new Error(`${name} requires a value`);
	return value;
}

export function notifyModelFamilyUpdated(
	notice: FableModelUpdateNotice,
	deps: {
		alertBin?: string;
		execFile?: typeof execFileSync;
	} = {},
): void {
	const alertBin =
		deps.alertBin ??
		process.env.FLYWHEEL_LEAD_ALERT_BIN ??
		join(homedir(), ".flywheel", "bin", "lead-alert.sh");
	const signature = `model-family-updated-fable-${notice.previousCanonical}-${notice.canonical}`;
	(deps.execFile ?? execFileSync)(
		alertBin,
		[
			"--project",
			"flywheel",
			"--lead",
			"updater",
			"--kind",
			"model_family_updated",
			"--severity",
			"info",
			"--title",
			"Fable model family authority updated",
			"--body",
			`Fable authority advanced from ${notice.previousCanonical} to ${notice.canonical} (source=${notice.source}). Future base-model resume will park fail-closed until contextWindowTokens is independently corroborated; pinned runs remain unchanged.`,
			"--signature",
			signature,
		],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);
}

/** Updater-safe entry: model probe failures never alter the shuttle exit code. */
export async function runFableModelSyncCli(
	deps: FableModelSyncCliDeps = {},
): Promise<number> {
	const log = deps.log ?? console.log;
	const warn = deps.warn ?? console.warn;
	try {
		const argv = deps.argv ?? process.argv.slice(2);
		const authorityPath = option(argv, "--authority");
		const alertBin = option(argv, "--alert-bin");
		const result = await (deps.sync ?? syncFableModelAuthority)({
			...(authorityPath ? { authorityPath } : {}),
		});
		log(JSON.stringify(result));
		if (
			result.status === "retained" &&
			result.reason !== undefined &&
			OPERATOR_WARNING_REASONS.has(result.reason)
		) {
			warn(`[fable-model-sync] authority retained: ${result.reason}`);
		}
		if (
			result.status === "updated" &&
			result.previousCanonical &&
			result.canonical
		) {
			try {
				const notice: FableModelUpdateNotice = {
					previousCanonical: result.previousCanonical,
					canonical: result.canonical,
					source: "anthropic_models_api",
				};
				if (deps.notify) deps.notify(notice);
				else
					notifyModelFamilyUpdated(notice, {
						...(alertBin ? { alertBin } : {}),
					});
			} catch {
				warn("[fable-model-sync] authority updated but notification failed");
			}
		}
	} catch {
		warn("[fable-model-sync] probe failed; retained current authority");
	}
	return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	runFableModelSyncCli().then((code) => process.exit(code));
}
