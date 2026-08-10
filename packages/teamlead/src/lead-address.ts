import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";

const SOCKET_PATH_BUDGET_BYTES = 90;

export interface LeadAddress {
	socketPath: string;
	sessionTarget: "=main";
	bodyPaneTarget: "%0";
}

export interface LeadRuntimeManifest {
	projectName?: unknown;
	leadId?: unknown;
	socketPath?: unknown;
}

function readablePrefix(exactKey: string): string {
	const prefix = exactKey
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 20);
	return prefix || "lead";
}

/**
 * FLY-1663 canonical per-Lead tmux socket resolver.
 *
 * Runtime writers derive this value from the exact key rather than trusting
 * manifest runtime evidence. The 90-byte budget leaves margin below macOS
 * sockaddr_un.sun_path.
 */
export function deriveLeadSocketPath(
	exactKey: string,
	stateDir: string,
): string {
	if (exactKey.length === 0) {
		throw new Error("lead exact key is required");
	}
	if (!isAbsolute(stateDir)) {
		throw new Error(
			`lead socket state directory must be absolute: ${stateDir}`,
		);
	}
	const hash = createHash("sha256").update(exactKey).digest("hex").slice(0, 16);
	const socketPath = join(
		stateDir,
		"sock",
		`fw-${readablePrefix(exactKey)}-${hash}.sock`,
	);
	const bytes = Buffer.byteLength(socketPath);
	if (bytes >= SOCKET_PATH_BUDGET_BYTES) {
		throw new Error(
			`lead socket path must be < 90 bytes (got ${bytes}): ${socketPath}`,
		);
	}
	return socketPath;
}

export function deriveLeadAddress(
	exactKey: string,
	stateDir: string,
): LeadAddress {
	return {
		socketPath: deriveLeadSocketPath(exactKey, stateDir),
		sessionTarget: "=main",
		bodyPaneTarget: "%0",
	};
}

/** Resolve only wrapper-published canonical runtime evidence. */
export function leadAddressFromManifest(
	projectName: string,
	leadId: string,
	stateDir: string,
	manifest: LeadRuntimeManifest,
): LeadAddress | null {
	if (manifest.projectName !== projectName || manifest.leadId !== leadId) {
		return null;
	}
	const exactKey = `${projectName}/${leadId}`;
	const canonical = deriveLeadAddress(exactKey, stateDir);
	return manifest.socketPath === canonical.socketPath ? canonical : null;
}
