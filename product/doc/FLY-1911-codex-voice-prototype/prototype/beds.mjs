/* 等待音的取样函数。单独一个文件,是为了能【离线渲染真正在跑的这份代码】来量它,
 * 而不是量一份抄过去的副本。⛔ 桥里那条混音路径(冻结过、跑过两场遮蔽测量)一个字没动 ——
 * 换的是【放哪一段】,不是【怎么放】。*/
const SR = 48000;

// 音乐盒族。她最后定的是 B(更疏更慢-最安静);A 是她在房里真听过 46 秒的那一版,留着。
// ⚠️ 每个变体自己一份音符缓存 —— 间隔不同,第 k 个音不是同一个音。
const N5 = [261.63, 293.66, 329.63, 392.0, 440.0];
const hash = (k) => {
	let x = (k * 1103515245 + 12345) & 0x7fffffff;
	x ^= x >>> 13;
	return (x * 1274126177) & 0x7fffffff;
};
const mkBox = ({ step, decay, amp }) => {
	const cache = new Map();
	const noteIdx = (k) => {
		if (k <= 0) return 2;
		const hit = cache.get(k);
		if (hit !== undefined) return hit;
		const v = Math.max(0, Math.min(4, noteIdx(k - 1) + ((hash(k) % 3) - 1)));
		cache.set(k, v);
		return v;
	};
	const span = Math.min(2.6, step * 3.2),
		keep = Math.ceil(span / step) + 1;
	return (n) => {
		const t = n / SR,
			k0 = Math.floor(t / step);
		let s = 0;
		for (let j = 0; j < keep; j++) {
			const k = k0 - j;
			if (k < 0) continue;
			const ts = t - k * step;
			if (ts < 0 || ts > span) continue;
			const f = N5[noteIdx(k)] * ((hash(k) >>> 8) % 100 < 25 ? 2 : 1);
			const env = Math.exp(-decay * ts);
			s +=
				(Math.sin(2 * Math.PI * f * ts) +
					0.28 *
						Math.sin(2 * Math.PI * 4 * f * ts) *
						Math.exp(-decay * 2.2 * ts)) *
				env *
				0.5;
		}
		return s * amp;
	};
};

// 4 气流:带通噪声。用状态变量滤波器实时滤白噪 —— 中心约 700Hz。
let lp = 0,
	bp = 0,
	tame = 0;
const AIR_F = 2 * Math.sin((Math.PI * 700) / SR),
	AIR_Q = 0.35;
// ⚠️ 实时滤波器的高频尾巴比样品那版亮:她挑的样品谱心 812Hz,第一版实时是 1327Hz。
//    她是按样品挑的 ⇒ 真跑的必须听起来是同一个东西 ⇒ 再压一级单极点低通把亮部收回去。
const AIR_TAME = 0.045;

export const BEDS = {
	// 1 软垫(先前那版,留着当兜底)
	pad: (n) => {
		const t = n / SR,
			br = 0.72 + 0.28 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.11 * t));
		return (
			(Math.sin(2 * Math.PI * 220 * t) * 0.55 +
				Math.sin(2 * Math.PI * 330 * t) * 0.32 +
				Math.sin(2 * Math.PI * 440 * t) * 0.13) *
			0.028 *
			br
		);
	},
	boxA: mkBox({ step: 0.75, decay: 2.6, amp: 0.06 }), // 她在房里真听过 46 秒的那版
	boxB: mkBox({ step: 1.5, decay: 1.5, amp: 0.06 }), // ⭐ 她最后定的:更疏更慢-最安静
	air: (n) => {
		const x = Math.random() * 2 - 1;
		const hp = x - lp - AIR_Q * bp;
		bp += AIR_F * hp;
		lp += AIR_F * bp;
		tame += AIR_TAME * (bp - tame);
		return tame * 0.19 * (0.7 + 0.3 * Math.sin((2 * Math.PI * 0.07 * n) / SR));
	},
};
export const BED_NAMES = {
	pad: "软垫",
	boxA: "音乐盒 A",
	boxB: "音乐盒 B(更疏更慢)",
	air: "气流",
};
