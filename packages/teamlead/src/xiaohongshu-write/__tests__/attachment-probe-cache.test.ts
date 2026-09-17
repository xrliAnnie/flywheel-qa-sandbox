import {
	chmodSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { XhsAttachmentProbeCache } from "../attachment-probe-cache.js";
import type { ReviewFile } from "../preview.js";

const policy = {
	guildId: "12345678901234567",
	channelId: "12345678901234568",
	botId: "12345678901234569",
	userChannelIds: ["12345678901234570"],
};
it("persists private bound receipts, reuses across restart and re-probes on expiry", async () => {
	const root = mkdtempSync("/tmp/xhs-probe-cache-");
	let now = 1789470000000,
		file: ReviewFile,
		content: string;
	const source = {
		channelGuild: async () => policy.guildId,
		send: vi.fn(async (text: string, files: ReviewFile[]) => {
			file = files[0]!;
			content = text;
			return "12345678901234571";
		}),
		fetch: async () => ({
			id: "12345678901234571",
			channelId: policy.channelId,
			authorId: policy.botId,
			content,
			attachments: [
				{ id: "12345678901234572", name: file.name, size: file.bytes.length },
			],
		}),
		readAttachment: async () => file.bytes,
		remove: async () => {},
	};
	const options = {
		stateRoot: root,
		serviceUid: process.getuid!(),
		policy,
		source,
		assertCurrent: () => {},
		now: () => now,
	};
	try {
		const first = new XhsAttachmentProbeCache(options);
		expect(first.limit()).toBe(10 * 1024 * 1024);
		await Promise.all([first.poll(), first.poll()]);
		expect(source.send).toHaveBeenCalledOnce();
		const files = readdirSync(root);
		expect(files).toHaveLength(1);
		const path = join(root, files[0]!);
		expect(lstatSync(path).mode & 0o777).toBe(0o600);
		const second = new XhsAttachmentProbeCache(options);
		await second.poll();
		expect(source.send).toHaveBeenCalledOnce();
		const proof = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(path, JSON.stringify({ ...proof, measuredBytes: 1024 }));
		expect(second.limit()).toBe(1024);
		chmodSync(path, 0o644);
		expect(second.limit()).toBe(10 * 1024 * 1024);
		chmodSync(path, 0o600);
		now += 86400_001;
		await second.poll();
		expect(source.send).toHaveBeenCalledTimes(2);
		expect(second.limit()).toBe(10 * 1024 * 1024);
		now += 86400_001;
		source.send.mockRejectedValue(Error("private failure"));
		await second.poll();
		await second.poll();
		expect(source.send).toHaveBeenCalledTimes(3);
		now += 300001;
		await second.poll();
		expect(source.send).toHaveBeenCalledTimes(4);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
