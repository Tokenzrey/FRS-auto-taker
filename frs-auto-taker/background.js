/*
 Dokumentasi
 Nama Berkas: background.js
 Deskripsi: Service worker ekstensi (MV3) yang mengoordinasikan state global, komunikasi antar komponen (popup, content, offscreen), alur hunting, CAPTCHA, dan Notify Extended.
 Tanggung Jawab:
 - Menyimpan serta memutakhirkan state di chrome.storage.local.
 - Meneruskan dan merespon pesan runtime (chrome.runtime.onMessage).
 - Mengelola siklus hidup audio offscreen untuk peringatan.
 - Menangani toggle dan baseline Notify Extended.
 - Menyampaikan hasil atau perintah ke content script (PRIORITY_UPDATED, NOTIFY_*).
 Kunci Penyimpanan Utama:
	 priority, runMode, pendingAction, activeCandidateIndex, classes, collapseSections,
	 lastCaptcha, notifyExtendedEnabled, notifyExtendedBaseline, notifyExtendedLastCheckTs.
 Pesan Utama:
	 PLAY_BEEP, START_DISTURBING_BEEP, STOP_DISTURBING_BEEP, GET_STATE, SET_STATE,
	 REORDER_PRIORITY, NEED_CAPTCHA, CAPTCHA_SUBMIT, STOP_HUNT, TOGGLE_NOTIFY_EXTENDED,
	 NOTIFY_BUILD_BASELINE, NOTIFY_EXTENDED_FOUND, NOTIFY_SET_LAST_TS, NOTIFY_STATUS, NOTIFY.
*/
const STATE_KEYS = {
	PRIORITY: "priority",
	RUNMODE: "runMode",
	PENDING: "pendingAction",
	ACTIVE_INDEX: "activeCandidateIndex",
	CLASSES: "classes",
	COLLAPSE: "collapseSections",
	LAST_CAPTCHA: "lastCaptcha",
	NOTIFY_ENABLED: "notifyExtendedEnabled",
	NOTIFY_BASELINE: "notifyExtendedBaseline",
	NOTIFY_LAST_TS: "notifyExtendedLastCheckTs",
};

chrome.runtime.onInstalled.addListener(async () => {
	const st = await chrome.storage.local.get(null);
	const set = {};
	if (!st[STATE_KEYS.RUNMODE]) set[STATE_KEYS.RUNMODE] = "idle";
	if (st[STATE_KEYS.NOTIFY_ENABLED] === undefined)
		set[STATE_KEYS.NOTIFY_ENABLED] = false;
	if (Object.keys(set).length) await chrome.storage.local.set(set);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	/**
	 * Router pesan utama service worker.
	 * Menangani audio offscreen, state, prioritas, captcha, serta notify extended.
	 */
	(async () => {
		switch (msg?.type) {
			case "PLAY_BEEP": {
				try {
					await AudioClient.ensureOffscreenReady();
					await AudioClient.playBeep(msg.options || {});
					sendResponse({ ok: true });
				} catch (e) {
					sendResponse({ ok: false, error: String(e) });
				}
				break;
			}

			case "START_DISTURBING_BEEP": {
				try {
					await AudioClient.ensureOffscreenReady();
					await AudioClient.startLoop(msg.options || {});
					sendResponse({ ok: true });
				} catch (e) {
					sendResponse({ ok: false, error: String(e) });
				}
				break;
			}

			case "STOP_DISTURBING_BEEP": {
				try {
					await AudioClient.ensureOffscreenReady();
					await AudioClient.stopLoop();
					sendResponse({ ok: true });
				} catch (e) {
					sendResponse({ ok: false, error: String(e) });
				}
				break;
			}
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

			case "TOGGLE_NOTIFY_EXTENDED": {
				const { enable } = msg;
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
	/** Mengambil tabId aktif pada jendela saat ini. */
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	return tab?.id || null;
}

/**
 * AudioClient
 * Facade to communicate with the offscreen audio page with retries and readiness checks.
 */
const AudioClient = {
	/** Ensure offscreen document is created and ready. */
	async ensureOffscreenReady() {
		try {
			console.log("[FRS][AudioClient] ensureOffscreenReady: checking...");
		} catch {}
		const has = await chrome.offscreen.hasDocument?.();
		if (!has) {
			try {
				console.log("[FRS][AudioClient] creating offscreen document...");
			} catch {}
			await chrome.offscreen.createDocument({
				url: "offscreen.html",
				reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
				justification:
					"Memutar suara peringatan saat Notify Extended tanpa interaksi pengguna",
			});
			await this._sleep(150);
			try {
				console.log("[FRS][AudioClient] offscreen created");
			} catch {}
		}
	},
	/** Play a single beep via offscreen. */
	async playBeep(options) {
		try {
			console.log("[FRS][AudioClient] playBeep");
		} catch {}
		return await this._withRetry(
			() =>
				chrome.runtime.sendMessage({ type: "OFFSCREEN_PLAY_BEEP", options }),
			5,
			150
		);
	},
	/** Start a repeating loop via offscreen. */
	async startLoop(options) {
		try {
			console.log("[FRS][AudioClient] startLoop", options);
		} catch {}
		return await this._withRetry(
			() =>
				chrome.runtime.sendMessage({
					type: "OFFSCREEN_START_BEEP_LOOP",
					options,
				}),
			5,
			150
		);
	},
	/** Stop any running loop via offscreen. */
	async stopLoop() {
		try {
			console.log("[FRS][AudioClient] stopLoop");
		} catch {}
		return await this._withRetry(
			() => chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP_BEEP" }),
			5,
			150
		);
	},
	/** Utilitas retry sederhana untuk panggilan runtime. */
	async _withRetry(fn, maxAttempts, delayMs) {
		let lastErr;
		for (let i = 1; i <= maxAttempts; i++) {
			try {
				return await fn();
			} catch (e) {
				lastErr = e;
				if (i < maxAttempts) await this._sleep(delayMs);
			}
		}
		throw lastErr || new Error("AudioClient call failed");
	},
	/** Delay utilitas. */
	_sleep(ms) {
		return new Promise((r) => setTimeout(r, ms));
	},
};
