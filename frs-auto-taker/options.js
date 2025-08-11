// Halaman Options: mengelola preferensi pengguna
// - maxCaptcha: batas maksimal percobaan CAPTCHA saat hunting
// - notifyIntervalSec: interval reload (detik) untuk Notify Extended
const KEY = "opts";
const els = {
	maxCaptcha: document.getElementById("maxCaptcha"),
	notifyIntervalSec: document.getElementById("notifyIntervalSec"),
	save: document.getElementById("save"),
	msg: document.getElementById("msg"),
};

init().catch(console.error);

async function init() {
	// Muat nilai awal dari storage dan pasang event handler
	const st = await chrome.storage.local.get([KEY]);
	const opts = st[KEY] || { maxCaptcha: 8, notifyIntervalSec: 30 };
	els.maxCaptcha.value = opts.maxCaptcha ?? 8;
	els.notifyIntervalSec.value = opts.notifyIntervalSec ?? 30;
	els.save.addEventListener("click", save);
}

async function save() {
	// Validasi input dan simpan ke storage
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
