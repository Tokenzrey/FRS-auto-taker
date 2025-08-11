/* Agent di halaman list_frs.php */

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
};

let MAX_CAPTCHA_ATTEMPTS = 8;
const BACKOFF_MS = 3000;

init().catch(console.error);

async function init() {
	try {
		const { opts } = await chrome.storage.local.get(["opts"]);
		if (opts?.maxCaptcha) MAX_CAPTCHA_ATTEMPTS = opts.maxCaptcha;
	} catch {}

	const classes = parseAllClasses();
	await chrome.storage.local.set({
		[STATE_KEYS.CLASSES]: { updatedAt: Date.now(), items: classes },
	});

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

			case "PRIORITY_UPDATED":
				await chrome.storage.local.set({ [STATE_KEYS.ACTIVE_INDEX]: 0 });
				await huntNext(true);
				sendResponse({ ok: true });
				break;

			case "CAPTCHA_VALUE":
				await submitWithCaptcha(msg.value);
				sendResponse({ ok: true });
				break;

			// tombol Refresh di popup
			case "REFRESH_CAPTCHA":
				await refreshCaptchaImage();
				sendResponse({ ok: true });
				break;

			default:
				sendResponse({ ok: true });
				break;
		}
	})();
	return true;
});

// ---------- Core ----------

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

	// Ambil src CAPTCHA yang ADA saat ini TANPA cache-bust
	const imgEl = FORM.captchaImage();
	const imgUrl = imgEl
		? new URL(imgEl.getAttribute("src"), location.href).href
		: new URL("/securimage/securimage_show.php", location.href).href;

	// Buat snapshot dataURL agar popup tidak memicu request server
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
		imageUrl: imgUrl, // tetap dikirim sebagai fallback
		imageDataUrl, // <-- utama untuk popup
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

// ---------- Helpers ----------

function ensureForm() {
	if (!FORM.sip() || !FORM.act() || !FORM.key() || !FORM.captchaKey()) {
		alert("Struktur form FRS berubah. Ekstensi tidak dapat melanjutkan.");
		throw new Error("FRS form not found");
	}
}

// Snapshot gambar captcha jadi dataURL agar popup tidak memicu request baru
async function snapshotCaptcha(imgEl, imgUrl) {
	try {
		// Prioritas: gunakan elemen img yang ada di halaman
		const src = imgEl ? imgEl.getAttribute("src") : imgUrl;
		const abs = new URL(src, location.href).href;

		// Jika imgEl tersedia dan sudah load, langsung capture
		if (
			imgEl &&
			imgEl.complete &&
			imgEl.naturalWidth > 0 &&
			imgEl.naturalHeight > 0
		) {
			return captureElementToDataURL(imgEl);
		}

		// Jika belum load, coba muat di content world (synchronous ke origin yang sama)
		const tmp = new Image();
		// sama origin, tidak perlu crossOrigin
		const loaded = await imageLoad(tmp, abs);
		if (loaded) return drawToDataURL(tmp);

		// Fallback terakhir: fetch blob lalu konversi ke dataURL
		const res = await fetch(abs, { credentials: "include", cache: "no-store" });
		const blob = await res.blob();
		return await blobToDataURL(blob);
	} catch {
		return ""; // biarkan popup fallback ke imageUrl (terjadi hanya jika sangat perlu)
	}
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

// Saat refresh: ubah src di halaman (cache-bust), TUNGGU load, baru kirim dataURL baru
async function refreshCaptchaImage() {
	const img = FORM.captchaImage();
	if (!img) return;

	const base = new URL(img.getAttribute("src"), location.href);
	base.searchParams.set("_", String(Math.random()).slice(2));
	const newUrl = base.href;

	const loaded = await imageLoad(img, newUrl); // menunggu load selesai
	if (!loaded) return;

	// pakai elemen yang sama untuk snapshot (pasti sama dengan yang akan divalidasi server)
	const imageDataUrl = captureElementToDataURL(img);

	// Ambil metadata kandidat dari storage untuk judul/desc/attempt
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
		imageDataUrl, // kirim snapshot-nya
		meta,
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
