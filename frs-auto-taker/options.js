const KEY = "opts";
const els = {
	maxCaptcha: document.getElementById("maxCaptcha"),
	save: document.getElementById("save"),
	msg: document.getElementById("msg"),
};

init().catch(console.error);

async function init() {
	const st = await chrome.storage.local.get([KEY]);
	const opts = st[KEY] || { maxCaptcha: 8 };
	els.maxCaptcha.value = opts.maxCaptcha;
	els.save.addEventListener("click", save);
}

async function save() {
	const maxCaptcha = Math.max(
		1,
		Math.min(20, parseInt(els.maxCaptcha.value, 10) || 8)
	);
	await chrome.storage.local.set({ [KEY]: { maxCaptcha } });
	els.msg.textContent = "Saved.";
	setTimeout(() => (els.msg.textContent = ""), 1500);
}
