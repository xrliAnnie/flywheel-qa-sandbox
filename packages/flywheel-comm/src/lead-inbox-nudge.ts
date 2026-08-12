import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	normalizeOptionalBearer,
	readEnvValueFromContent,
} from "flywheel-config";

export interface LeadInboxNudgeArgs {
	bridgeUrl?: string;
	leadId: string;
	project?: string;
	apiToken?: string;
	ingestToken?: string;
	apiTokenFile?: string;
	resolveApiToken?: () => string | undefined;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
	warn?: (message: string) => void;
}

function readCurrentBridgeApiToken(path: string): string | undefined {
	try {
		const content = readFileSync(path, "utf8");
		const raw = readEnvValueFromContent(content, "TEAMLEAD_API_TOKEN")?.trim();
		if (!raw) return undefined;
		const quoted = raw.match(/^(["'])(.*)\1$/);
		return quoted?.[2] ?? raw;
	} catch {
		return undefined;
	}
}

/**
 * Best-effort doorbell for the durable Lead inbox queue. The queue row is the
 * authority; this request only shortens the next adaptive poll interval.
 */
export async function nudgeLeadInboxBestEffort(
	args: LeadInboxNudgeArgs,
): Promise<void> {
	const bridgeUrl = args.bridgeUrl?.trim();
	if (!bridgeUrl) return;
	const timeoutMs = args.timeoutMs ?? 200;
	const warn =
		args.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
	const fetchImpl = args.fetchImpl ?? fetch;
	const masterToken = normalizeOptionalBearer(args.apiToken);
	const ingestToken = normalizeOptionalBearer(args.ingestToken);
	const initialTier = masterToken ? "master" : ingestToken ? "ingest" : "none";
	const initialToken = masterToken ?? ingestToken;
	const post = async (apiToken: string | undefined): Promise<Response> => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			return await fetchImpl(
				`${bridgeUrl.replace(/\/+$/, "")}/api/lead-inbox/nudge`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
					},
					body: JSON.stringify({
						leadId: args.leadId,
						...(args.project ? { project: args.project } : {}),
					}),
					signal: controller.signal,
				},
			);
		} finally {
			clearTimeout(timer);
		}
	};

	try {
		let response = await post(initialToken);
		if (
			initialTier === "master" &&
			(response.status === 401 || response.status === 403)
		) {
			const refreshedToken = (
				args.resolveApiToken ??
				(() =>
					readCurrentBridgeApiToken(
						args.apiTokenFile ?? join(homedir(), ".flywheel", ".env"),
					))
			)();
			if (refreshedToken) {
				response = await post(refreshedToken);
			}
		}
		if (!response.ok) {
			warn(
				`[flywheel-comm] lead inbox nudge returned ${response.status}; durable queue row retained`,
			);
		}
	} catch (error) {
		warn(
			`[flywheel-comm] lead inbox nudge failed: ${(error as Error).message}; durable queue row retained`,
		);
	}
}
