import { deflateRawSync } from "node:zlib";
/** Small ZIP fixtures, including deliberately malformed entries, without filesystem extraction. */
export function receiptZip(
	entries: {
		name: string;
		data: string;
		mode?: number;
		flags?: number;
		size?: number;
		compress?: boolean;
	}[],
): Buffer {
	const locals: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const e of entries) {
		const name = Buffer.from(e.name);
		const content = Buffer.from(e.data);
		const data = e.compress ? deflateRawSync(content) : content;
		let crc = 0xffffffff;
		for (const byte of content) {
			crc ^= byte;
			for (let i = 0; i < 8; i++)
				crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
		crc = (crc ^ 0xffffffff) >>> 0;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(e.flags ?? 0, 6);
		local.writeUInt16LE(e.compress ? 8 : 0, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(e.size ?? content.length, 22);
		local.writeUInt16LE(name.length, 26);
		const c = Buffer.alloc(46);
		c.writeUInt32LE(0x02014b50, 0);
		c.writeUInt16LE(0x0314, 4);
		c.writeUInt16LE(20, 6);
		c.writeUInt16LE(e.flags ?? 0, 8);
		c.writeUInt16LE(e.compress ? 8 : 0, 10);
		c.writeUInt32LE(crc, 16);
		c.writeUInt32LE(data.length, 20);
		c.writeUInt32LE(e.size ?? content.length, 24);
		c.writeUInt16LE(name.length, 28);
		c.writeUInt32LE(((e.mode ?? 0o100644) * 65536) >>> 0, 38);
		c.writeUInt32LE(offset, 42);
		locals.push(local, name, data);
		central.push(c, name);
		offset += local.length + name.length + data.length;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}
