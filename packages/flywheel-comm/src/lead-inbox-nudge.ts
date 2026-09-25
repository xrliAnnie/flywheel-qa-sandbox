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

export type LeadInboxNudgeResult =
	| { status: "accepted"; httpStatus: number }
	| { status: "skipped"; reason: "bridge_url_missing" }
	| {
			status: "failed";
			reason: "bridge_url_invalid" | "http_error" | "request_error";
			httpStatus?: number;
	  };

export function resolveLeadInboxBridgeUrl(
	env: NodeJS.ProcessEnv,
): string | undefined {
	return env.FLYWHEEL_BRIDGE_URL ?? env.BRIDGE_URL;
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
): Promise<LeadInboxNudgeResult> {
	const bridgeUrl = args.bridgeUrl?.trim();
	const warn =
		args.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
	if (!bridgeUrl) {
		return { status: "skipped", reason: "bridge_url_missing" };
	}
	try {
		const parsed = new URL(bridgeUrl);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new Error("unsupported protocol");
		}
	} catch {
		warn(
			"[flywheel-comm] lead inbox doorbell not delivered (invalid Bridge URL); durable queue row retained",
		);
		return { status: "failed", reason: "bridge_url_invalid" };
	}
	const timeoutMs = args.timeoutMs ?? 1500;
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
				`[flywheel-comm] lead inbox doorbell returned ${response.status}; durable queue row retained — a healthy Lead loop retries on its next poll (nominally <=30 s)`,
			);
			return {
				status: "failed",
				reason: "http_error",
				httpStatus: response.status,
			};
		}
		return { status: "accepted", httpStatus: response.status };
	} catch (error) {
		warn(
			`[flywheel-comm] lead inbox doorbell not delivered (${(error as Error).message}); durable queue row retained — a healthy Lead loop retries on its next poll (nominally <=30 s)`,
		);
		return { status: "failed", reason: "request_error" };
	}
}
