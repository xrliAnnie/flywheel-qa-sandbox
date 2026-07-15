import { randomBytes, randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { StateStore } from "../StateStore.js";
import type {
	DeliverySecret,
	DeliverySecretProvider,
} from "./lead-event-delivery.js";

export interface FileDeliverySecretProviderOptions {
	store: StateStore;
	secretPath?: string;
}

export class FileDeliverySecretProvider implements DeliverySecretProvider {
	private readonly secretPath: string;

	constructor(private readonly options: FileDeliverySecretProviderOptions) {
		this.secretPath =
			options.secretPath ??
			process.env.FLYWHEEL_DELIVERY_SECRET_PATH?.trim() ??
			join(homedir(), ".flywheel", "delivery-secret");
	}

	getActive(): DeliverySecret {
		const marker = this.options.store.getDeliverySecretState();
		if (!marker) return this.provision(false);
		if (marker.state === "PREPARED") {
			if (!marker.preparedSecretId) {
				throw new Error("PREPARED delivery secret marker has no secret id");
			}
			const prepared = this.readVersion(marker.preparedSecretId, "PREPARED");
			if (
				!this.options.store.activatePreparedDeliverySecret(
					marker.preparedSecretId,
				)
			) {
				throw new Error(
					"delivery secret PREPARED→ACTIVE reconciliation failed",
				);
			}
			return prepared;
		}
		if (!marker.activeSecretId) {
			throw new Error("ACTIVE delivery secret marker has no secret id");
		}
		return this.readVersion(marker.activeSecretId, "ACTIVE");
	}

	rotate(): DeliverySecret {
		this.getActive();
		return this.provision(true);
	}

	private provision(rotation: boolean): DeliverySecret {
		mkdirSync(dirname(this.secretPath), { recursive: true });
		if (!rotation) this.removeOrphanVersions();
		const secret: DeliverySecret = {
			secretId: randomUUID(),
			key: randomBytes(32),
		};
		const versionPath = this.versionPath(secret.secretId);
		const fd = openSync(versionPath, "wx", 0o600);
		try {
			writeFileSync(
				fd,
				JSON.stringify({
					secret_id: secret.secretId,
					key: secret.key.toString("base64"),
				}),
				{ encoding: "utf8" },
			);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		this.options.store.prepareDeliverySecret(secret.secretId);
		if (!this.options.store.activatePreparedDeliverySecret(secret.secretId)) {
			throw new Error("delivery secret activation failed");
		}
		return secret;
	}

	private readVersion(
		secretId: string,
		markerState: "PREPARED" | "ACTIVE",
	): DeliverySecret {
		const path = this.versionPath(secretId);
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(path);
		} catch {
			throw new Error(
				`${markerState} delivery secret ${secretId} is missing at ${path}`,
			);
		}
		if (stat.isSymbolicLink() || !stat.isFile()) {
			throw new Error(
				`delivery secret must be a regular non-symlink file: ${path}`,
			);
		}
		if ((stat.mode & 0o777) !== 0o600) {
			throw new Error(`delivery secret must have mode 0600: ${path}`);
		}
		if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
			throw new Error(
				`delivery secret owner does not match bridge uid: ${path}`,
			);
		}
		let parsed: { secret_id?: unknown; key?: unknown };
		try {
			parsed = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			throw new Error(`delivery secret is corrupt: ${path}`);
		}
		if (parsed.secret_id !== secretId || typeof parsed.key !== "string") {
			throw new Error(`delivery secret identity is corrupt: ${path}`);
		}
		const key = Buffer.from(parsed.key, "base64");
		if (key.length < 32)
			throw new Error(`delivery secret key is too short: ${path}`);
		return { secretId, key };
	}

	private removeOrphanVersions(): void {
		const dir = dirname(this.secretPath);
		const prefix = `${basename(this.secretPath)}.`;
		for (const name of readdirSync(dir)) {
			if (name.startsWith(prefix)) {
				rmSync(join(dir, name), { force: true });
			}
		}
	}

	private versionPath(secretId: string): string {
		return `${this.secretPath}.${secretId}`;
	}
}
