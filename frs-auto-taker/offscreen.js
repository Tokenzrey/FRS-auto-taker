/*
 Dokumentasi
 Nama Berkas: offscreen.js
 Deskripsi: Layanan audio offscreen untuk memutar bunyi peringatan (sekali jalan atau loop) tanpa interaksi pengguna.
 Tanggung Jawab:
 - Menyediakan antarmuka pemutaran beep satu kali dan loop yang mengganggu.
 - Mengelola siklus hidup Web Audio (AudioContext, Oscillator, Gain) secara aman.
 Pesan Runtime: OFFSCREEN_PLAY_BEEP, OFFSCREEN_START_BEEP_LOOP, OFFSCREEN_STOP_BEEP.
*/
class OffscreenAudioService {
	/** @private */ _loop = {
		running: false,
		intervalId: null,
		timeoutId: null,
		ctx: null,
		osc: null,
		gain: null,
	};

	/** Putar beep singkat atau audio file (opsional). */
	async playBeep(options = {}) {
		try {
			console.log("[FRS][Offscreen] playBeep called");
		} catch {}
		const opts = this._normalizeOptions(options);
		try {
			if (opts.url) {
				const audio = new Audio(opts.url);
				audio.volume = opts.volume;
				await audio.play().catch(() => {});
				return true;
			}

			const AudioCtx = self.AudioContext || self.webkitAudioContext;
			if (!AudioCtx) return false;
			const ctx = new AudioCtx();
			if (ctx.state === "suspended") {
				try {
					await ctx.resume();
				} catch (_) {}
			}
			const osc = ctx.createOscillator();
			const g = ctx.createGain();
			osc.type = "square";
			osc.frequency.value = opts.frequency;
			g.gain.value = opts.gain;
			osc.connect(g).connect(ctx.destination);
			osc.start();
			await this._sleep(opts.durationMs);
			try {
				osc.stop();
			} catch (_) {}
			try {
				await ctx.close();
			} catch (_) {}
			return true;
		} catch (e) {
			console.warn("[FRS] Offscreen playBeep error:", e);
			return false;
		}
	}

	/** Mulai loop beep yang mengganggu dengan frekuensi bergantian. */
	async startLoop(options = {}) {
		try {
			console.log("[FRS][Offscreen] startLoop called", options);
		} catch {}
		this.stopLoop();
		const opts = this._normalizeLoopOptions(options);
		const AudioCtx = self.AudioContext || self.webkitAudioContext;
		if (!AudioCtx) throw new Error("AudioContext not available");
		const ctx = new AudioCtx();
		if (ctx.state === "suspended") {
			try {
				await ctx.resume();
			} catch (_) {}
		}
		const osc = ctx.createOscillator();
		const g = ctx.createGain();
		osc.type = "square";
		g.gain.value = 0;
		osc.connect(g).connect(ctx.destination);
		osc.start();

		this._loop = {
			running: true,
			intervalId: null,
			timeoutId: null,
			ctx,
			osc,
			gain: g,
		};

		let on = false;
		let high = true;
		this._loop.intervalId = setInterval(() => {
			if (!this._loop.running) return;
			on = !on;
			if (on) {
				high = !high;
				try {
					osc.frequency.value = high ? opts.freqHigh : opts.freqLow;
				} catch (_) {}
				g.gain.value = opts.gain;
			} else {
				g.gain.value = 0;
			}
		}, opts.stepMs);

		this._loop.timeoutId = setTimeout(
			() => this.stopLoop(),
			opts.totalDurationMs
		);
	}

	/** Hentikan loop yang berjalan dan rilis resource. */
	stopLoop() {
		try {
			console.log("[FRS][Offscreen] stopLoop called");
		} catch {}
		if (!this._loop.running) return;
		this._loop.running = false;
		try {
			if (this._loop.intervalId) clearInterval(this._loop.intervalId);
		} catch (_) {}
		try {
			if (this._loop.timeoutId) clearTimeout(this._loop.timeoutId);
		} catch (_) {}
		try {
			if (this._loop.gain) this._loop.gain.gain.value = 0;
		} catch (_) {}
		try {
			if (this._loop.osc) this._loop.osc.stop();
		} catch (_) {}
		try {
			if (this._loop.ctx) this._loop.ctx.close();
		} catch (_) {}
		this._loop = {
			running: false,
			intervalId: null,
			timeoutId: null,
			ctx: null,
			osc: null,
			gain: null,
		};
	}

	/** Normalisasi opsi beep satu kali. */
	_normalizeOptions(options) {
		const frequency = Number.isFinite(options.frequency)
			? Number(options.frequency)
			: 880;
		const durationMs = Number.isFinite(options.durationMs)
			? Number(options.durationMs)
			: 750;
		const gain = Math.max(
			0,
			Math.min(1, Number.isFinite(options.gain) ? Number(options.gain) : 0.5)
		);
		const volume = Math.max(
			0,
			Math.min(
				1,
				Number.isFinite(options.volume)
					? Number(options.volume)
					: Number.isFinite(options.gain)
					? Number(options.gain)
					: 1
			)
		);
		const url =
			typeof options.url === "string" && options.url ? options.url : null;
		return { frequency, durationMs, gain, volume, url };
	}

	/** Normalisasi opsi loop beep. */
	_normalizeLoopOptions(options) {
		const totalDurationMs = Math.max(
			1000,
			Number.isFinite(options.totalDurationMs)
				? Number(options.totalDurationMs)
				: 10000
		);
		const stepMs = Math.max(
			50,
			Number.isFinite(options.stepMs) ? Number(options.stepMs) : 150
		);
		const gain = Math.max(
			0,
			Math.min(1, Number.isFinite(options.gain) ? Number(options.gain) : 1)
		);
		const freqHigh = Number.isFinite(options.freqHigh)
			? Number(options.freqHigh)
			: 1400;
		const freqLow = Number.isFinite(options.freqLow)
			? Number(options.freqLow)
			: 700;
		return { totalDurationMs, stepMs, gain, freqHigh, freqLow };
	}

	/** Delay utilitas. */
	_sleep(ms) {
		return new Promise((r) => setTimeout(r, ms));
	}
}

// Create a single service instance
const audioService = new OffscreenAudioService();

// Entripoint messaging runtime
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	if (msg && msg.type === "OFFSCREEN_PLAY_BEEP") {
		audioService
			.playBeep(msg.options || {})
			.then((ok) => sendResponse({ ok }))
			.catch((err) => sendResponse({ ok: false, error: String(err) }));
		return true;
	}
	if (msg && msg.type === "OFFSCREEN_START_BEEP_LOOP") {
		audioService
			.startLoop(msg.options || {})
			.then(() => sendResponse({ ok: true }))
			.catch((err) => sendResponse({ ok: false, error: String(err) }));
		return true;
	}
	if (msg && msg.type === "OFFSCREEN_STOP_BEEP") {
		try {
			audioService.stopLoop();
			sendResponse({ ok: true });
		} catch (e) {
			sendResponse({ ok: false, error: String(e) });
		}
		return false;
	}
});

// Fallback window messaging (kompatibilitas)
self.onmessage = async (ev) => {
	const msg = ev.data || {};
	if (msg.type === "PLAY_BEEP" || msg.type === "OFFSCREEN_PLAY_BEEP") {
		const ok = await audioService.playBeep(msg.options || {});
		try {
			self.postMessage({ type: "PLAY_BEEP_RESULT", ok });
		} catch (_) {}
	}
};
