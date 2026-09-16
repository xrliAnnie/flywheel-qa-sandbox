import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readSync,
	realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { ReleaseControlNotice } from "./activation-store.js";
import type { CustomerReleaseAuthority } from "./authority.js";
import { releaseMessageDigest } from "./cards.js";
import type { ReleaseControlDelivery } from "./control-delivery.js";
import { activationCard } from "./controls.js";

/** A deployment-owned file requests delivery only. It cannot enable the flag,
 * mint a founder receipt or bypass the authenticated Gateway click. */
export function readReleaseControlRequest(
	directory: string,
	file:
		| "control.json"
		| "manual.json"
		| "intake.json"
		| "accounting.json" = "control.json",
): unknown | null {
	if (
		file !== "control.json" &&
		file !== "manual.json" &&
		file !== "intake.json" &&
		file !== "accounting.json"
	)
		return null;
	try {
		const root = resolve(directory);
		if (realpathSync(root) !== root) return null;
		const fd = openSync(
			join(root, file),
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		try {
			const before = fstatSync(fd);
			if (!before.isFile() || before.size <= 0 || before.size > 16384)
				return null;
			const bytes = Buffer.alloc(before.size + 1);
			let length = 0;
			while (length < bytes.length) {
				const count = readSync(fd, bytes, length, bytes.length - length, null);
				if (!count) break;
				length += count;
			}
			const after = fstatSync(fd);
			if (
				length !== before.size ||
				before.size !== after.size ||
				before.mtimeMs !== after.mtimeMs ||
				before.ctimeMs !== after.ctimeMs
			)
				return null;
			return JSON.parse(bytes.subarray(0, length).toString("utf8"));
		} finally {
			closeSync(fd);
		}
	} catch {
		return null;
	}
}
export class ReleaseControlTrigger {
	private last: { key: string; at: number } | null = null;
	constructor(
		private readonly options: {
			snapshot: () => ReturnType<CustomerReleaseAuthority["read"]>;
			read: () => unknown | null;
			delivery: Pick<ReleaseControlDelivery, "deliver">;
			now: () => number;
		},
	) {}
	async tick(signal?: AbortSignal): Promise<void> {
		try {
			signal?.throwIfAborted();
			const snapshot = this.options.snapshot(),
				value = this.options.read(),
				now = this.options.now();
			if (
				!snapshot ||
				snapshot.config.mode === "observe" ||
				!value ||
				typeof value !== "object" ||
				Array.isArray(value)
			)
				return;
			const raw = value as Record<string, unknown>;
			const keys = [
				"schemaVersion",
				"action",
				"noticeId",
				"epoch",
				"identityDigest",
				"evidenceBundleDigest",
				"expiresAt",
			];
			if (
				Object.keys(raw).length !== keys.length ||
				keys.some((key) => !Object.hasOwn(raw, key)) ||
				raw.schemaVersion !== 1 ||
				(raw.action !== "enable" && raw.action !== "disable") ||
				typeof raw.noticeId !== "string" ||
				!/^[a-f0-9]{32}$/.test(raw.noticeId) ||
				raw.epoch !== snapshot.target.epoch ||
				raw.identityDigest !== snapshot.identity.identityDigest ||
				typeof raw.evidenceBundleDigest !== "string" ||
				!/^[a-f0-9]{64}$/.test(raw.evidenceBundleDigest) ||
				!Number.isSafeInteger(raw.expiresAt) ||
				!Number.isSafeInteger(now) ||
				now < 0 ||
				(raw.expiresAt as number) <= now ||
				(raw.action === "enable" &&
					(snapshot.config.mode !== "canary" ||
						!snapshot.evidenceDigest ||
						raw.evidenceBundleDigest !== snapshot.evidenceDigest))
			)
				return;
			const intent: Omit<ReleaseControlNotice, "messageId" | "messageDigest"> =
				{
					action: raw.action,
					noticeId: raw.noticeId,
					epoch: snapshot.target.epoch,
					identityDigest: snapshot.identity.identityDigest,
					evidenceBundleDigest: raw.evidenceBundleDigest,
					expiresAt: raw.expiresAt as number,
					policyRevision: snapshot.identity.policyRevision,
					applicationId: snapshot.target.applicationId,
					channelId: snapshot.target.channelId,
					botUserId: snapshot.target.botUserId,
				};
			const key = JSON.stringify(intent);
			if (
				this.last?.key === key &&
				now >= this.last.at &&
				now - this.last.at < 30000
			)
				return;
			this.last = { key, at: now };
			await this.options.delivery.deliver(
				{
					...intent,
					messageDigest: releaseMessageDigest(activationCard(intent)),
				},
				signal,
			);
		} catch {
			// No card is authorization; malformed/unavailable requests remain inert.
		}
	}
}
