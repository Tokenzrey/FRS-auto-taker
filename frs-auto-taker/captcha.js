const img = document.getElementById("captchaImg");
const val = document.getElementById("captchaVal");
const refreshBtn = document.getElementById("refreshBtn");
const submitBtn = document.getElementById("submitBtn");

init().catch(console.error);

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

	// Listen storage change for new image (if page refreshes it)
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
	// Tambahkan noise param agar reload gambar
	const url = new URL(img.src);
	url.searchParams.set("_", String(Math.random()).slice(2));
	img.src = url.href;
	// Update juga di storage agar popup sinkron (opsional)
	const lc = await chrome.storage.local.get(["lastCaptcha"]);
	await chrome.storage.local.set({
		lastCaptcha: { ...(lc.lastCaptcha || {}), imageUrl: img.src },
	});
}
