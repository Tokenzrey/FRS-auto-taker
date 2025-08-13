/*
 Dokumentasi
 Nama Berkas: captcha.js
 Deskripsi: Tampilan minimal untuk menampilkan gambar CAPTCHA dan mengirim nilai ke tab FRS sumber.
 Tanggung Jawab:
 - Memantau perubahan lastCaptcha dan memperbarui pratinjau gambar.
 - Mengirim nilai CAPTCHA serta memperbarui URL saat refresh.
 Dependensi: chrome.runtime messaging, chrome.storage.local.
*/
const img = document.getElementById("captchaImg");
const val = document.getElementById("captchaVal");
const refreshBtn = document.getElementById("refreshBtn");
const submitBtn = document.getElementById("submitBtn");

init().catch(console.error);

/** Inisialisasi tampilan captcha dan binding event. */
async function init() {
	const lc = await chrome.storage.local.get(["lastCaptcha"]);
	const imageUrl = lc.lastCaptcha?.imageUrl;
	img.src = imageUrl || "";
	val.focus();

	submitBtn.addEventListener("click", submit);
	val.addEventListener("keydown", (e) => {
		if (e.key === "Enter") submit();
	});
	refreshBtn.addEventListener("click", refreshImg);

	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== "local") return;
		if (changes.lastCaptcha?.newValue?.imageUrl) {
			img.src = changes.lastCaptcha.newValue.imageUrl;
		}
	});
}

/** Kirim nilai captcha ke tab sumber FRS. */
async function submit() {
	const lc = await chrome.storage.local.get(["lastCaptcha"]);
	const tabId = lc.lastCaptcha?.tabId;
	const value = val.value.trim();
	if (!tabId || !value) return;
	await chrome.runtime.sendMessage({ type: "CAPTCHA_SUBMIT", tabId, value });
	val.value = "";
}

/** Refresh gambar captcha dan sinkronkan URL ke storage. */
async function refreshImg() {
	const url = new URL(img.src);
	url.searchParams.set("_", String(Math.random()).slice(2));
	img.src = url.href;
	const lc = await chrome.storage.local.get(["lastCaptcha"]);
	await chrome.storage.local.set({
		lastCaptcha: { ...(lc.lastCaptcha || {}), imageUrl: img.src },
	});
}
