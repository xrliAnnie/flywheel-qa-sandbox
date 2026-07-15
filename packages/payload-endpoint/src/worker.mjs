// FLY-1062 PR3 · Cloudflare Worker entry — the ONLY vendor-shaped file.
//
// Everything testable lives in handler.mjs (pure, node-run); this file just
// binds the Worker environment:
//   env.PAYLOADS                          — R2 bucket binding (wrangler.toml)
//   env.FW_BETA_PUBLISH_TOKEN_SHA256      — worker secret: sha256 hex of the
//   env.FW_CUSTOMER_RELEASE_TOKEN_SHA256    capability token (NEVER the token
//   env.FW_OPS_ADMIN_TOKEN_SHA256           itself — plan §B0-6)
//
// Deploys via `wrangler deploy` run BY THE FOUNDER from her own Cloudflare
// account (plan §3 底线二: the vendor control-plane credential never enters
// repo secrets or any workflow).
import { handleRequest } from "./handler.mjs";

export default {
	async fetch(request, env) {
		return handleRequest(request, {
			bucket: env.PAYLOADS,
			secrets: {
				betaPublishTokenSha256: env.FW_BETA_PUBLISH_TOKEN_SHA256,
				customerReleaseTokenSha256: env.FW_CUSTOMER_RELEASE_TOKEN_SHA256,
				opsAdminTokenSha256: env.FW_OPS_ADMIN_TOKEN_SHA256,
			},
			now: () => new Date(),
			// no logger wired on purpose: production emits ZERO log lines, so a
			// key / token can never leak through observability plumbing.
		});
	},
};
