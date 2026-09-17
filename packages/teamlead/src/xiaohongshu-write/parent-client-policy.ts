import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { createLeadCapabilityContext } from "../lead-capabilities/runtime-context.js";
import { XhsAuthorityClient } from "./authority-client.js";
import {
	type AuthorityConfig,
	parseAuthorityConfig,
	verifyProviderConfigBinding,
} from "./authority-config.js";
import { verifyBoundaryAcceptance } from "./boundary-acceptance.js";
import { readInstallationMetadata } from "./installation-metadata.js";
import { readImmutableFile, readRootReceipt } from "./trusted-files.js";

const selectionSchema = z
	.object({
		projectId: z.string().min(1).max(256),
		leadId: z.string().min(1).max(256),
		activationId: z.string().min(1).max(256),
	})
	.strict();
type ScopePolicy = Pick<
	AuthorityConfig,
	"enabled" | "modelUid" | "serviceUid" | "serviceGid" | "ingressGid"
> & { registry: readonly { projectId: string; leadId: string }[] };
/** Transport scope is available for reads regardless of the founder write gate.
 * Only the authority's preparation/execution paths may evaluate write enablement. */
export function deriveAuthorityClientScope(
	config: ScopePolicy,
	input: unknown,
	actual: { uid: number; groups: number[] },
) {
	try {
		const scope = selectionSchema.parse(input);
		if (
			actual.uid <= 0 ||
			actual.uid !== config.modelUid ||
			actual.uid === config.serviceUid ||
			actual.groups.includes(config.serviceGid) ||
			!actual.groups.includes(config.ingressGid) ||
			config.registry.filter(
				(entry) =>
					entry.projectId === scope.projectId && entry.leadId === scope.leadId,
			).length !== 1
		)
			throw Error();
		return scope;
	} catch {
		throw Error("authority_client_policy_unavailable");
	}
}
function checkIngressSocket(config: AuthorityConfig) {
	for (let path = dirname(config.ingressSocket); ; path = dirname(path)) {
		const stat = lstatSync(path);
		if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0)
			throw Error();
		if (path === dirname(path)) break;
	}
	const socket = lstatSync(config.ingressSocket);
	if (
		!socket.isSocket() ||
		socket.uid !== 0 ||
		socket.gid !== config.ingressGid ||
		socket.nlink !== 1 ||
		(socket.mode & 0o7777) !== 0o660
	)
		throw Error();
}
function actualPrincipal() {
	if (!process.getuid || !process.getgroups) throw Error();
	return { uid: process.getuid(), groups: process.getgroups() };
}
function loadPublicTransportPolicy(policyPath: string) {
	const raw = readImmutableFile(policyPath, { maxBytes: 64 * 1024 });
	const decode = (bytes: Buffer) =>
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	const config = parseAuthorityConfig(decode(raw));
	const configDigest = createHash("sha256").update(raw).digest("hex");
	const installation = readInstallationMetadata();
	const verify = () => {
		readImmutableFile(policyPath, {
			maxBytes: 64 * 1024,
			sha256: configDigest,
		});
		const provider = verifyProviderConfigBinding(
			config,
			decode(
				readImmutableFile(config.providerConfig.path, {
					maxBytes: 64 * 1024,
					sha256: config.providerConfig.sha256,
				}),
			),
		);
		readImmutableFile(config.peerHelper.path, {
			maxBytes: 1024 * 1024,
			executable: true,
			sha256: config.peerHelper.sha256,
		});
		verifyBoundaryAcceptance(
			decode(
				readRootReceipt(config.acceptancePath, {
					serviceUid: config.serviceUid,
					maxBytes: 4096,
				}),
			),
			{
				publicKey: config.acceptancePublicKey,
				configDigest,
				providerBinarySha256: provider.providerBinary.sha256,
				toolSchemaDigest: provider.toolSchemaDigest,
				probeSha256: config.boundaryProbe.sha256,
				...readInstallationMetadata(installation),
			},
		);
		checkIngressSocket(config);
	};
	verify();
	return { config, verify };
}
/** 2519 parent factory. The Lead activation check remains mandatory for all
 * model operations; only public root policy/proof is read here. */
export function createParentXhsAuthorityClient(options: {
	policyPath: string;
	env: NodeJS.ProcessEnv;
	activationId: string;
}) {
	try {
		const { config, verify } = loadPublicTransportPolicy(options.policyPath);
		const env = Object.freeze({ ...options.env });
		const scope = deriveAuthorityClientScope(
			config,
			{
				projectId: env.FLYWHEEL_PROJECT_NAME,
				leadId: env.FLYWHEEL_LEAD_ID,
				activationId: options.activationId,
			},
			actualPrincipal(),
		);
		const trusted = createLeadCapabilityContext(env);
		const assertCurrent = () => {
			trusted.assertActivationCurrent();
			deriveAuthorityClientScope(config, scope, actualPrincipal());
			verify();
		};
		assertCurrent();
		return new XhsAuthorityClient({
			socketPath: config.ingressSocket,
			// launchd calls listen as root; verify() pins this policy socket and ancestry.
			authorityUid: 0,
			peerHelper: config.peerHelper,
			scope,
			assertCurrent,
		});
	} catch {
		throw Error("authority_client_policy_unavailable");
	}
}
/** Bridge owns delivery, not a Lead activation. Its fixed attribution permits
 * only non-authorizing notification list/ACK, even if called with untyped input. */
export function createBridgeXhsNotificationClients(policyPath: string) {
	try {
		const { config, verify } = loadPublicTransportPolicy(policyPath);
		return config.registry.map(({ projectId, leadId }) => {
			const selection = {
				projectId,
				leadId,
				activationId: "bridge-xhs-notifications",
			};
			const assertCurrent = () => {
				verify();
				deriveAuthorityClientScope(config, selection, actualPrincipal());
			};
			assertCurrent();
			const transport = new XhsAuthorityClient({
				socketPath: config.ingressSocket,
				// launchd calls listen as root; verify() pins this policy socket and ancestry.
				authorityUid: 0,
				peerHelper: config.peerHelper,
				scope: selection,
				assertCurrent,
			});
			return {
				scope: { projectId, leadId },
				client: {
					async call(
						action: "notifications" | "notification_ack",
						input: unknown,
						signal?: AbortSignal,
					) {
						if (action !== "notifications" && action !== "notification_ack")
							throw Error("notification_action_denied");
						return transport.call(action, input, signal);
					},
				},
			};
		});
	} catch {
		throw Error("authority_client_policy_unavailable");
	}
}

/** Fixed Bridge write routes supply a freshly verified backend identity guard.
 * Public root policy still limits scope; no authority secrets enter Bridge. */
export function createBridgeXhsWriteClient(options: {
	policyPath: string;
	scope: z.infer<typeof selectionSchema>;
	assertCurrent(): void;
}) {
	try {
		options.assertCurrent();
		const { config, verify } = loadPublicTransportPolicy(options.policyPath);
		const scope = deriveAuthorityClientScope(
			config,
			options.scope,
			actualPrincipal(),
		);
		const assertCurrent = () => {
			options.assertCurrent();
			verify();
			deriveAuthorityClientScope(config, scope, actualPrincipal());
		};
		assertCurrent();
		return new XhsAuthorityClient({
			socketPath: config.ingressSocket,
			// launchd calls listen as root; verify() pins this policy socket and ancestry.
			authorityUid: 0,
			peerHelper: config.peerHelper,
			scope,
			assertCurrent,
		});
	} catch {
		throw Error("authority_client_policy_unavailable");
	}
}
