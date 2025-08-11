/*
 * Agent untuk halaman list_frs.php
 *
 * Fungsionalitas:
 * - Parsing kelas (sedini mungkin) dan penyimpanan ke storage
 * - Proses ambil kelas (Hunting) + evaluasi hasil setelah reload
 * - Pusat CAPTCHA (snapshot dataURL, refresh, submit)
 * - Notify Extended (pantau kenaikan kuota, tampilkan overlay+suara, auto mulai hunting)
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

	// Notify Extended
	NOTIFY_ENABLED: "notifyExtendedEnabled",
	NOTIFY_BASELINE: "notifyExtendedBaseline", // { [rawValue]: { kuota, ts } }
	NOTIFY_LAST_TS: "notifyExtendedLastCheckTs",
};

// Early DOM Sniffer: mem-parsing kelas segera saat opsi muncul
// Tujuan: mengurangi jeda, tidak menunggu render/DOMContentLoaded
earlyParseWhenOptionsReady();

function earlyParseWhenOptionsReady() {
	// gabungan semua selector yang mungkin berisi kelas
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

		// cek apakah SUDAH ada opsi bermakna (value bukan string kosong)
		const hasUsefulOptions = selects.some((sel) =>
			Array.from(sel.options || []).some(
				(opt) => (opt.value || "").trim() !== ""
			)
		);
		if (!hasUsefulOptions) return;

		// saat opsi sudah ada → parse segera
		const classes = parseAllClasses();
		chrome.storage.local.set({
			[STATE_KEYS.CLASSES]: { updatedAt: Date.now(), items: classes },
		});

		parsedOnce = true;
		if (mo) mo.disconnect();
	};

	// 1) Coba sinkron (jika sudah ada)
	tryParse();

	// 2) Jika belum ada, observasi DOM untuk menangkap momen pertama opsi muncul
	if (!parsedOnce) {
		mo = new MutationObserver(() => {
			tryParse();
		});
		mo.observe(document.documentElement || document, {
			childList: true,
			subtree: true,
		});

		// 3) Fallback: coba ulang beberapa kali awal (ringan, non-spam)
		let retries = 10;
		const tick = () => {
			if (parsedOnce) return;
			tryParse();
			if (!parsedOnce && --retries > 0) {
				// gunakan micro-delay kecil supaya responsif
				setTimeout(tick, 50);
			}
		};
		setTimeout(tick, 0);
	}
}

let MAX_CAPTCHA_ATTEMPTS = 8;
const BACKOFF_MS = 3000;

// Notify Extended runtime
let notifyTimer = null;
let notifyIntervalMs = 30000; // default; bisa ditimpa dari Options
const OVERLAY_ID = "frs-ext-notify-overlay";

init().catch(console.error);

async function init() {
	// Muat opsi dari Options
	try {
		const { opts } = await chrome.storage.local.get(["opts"]);
		if (opts?.maxCaptcha) MAX_CAPTCHA_ATTEMPTS = opts.maxCaptcha;
		if (opts?.notifyIntervalSec)
			notifyIntervalMs = Math.max(5, +opts.notifyIntervalSec) * 1000;
	} catch {}

	// Parse kelas saat halaman siap
	const classes = parseAllClasses();
	await chrome.storage.local.set({
		[STATE_KEYS.CLASSES]: { updatedAt: Date.now(), items: classes },
	});

	// Notify Extended: jalankan siklus awal saat load (jika aktif)
	const { notifyExtendedEnabled } = await chrome.storage.local.get([
		STATE_KEYS.NOTIFY_ENABLED,
	]);
	if (notifyExtendedEnabled) {
		// 1) bandingkan baseline (jika ada), 2) jika tidak extended, jadwalkan reload berikutnya
		await notifyCheckAndSchedule();
	}

	// Jika sedang hunting: evaluasi pending lalu lanjut
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

// Listener pesan dari Background/Popup
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

			case "PRIORITY_UPDATED":
				await chrome.storage.local.set({ [STATE_KEYS.ACTIVE_INDEX]: 0 });
				// Jika notify extended ON → rebuild baseline agar akurat
				{
					const { notifyExtendedEnabled } = await chrome.storage.local.get([
						STATE_KEYS.NOTIFY_ENABLED,
					]);
					if (notifyExtendedEnabled) await buildNotifyBaseline();
				}
				await huntNext(true);
				sendResponse({ ok: true });
				break;

			case "CAPTCHA_VALUE":
				await submitWithCaptcha(msg.value);
				sendResponse({ ok: true });
				break;

			case "REFRESH_CAPTCHA":
				await refreshCaptchaImage();
				sendResponse({ ok: true });
				break;

			// Notify Extended controls
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

/* ===========================
	Hunting (inti)
=========================== */

async function huntNext(forceTop = false) {
	const st = await chrome.storage.local.get([
		STATE_KEYS.PRIORITY,
		STATE_KEYS.ACTIVE_INDEX,
		STATE_KEYS.RUNMODE,
	]);
	if (st[STATE_KEYS.RUNMODE] !== "hunting") return;
	const priority = st[STATE_KEYS.PRIORITY] || [];
	if (!priority.length) return;

	const idx = forceTop ? 0 : st[STATE_KEYS.ACTIVE_INDEX] || 0;
	if (idx >= priority.length) {
		await notify("Selesai", "Semua kandidat sudah dicoba.");
		await chrome.storage.local.set({
			[STATE_KEYS.RUNMODE]: "idle",
			[STATE_KEYS.PENDING]: null,
		});
		return;
	}
	const candidate = priority[idx];
	await tryTakeCandidate(candidate, idx);
}

async function tryTakeCandidate(candidate, index) {
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

	// CAPTCHA: gunakan snapshot dataURL agar popup tidak memicu request ulang
	const imgEl = FORM.captchaImage();
	const imgUrl = imgEl
		? new URL(imgEl.getAttribute("src"), location.href).href
		: new URL("/securimage/securimage_show.php", location.href).href;
	const imageDataUrl = await snapshotCaptcha(imgEl, imgUrl);

	const meta = {
		title: `${pending.displayCode || pending.valueCode} — Kelas ${
			pending.kelas
		}`,
		desc: pending.name || "",
		kelas: String(pending.kelas || ""),
		kategori: String(pending.kategori || ""),
		attempt: pending.attempt || 1,
	};

	await chrome.runtime.sendMessage({
		type: "NEED_CAPTCHA",
		imageUrl: imgUrl,
		imageDataUrl,
		meta,
	});

	ensureForm();
	FORM.act().value = "ambil";
	FORM.key().value = candidate.rawValue;
	FORM.captchaKey().value = "";
	FORM.captchaInput()?.focus();
}

async function submitWithCaptcha(value) {
	const ci = FORM.captchaInput();
	if (ci) ci.value = value;
	FORM.captchaKey().value = value;
	FORM.sip().submit();
}

async function evaluateAfterReload(pending) {
	const ok =
		isCandidateInGrid(pending.displayCode, pending.kelas) ||
		isCandidateInGrid(pending.valueCode, pending.kelas);
	if (ok) {
		await notify(
			"Berhasil",
			`Berhasil ambil ${pending.displayCode || pending.valueCode} kelas ${
				pending.kelas
			}.`
		);
		await chrome.storage.local.set({
			[STATE_KEYS.PENDING]: null,
			[STATE_KEYS.ACTIVE_INDEX]: (await getActiveIndex()) + 1,
		});
		return;
	}

	const classes = parseAllClasses();
	const found = classes.find((c) => c.rawValue === pending.rawValue);
	let captchaError = true;
	if (found) {
		const { terisi, kuota } = found.kapasitas || {};
		if (typeof terisi === "number" && typeof kuota === "number") {
			if (kuota === 0 || terisi >= kuota) captchaError = false;
		}
	}

	if (!captchaError) {
		await notify(
			"Kelas penuh",
			`${pending.displayCode || pending.valueCode} kelas ${
				pending.kelas
			} penuh. Lanjut kandidat berikut.`
		);
		await chrome.storage.local.set({
			[STATE_KEYS.PENDING]: null,
			[STATE_KEYS.ACTIVE_INDEX]: (await getActiveIndex()) + 1,
		});
	} else {
		const attempts = pending.attempt || 1;
		if (attempts >= MAX_CAPTCHA_ATTEMPTS) {
			await notify(
				"CAPTCHA gagal",
				`Terlalu banyak percobaan untuk ${
					pending.displayCode || pending.valueCode
				} ${pending.kelas}. Lewati.`
			);
			await chrome.storage.local.set({
				[STATE_KEYS.PENDING]: null,
				[STATE_KEYS.ACTIVE_INDEX]: (await getActiveIndex()) + 1,
			});
		} else {
			await sleep(BACKOFF_MS);
			await tryTakeCandidate(
				found || pendingToCandidate(pending),
				await getActiveIndex()
			);
		}
	}
}

/* ===========================
	Notify Extended
=========================== */

async function enableNotifyWatcher(enable) {
	// Baca opsi interval dari storage
	try {
		const { opts } = await chrome.storage.local.get(["opts"]);
		if (opts?.notifyIntervalSec)
			notifyIntervalMs = Math.max(5, +opts.notifyIntervalSec) * 1000;
	} catch {}

	// Simpan flag enable/disable ke storage
	await chrome.storage.local.set({ [STATE_KEYS.NOTIFY_ENABLED]: !!enable });

	// Bersihkan timer yang aktif jika ada
	if (notifyTimer) {
		clearTimeout(notifyTimer);
		notifyTimer = null;
	}

	if (enable) {
		await buildNotifyBaseline(); // Snapshot awal dari daftar prioritas
		await notifyCheckAndSchedule(); // Cek sekarang, lalu jadwalkan reload
	} else {
		removeOverlay();
	}
}

// Membangun baseline kuota dari kelas di daftar prioritas saat ini
async function buildNotifyBaseline() {
	const st = await chrome.storage.local.get([
		STATE_KEYS.PRIORITY,
		STATE_KEYS.CLASSES,
	]);
	const priority = st[STATE_KEYS.PRIORITY] || [];
	const classes = st[STATE_KEYS.CLASSES]?.items || parseAllClasses();

	const pMap = new Map(priority.map((p) => [p.rawValue, true]));
	const baseline = {};

	for (const c of classes) {
		if (!pMap.has(c.rawValue)) continue;
		const kuota = c.kapasitas?.kuota;
		if (typeof kuota === "number") {
			baseline[c.rawValue] = { kuota, ts: Date.now() };
		}
	}

	await chrome.storage.local.set({ [STATE_KEYS.NOTIFY_BASELINE]: baseline });
}

// Siklus Notify: bandingkan baseline vs kondisi sekarang.
// Jika ada kenaikan kuota → overlay + suara + mulai hunting.
// Jika tidak ada → perbarui baseline dan jadwalkan reload berikutnya.
async function notifyCheckAndSchedule() {
	const st = await chrome.storage.local.get([
		STATE_KEYS.NOTIFY_ENABLED,
		STATE_KEYS.PRIORITY,
		STATE_KEYS.CLASSES,
		STATE_KEYS.NOTIFY_BASELINE,
		STATE_KEYS.RUNMODE,
	]);

	// Jika notify tidak aktif atau sedang hunting, hentikan proses
	if (!st[STATE_KEYS.NOTIFY_ENABLED] || st[STATE_KEYS.RUNMODE] !== "idle")
		return;

	const priority = st[STATE_KEYS.PRIORITY] || [];
	const pOrder = new Map(priority.map((p, i) => [p.rawValue, i])); // untuk pilih top-priority

	// Pastikan data kelas terbaru tersedia
	let classes = st[STATE_KEYS.CLASSES]?.items;
	if (!Array.isArray(classes) || !classes.length) {
		classes = parseAllClasses();
		await chrome.storage.local.set({
			[STATE_KEYS.CLASSES]: { updatedAt: Date.now(), items: classes },
		});
	}

	const baseline = st[STATE_KEYS.NOTIFY_BASELINE] || {};
	if (!Object.keys(baseline).length) {
		await buildNotifyBaseline();
	}

	// Bandingkan kuota baseline vs sekarang
	const nowMap = new Map(classes.map((c) => [c.rawValue, c]));
	const extendedItems = [];

	for (const [raw, base] of Object.entries(baseline)) {
		const c = nowMap.get(raw);
		if (!c) continue;
		const newKuota = c.kapasitas?.kuota;
		const oldKuota = base?.kuota;
		if (typeof newKuota !== "number" || typeof oldKuota !== "number") continue;
		if (newKuota > oldKuota) {
			extendedItems.push({
				rawValue: raw,
				displayCode: c.displayCode || c.valueCode,
				name: c.name || "",
				kelas: c.kelas || "",
				oldKuota,
				newKuota,
				delta: newKuota - oldKuota,
				kategori: c.kategori,
			});
		}
	}

	if (extendedItems.length) {
		// Tampilkan overlay + mainkan suara peringatan
		showOverlayExtended(extendedItems);
		playLoudBeep();

		// Pilih target hunting berdasarkan urutan prioritas
		extendedItems.sort(
			(a, b) =>
				(pOrder.get(a.rawValue) ?? 1e9) - (pOrder.get(b.rawValue) ?? 1e9)
		);
		const target = extendedItems[0];
		const targetIndex = pOrder.get(target.rawValue) ?? 0;

		// Matikan notify, set state hunting, dan mulai kandidat target
		await chrome.runtime.sendMessage({ type: "NOTIFY_EXTENDED_FOUND" });
		await chrome.storage.local.set({
			[STATE_KEYS.NOTIFY_ENABLED]: false,
			[STATE_KEYS.RUNMODE]: "hunting",
			[STATE_KEYS.PENDING]: null,
			[STATE_KEYS.ACTIVE_INDEX]: targetIndex,
		});
		await chrome.runtime.sendMessage({ type: "NOTIFY_SET_LAST_TS" });

		// Mulai proses ambil kelas (langsung)
		const st2 = await chrome.storage.local.get([STATE_KEYS.PRIORITY]);
		const candidate = (st2[STATE_KEYS.PRIORITY] || [])[targetIndex];
		if (candidate) {
			await tryTakeCandidate(candidate, targetIndex);
		}
		// Overlay akan hilang sendiri 10 detik atau saat submit
		return;
	}

	// Tidak ada kenaikan kuota → perbarui baseline agar deteksi delta berkelanjutan
	const newBaseline = {};
	for (const p of priority) {
		const c = nowMap.get(p.rawValue);
		const kuota = c?.kapasitas?.kuota;
		if (typeof kuota === "number")
			newBaseline[p.rawValue] = { kuota, ts: Date.now() };
	}
	await chrome.storage.local.set({
		[STATE_KEYS.NOTIFY_BASELINE]: newBaseline,
		[STATE_KEYS.NOTIFY_LAST_TS]: Date.now(),
	});

	// Jadwalkan reload berikutnya (menghormati interval dari Options)
	if (notifyTimer) clearTimeout(notifyTimer);
	notifyTimer = setTimeout(() => {
		// reload page untuk mendapatkan data terbaru
		location.reload();
	}, notifyIntervalMs);
}

// Overlay merah berisi daftar kelas yang kuotanya bertambah (otomatis hilang 10 detik)
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

	// Auto-remove
	setTimeout(removeOverlay, 10000);
}

function removeOverlay() {
	document.getElementById(OVERLAY_ID)?.remove();
}

// Suara peringatan singkat
function playLoudBeep() {
	try {
		const audio = new Audio(
			chrome.runtime.getURL("assets/notify-extended.mp3")
		);
		audio.play();

		const AudioCtx = window.AudioContext || window.webkitAudioContext;
		const ctx = new AudioCtx();
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		osc.type = "square";
		osc.frequency.value = 880; // tinggi
		gain.gain.value = 0.5; // cukup keras
		osc.connect(gain).connect(ctx.destination);
		osc.start();

		// pattern: 300ms on, 150ms off, 300ms on
		setTimeout(() => (gain.gain.value = 0), 300);
		setTimeout(() => (gain.gain.value = 0.5), 450);
		setTimeout(() => {
			gain.gain.value = 0;
			osc.stop();
			ctx.close();
		}, 750);
	} catch {}
}

/* ===========================
	Utilitas bersama
=========================== */

function ensureForm() {
	if (!FORM.sip() || !FORM.act() || !FORM.key() || !FORM.captchaKey()) {
		alert("Struktur form FRS berubah. Ekstensi tidak dapat melanjutkan.");
		throw new Error("FRS form not found");
	}
}

// Membuat snapshot gambar captcha menjadi dataURL agar Popup tidak memicu request baru
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

function imageLoad(img, src) {
	return new Promise((resolve) => {
		img.onload = () => resolve(true);
		img.onerror = () => resolve(false);
		img.src = src;
	});
}

function blobToDataURL(blob) {
	return new Promise((resolve, reject) => {
		const fr = new FileReader();
		fr.onload = () => resolve(String(fr.result || ""));
		fr.onerror = reject;
		fr.readAsDataURL(blob);
	});
}

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

function parseOptionValue(val) {
	const parts = String(val).split("|");
	return {
		code: parts[0] || "",
		kelas: parts[1] || "",
		thnKurikulum: parts[2] || "",
		jur: parts[3] || "",
	};
}

function getOptionText(opt) {
	return (
		opt.getAttribute?.("label") ||
		opt.text ||
		opt.textContent ||
		opt.innerText ||
		""
	);
}

function prepareTextForParsing(s) {
	let t = String(s).replace(/\u00A0/g, " ");
	const pipeIdx = t.indexOf(" | ");
	if (pipeIdx >= 0) t = t.slice(0, pipeIdx);
	t = t.replace(/\s+/g, " ").trim();
	return t;
}

function parseCapacityFlexible(text) {
	const matches = [...String(text).matchAll(/(\d+)\s*\/\s*(\d+)/g)];
	if (!matches.length) return { terisi: null, kuota: null };
	const last = matches[matches.length - 1];
	return { terisi: parseInt(last[1], 10), kuota: parseInt(last[2], 10) };
}

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

async function getAttempt(rawValue) {
	const { pendingAction } = await chrome.storage.local.get([
		STATE_KEYS.PENDING,
	]);
	if (pendingAction?.rawValue === rawValue) return pendingAction.attempt || 0;
	return 0;
}
async function getActiveIndex() {
	const st = await chrome.storage.local.get([STATE_KEYS.ACTIVE_INDEX]);
	return st[STATE_KEYS.ACTIVE_INDEX] || 0;
}

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
function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}
async function notify(title, message) {
	try {
		await chrome.runtime.sendMessage({ type: "NOTIFY", title, message });
	} catch {}
}

// Mencari elemen <select> berdasarkan label (teks di kolom pertama pada FilterBox)
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

// Utilitas kecil
function escapeHtml(s) {
	return String(s || "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}
