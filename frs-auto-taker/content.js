/*
 Dokumentasi
 Nama Berkas: content.js
 Deskripsi: Agen halaman FRS (list_frs.php) untuk parsing data kelas, eksekusi pengambilan (hunting), penanganan CAPTCHA, dan pemantauan kenaikan kuota (Notify Extended).
 Tanggung Jawab:
 - Mengurai opsi kelas dari DOM dan menyimpannya ke chrome.storage.local.
 - Menjalankan alur hunting kandidat prioritas serta mengevaluasi hasil setelah muat ulang.
 - Menangani permintaan CAPTCHA (snapshot, refresh, submit) dan mengirimkannya ke Popup.
 - Memantau kenaikan kuota kelas prioritas dan memicu hunting berbasis antrean.
 Kunci Penyimpanan:
 - priority, runMode, pendingAction, activeCandidateIndex, classes, lastCaptcha,
	 notifyExtendedEnabled, notifyExtendedBaseline, notifyExtendedLastCheckTs, notifyExtendedQueue.
 Pesan Runtime:
 - START_HUNT, PRIORITY_UPDATED, CAPTCHA_VALUE, REFRESH_CAPTCHA,
	 NOTIFY_EXTENDED_START/STOP, NOTIFY_BUILD_BASELINE.
 Dependensi: DOM list_frs.php, chrome.storage.local, chrome.runtime messaging.
*/

const SELECTORS = {
	jur: "#kelasjur",
	jurlain:
		"#kelasjur2, #kelasjurlain, #kelas_dep_lain, #kelasjur_lain, #kelasjur-lain",
	tpb: "#kelastpb",
	pengayaan: "#kelaspengayaan",
	mbkm: "#kelasmbkm",
};

const FORM = {
	sip: () => document.querySelector("#sipform"),
	act: () => document.querySelector("#act"),
	key: () => document.querySelector("#key"),
	captchaKey: () => document.querySelector("#captcha_key"),
	captchaImage: () => document.querySelector("#captcha_image"),
	captchaInput: () => document.querySelector("#captcha_code"),
};

const STATE_KEYS = {
	PRIORITY: "priority",
	RUNMODE: "runMode",
	PENDING: "pendingAction",
	ACTIVE_INDEX: "activeCandidateIndex",
	CLASSES: "classes",
	LAST_CAPTCHA: "lastCaptcha",
	NOTIFY_ENABLED: "notifyExtendedEnabled",
	NOTIFY_BASELINE: "notifyExtendedBaseline",
	NOTIFY_LAST_TS: "notifyExtendedLastCheckTs",
	NOTIFY_QUEUE: "notifyExtendedQueue",
};

earlyParseWhenOptionsReady();

/**
 * Inisiasi parsing DOM awal untuk mengekstrak data kelas sedini mungkin.
 * Menggunakan MutationObserver dan retry singkat agar robust saat elemen terlambat muncul.
 */
function earlyParseWhenOptionsReady() {
	const ALL_SELECTORS = [
		SELECTORS.jur,
		SELECTORS.jurlain,
		SELECTORS.tpb,
		SELECTORS.pengayaan,
		SELECTORS.mbkm,
	]
		.filter(Boolean)
		.join(",");

	let parsedOnce = false;
	let mo = null;

	const tryParse = () => {
		if (parsedOnce) return;

		const selects = Array.from(document.querySelectorAll(ALL_SELECTORS));
		if (!selects.length) return;

		const hasUsefulOptions = selects.some((sel) =>
			Array.from(sel.options || []).some(
				(opt) => (opt.value || "").trim() !== ""
			)
		);
		if (!hasUsefulOptions) return;

		const classes = parseAllClasses();
		chrome.storage.local.set({
			[STATE_KEYS.CLASSES]: { updatedAt: Date.now(), items: classes },
		});

		parsedOnce = true;
		if (mo) mo.disconnect();
	};

	tryParse();

	if (!parsedOnce) {
		mo = new MutationObserver(() => {
			tryParse();
		});
		mo.observe(document.documentElement || document, {
			childList: true,
			subtree: true,
		});

		let retries = 10;
		const tick = () => {
			if (parsedOnce) return;
			tryParse();
			if (!parsedOnce && --retries > 0) setTimeout(tick, 50);
		};
		setTimeout(tick, 0);
	}
}

let MAX_CAPTCHA_ATTEMPTS = 8;
const BACKOFF_MS = 3000;
let notifyTimer = null;
let notifyIntervalMs = 30000;
const OVERLAY_ID = "frs-ext-notify-overlay";

init().catch(console.error);

/**
 * Titik masuk utama content script.
 * - Memuat opsi, menyimpan cache kelas, memulai notify/hunting sesuai state.
 */
async function init() {
	try {
		const { opts } = await chrome.storage.local.get(["opts"]);
		if (opts?.maxCaptcha) MAX_CAPTCHA_ATTEMPTS = opts.maxCaptcha;
		if (opts?.notifyIntervalSec)
			notifyIntervalMs = Math.max(5, +opts.notifyIntervalSec) * 1000;
	} catch {}

	const classes = parseAllClasses();
	await chrome.storage.local.set({
		[STATE_KEYS.CLASSES]: { updatedAt: Date.now(), items: classes },
	});

	const { notifyExtendedEnabled } = await chrome.storage.local.get([
		STATE_KEYS.NOTIFY_ENABLED,
	]);
	if (notifyExtendedEnabled) {
		await notifyCheckAndSchedule();
	}

	const { priority, runMode } = await chrome.storage.local.get([
		STATE_KEYS.PRIORITY,
		STATE_KEYS.RUNMODE,
	]);
	if (Array.isArray(priority) && priority.length && runMode === "hunting") {
		const { pendingAction } = await chrome.storage.local.get([
			STATE_KEYS.PENDING,
		]);
		if (pendingAction?.rawValue) {
			await evaluateAfterReload(pendingAction);
		}
		await huntNext();
	}
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	(async () => {
		switch (msg?.type) {
			case "START_HUNT":
				await chrome.storage.local.set({
					[STATE_KEYS.PENDING]: null,
					[STATE_KEYS.ACTIVE_INDEX]: 0,
					[STATE_KEYS.RUNMODE]: "hunting",
				});
				await huntNext();
				sendResponse({ ok: true });
				break;

			case "PRIORITY_UPDATED": {
				await chrome.storage.local.set({ [STATE_KEYS.ACTIVE_INDEX]: 0 });
				const st = await chrome.storage.local.get([
					STATE_KEYS.RUNMODE,
					STATE_KEYS.NOTIFY_ENABLED,
				]);
				if (st[STATE_KEYS.NOTIFY_ENABLED]) {
					await buildNotifyBaseline();
				}
				if (st[STATE_KEYS.RUNMODE] === "hunting") {
					await huntNext(true);
				} else {
					console.log(
						"[FRS][Flow] PRIORITY_UPDATED: runMode != hunting, skip auto hunt"
					);
				}
				sendResponse({ ok: true });
				break;
			}

			case "CAPTCHA_VALUE":
				await submitWithCaptcha(msg.value);
				sendResponse({ ok: true });
				break;

			case "REFRESH_CAPTCHA":
				await refreshCaptchaImage();
				sendResponse({ ok: true });
				break;

			case "NOTIFY_EXTENDED_START":
				await enableNotifyWatcher(true);
				sendResponse({ ok: true });
				break;

			case "NOTIFY_EXTENDED_STOP":
				await enableNotifyWatcher(false);
				sendResponse({ ok: true });
				break;

			case "NOTIFY_BUILD_BASELINE":
				await buildNotifyBaseline();
				sendResponse({ ok: true });
				break;

			default:
				sendResponse({ ok: true });
		}
	})();
	return true;
});

/**
 * Menentukan kandidat berikutnya untuk dicoba dan memulai proses pengambilan.
 * @param {boolean} [forceTop=false] Jika true, mulai dari elemen paling atas.
 */
async function huntNext(forceTop = false) {
	console.log("[FRS][Flow] huntNext START", { forceTop, ts: Date.now() });
	const st = await chrome.storage.local.get([
		STATE_KEYS.PRIORITY,
		STATE_KEYS.ACTIVE_INDEX,
		STATE_KEYS.NOTIFY_QUEUE,
		STATE_KEYS.RUNMODE,
	]);
	const priority = st[STATE_KEYS.PRIORITY] || [];
	const queue = Array.isArray(st[STATE_KEYS.NOTIFY_QUEUE])
		? st[STATE_KEYS.NOTIFY_QUEUE]
		: [];
	if (!priority.length) {
		console.log("[FRS][Flow] huntNext ABORT: empty priority list");
		return;
	}
	if (st[STATE_KEYS.RUNMODE] !== "hunting" && !queue.length) {
		console.log(
			"[FRS][Flow] huntNext ABORT: runMode != hunting and queue empty"
		);
		return;
	}
	console.log("[FRS][Flow] huntNext state", {
		activeIndex: st[STATE_KEYS.ACTIVE_INDEX],
		queue,
	});

	if (queue.length) {
		const nextRaw = forceTop ? queue[0] : queue[0];
		const idx = priority.findIndex((p) => p.rawValue === nextRaw);
		if (idx < 0) {
			queue.shift();
			await chrome.storage.local.set({ [STATE_KEYS.NOTIFY_QUEUE]: queue });
			console.warn("[FRS][Flow] Removed invalid queue item", nextRaw, {
				queue,
			});
			return await huntNext(true);
		}
		const candidate = priority[idx];
		console.log("[FRS][Flow] huntNext -> trying extended candidate", {
			rawValue: candidate.rawValue,
			idx,
		});
		await tryTakeCandidate(candidate, idx);
		return;
	}

	const idx = forceTop ? 0 : st[STATE_KEYS.ACTIVE_INDEX] || 0;
	if (idx >= priority.length) {
		await notify("Selesai", "Semua kandidat sudah dicoba.");
		await chrome.storage.local.set({
			[STATE_KEYS.RUNMODE]: "idle",
			[STATE_KEYS.ACTIVE_INDEX]: 0,
		});
		console.log("[FRS][Flow] huntNext complete: exhausted priority list");
		return;
	}
	const candidate = priority[idx];
	console.log("[FRS][Flow] huntNext -> trying normal candidate", {
		rawValue: candidate.rawValue,
		idx,
	});
	await tryTakeCandidate(candidate, idx);
}

/**
 * Menyiapkan form dan data untuk mencoba mengambil satu kandidat kelas.
 * Mengambil snapshot CAPTCHA dan mengumumkannya ke background/popup.
 * @param {Object} candidate Objek kelas prioritas.
 * @param {number} index Indeks kandidat pada daftar prioritas.
 */
async function tryTakeCandidate(candidate, index) {
	console.log("[FRS][Flow] tryTakeCandidate START", {
		rawValue: candidate.rawValue,
		index,
	});
	const pending = {
		rawValue: candidate.rawValue,
		valueCode: candidate.valueCode,
		displayCode: candidate.displayCode,
		name: candidate.name,
		kelas: candidate.kelas,
		kategori: candidate.kategori,
		attempt: (await getAttempt(candidate.rawValue)) + 1,
		ts: Date.now(),
	};
	await chrome.storage.local.set({
		[STATE_KEYS.PENDING]: pending,
		[STATE_KEYS.ACTIVE_INDEX]: index,
	});

	const imgEl = FORM.captchaImage();
	const imgUrl = imgEl
		? new URL(imgEl.getAttribute("src"), location.href).href
		: new URL("/securimage/securimage_show.php", location.href).href;
	const imageDataUrl = await snapshotCaptcha(imgEl, imgUrl);
	console.log("[FRS][Flow] tryTakeCandidate captcha snapshot", {
		rawValue: candidate.rawValue,
		hasImage: !!imageDataUrl,
	});

	const meta = {
		title: `${pending.displayCode || pending.valueCode} — Kelas ${
			pending.kelas
		}`,
		desc: pending.name || "",
		kelas: String(pending.kelas || ""),
		kategori: String(pending.kategori || ""),
		attempt: pending.attempt || 1,
	};

	try {
		await chrome.runtime.sendMessage({
			type: "NEED_CAPTCHA",
			imageUrl: imgUrl,
			imageDataUrl,
			meta,
		});
		try {
			await chrome.storage.local.set({
				[STATE_KEYS.LAST_CAPTCHA]: {
					imageUrl: imgUrl,
					imageDataUrl,
					tabId: null,
					meta,
					ts: Date.now(),
				},
			});
		} catch {}
	} catch (e) {
		try {
			await chrome.storage.local.set({
				[STATE_KEYS.LAST_CAPTCHA]: {
					imageUrl: imgUrl,
					imageDataUrl,
					tabId: null,
					meta,
					ts: Date.now(),
				},
			});
		} catch {}
		console.warn(
			"[FRS][Flow] tryTakeCandidate NEED_CAPTCHA send failed, fallback set",
			{ rawValue: candidate.rawValue, error: e }
		);
	}

	ensureForm();
	FORM.act().value = "ambil";
	FORM.key().value = candidate.rawValue;
	FORM.captchaKey().value = "";
	FORM.captchaInput()?.focus();
}
/**
 * Mengisi nilai CAPTCHA ke form dan submit.
 * @param {string} value Nilai CAPTCHA.
 */
async function submitWithCaptcha(value) {
	const ci = FORM.captchaInput();
	if (ci) ci.value = value;
	FORM.captchaKey().value = value;
	FORM.sip().submit();
}

/**
 * Mengevaluasi hasil setelah halaman termuat ulang untuk kandidat yang barusan dicoba.
 * Mengelola antrean notify dan penyesuaian indeks aktif.
 * @param {Object} pending Informasi kandidat yang diproses.
 */
async function evaluateAfterReload(pending) {
	console.log("[FRS][Flow] evaluateAfterReload START", {
		rawValue: pending?.rawValue,
		ts: Date.now(),
	});
	const stQ = await chrome.storage.local.get([STATE_KEYS.NOTIFY_QUEUE]);
	const queueAtStart = Array.isArray(stQ[STATE_KEYS.NOTIFY_QUEUE])
		? stQ[STATE_KEYS.NOTIFY_QUEUE]
		: [];
	const ok =
		isCandidateInGrid(pending.displayCode, pending.kelas) ||
		isCandidateInGrid(pending.valueCode, pending.kelas);
	if (ok) {
		console.log("[FRS][Flow] evaluateAfterReload SUCCESS", {
			rawValue: pending.rawValue,
		});
		await notify(
			"Berhasil",
			`Berhasil ambil ${pending.displayCode || pending.valueCode} kelas ${
				pending.kelas
			}.`
		);
		if (queueAtStart.length > 0) {
			await chrome.storage.local.set({ [STATE_KEYS.PENDING]: null });
		} else {
			await chrome.storage.local.set({
				[STATE_KEYS.PENDING]: null,
				[STATE_KEYS.ACTIVE_INDEX]: (await getActiveIndex()) + 1,
			});
		}
	} else {
		const classes = parseAllClasses();
		const found = classes.find((c) => c.rawValue === pending.rawValue);
		let captchaError = true;
		if (found) {
			const { terisi, kuota } = found.kapasitas || {};
			if (typeof terisi === "number" && typeof kuota === "number") {
				if (kuota > 0 && terisi >= kuota) captchaError = false;
			}
		}
		console.log("[FRS][Flow] evaluateAfterReload status", {
			rawValue: pending.rawValue,
			captchaError,
		});

		if (!captchaError) {
			if (queueAtStart.length > 0) {
				await chrome.storage.local.set({ [STATE_KEYS.PENDING]: null });
			} else {
				await chrome.storage.local.set({
					[STATE_KEYS.PENDING]: null,
					[STATE_KEYS.ACTIVE_INDEX]: (await getActiveIndex()) + 1,
				});
			}
		} else {
			const attempts = pending.attempt || 1;
			if (attempts >= MAX_CAPTCHA_ATTEMPTS) {
				console.warn("[FRS][Flow] Max CAPTCHA attempts reached", {
					rawValue: pending.rawValue,
					attempts,
				});
				await notify(
					"CAPTCHA gagal",
					`Terlalu banyak percobaan untuk ${
						pending.displayCode || pending.valueCode
					} ${pending.kelas}. Lewati.`
				);
				if (queueAtStart.length > 0) {
					await chrome.storage.local.set({ [STATE_KEYS.PENDING]: null });
				} else {
					await chrome.storage.local.set({
						[STATE_KEYS.PENDING]: null,
						[STATE_KEYS.ACTIVE_INDEX]: (await getActiveIndex()) + 1,
					});
				}
			} else {
				console.log("[FRS][Flow] Retrying candidate after CAPTCHA error", {
					rawValue: pending.rawValue,
					attempt: attempts + 1,
					backoffMs: BACKOFF_MS,
				});
				await sleep(BACKOFF_MS);
				await tryTakeCandidate(
					found || pendingToCandidate(pending),
					await getActiveIndex()
				);
			}
		}
	}

	const st = await chrome.storage.local.get([STATE_KEYS.NOTIFY_QUEUE]);
	const queue = Array.isArray(st[STATE_KEYS.NOTIFY_QUEUE])
		? st[STATE_KEYS.NOTIFY_QUEUE]
		: [];
	if (queue.length && pending?.rawValue) {
		if (queue[0] === pending.rawValue) {
			queue.shift();
			await chrome.storage.local.set({ [STATE_KEYS.NOTIFY_QUEUE]: queue });
			console.log("[FRS][Flow] Queue advanced", {
				removed: pending.rawValue,
				remaining: queue,
			});
		}
		if (queue.length) {
			console.log("[FRS][Flow] Proceeding to next queue item");
			await huntNext(true);
		} else {
			await chrome.storage.local.set({ [STATE_KEYS.RUNMODE]: "idle" });
			console.log("[FRS][Flow] Queue finished; RUNMODE -> idle");
		}
	}
}

/**
 * Mengaktifkan atau menonaktifkan pemantau Notify Extended dan penjadwal reload.
 * @param {boolean} enable True untuk mengaktifkan.
 */
async function enableNotifyWatcher(enable) {
	console.log("[FRS][Flow] enableNotifyWatcher invoked", {
		enable,
		ts: Date.now(),
	});
	try {
		const { opts } = await chrome.storage.local.get(["opts"]);
		if (opts?.notifyIntervalSec) {
			notifyIntervalMs = Math.max(5, +opts.notifyIntervalSec) * 1000;
			console.log(
				"[FRS][Notify] notifyIntervalMs set from options:",
				notifyIntervalMs
			);
		}
	} catch {}

	await chrome.storage.local.set({ [STATE_KEYS.NOTIFY_ENABLED]: !!enable });
	console.log("[FRS][Flow] notifyEnabled flag stored", { enabled: !!enable });

	if (notifyTimer) {
		clearTimeout(notifyTimer);
		notifyTimer = null;
	}

	if (enable) {
		console.log(
			"[FRS][Flow] Notify enable: building baseline then first check"
		);
		await buildNotifyBaseline();
		console.log(
			"[FRS][Flow] Baseline built. Running first notifyCheckAndSchedule()"
		);
		await notifyCheckAndSchedule();
	} else {
		removeOverlay();
		console.log("[FRS][Flow] Notify disabled: overlay removed, timers cleared");
	}
}

/**
 * Menyusun baseline kuota saat ini untuk seluruh kelas prioritas sebagai acuan perbandingan.
 */
async function buildNotifyBaseline() {
	console.log("[FRS][Notify] buildNotifyBaseline start");
	const st = await chrome.storage.local.get([
		STATE_KEYS.PRIORITY,
		STATE_KEYS.CLASSES,
	]);
	const priority = st[STATE_KEYS.PRIORITY] || [];
	let classes = st[STATE_KEYS.CLASSES]?.items;
	if (!Array.isArray(classes) || !classes.length) {
		console.log(
			"[FRS][Notify] No cached classes when building baseline; reparsing DOM"
		);
		classes = parseAllClasses();
	}
	console.log("[FRS][Notify] baseline sources:", {
		priority: priority.length,
		classes: classes.length,
	});

	const classMap = new Map(classes.map((c) => [c.rawValue, c]));
	const baseline = {};
	const notFound = [];
	const noCapacity = [];

	for (const p of priority) {
		const c = classMap.get(p.rawValue);
		if (!c) {
			notFound.push(p.rawValue);
			continue;
		}
		const kuota = c.kapasitas?.kuota;
		const terisi = c.kapasitas?.terisi;
		if (typeof kuota === "number") {
			baseline[p.rawValue] = { kuota, terisi: terisi ?? null, ts: Date.now() };
		} else {
			baseline[p.rawValue] = { kuota: null, terisi: null, ts: Date.now() };
			noCapacity.push(p.rawValue);
		}
	}

	await chrome.storage.local.set({ [STATE_KEYS.NOTIFY_BASELINE]: baseline });
	console.log("[FRS][Notify] baseline saved", {
		entries: Object.keys(baseline).length,
		notFound,
		noCapacity,
		withCapacity: Object.values(baseline).filter((b) => b.kuota != null).length,
	});
}

/**
 * Melakukan satu siklus pemeriksaan kenaikan kuota, memicu antrean hunting bila ada peningkatan,
 * memperbarui baseline, dan menjadwalkan reload halaman berikutnya.
 */
async function notifyCheckAndSchedule() {
	const startedAt = Date.now();
	console.log("[FRS][Flow] notifyCheckAndSchedule START", { ts: startedAt });
	const st = await chrome.storage.local.get([
		STATE_KEYS.NOTIFY_ENABLED,
		STATE_KEYS.PRIORITY,
		STATE_KEYS.CLASSES,
		STATE_KEYS.NOTIFY_BASELINE,
		STATE_KEYS.RUNMODE,
	]);
	console.log("[FRS][Flow] notifyCheckAndSchedule state snapshot", {
		enabled: !!st[STATE_KEYS.NOTIFY_ENABLED],
		runMode: st[STATE_KEYS.RUNMODE],
		baselineKeys: Object.keys(st[STATE_KEYS.NOTIFY_BASELINE] || {}).length,
		classCountCached: st[STATE_KEYS.CLASSES]?.items?.length || 0,
	});

	if (!st[STATE_KEYS.NOTIFY_ENABLED] || st[STATE_KEYS.RUNMODE] !== "idle") {
		console.log(
			"[FRS][Flow] notifyCheckAndSchedule ABORT (disabled or runMode != idle)"
		);
		return;
	}

	const priority = st[STATE_KEYS.PRIORITY] || [];
	const pOrder = new Map(priority.map((p, i) => [p.rawValue, i]));

	let classes = st[STATE_KEYS.CLASSES]?.items;
	if (!Array.isArray(classes) || !classes.length) {
		console.log("[FRS][Flow] No cached classes; reparsing DOM now");
		classes = parseAllClasses();
		await chrome.storage.local.set({
			[STATE_KEYS.CLASSES]: { updatedAt: Date.now(), items: classes },
		});
		console.log("[FRS][Flow] Parsed classes", { count: classes.length });
	}

	const baseline = st[STATE_KEYS.NOTIFY_BASELINE] || {};
	if (!Object.keys(baseline).length) {
		console.log("[FRS][Flow] Baseline empty; rebuilding before comparison");
		await buildNotifyBaseline();
	}

	const nowMap = new Map(classes.map((c) => [c.rawValue, c]));
	const extendedItems = [];

	let baselineChanged = false;
	for (const [raw, base] of Object.entries(baseline)) {
		const c = nowMap.get(raw);
		if (!c) continue;
		const newKuota = c.kapasitas?.kuota;
		const oldKuota = base?.kuota;
		if (typeof oldKuota !== "number" && typeof newKuota === "number") {
			baseline[raw] = {
				kuota: newKuota,
				terisi: c.kapasitas?.terisi ?? null,
				ts: Date.now(),
			};
			baselineChanged = true;
			console.log("[FRS][Flow] Baseline upgrade from placeholder", {
				raw,
				newKuota,
			});
			continue;
		}
		if (typeof newKuota === "number" && typeof oldKuota === "number") {
			const delta = newKuota - oldKuota;
			if (delta > 0) {
				extendedItems.push({
					rawValue: raw,
					displayCode: c.displayCode || c.valueCode,
					name: c.name || "",
					kelas: c.kelas || "",
					oldKuota,
					newKuota,
					delta,
					kategori: c.kategori,
				});
			}
			console.log("[FRS][Flow] Compare baseline vs now", {
				raw,
				oldKuota,
				newKuota,
				delta,
			});
		} else {
			console.log("[FRS][Flow] Compare skip (non-numeric)", {
				raw,
				oldKuota,
				newKuota,
			});
		}
	}
	if (baselineChanged) {
		await chrome.storage.local.set({ [STATE_KEYS.NOTIFY_BASELINE]: baseline });
		console.log("[FRS][Flow] Baseline persisted after upgrades");
	}
	console.log("[FRS][Flow] Extended scan result", {
		found: extendedItems.length,
	});
	if (extendedItems.length) {
		showOverlayExtended(extendedItems);
		try {
			await chrome.runtime.sendMessage({
				type: "START_DISTURBING_BEEP",
				options: {
					gain: 1,
					stepMs: 120,
					totalDurationMs: 10000,
					freqHigh: 1700,
					freqLow: 600,
				},
			});
			console.log("[FRS][Flow] Beep started (10s) for extended detection");
		} catch (e) {
			playLoudBeep();
			console.warn(
				"[FRS][Flow] Offscreen beep failed, fallback playLoudBeep",
				e
			);
		}

		extendedItems.sort(
			(a, b) =>
				(pOrder.get(a.rawValue) ?? 1e9) - (pOrder.get(b.rawValue) ?? 1e9)
		);
		const queueRaw = extendedItems
			.map((it) => it.rawValue)
			.filter((rv) => priority.some((p) => p.rawValue === rv));
		console.log("[FRS][Flow] Extended queue (priority-filtered)", queueRaw);

		if (queueRaw.length > 0) {
			if (notifyTimer) {
				clearTimeout(notifyTimer);
				notifyTimer = null;
				console.log("[FRS][Flow] Cleared existing reload timer");
			}
			await chrome.runtime.sendMessage({ type: "NOTIFY_EXTENDED_FOUND" });
			console.log("[FRS][Flow] Switching to hunting mode for extended queue");
			await chrome.storage.local.set({
				[STATE_KEYS.NOTIFY_ENABLED]: false,
				[STATE_KEYS.RUNMODE]: "hunting",
				[STATE_KEYS.PENDING]: null,
				[STATE_KEYS.NOTIFY_QUEUE]: queueRaw,
			});
			await chrome.runtime.sendMessage({ type: "NOTIFY_SET_LAST_TS" });
			await huntNext(true);
			return;
		} else {
			console.log(
				"[FRS][Flow] None of extended belong to priority; remain in notify mode"
			);
			await chrome.runtime.sendMessage({ type: "NOTIFY_SET_LAST_TS" });
		}
	}

	const newBaseline = {};
	for (const p of priority) {
		const c = nowMap.get(p.rawValue);
		const kuota = c?.kapasitas?.kuota;
		const terisi = c?.kapasitas?.terisi;
		if (typeof kuota === "number")
			newBaseline[p.rawValue] = { kuota, terisi, ts: Date.now() };
	}
	await chrome.storage.local.set({
		[STATE_KEYS.NOTIFY_BASELINE]: newBaseline,
		[STATE_KEYS.NOTIFY_LAST_TS]: Date.now(),
	});

	if (notifyTimer) clearTimeout(notifyTimer);
	console.log("[FRS][Flow] Scheduling page reload for notify cycle", {
		inMs: notifyIntervalMs,
	});
	notifyTimer = setTimeout(() => {
		console.log("[FRS][Flow] Page reload NOW (notify cycle)");
		location.reload();
	}, notifyIntervalMs);
	console.log("[FRS][Flow] notifyCheckAndSchedule END", {
		durationMs: Date.now() - startedAt,
	});
}

/**
 * Menampilkan overlay informasi kelas yang mengalami kenaikan kuota.
 * @param {Array<Object>} items Daftar item yang naik kuotanya.
 */
function showOverlayExtended(items) {
	removeOverlay();
	const overlay = document.createElement("div");
	overlay.id = OVERLAY_ID;
	overlay.style.position = "fixed";
	overlay.style.inset = "0";
	overlay.style.background = "rgba(255,0,0,0.25)";
	overlay.style.zIndex = "2147483647";
	overlay.style.display = "grid";
	overlay.style.placeItems = "center";

	const card = document.createElement("div");
	card.style.background = "rgba(255,255,255,0.98)";
	card.style.borderRadius = "12px";
	card.style.boxShadow = "0 12px 30px rgba(0,0,0,0.25)";
	card.style.maxWidth = "720px";
	card.style.width = "90%";
	card.style.padding = "16px 18px";
	card.style.fontFamily = "system-ui, Arial, sans-serif";

	const title = document.createElement("div");
	title.textContent = "Kapasitas Kelas Bertambah";
	title.style.fontWeight = "700";
	title.style.fontSize = "20px";
	title.style.marginBottom = "10px";

	const list = document.createElement("div");
	list.style.maxHeight = "320px";
	list.style.overflow = "auto";
	list.style.fontSize = "14px";
	list.style.color = "#111";

	for (const it of items) {
		const row = document.createElement("div");
		row.style.padding = "8px 10px";
		row.style.border = "1px solid #eee";
		row.style.borderRadius = "8px";
		row.style.background = "#fff";
		row.style.marginBottom = "8px";
		row.innerHTML = `
      <div style="font-weight:600">${escapeHtml(it.displayCode)} — ${escapeHtml(
			it.name
		)}</div>
      <div style="color:#444">Kelas ${escapeHtml(String(it.kelas))}</div>
      <div style="margin-top:4px">Kuota: <b>${it.oldKuota}</b> → <b>${
			it.newKuota
		}</b> (+${it.delta})</div>
    `;
		list.appendChild(row);
	}

	const hint = document.createElement("div");
	hint.textContent = "Layar akan kembali normal otomatis dalam 10 detik…";
	hint.style.fontSize = "12px";
	hint.style.color = "#666";
	hint.style.marginTop = "8px";

	card.appendChild(title);
	card.appendChild(list);
	card.appendChild(hint);
	overlay.appendChild(card);
	document.body.appendChild(overlay);

	setTimeout(removeOverlay, 10000);
}

function removeOverlay() {
	document.getElementById(OVERLAY_ID)?.remove();
}

/**
 * Memainkan bunyi peringatan sederhana sebagai fallback jika offscreen audio gagal.
 */
function playLoudBeep() {
	try {
		const ua = navigator.userActivation;
		const canAutoPlay = !!(ua && (ua.isActive || ua.hasBeenActive));
		console.log(
			"[FRS] playLoudBeep: userActivation=",
			ua,
			"canAutoPlay=",
			canAutoPlay
		);

		if (canAutoPlay) {
			try {
				const url = chrome.runtime.getURL("assets/notify-extended.mp3");
				const audio = new Audio(url);
				audio.volume = 1;
				console.log("[FRS] playLoudBeep: trying audio.play() =>", url);
				const p = audio.play();
				if (p && typeof p.then === "function")
					p.then(() => {
						console.log("[FRS] playLoudBeep: audio.play() resolved");
					}).catch((e) => {
						console.warn("[FRS] playLoudBeep: audio.play() rejected:", e);
					});
			} catch {}

			try {
				const AudioCtx = window.AudioContext || window.webkitAudioContext;
				console.log("[FRS] playLoudBeep: AudioContext available=", !!AudioCtx);
				if (AudioCtx) {
					const ctx = new AudioCtx();
					console.log("[FRS] playLoudBeep: ctx.state=", ctx.state);
					if (ctx.state === "suspended") {
						console.log("[FRS] playLoudBeep: attempting ctx.resume()...");
						ctx
							.resume()
							.then(() => {
								console.log(
									"[FRS] playLoudBeep: ctx resumed, state=",
									ctx.state
								);
							})
							.catch((e) => {
								console.warn("[FRS] playLoudBeep: ctx.resume() failed:", e);
							});
					}
					const osc = ctx.createOscillator();
					const gain = ctx.createGain();
					osc.type = "square";
					osc.frequency.value = 880;
					gain.gain.value = 0.5;
					osc.connect(gain).connect(ctx.destination);
					console.log("[FRS] playLoudBeep: oscillator start");
					osc.start();
					setTimeout(() => (gain.gain.value = 0), 300);
					setTimeout(() => (gain.gain.value = 0.5), 450);
					setTimeout(() => {
						gain.gain.value = 0;
						console.log("[FRS] playLoudBeep: oscillator stop & ctx.close()");
						osc.stop();
						ctx.close();
					}, 750);
				}
			} catch {}
		} else {
			console.warn(
				"[FRS] playLoudBeep: blocked due to no user activation; skipping audio"
			);
		}
	} catch {}
}

/** Pastikan elemen form penting tersedia, jika tidak lempar error. */
function ensureForm() {
	if (!FORM.sip() || !FORM.act() || !FORM.key() || !FORM.captchaKey()) {
		alert("Struktur form FRS berubah. Ekstensi tidak dapat melanjutkan.");
		throw new Error("FRS form not found");
	}
}

/**
 * Menghasilkan dataURL captcha dari elemen/img URL dengan berbagai fallback.
 * @param {HTMLImageElement|null} imgEl Elemen gambar captcha (opsional).
 * @param {string} imgUrl URL absolut captcha.
 * @returns {Promise<string>} dataURL PNG atau string kosong jika gagal.
 */
async function snapshotCaptcha(imgEl, imgUrl) {
	try {
		const src = imgEl ? imgEl.getAttribute("src") : imgUrl;
		const abs = new URL(src, location.href).href;
		if (
			imgEl &&
			imgEl.complete &&
			imgEl.naturalWidth > 0 &&
			imgEl.naturalHeight > 0
		) {
			return captureElementToDataURL(imgEl);
		}
		const tmp = new Image();
		const loaded = await imageLoad(tmp, abs);
		if (loaded) return drawToDataURL(tmp);

		const res = await fetch(abs, { credentials: "include", cache: "no-store" });
		const blob = await res.blob();
		return await blobToDataURL(blob);
	} catch {
		return "";
	}
}

/**
 * Meminta captcha baru pada halaman, mengambil snapshot, dan mengumumkan ke background/popup.
 */
async function refreshCaptchaImage() {
	const img = FORM.captchaImage();
	if (!img) return;
	const base = new URL(img.getAttribute("src"), location.href);
	base.searchParams.set("_", String(Math.random()).slice(2));
	const newUrl = base.href;
	const loaded = await imageLoad(img, newUrl);
	if (!loaded) return;

	const imageDataUrl = captureElementToDataURL(img);
	const { pendingAction } = await chrome.storage.local.get([
		STATE_KEYS.PENDING,
	]);
	const meta = pendingAction
		? {
				title: `${
					pendingAction.displayCode || pendingAction.valueCode
				} — Kelas ${pendingAction.kelas}`,
				desc: pendingAction.name || "",
				kelas: String(pendingAction.kelas || ""),
				kategori: String(pendingAction.kategori || ""),
				attempt: pendingAction.attempt || 1,
		  }
		: null;

	await chrome.runtime.sendMessage({
		type: "NEED_CAPTCHA",
		imageUrl: newUrl,
		imageDataUrl,
		meta,
	});
}

/**
 * Mengonversi elemen gambar HTML menjadi dataURL PNG.
 * @param {HTMLImageElement} imgEl
 * @returns {string}
 */
function captureElementToDataURL(imgEl) {
	try {
		const w = imgEl.naturalWidth || imgEl.width;
		const h = imgEl.naturalHeight || imgEl.height;
		if (!w || !h) return "";
		const canvas = document.createElement("canvas");
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext("2d");
		ctx.drawImage(imgEl, 0, 0, w, h);
		return canvas.toDataURL("image/png");
	} catch {
		return "";
	}
}

/**
 * Menggambar objek Image ke kanvas dan mengembalikan dataURL PNG.
 * @param {HTMLImageElement} img
 * @returns {string}
 */
function drawToDataURL(img) {
	const w = img.naturalWidth || img.width;
	const h = img.naturalHeight || img.height;
	if (!w || !h) return "";
	const canvas = document.createElement("canvas");
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext("2d");
	ctx.drawImage(img, 0, 0, w, h);
	return canvas.toDataURL("image/png");
}

/**
 * Memuat gambar dari sumber dan resolve boolean sukses.
 * @param {HTMLImageElement} img
 * @param {string} src
 * @returns {Promise<boolean>}
 */
function imageLoad(img, src) {
	return new Promise((resolve) => {
		img.onload = () => resolve(true);
		img.onerror = () => resolve(false);
		img.src = src;
	});
}

/**
 * Mengonversi Blob menjadi dataURL.
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToDataURL(blob) {
	return new Promise((resolve, reject) => {
		const fr = new FileReader();
		fr.onload = () => resolve(String(fr.result || ""));
		fr.onerror = reject;
		fr.readAsDataURL(blob);
	});
}

/**
 * Mengurai semua kelas dari select di halaman menjadi array objek kelas terstruktur.
 * @returns {Array<Object>}
 */
function parseAllClasses() {
	const out = [];
	for (const [kategori, sel] of Object.entries(SELECTORS)) {
		for (const el of document.querySelectorAll(sel)) {
			if (!el) continue;
			for (const opt of el.querySelectorAll("option")) {
				const rawValue = opt.value || "";
				if (!rawValue) continue;

				const meta = parseOptionValue(rawValue);
				const textRaw = getOptionText(opt);
				const text = prepareTextForParsing(textRaw);

				const cap = parseCapacityFlexible(text);
				const disp = parseDisplayMetaRobust(text);

				out.push({
					kategori,
					rawValue,
					valueCode: meta.code,
					displayCode: disp.displayCode,
					name: disp.name,
					sks: disp.sks,
					kelas: meta.kelas,
					jur: meta.jur,
					thnKurikulum: meta.thnKurikulum,
					kapasitas: cap,
				});
			}
		}
	}

	if (!out.some((c) => c.kategori === "jurlain")) {
		const sel = findSelectByLabel("Kelas Dep. Lain");
		if (sel) {
			for (const opt of sel.querySelectorAll("option")) {
				const rawValue = opt.value || "";
				if (!rawValue) continue;

				const meta = parseOptionValue(rawValue);
				const textRaw = getOptionText(opt);
				const text = prepareTextForParsing(textRaw);

				const cap = parseCapacityFlexible(text);
				const disp = parseDisplayMetaRobust(text);

				out.push({
					kategori: "jurlain",
					rawValue,
					valueCode: meta.code,
					displayCode: disp.displayCode,
					name: disp.name,
					sks: disp.sks,
					kelas: meta.kelas,
					jur: meta.jur,
					thnKurikulum: meta.thnKurikulum,
					kapasitas: cap,
				});
			}
		}
	}

	return out;
}

/**
 * Mengurai value option menjadi struktur kode, kelas, tahun kurikulum, dan jurusan.
 * @param {string} val
 * @returns {{code:string,kelas:string,thnKurikulum:string,jur:string}}
 */
function parseOptionValue(val) {
	const parts = String(val).split("|");
	return {
		code: parts[0] || "",
		kelas: parts[1] || "",
		thnKurikulum: parts[2] || "",
		jur: parts[3] || "",
	};
}

/**
 * Mengambil teks representatif dari elemen option.
 * @param {HTMLOptionElement} opt
 * @returns {string}
 */
function getOptionText(opt) {
	return (
		opt.getAttribute?.("label") ||
		opt.text ||
		opt.textContent ||
		opt.innerText ||
		""
	);
}

/** Menormalkan teks opsi untuk memudahkan parsing. */
function prepareTextForParsing(s) {
	let t = String(s).replace(/\u00A0/g, " ");
	const pipeIdx = t.indexOf(" | ");
	if (pipeIdx >= 0) t = t.slice(0, pipeIdx);
	t = t.replace(/\s+/g, " ").trim();
	return t;
}

/**
 * Menemukan pasangan terisi/kuota terakhir dalam teks.
 * @param {string} text
 * @returns {{terisi:number|null, kuota:number|null}}
 */
function parseCapacityFlexible(text) {
	const matches = [...String(text).matchAll(/(\d+)\s*\/\s*(\d+)/g)];
	if (!matches.length) return { terisi: null, kuota: null };
	const last = matches[matches.length - 1];
	return { terisi: parseInt(last[1], 10), kuota: parseInt(last[2], 10) };
}

/**
 * Mengambil displayCode, nama mata kuliah, dan SKS dari teks dengan fallback.
 * @param {string} text
 * @returns {{displayCode:string,name:string,sks:number|null}}
 */
function parseDisplayMetaRobust(text) {
	let m = String(text).match(/^\s*([A-Z]{1,4}\d{3,6})\s+(.+?)\((\d+)\)/);
	if (m) {
		return { displayCode: m[1], name: m[2].trim(), sks: parseInt(m[3], 10) };
	}
	const tokens = String(text).split(" ");
	const codeGuess =
		tokens[0] && /^[A-Z]{1,5}\d{3,7}$/.test(tokens[0]) ? tokens[0] : "";
	let sks = null;
	const sksMatch = text.match(/\((\d+)\)/);
	if (sksMatch) sks = parseInt(sksMatch[1], 10);

	const noCap = text.replace(/\s+\d+\s*\/\s*\d+\s*$/, "").trim();
	let name = "";
	const idxParen = noCap.indexOf("(");
	if (idxParen > 0) {
		const afterCode = codeGuess
			? noCap.replace(new RegExp("^\\s*" + codeGuess + "\\s*"), "")
			: noCap;
		name = afterCode.slice(0, afterCode.indexOf("(")).trim();
	} else {
		name = tokens
			.slice(1, Math.max(1, tokens.length - 2))
			.join(" ")
			.trim();
	}
	return { displayCode: codeGuess, name, sks };
}

/**
 * Mengecek baris grid hasil FRS untuk memastikan kelas telah diambil.
 * @param {string} codeOrDisplay Kode display atau kode nilai.
 * @param {string|number} kelas Kelas target.
 * @returns {boolean}
 */
function isCandidateInGrid(codeOrDisplay, kelas) {
	const rows = document.querySelectorAll(".GridStyle tr");
	for (const tr of rows) {
		const tds = tr.querySelectorAll("td");
		if (tds.length >= 4) {
			const c = (tds[0].textContent || "").trim();
			const k = (tds[3].textContent || "").trim();
			if (c === codeOrDisplay && k === String(kelas)) return true;
		}
	}
	return false;
}

/** Mengambil jumlah percobaan sebelumnya untuk kandidat yang sama. */
async function getAttempt(rawValue) {
	const { pendingAction } = await chrome.storage.local.get([
		STATE_KEYS.PENDING,
	]);
	if (pendingAction?.rawValue === rawValue) return pendingAction.attempt || 0;
	return 0;
}
/** Mengambil indeks aktif saat ini dari penyimpanan. */
async function getActiveIndex() {
	const st = await chrome.storage.local.get([STATE_KEYS.ACTIVE_INDEX]);
	return st[STATE_KEYS.ACTIVE_INDEX] || 0;
}

/** Mengubah struktur pendingAction menjadi kandidat kelas. */
function pendingToCandidate(p) {
	return {
		rawValue: p.rawValue,
		valueCode: p.valueCode,
		displayCode: p.displayCode,
		name: p.name,
		kelas: p.kelas,
		kategori: p.kategori,
	};
}
/** Promise sleep utilitas. */
function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}
/** Mengirim notifikasi OS melalui background. */
async function notify(title, message) {
	try {
		await chrome.runtime.sendMessage({ type: "NOTIFY", title, message });
	} catch {}
}

/** Mencari elemen select berdasarkan label teks pada FilterBox. */
function findSelectByLabel(labelText) {
	const rows = document.querySelectorAll("table.FilterBox tr");
	for (const tr of rows) {
		const tds = tr.querySelectorAll("td");
		if (!tds.length) continue;
		const label = tds[0].textContent?.trim() || "";
		if (label.toLowerCase().includes(labelText.toLowerCase())) {
			const sel = tr.querySelector("select");
			if (sel) return sel;
		}
	}
	return null;
}

/** Meng-escape karakter HTML umum. */
function escapeHtml(s) {
	return String(s || "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}
