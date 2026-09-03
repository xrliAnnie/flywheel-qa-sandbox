/**
 * GEO-294: Vercel Deploy helper — deploy HTML as a static site.
 * Uses Vercel REST API v13/deployments with inline file content.
 *
 * Deploys as `target: "production"` so the site is publicly accessible.
 * Returns the production alias URL (not the deployment-specific URL)
 * because Vercel SSO Protection blocks deployment URLs on Hobby plan.
 *
 * FLY-203: the generic multi-file deploy (`deployFilesToVercel`) is shared
 * by the remote report pipeline. `deployToVercel` keeps its exact GEO-294
 * behavior (triage- prefix, single index.html, deterministic alias) on top
 * of it — guarded by a reverse-compat sentinel test.
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_ATTEMPTS = 15; // 30s max polling
export const VERCEL_API_BASE_URL = "https://api.vercel.com";

export interface VercelDeployResult {
	url: string;
	deploymentId: string;
}

export interface VercelDeployFile {
	/** Relative POSIX path inside the deployment (e.g. "r/<token>/index.html"). */
	file: string;
	data: string;
}

/**
 * FLY-203: deploy a set of inline files to a Vercel project. The
 * `deploymentName` is used AS-IS (no triage- prefix) and determines the
 * `{name}.vercel.app` production alias.
 */
export async function deployFilesToVercel(
	vercelToken: string,
	deploymentName: string,
	files: VercelDeployFile[],
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
	apiBaseUrl: string = VERCEL_API_BASE_URL,
): Promise<{ deploymentId: string }> {
	if (files.length === 0) {
		throw new Error("deployFilesToVercel: files must be non-empty");
	}
	for (const f of files) {
		if (
			f.file.length === 0 ||
			f.file.startsWith("/") ||
			f.file.includes("\\") ||
			f.file.split("/").includes("..")
		) {
			throw new Error(
				`deployFilesToVercel: invalid file path "${f.file}" — must be a relative POSIX path without ".." segments`,
			);
		}
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	const normalizedApiBaseUrl = apiBaseUrl.replace(/\/+$/, "");

	try {
		const res = await fetch(`${normalizedApiBaseUrl}/v13/deployments`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${vercelToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				name: deploymentName,
				target: "production",
				files: files.map((f) => ({
					file: f.file,
					data: f.data,
					encoding: "utf-8",
				})),
				projectSettings: {
					framework: null,
				},
			}),
			signal: controller.signal,
			...(normalizedApiBaseUrl !== VERCEL_API_BASE_URL
				? { redirect: "error" as const }
				: {}),
		});

		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(
				`Vercel deploy failed (${res.status}): ${body.slice(0, 200)}`,
			);
		}

		const data = (await res.json()) as {
			url: string;
			id: string;
			readyState: string;
		};

		// Poll until deployment is ready (static files are usually instant)
		if (data.readyState !== "READY") {
			await waitForReady(
				vercelToken,
				data.id,
				controller.signal,
				normalizedApiBaseUrl,
			);
		}

		return { deploymentId: data.id };
	} finally {
		clearTimeout(timeout);
	}
}

/** Deploy a single HTML file to Vercel and return the public URL. */
export async function deployToVercel(
	vercelToken: string,
	projectName: string,
	html: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<VercelDeployResult> {
	// GEO-294 byte-compat: deployment name is `triage-{lowercased project}`
	// and the deterministic `{name}.vercel.app` production alias is returned.
	const name = `triage-${projectName.toLowerCase()}`;
	const { deploymentId } = await deployFilesToVercel(
		vercelToken,
		name,
		[{ file: "index.html", data: html }],
		timeoutMs,
	);

	// Return the deterministic production URL ({name}.vercel.app).
	// Vercel SSO Protection blocks deployment-specific URLs and team-scoped
	// aliases, but the {name}.vercel.app domain is publicly accessible.
	return {
		url: `https://${name}.vercel.app`,
		deploymentId,
	};
}

async function waitForReady(
	token: string,
	deploymentId: string,
	signal: AbortSignal,
	apiBaseUrl: string,
): Promise<void> {
	for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

		const res = await fetch(`${apiBaseUrl}/v13/deployments/${deploymentId}`, {
			headers: { Authorization: `Bearer ${token}` },
			signal,
			...(apiBaseUrl !== VERCEL_API_BASE_URL
				? { redirect: "error" as const }
				: {}),
		});

		if (!res.ok) {
			throw new Error(`Vercel deployment status check failed (${res.status})`);
		}

		const data = (await res.json()) as { readyState: string };
		if (data.readyState === "READY") return;
		if (data.readyState === "ERROR" || data.readyState === "CANCELED") {
			throw new Error(`Vercel deployment ${data.readyState}`);
		}
	}

	throw new Error(
		`Vercel deployment not ready after ${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s`,
	);
}
