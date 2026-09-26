/**
 * FLY-1062 broker PR · publish-shell executor (plan §3 ②/③): publish the
 * STAGED thin-shell tarball with the in-memory npm GAT.
 *
 * Order of authority:
 *  1. broker-side re-verification of the staged bytes (rehash == approved
 *     sha256 + the authoritative content gate — the prepare stage ran in an
 *     untrusted domain and is NOT believed);
 *  2. registry preflight: if the version already exists, it must be THESE
 *     exact bytes (local sha256 of the downloaded tarball == approved) →
 *     idempotent success; anything else refuses;
 *  3. in-process registry PUT (the GAT never enters a child process);
 *  4. a 409/403 conflict on PUT is not taken as success — the published
 *     tarball is re-downloaded and re-hashed against the approved sha256.
 */

import {
	fetchPublishedTarballSha256,
	publishTarball,
} from "./registry-client.js";
import { verifyShellTarball } from "./shell-verify.js";

export interface PublishShellArgs {
	stagedPath: string;
	/** the sha256 the founder approval is bound to */
	sha256: string;
	registryUrl: string;
}

export async function executePublishShell(
	args: PublishShellArgs,
	npmGatToken: string,
): Promise<Record<string, string>> {
	// 1. authoritative verification in the broker's trust domain
	const identity = verifyShellTarball(args.stagedPath, args.sha256);

	// 2. registry preflight — clean semver never reused with different bytes
	const existing = await fetchPublishedTarballSha256({
		registryUrl: args.registryUrl,
		name: identity.name,
		version: identity.version,
		token: npmGatToken,
	});
	if (existing !== null) {
		if (existing === args.sha256) {
			return {
				name: identity.name,
				version: identity.version,
				idempotent: "true",
			};
		}
		throw new Error(
			`${identity.name}@${identity.version} already exists with DIFFERENT content — bump the shell version`,
		);
	}

	// 3. in-process publish — the tarball's FULL package.json rides as the
	// version manifest (bin/engines/etc.; Codex code R1 HIGH)
	const status = await publishTarball({
		registryUrl: args.registryUrl,
		token: npmGatToken,
		name: identity.name,
		version: identity.version,
		tarballPath: args.stagedPath,
		manifest: identity.manifest,
	});
	if (status === 200 || status === 201) {
		return { name: identity.name, version: identity.version };
	}
	if (status === 409 || status === 403) {
		// 4. conflict is never taken as success — re-download and re-hash
		const published = await fetchPublishedTarballSha256({
			registryUrl: args.registryUrl,
			name: identity.name,
			version: identity.version,
			token: npmGatToken,
		});
		if (published === args.sha256) {
			return {
				name: identity.name,
				version: identity.version,
				idempotent: "true",
			};
		}
		throw new Error(
			`publish conflict (HTTP ${status}) and the registry content does not match the approved artifact`,
		);
	}
	throw new Error(`registry publish refused (HTTP ${status})`);
}
