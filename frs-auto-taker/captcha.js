const img = document.getElementById("captchaImg");
const val = document.getElementById("captchaVal");
const refreshBtn = document.getElementById("refreshBtn");
const submitBtn = document.getElementById("submitBtn");

// Dialog CAPTCHA: menampilkan gambar, input, dan aksi refresh/submit
init().catch(console.error);

async function init() {
	// Ambil URL captcha terakhir dari storage dan pasang event handler
	const lc = await chrome.storage.local.get(["lastCaptcha"]);
	const imageUrl = lc.lastCaptcha?.imageUrl;
	img.src = imageUrl || "";
	val.focus();

	submitBtn.addEventListener("click", submit);
	val.addEventListener("keydown", (e) => {
		if (e.key === "Enter") submit();
	});
	refreshBtn.addEventListener("click", refreshImg);

	// Sinkronisasi jika gambar CAPTCHA diperbarui dari content script
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== "local") return;
		if (changes.lastCaptcha?.newValue?.imageUrl) {
			img.src = changes.lastCaptcha.newValue.imageUrl;
		}
	});
}

async function submit() {
	const lc = await chrome.storage.local.get(["lastCaptcha"]);
	const tabId = lc.lastCaptcha?.tabId;
	const value = val.value.trim();
	if (!tabId || !value) return;
	await chrome.runtime.sendMessage({ type: "CAPTCHA_SUBMIT", tabId, value });
	val.value = "";
}

async function refreshImg() {
	// Tambahkan parameter acak agar gambar tidak di-cache
	const url = new URL(img.src);
	url.searchParams.set("_", String(Math.random()).slice(2));
	img.src = url.href;
	// Perbarui storage agar komponen lain ikut tersinkron
	const lc = await chrome.storage.local.get(["lastCaptcha"]);
	await chrome.storage.local.set({
		lastCaptcha: { ...(lc.lastCaptcha || {}), imageUrl: img.src },
	});
}
