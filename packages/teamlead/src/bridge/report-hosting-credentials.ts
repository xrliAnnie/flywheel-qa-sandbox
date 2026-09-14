import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readEnvValueFromContent } from "flywheel-config";
export type CredentialKey =
	| "BLOB_READ_WRITE_TOKEN"
	| "REPORT_HOSTING_VERCEL_TOKEN"
	| "VERCEL_TOKEN";
export interface CredentialSnapshot {
	readonly key: CredentialKey;
	readonly value: string | undefined;
	readonly source: "file" | "process" | "absent";
	readonly generation: number;
}
export interface ReportHostingCredentials {
	snapshot(key: CredentialKey): CredentialSnapshot;
}
export function blobStoreIdFromToken(token: string): string | undefined {
	return /^vercel_blob_rw_([a-z0-9]+)_[a-z0-9_]+$/i
		.exec(token)?.[1]
		?.toLowerCase();
}
export class FileReportHostingCredentials implements ReportHostingCredentials {
	private signature: string | undefined;
	private content: string | undefined;
	private generation = 0;
	private readonly env: NodeJS.ProcessEnv;
	private readonly envPath: string;
	private readonly warn: (message: string) => void;
	constructor(
		options: {
			envPath?: string;
			env?: NodeJS.ProcessEnv;
			warn?: (message: string) => void;
		} = {},
	) {
		this.env = options.env ?? process.env;
		this.envPath =
			options.envPath ??
			join(
				this.env.FLYWHEEL_STATE_DIR?.trim() || join(homedir(), ".flywheel"),
				".env",
			);
		this.warn = options.warn ?? console.warn;
	}
	snapshot(key: CredentialKey): CredentialSnapshot {
		try {
			const stat = statSync(this.envPath);
			const signature = `${stat.mtimeMs}:${stat.size}`;
			if (signature !== this.signature) {
				const content = readFileSync(this.envPath, "utf8");
				this.content = content;
				this.signature = signature;
				this.generation++;
			}
		} catch {
			if (this.signature !== "unavailable") {
				this.warn(
					"[reports] credential file unavailable; using process environment",
				);
				this.generation++;
			}
			this.signature = "unavailable";
			this.content = undefined;
		}
		const raw =
			this.content === undefined
				? undefined
				: readEnvValueFromContent(this.content, key);
		let value = (raw ?? this.env[key])?.trim();
		if (
			value &&
			((value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'")))
		)
			value = value.slice(1, -1).trim();
		return Object.freeze({
			key,
			value: value || undefined,
			source: value ? (raw === undefined ? "process" : "file") : "absent",
			generation: this.generation,
		});
	}
}

export class ReportHostingCredentialMismatch extends Error {
	readonly expectedStoreId8: string;
	readonly actualStoreId8: string;
	constructor(expected: string, actual: string | undefined) {
		super("report hosting credentials do not match registry store");
		this.name = "ReportHostingCredentialMismatch";
		this.expectedStoreId8 = expected.slice(0, 8);
		this.actualStoreId8 = (actual ?? "-").slice(0, 8);
	}
}
let warnedMissingStoreId = false;
export function assertReportHostingCredentialBinding(
	storeId: string | undefined,
	snapshot: CredentialSnapshot,
): void {
	if (!storeId) {
		if (!warnedMissingStoreId) {
			console.warn(
				"[reports] registry store identity missing; run usage-check to record it",
			);
			warnedMissingStoreId = true;
		}
		return;
	}
	const actual = blobStoreIdFromToken(snapshot.value ?? "");
	if (storeId !== actual)
		throw new ReportHostingCredentialMismatch(storeId, actual);
}
