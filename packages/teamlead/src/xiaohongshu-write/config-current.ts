import type { AuthorityConfig } from "./authority-config.js";
import { verifyBoundaryAcceptance } from "./boundary-acceptance.js";
import {
	type InstallationBinding,
	readInstallationMetadata,
} from "./installation-metadata.js";
import { readImmutableFile, readRootReceipt } from "./trusted-files.js";

type Config = Pick<
	AuthorityConfig,
	| "serviceUid"
	| "providerConfig"
	| "acceptancePath"
	| "acceptancePublicKey"
	| "boundaryProbe"
> & {
	configDigest: string;
	installation: InstallationBinding;
	provider: { providerBinary: { sha256: string }; toolSchemaDigest: string };
};
/** Call only after loadAuthorityConfig. Recheck the same root-owned policy and
 * provider configuration plus signed acceptance; never accept replacement pins. */
export function createAuthorityConfigCurrent(
	policyPath: string,
	loaded: Config,
): () => void {
	const config = structuredClone(loaded);
	return () => {
		try {
			readImmutableFile(policyPath, {
				maxBytes: 64 * 1024,
				sha256: config.configDigest,
			});
			readImmutableFile(config.providerConfig.path, {
				maxBytes: 64 * 1024,
				sha256: config.providerConfig.sha256,
			});
			const proof = readRootReceipt(config.acceptancePath, {
				serviceUid: config.serviceUid,
				maxBytes: 4096,
			});
			verifyBoundaryAcceptance(
				new TextDecoder("utf-8", { fatal: true }).decode(proof),
				{
					publicKey: config.acceptancePublicKey,
					configDigest: config.configDigest,
					providerBinarySha256: config.provider.providerBinary.sha256,
					toolSchemaDigest: config.provider.toolSchemaDigest,
					probeSha256: config.boundaryProbe.sha256,
					...readInstallationMetadata(config.installation),
				},
			);
		} catch {
			throw Error("authority_configuration_changed");
		}
	};
}
