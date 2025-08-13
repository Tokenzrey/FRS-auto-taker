/*
 Dokumentasi
 Nama Berkas: options.js
 Deskripsi: Logika halaman opsi untuk menyimpan preferensi seperti batas percobaan CAPTCHA dan interval Notify Extended.
 Tanggung Jawab:
 - Membaca dan menulis preferensi ke chrome.storage.local.
 - Memvalidasi nilai masukan sederhana.
 Dependensi: DOM options.html, chrome.storage.local.
*/
const KEY = "opts";
const els = {
	maxCaptcha: document.getElementById("maxCaptcha"),
	notifyIntervalSec: document.getElementById("notifyIntervalSec"),
	save: document.getElementById("save"),
	msg: document.getElementById("msg"),
};

init().catch(console.error);

/** Inisialisasi halaman opsi dan memuat nilai awal. */
async function init() {
	const st = await chrome.storage.local.get([KEY]);
	const opts = st[KEY] || { maxCaptcha: 8, notifyIntervalSec: 30 };
	els.maxCaptcha.value = opts.maxCaptcha ?? 8;
	els.notifyIntervalSec.value = opts.notifyIntervalSec ?? 30;
	els.save.addEventListener("click", save);
}

/** Simpan preferensi ke chrome.storage.local. */
async function save() {
	const maxCaptcha = Math.max(
		1,
		Math.min(20, parseInt(els.maxCaptcha.value, 10) || 8)
	);
	const notifyIntervalSec = Math.max(
		5,
		Math.min(300, parseInt(els.notifyIntervalSec.value, 10) || 30)
	);
	await chrome.storage.local.set({ [KEY]: { maxCaptcha, notifyIntervalSec } });
	els.msg.textContent = "Saved.";
	setTimeout(() => (els.msg.textContent = ""), 1500);
}
