/**
 * GEO-294: Vercel Deploy helper — deploy HTML as a static site.
 * Uses Vercel REST API v13/deployments with inline file content.
 *
 * Deploys as `target: "production"` so the site is publicly accessible.
 * Returns the production alias URL (not the deployment-specific URL)
 * because Vercel SSO Protection blocks deployment URLs on Hobby plan.
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_ATTEMPTS = 15; // 30s max polling

export interface VercelDeployResult {
	url: string;
	deploymentId: string;
}

/** Deploy a single HTML file to Vercel and return the public URL. */
export async function deployToVercel(
	vercelToken: string,
	projectName: string,
	html: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<VercelDeployResult> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const res = await fetch("https://api.vercel.com/v13/deployments", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${vercelToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				name: `triage-${projectName.toLowerCase()}`,
				target: "production",
				files: [
					{
						file: "index.html",
						data: html,
						encoding: "utf-8",
					},
				],
				projectSettings: {
					framework: null,
				},
			}),
			signal: controller.signal,
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
			await waitForReady(vercelToken, data.id, controller.signal);
		}

		// Return the deterministic production URL ({name}.vercel.app).
		// Vercel SSO Protection blocks deployment-specific URLs and team-scoped
		// aliases, but the {name}.vercel.app domain is publicly accessible.
		const name = `triage-${projectName.toLowerCase()}`;
		return {
			url: `https://${name}.vercel.app`,
			deploymentId: data.id,
		};
	} finally {
		clearTimeout(timeout);
	}
}

async function waitForReady(
	token: string,
	deploymentId: string,
	signal: AbortSignal,
): Promise<void> {
	for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

		const res = await fetch(
			`https://api.vercel.com/v13/deployments/${deploymentId}`,
			{
				headers: { Authorization: `Bearer ${token}` },
				signal,
			},
		);

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
