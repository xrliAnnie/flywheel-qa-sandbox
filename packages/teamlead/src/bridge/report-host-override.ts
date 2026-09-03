export interface ReportHostOverride {
	apiBaseUrl: string;
	publicBaseUrl: string;
}

const INVALID_OVERRIDE =
	"FLYWHEEL_REPORT_HOST_OVERRIDE_URL must be exactly http://127.0.0.1:<port> (QA loopback only); refusing to start";

export function parseReportHostOverride(
	raw: string | undefined,
): ReportHostOverride | undefined {
	if (!raw?.trim()) return undefined;
	const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/.exec(raw);
	if (!match || Number(match[1]) > 65_535) throw new Error(INVALID_OVERRIDE);

	const url = new URL(raw);
	if (
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		url.port !== match[1] ||
		url.pathname !== "/" ||
		url.search ||
		url.hash ||
		url.username ||
		url.password
	) {
		throw new Error(INVALID_OVERRIDE);
	}

	const baseUrl = `http://127.0.0.1:${match[1]}`;
	return { apiBaseUrl: baseUrl, publicBaseUrl: baseUrl };
}
