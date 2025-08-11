/*
 * Service Worker (Background)
 *
 * Peran:
 * - Menjadi pusat state global (chrome.storage.local)
 * - Bus pesan antara Popup dan Content Script
 * - Mengelola alur CAPTCHA, proses Hunting, dan Notify Extended
 */

/**
 * Kunci-kunci state yang disimpan di chrome.storage.local
 * - PRIORITY: daftar kandidat prioritas untuk diambil
 * - RUNMODE: mode runtime ("idle" | "hunting")
 * - PENDING: informasi kandidat yang sedang dicoba (untuk evaluasi pasca reload)
 * - ACTIVE_INDEX: indeks kandidat aktif di daftar prioritas
 * - CLASSES: hasil parsing seluruh kelas { updatedAt, items }
 * - COLLAPSE: preferensi UI (status collapse per seksi) di Popup
 * - LAST_CAPTCHA: cache metadata captcha terakhir (url, snapshot, tabId, meta)
 * - NOTIFY_ENABLED: status Notify Extended (on/off)
 * - NOTIFY_BASELINE: baseline kuota per kandidat prioritas { [rawValue]: { kuota, ts } }
 * - NOTIFY_LAST_TS: timestamp pengecekan Notify Extended terakhir
 */
const STATE_KEYS = {
	PRIORITY: "priority",
	RUNMODE: "runMode",
	PENDING: "pendingAction",
	ACTIVE_INDEX: "activeCandidateIndex",
	CLASSES: "classes",
	COLLAPSE: "collapseSections",
	LAST_CAPTCHA: "lastCaptcha",

	// Notify Extended
	NOTIFY_ENABLED: "notifyExtendedEnabled",
	NOTIFY_BASELINE: "notifyExtendedBaseline", // { [rawValue]: { kuota:number, ts:number } }
	NOTIFY_LAST_TS: "notifyExtendedLastCheckTs",
};

// Inisialisasi nilai default saat ekstensi terpasang/diupdate
chrome.runtime.onInstalled.addListener(async () => {
	const st = await chrome.storage.local.get(null);
	const set = {};
	if (!st[STATE_KEYS.RUNMODE]) set[STATE_KEYS.RUNMODE] = "idle";
	if (st[STATE_KEYS.NOTIFY_ENABLED] === undefined)
		set[STATE_KEYS.NOTIFY_ENABLED] = false;
	if (Object.keys(set).length) await chrome.storage.local.set(set);
});

// Bus pesan terpusat antara Popup dan Content Script
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

			// Sumber kebenaran tunggal untuk CAPTCHA (URL, snapshot dataURL, dan meta)
			case "NEED_CAPTCHA": {
				const imageUrl = msg.imageUrl || null;
				const imageDataUrl = msg.imageDataUrl || null;
				const meta = msg.meta || null;
				const tabId = sender?.tab?.id || (await getActiveTabId());
				await chrome.storage.local.set({
					[STATE_KEYS.LAST_CAPTCHA]: {
						imageUrl,
						imageDataUrl,
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

			// Toggle Notify Extended (hanya boleh ON saat Idle)
			case "TOGGLE_NOTIFY_EXTENDED": {
				const { enable } = msg;
				// validasi: hanya boleh enable jika idle
				const st = await chrome.storage.local.get([STATE_KEYS.RUNMODE]);
				if (enable && st[STATE_KEYS.RUNMODE] !== "idle") {
					sendResponse({
						ok: false,
						error: "Must be idle to enable notify extended.",
					});
					break;
				}
				await chrome.storage.local.set({
					[STATE_KEYS.NOTIFY_ENABLED]: !!enable,
					[STATE_KEYS.NOTIFY_BASELINE]: enable ? {} : null,
				});
				try {
					const [tab] = await chrome.tabs.query({
						active: true,
						currentWindow: true,
					});
					if (tab?.id) {
						await chrome.tabs.sendMessage(tab.id, {
							type: enable ? "NOTIFY_EXTENDED_START" : "NOTIFY_EXTENDED_STOP",
						});
					}
				} catch {}
				sendResponse({ ok: true });
				break;
			}

			case "NOTIFY_BUILD_BASELINE": {
				// Minta Content melakukan parse & membangun baseline terbaru
				try {
					const [tab] = await chrome.tabs.query({
						active: true,
						currentWindow: true,
					});
					if (tab?.id) {
						await chrome.tabs.sendMessage(tab.id, {
							type: "NOTIFY_BUILD_BASELINE",
						});
					}
				} catch {}
				sendResponse({ ok: true });
				break;
			}

			case "NOTIFY_EXTENDED_FOUND": {
				// Content mengabarkan ada kuota bertambah → matikan flag notify agar UI konsisten
				await chrome.storage.local.set({ [STATE_KEYS.NOTIFY_ENABLED]: false });
				sendResponse({ ok: true });
				break;
			}

			case "NOTIFY_SET_LAST_TS": {
				await chrome.storage.local.set({
					[STATE_KEYS.NOTIFY_LAST_TS]: Date.now(),
				});
				sendResponse({ ok: true });
				break;
			}

			case "NOTIFY_STATUS": {
				const st = await chrome.storage.local.get([
					STATE_KEYS.NOTIFY_ENABLED,
					STATE_KEYS.NOTIFY_LAST_TS,
					STATE_KEYS.NOTIFY_BASELINE,
				]);
				sendResponse({
					enabled: !!st[STATE_KEYS.NOTIFY_ENABLED],
					lastTs: st[STATE_KEYS.NOTIFY_LAST_TS] || null,
					baselineSize: st[STATE_KEYS.NOTIFY_BASELINE]
						? Object.keys(st[STATE_KEYS.NOTIFY_BASELINE]).length
						: 0,
				});
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
