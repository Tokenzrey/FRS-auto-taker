// Background service worker

// Default state
const STATE_KEYS = {
	PRIORITY: "priority",
	RUNMODE: "runMode",
	PENDING: "pendingAction",
	ACTIVE_INDEX: "activeCandidateIndex",
	CLASSES: "classes",
	COLLAPSE: "collapseSections",
	LAST_CAPTCHA: "lastCaptcha",
};

// Ensure base state exists
chrome.runtime.onInstalled.addListener(async () => {
	const st = await chrome.storage.local.get(null);
	if (!st[STATE_KEYS.RUNMODE]) {
		await chrome.storage.local.set({ [STATE_KEYS.RUNMODE]: "idle" });
	}
});

// Central message bus
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	(async () => {
		switch (msg?.type) {
			case "GET_STATE": {
				const all = await chrome.storage.local.get(null);
				sendResponse(all);
				break;
			}

			case "SET_STATE": {
				const payload = msg.payload || {};
				await chrome.storage.local.set(payload);
				sendResponse({ ok: true });
				break;
			}

			case "REORDER_PRIORITY": {
				const priority = msg.priority || [];
				await chrome.storage.local.set({ [STATE_KEYS.PRIORITY]: priority });
				try {
					const [tab] = await chrome.tabs.query({
						active: true,
						currentWindow: true,
					});
					if (tab?.id)
						chrome.tabs.sendMessage(tab.id, { type: "PRIORITY_UPDATED" });
				} catch {}
				sendResponse({ ok: true });
				break;
			}

			// SINGLE SOURCE OF TRUTH for CAPTCHA (sekarang simpan juga dataURL)
			case "NEED_CAPTCHA": {
				const imageUrl = msg.imageUrl || null;
				const imageDataUrl = msg.imageDataUrl || null; // <-- tambah
				const meta = msg.meta || null;
				const tabId = sender?.tab?.id || (await getActiveTabId());
				await chrome.storage.local.set({
					[STATE_KEYS.LAST_CAPTCHA]: {
						imageUrl,
						imageDataUrl, // <-- simpan
						tabId,
						meta,
						ts: Date.now(),
					},
				});
				sendResponse({ ok: true });
				break;
			}

			case "CAPTCHA_SUBMIT": {
				const { tabId, value } = msg;
				if (tabId && value) {
					try {
						await chrome.tabs.sendMessage(tabId, {
							type: "CAPTCHA_VALUE",
							value,
						});
						sendResponse({ ok: true });
					} catch (e) {
						sendResponse({ ok: false, error: String(e) });
					}
				} else {
					sendResponse({ ok: false, error: "tabId/value missing" });
				}
				break;
			}

			case "STOP_HUNT": {
				await chrome.storage.local.set({
					[STATE_KEYS.RUNMODE]: "idle",
					[STATE_KEYS.PENDING]: null,
					[STATE_KEYS.ACTIVE_INDEX]: 0,
					[STATE_KEYS.LAST_CAPTCHA]: null,
				});
				sendResponse({ ok: true });
				break;
			}

			case "NOTIFY": {
				const { title, message } = msg;
				try {
					await chrome.notifications.create({
						type: "basic",
						iconUrl: "assets/icon128.png",
						title: title || "FRS Auto-Taker",
						message: message || "",
					});
				} catch {}
				sendResponse({ ok: true });
				break;
			}

			default:
				sendResponse({ ok: true });
		}
	})();
	return true;
});

async function getActiveTabId() {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	return tab?.id || null;
}
