import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fsyncSync,
	lstatSync,
	openSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import {
	ATTACHMENT_HARD_LIMIT,
	type AttachmentProbePolicy,
	type AttachmentProbeReceipt,
	measureAttachmentLimit,
	validAttachmentProbeReceipt,
} from "./attachment-probe.js";
import { parseStrictJson } from "./canonical.js";
import { readPrivateFile } from "./trusted-files.js";

type Options = {
	stateRoot: string;
	serviceUid: number;
	policy: AttachmentProbePolicy;
	source: Parameters<typeof measureAttachmentLimit>[0]["source"];
	assertCurrent: () => void;
	now?: () => number;
};
/** Private authority cache, never an approval receipt. Invalid/missing cache
 * cannot raise the independent ceiling or stop read-service activation. */
export class XhsAttachmentProbeCache {
	private readonly root: string;
	private readonly uid: number;
	private readonly identity: string;
	private readonly policy: AttachmentProbePolicy;
	private readonly path: string;
	private active: Promise<number> | undefined;
	private nextProbeAt = 0;
	constructor(private readonly options: Options) {
		this.root = options.stateRoot;
		this.uid = options.serviceUid;
		this.policy = structuredClone(options.policy);
		const stat = lstatSync(this.root);
		if (
			!isAbsolute(this.root) ||
			normalize(this.root) !== this.root ||
			!stat.isDirectory() ||
			stat.uid !== this.uid ||
			process.getuid?.() !== this.uid ||
			(stat.mode & 0o7777) !== 0o700
		)
			throw Error("attachment_probe_cache_unavailable");
		this.identity = `${stat.dev}:${stat.ino}`;
		const key = createHash("sha256")
			.update(
				JSON.stringify([
					this.policy.guildId,
					this.policy.channelId,
					this.policy.botId,
				]),
			)
			.digest("hex");
		this.path = join(this.root, `attachment-probe-${key}.json`);
	}
	private current() {
		this.options.assertCurrent();
		const stat = lstatSync(this.root);
		if (
			!stat.isDirectory() ||
			stat.uid !== this.uid ||
			(stat.mode & 0o7777) !== 0o700 ||
			`${stat.dev}:${stat.ino}` !== this.identity
		)
			throw Error("attachment_probe_cache_unavailable");
	}
	private read(): AttachmentProbeReceipt | null {
		try {
			this.current();
			const bytes = readPrivateFile(this.path, {
				root: this.root,
				uid: this.uid,
				maxBytes: 4096,
			});
			return validAttachmentProbeReceipt(
				parseStrictJson(
					new TextDecoder("utf-8", { fatal: true }).decode(bytes),
				),
				this.policy,
				(this.options.now ?? Date.now)(),
			);
		} catch {
			return null;
		}
	}
	limit(): number {
		return this.read()?.measuredBytes ?? ATTACHMENT_HARD_LIMIT;
	}
	private save(receipt: AttachmentProbeReceipt) {
		this.current();
		const path = join(this.root, `.attachment-probe-${randomUUID()}.tmp`);
		let fd: number | undefined,
			created = false;
		try {
			fd = openSync(
				path,
				constants.O_WRONLY |
					constants.O_CREAT |
					constants.O_EXCL |
					constants.O_NOFOLLOW,
				0o600,
			);
			created = true;
			writeFileSync(fd, JSON.stringify(receipt));
			fsyncSync(fd);
			closeSync(fd);
			fd = undefined;
			this.current();
			renameSync(path, this.path);
			created = false;
			const directory = openSync(
				this.root,
				constants.O_RDONLY | constants.O_NOFOLLOW,
			);
			try {
				fsyncSync(directory);
			} finally {
				closeSync(directory);
			}
			this.current();
		} finally {
			if (fd !== undefined) closeSync(fd);
			if (created) {
				this.current();
				unlinkSync(path);
			}
		}
	}
	poll(signal?: AbortSignal): Promise<number> {
		if (this.active) return this.active;
		this.active = (async () => {
			try {
				this.current();
				signal?.throwIfAborted();
				const cached = this.read();
				if (cached) return cached.measuredBytes;
				const now = (this.options.now ?? Date.now)();
				if (now < this.nextProbeAt) return ATTACHMENT_HARD_LIMIT;
				this.nextProbeAt = now + 300000;

				const receipt = await measureAttachmentLimit({
					policy: this.policy,
					source: this.options.source,
					now: this.options.now,
					assertCurrent: () => {
						this.current();
						signal?.throwIfAborted();
					},
				});
				this.current();
				signal?.throwIfAborted();
				if (
					!receipt ||
					!validAttachmentProbeReceipt(
						receipt,
						this.policy,
						(this.options.now ?? Date.now)(),
					)
				)
					return ATTACHMENT_HARD_LIMIT;
				this.save(receipt);
				return receipt.measuredBytes;
			} catch {
				return ATTACHMENT_HARD_LIMIT;
			}
		})().finally(() => {
			this.active = undefined;
		});
		return this.active;
	}
}
