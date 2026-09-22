import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ReclosePeerNativeAdapter {
	abiVersion(): number;
	createListener(socketPath: string): number;
	accept(listenerHandle: number): number | null;
	readFrame(
		connectionHandle: number,
		maxBytes: number,
	): { complete: false } | { complete: true; frame: string };
	writeFrame(connectionHandle: number, frame: string): boolean;
	getPeerSnapshot(connectionHandle: number): ReclosePeerSnapshot;
	revalidatePeer(connectionHandle: number): ReclosePeerSnapshot;
	inspectProcess(pid: number): RecloseProcessSnapshot;
	close(handle: number): boolean;
}

export interface RecloseProcessSnapshot {
	pid: number;
	parentPid: number;
	uid: number;
	startSeconds: string;
	startMicroseconds: number;
	uniqueId: string;
	parentUniqueId: string;
	pidVersion: number;
	originalParentPidVersion: number;
}

export interface ReclosePeerSnapshot extends RecloseProcessSnapshot {
	effectiveUid: number;
	effectiveGid: number;
	auditPidVersion: number;
}

export type ReclosePeerNativeLoadResult =
	| { available: true; adapter: ReclosePeerNativeAdapter; modulePath: string }
	| {
			available: false;
			reason: "peer_adapter_unavailable";
			detail: string;
	  };

export interface ReclosePeerNativeLoadOptions {
	moduleDirectory?: string;
	platform?: NodeJS.Platform;
	arch?: string;
}

const require = createRequire(import.meta.url);

/**
 * Load only an exact platform/architecture Node-API module. The adapter is an
 * optional Darwin capability: Bridge startup and all non-Claude-reclose paths
 * must remain usable when the binary or host toolchain is absent.
 */
export async function loadReclosePeerNative(
	options: ReclosePeerNativeLoadOptions = {},
): Promise<ReclosePeerNativeLoadResult> {
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const moduleDirectory =
		options.moduleDirectory ??
		fileURLToPath(new URL("../native/", import.meta.url));
	const modulePath = join(
		moduleDirectory,
		`reclose-peer-${platform}-${arch}.node`,
	);

	if (platform !== "darwin") {
		return {
			available: false,
			reason: "peer_adapter_unavailable",
			detail: `unsupported platform for ${modulePath}`,
		};
	}

	try {
		const adapter = require(modulePath) as Partial<ReclosePeerNativeAdapter>;
		if (
			typeof adapter.abiVersion !== "function" ||
			adapter.abiVersion() !== 2 ||
			[
				"createListener",
				"accept",
				"readFrame",
				"writeFrame",
				"getPeerSnapshot",
				"revalidatePeer",
				"inspectProcess",
				"close",
			].some(
				(name) =>
					typeof adapter[name as keyof ReclosePeerNativeAdapter] !== "function",
			)
		) {
			return {
				available: false,
				reason: "peer_adapter_unavailable",
				detail: `unsupported native adapter ABI at ${modulePath}`,
			};
		}
		return {
			available: true,
			adapter: adapter as ReclosePeerNativeAdapter,
			modulePath,
		};
	} catch (error) {
		return {
			available: false,
			reason: "peer_adapter_unavailable",
			detail: `${modulePath}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
