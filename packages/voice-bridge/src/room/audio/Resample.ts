function clamp16(value: number): number {
	return Math.max(-32_768, Math.min(32_767, Math.trunc(value)));
}

export class Downmix48to24 {
	private bytes = Buffer.alloc(0);
	private pendingMono: number | null = null;

	push(chunk: Buffer): Buffer {
		let input = this.bytes.length
			? Buffer.concat([this.bytes, chunk])
			: Buffer.from(chunk);
		const completeBytes = input.length - (input.length % 4);
		this.bytes = Buffer.from(input.subarray(completeBytes));
		input = input.subarray(0, completeBytes);
		const output: number[] = [];
		for (let offset = 0; offset < input.length; offset += 4) {
			const mono = Math.trunc(
				(input.readInt16LE(offset) + input.readInt16LE(offset + 2)) / 2,
			);
			if (this.pendingMono === null) {
				this.pendingMono = mono;
			} else {
				output.push(clamp16((this.pendingMono + mono) / 2));
				this.pendingMono = null;
			}
		}
		const result = Buffer.alloc(output.length * 2);
		output.forEach((sample, index) => result.writeInt16LE(sample, index * 2));
		return result;
	}
}

export class Up24to48Stereo {
	private bytes = Buffer.alloc(0);
	private previous: number | null = null;

	push(chunk: Buffer): Buffer {
		let input = this.bytes.length
			? Buffer.concat([this.bytes, chunk])
			: Buffer.from(chunk);
		const completeBytes = input.length - (input.length % 2);
		this.bytes = Buffer.from(input.subarray(completeBytes));
		input = input.subarray(0, completeBytes);
		const output: number[] = [];
		for (let offset = 0; offset < input.length; offset += 2) {
			const sample = input.readInt16LE(offset);
			if (this.previous === null) {
				output.push(sample, sample);
			} else {
				output.push(clamp16((this.previous + sample) / 2), sample);
			}
			this.previous = sample;
		}
		const result = Buffer.alloc(output.length * 4);
		output.forEach((sample, index) => {
			const offset = index * 4;
			result.writeInt16LE(sample, offset);
			result.writeInt16LE(sample, offset + 2);
		});
		return result;
	}
}
