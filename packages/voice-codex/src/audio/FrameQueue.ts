export class FrameQueue {
	private readonly frames: Buffer[] = [];
	private residue = Buffer.alloc(0);

	constructor(private readonly frameBytes: number) {
		if (!Number.isInteger(frameBytes) || frameBytes <= 0) {
			throw new Error("frameBytes must be a positive integer");
		}
	}

	push(chunk: Buffer): void {
		if (chunk.length === 0) return;
		let bytes = this.residue.length
			? Buffer.concat([this.residue, chunk])
			: Buffer.from(chunk);
		while (bytes.length >= this.frameBytes) {
			this.frames.push(Buffer.from(bytes.subarray(0, this.frameBytes)));
			bytes = bytes.subarray(this.frameBytes);
		}
		this.residue = Buffer.from(bytes);
	}

	take(): Buffer | null {
		return this.frames.shift() ?? null;
	}

	depth(): number {
		return this.frames.length;
	}

	residueBytes(): number {
		return this.residue.length;
	}

	flush(): void {
		this.frames.length = 0;
		this.residue = Buffer.alloc(0);
	}
}
