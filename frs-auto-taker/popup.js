// Kunci-kunci state yang digunakan Popup (sinkron dengan Background/Content)
const STATE_KEYS = {
	PRIORITY: "priority",
	RUNMODE: "runMode",
	PENDING: "pendingAction",
	ACTIVE_INDEX: "activeCandidateIndex",
	CLASSES: "classes",
	COLLAPSE: "collapseSections",
	LAST_CAPTCHA: "lastCaptcha",

	NOTIFY_ENABLED: "notifyExtendedEnabled",
	NOTIFY_LAST_TS: "notifyExtendedLastCheckTs",
};

// Label kategori untuk tampilan UI
const LABELS = {
	jur: "Kelas Dep.",
	jurlain: "Kelas Dep. Lain",
	tpb: "Kelas SKPB",
	pengayaan: "Kelas Pengayaan",
	mbkm: "Kelas MBKM",
};

// Referensi elemen UI utama
const els = {
	statusDot: document.getElementById("statusDot"),
	setupSection: document.getElementById("setupSection"),
	huntSection: document.getElementById("huntSection"),

	search: document.getElementById("search"),
	refresh: document.getElementById("refresh"),

	classSections: document.getElementById("classSections"),
	priorityList: document.getElementById("priorityList"),

	startBtn: document.getElementById("startBtn"),
	clearPriority: document.getElementById("clearPriority"),

	stopBtn: document.getElementById("stopBtn"),
	targetTitle: document.getElementById("targetTitle"),
	targetDesc: document.getElementById("targetDesc"),
	attemptInfo: document.getElementById("attemptInfo"),
	captchaPreview: document.getElementById("captchaPreview"),
	captchaInput: document.getElementById("captchaInput"),
	captchaSubmit: document.getElementById("captchaSubmit"),
	captchaRefresh: document.getElementById("captchaRefresh"),
	log: document.getElementById("log"),

	// Elemen untuk Notify Extended
	notifyToggle: document.getElementById("notifyToggle"),
	notifyBadge: document.getElementById("notifyBadge"),
	notifyHint: document.getElementById("notifyHint"),
};

let classesCache = [];
let filterText = "";
let collapseState = {
	jur: false,
	jurlain: false,
	tpb: false,
	pengayaan: false,
	mbkm: false,
};
let dragging = null;

// Inisialisasi Popup
init().catch(console.error);

async function init() {
	// Muat state awal, setup UI mode, dan pasang event handler
	const st = await getState();
	window.__stateCache = st;

	classesCache = st[STATE_KEYS.CLASSES]?.items || [];
	collapseState = Object.assign(collapseState, st["collapseSections"] || {});

	// Status awal toggle Notify Extended
	const notifyEnabled = !!st[STATE_KEYS.NOTIFY_ENABLED];
	els.notifyToggle.checked = notifyEnabled;

	// Mode UI awal (Idle vs Hunting)
	if (st[STATE_KEYS.RUNMODE] === "hunting") enterHuntUI();
	else enterSetupUI();

	// Event handler
	els.search.addEventListener("input", () => {
		filterText = els.search.value.trim();
		renderClassSections(getPrioritySync());
	});
	els.refresh.addEventListener("click", refreshClasses);
	els.startBtn.addEventListener("click", startHunt);
	els.clearPriority.addEventListener("click", () =>
		savePriority([]).then(() => renderClassSections([]))
	);
	els.stopBtn.addEventListener("click", stopHunt);
	els.captchaSubmit.addEventListener("click", submitCaptcha);
	els.captchaInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter") submitCaptcha();
	});
	els.captchaRefresh.addEventListener("click", refreshCaptcha);

	els.notifyToggle.addEventListener("change", onToggleNotify);

	// Dengarkan perubahan storage untuk captcha, runMode, dan notify
	chrome.storage.onChanged.addListener(async (changes, area) => {
		if (area !== "local") return;

		if (changes[STATE_KEYS.LAST_CAPTCHA]?.newValue) {
			const lc = changes[STATE_KEYS.LAST_CAPTCHA].newValue || {};
			const dataUrl = lc.imageDataUrl || "";
			const imageUrl = lc.imageUrl || "";
			const meta = lc.meta || null;

			if (els.huntSection.hidden) enterHuntUI();
			const nextSrc = dataUrl || imageUrl || "";
			if (nextSrc && els.captchaPreview.src !== nextSrc) {
				els.captchaPreview.src = nextSrc;
			}
			renderTargetMeta(meta);
			setTimeout(() => els.captchaInput?.focus(), 30);
		}

		if (changes[STATE_KEYS.RUNMODE]?.newValue) {
			if (changes[STATE_KEYS.RUNMODE].newValue === "idle") {
				enterSetupUI();
			} else if (changes[STATE_KEYS.RUNMODE].newValue === "hunting") {
				enterHuntUI();
			}
		}

		if (changes[STATE_KEYS.NOTIFY_ENABLED]) {
			const on = !!changes[STATE_KEYS.NOTIFY_ENABLED].newValue;
			els.notifyToggle.checked = on;
			updateNotifyUI(on);
		}
	});

	// Jika sedang hunting, tampilkan CAPTCHA/meta terakhir
	const lc = st[STATE_KEYS.LAST_CAPTCHA];
	if (lc && st[STATE_KEYS.RUNMODE] === "hunting") {
		const nextSrc = lc.imageDataUrl || lc.imageUrl || "";
		if (nextSrc && els.captchaPreview.src !== nextSrc) {
			els.captchaPreview.src = nextSrc;
		}
		renderTargetMeta(lc.meta || null);
		const pending = st[STATE_KEYS.PENDING];
		if (pending?.attempt)
			els.attemptInfo.textContent = `Percobaan ke-${pending.attempt}`;
		setTimeout(() => els.captchaInput?.focus(), 50);
	}

	updateNotifyUI(notifyEnabled);
	setupDragAndDrop();
}

/* ---------- Notify Extended (UI) ---------- */

async function onToggleNotify() {
	const on = els.notifyToggle.checked;
	const st = await getState();
	if (st[STATE_KEYS.RUNMODE] !== "idle" && on) {
		// Tidak bisa mengaktifkan saat tidak Idle
		els.notifyToggle.checked = false;
		return;
	}
	await chrome.runtime.sendMessage({
		type: "TOGGLE_NOTIFY_EXTENDED",
		enable: on,
	});
	if (on) {
		// Bangun baseline terbaru
		await chrome.runtime.sendMessage({ type: "NOTIFY_BUILD_BASELINE" });
	}
	updateNotifyUI(on);
}

function updateNotifyUI(on) {
	els.notifyBadge.textContent = on ? "On" : "Off";
	els.notifyBadge.className = `badge ${on ? "live" : "muted"}`;
	// Saat Notify ON → disable Start agar tidak bentrok (kebijakan)
	els.startBtn.disabled = on;
	els.startBtn.title = on
		? "Matikan Notify Extended untuk memulai Hunting"
		: "";
	els.notifyHint.textContent = on
		? "Watching… halaman akan direfresh berkala sesuai Options."
		: "Memantau kenaikan kuota untuk kelas di Prioritas. Hanya bisa diaktifkan saat Idle.";
}

/* ---------- Mode UI ---------- */
function enterHuntUI() {
	setDot("hunting");
	els.setupSection.hidden = true;
	els.huntSection.hidden = false;
}
function enterSetupUI() {
	setDot("idle");
	els.setupSection.hidden = false;
	els.huntSection.hidden = true;
	renderClassSections(getPrioritySyncInitial());
}

function setDot(kind) {
	els.statusDot.className = `dot ${kind}`;
	els.statusDot.title = kind === "hunting" ? "Hunting" : "Idle";
}

/* ---------- Umum ---------- */

async function getState() {
	return await chrome.runtime.sendMessage({ type: "GET_STATE" });
}
function getPrioritySync() {
	return window._priority || [];
}
function getPrioritySyncInitial() {
	return (
		window._priority ||
		(window._priority = (window.__stateCache || {})[STATE_KEYS.PRIORITY] || [])
	);
}
async function savePriority(priority) {
	window._priority = priority;
	await chrome.runtime.sendMessage({ type: "REORDER_PRIORITY", priority });
}

function renderClassSections(priority) {
	window._priority = priority.slice();
	els.classSections.innerHTML = "";

	const inPriority = new Set(priority.map((p) => p.rawValue));
	const filtered = classesCache.filter((c) => {
		if (inPriority.has(c.rawValue)) return false;
		if (!filterText) return true;
		const hay = `${c.valueCode} ${c.displayCode} ${c.kelas} ${c.name} ${
			c.sks ?? ""
		}`.toLowerCase();
		return hay.includes(filterText.toLowerCase());
	});

	const dataByCat = groupBy(filtered, "kategori");
	const order = ["jur", "jurlain", "tpb", "pengayaan", "mbkm"];

	for (const k of order) {
		const items = dataByCat[k] || [];
		const section = document.createElement("div");
		section.className = `section${collapseState[k] ? " collapsed" : ""}`;

		const hdr = document.createElement("button");
		hdr.type = "button";
		hdr.className = "section-header";
		hdr.setAttribute("aria-expanded", String(!collapseState[k]));
		hdr.innerHTML = `
      <span class="chev">${collapseState[k] ? "▶" : "▼"}</span>
      <span>${LABELS[k] || k}</span>
      <span class="count">${items.length}</span>
    `;
		hdr.addEventListener("click", async () => {
			collapseState[k] = !collapseState[k];
			await chrome.storage.local.set({ collapseSections: collapseState });
			renderClassSections(getPrioritySync());
		});
		section.appendChild(hdr);

		const ul = document.createElement("ul");
		ul.className = "list";
		ul.dataset.section = k;
		if (collapseState[k]) ul.style.display = "none";

		for (const c of items) ul.appendChild(classItem(c, false));
		section.appendChild(ul);
		els.classSections.appendChild(section);
	}

	// Kolom Prioritas
	els.priorityList.innerHTML = "";
	for (const p of priority) els.priorityList.appendChild(classItem(p, true));

	bindPriorityDropzone();
	bindClassSectionDropzones();
}

function classItem(item, removable) {
	const li = document.createElement("li");
	li.draggable = true;
	li.dataset.rawValue = item.rawValue;
	li.dataset.source = removable ? "priority" : "class";

	li.innerHTML = `
    <div class="drag-handle" title="Drag">&#8942;</div>
    <div class="meta">
      <div class="item-title">${escapeHtml(
				item.displayCode || item.valueCode
			)} — ${escapeHtml(item.name || "")}${
		item.sks ? ` (${item.sks})` : ""
	}</div>
      <div class="item-sub">Kelas ${escapeHtml(item.kelas || "")}
        <span class="badge">${LABELS[item.kategori] || item.kategori}</span>
      </div>
    </div>
    <div class="badge cap">${kapTxt(item.kapasitas)}</div>
  `;

	if (removable) {
		li.addEventListener("dblclick", async () => {
			const pr = getPrioritySync().filter((p) => p.rawValue !== item.rawValue);
			await savePriority(pr);
			renderClassSections(pr);
		});
	} else {
		li.addEventListener("dblclick", async () => {
			const pr = getPrioritySync().concat([item]);
			await savePriority(pr);
			renderClassSections(pr);
		});
	}
	return li;
}

function kapTxt(k) {
	if (!k || k.terisi == null || k.kuota == null) return "—";
	return `${k.terisi}/${k.kuota}`;
}

async function refreshClasses() {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (tab?.id) chrome.tabs.reload(tab.id);
}

async function startHunt() {
	const pr = getPrioritySync();
	if (!pr.length) {
		alert("Priority kosong. Pilih kelas dulu.");
		return;
	}
	await chrome.runtime.sendMessage({
		type: "SET_STATE",
		payload: {
			[STATE_KEYS.PRIORITY]: pr,
			[STATE_KEYS.RUNMODE]: "hunting",
			[STATE_KEYS.ACTIVE_INDEX]: 0,
			[STATE_KEYS.PENDING]: null,
		},
	});
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: "START_HUNT" });
	enterHuntUI();
}

async function stopHunt() {
	await chrome.runtime.sendMessage({ type: "STOP_HUNT" });
	enterSetupUI();
	els.captchaPreview.removeAttribute("src");
	els.targetTitle.textContent = "Menyiapkan…";
	els.targetDesc.textContent = "";
	els.attemptInfo.textContent = "";
}

async function submitCaptcha() {
	const value = els.captchaInput.value.trim();
	if (!value) return;
	const lc = await chrome.storage.local.get([STATE_KEYS.LAST_CAPTCHA]);
	const tabId = lc[STATE_KEYS.LAST_CAPTCHA]?.tabId;
	if (!tabId) {
		alert("Tab FRS tidak ditemukan.");
		return;
	}
	await chrome.runtime.sendMessage({ type: "CAPTCHA_SUBMIT", tabId, value });
	log(`CAPTCHA dikirim.`);
	els.captchaInput.value = "";
}

async function refreshCaptcha() {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!tab?.id) return;
	await chrome.tabs.sendMessage(tab.id, { type: "REFRESH_CAPTCHA" });
	log("CAPTCHA di-refresh.");
}

function log(s) {
	const line = document.createElement("div");
	line.textContent = `[${new Date().toLocaleTimeString()}] ${s}`;
	els.log.prepend(line);
}

/* ---------- Metadata target ---------- */
function renderTargetMeta(meta) {
	if (!meta) {
		els.targetTitle.textContent = "Menyiapkan…";
		els.targetDesc.textContent = "";
		els.attemptInfo.textContent = "";
		return;
	}
	els.targetTitle.textContent = meta.title || "Menyiapkan…";
	els.targetDesc.textContent = meta.desc || "";
	if (typeof meta.attempt === "number") {
		els.attemptInfo.textContent = `Percobaan ke-${meta.attempt}`;
	}
}

/* ---------- Drag & Drop ---------- */
function setupDragAndDrop() {
	document.addEventListener("dragstart", (e) => {
		const li = e.target.closest("li");
		if (!li || !li.dataset.rawValue) return;
		dragging = {
			raw: li.dataset.rawValue,
			source: li.dataset.source === "priority" ? "priority" : "class",
			height: li.getBoundingClientRect().height,
		};
		li.classList.add("dragging");
		e.dataTransfer.effectAllowed = "move";
		e.dataTransfer.setData("text/plain", dragging.raw);
	});
	document.addEventListener("dragend", () => {
		const d = document.querySelector("li.dragging");
		if (d) d.classList.remove("dragging");
		dragging = null;
		clearDropIndicators();
	});
	els.classSections.addEventListener("dragover", (e) => e.preventDefault());
}

function bindPriorityDropzone() {
	const priorityCol = els.priorityList.closest(".col") || els.priorityList;
	const onOver = (e) => {
		e.preventDefault();
		priorityCol.classList.add("priority-drop");
		const index = getDropIndex(els.priorityList, e.clientY);
		showDropIndicatorAt(els.priorityList, index);
	};
	const onLeave = () => {
		priorityCol.classList.remove("priority-drop");
		clearDropIndicators();
	};
	const onDrop = async (e) => {
		e.preventDefault();
		priorityCol.classList.remove("priority-drop");
		const raw = e.dataTransfer.getData("text/plain") || dragging?.raw;
		if (!raw) return;

		const pr = getPrioritySync().slice();
		const index = getDropIndex(els.priorityList, e.clientY);

		if (dragging?.source === "priority") {
			const srcIndex = pr.findIndex((p) => p.rawValue === raw);
			if (srcIndex < 0) return;
			const [moved] = pr.splice(srcIndex, 1);
			const dest = srcIndex < index ? index - 1 : index;
			pr.splice(dest, 0, moved);
			await savePriority(pr);
			renderClassSections(pr);
		} else {
			if (pr.some((p) => p.rawValue === raw)) return;
			const item = classesCache.find((c) => c.rawValue === raw);
			if (!item) return;
			pr.splice(index, 0, item);
			await savePriority(pr);
			renderClassSections(pr);
		}
		clearDropIndicators();
	};

	priorityCol.addEventListener("dragover", onOver);
	priorityCol.addEventListener("dragleave", onLeave);
	priorityCol.addEventListener("drop", onDrop);
}

function bindClassSectionDropzones() {
	els.classSections.querySelectorAll(".list").forEach((ul) => {
		ul.classList.remove("drop-target");
		ul.addEventListener("dragover", (e) => {
			e.preventDefault();
			ul.classList.add("drop-target");
		});
		ul.addEventListener("dragleave", () => ul.classList.remove("drop-target"));
		ul.addEventListener("drop", async (e) => {
			e.preventDefault();
			ul.classList.remove("drop-target");
			const raw = e.dataTransfer.getData("text/plain") || dragging?.raw;
			if (!raw) return;
			if (dragging?.source === "priority") {
				const pr = getPrioritySync().slice();
				const idx = pr.findIndex((p) => p.rawValue === raw);
				if (idx >= 0) {
					pr.splice(idx, 1);
					await savePriority(pr);
					renderClassSections(pr);
				}
			}
			clearDropIndicators();
		});
	});
}

function getDropIndex(ul, y) {
	const children = Array.from(ul.children);
	if (!children.length) return 0;
	let idx = children.length;
	for (let i = 0; i < children.length; i++) {
		const rect = children[i].getBoundingClientRect();
		const mid = rect.top + rect.height / 2;
		if (y < mid) {
			idx = i;
			break;
		}
	}
	return idx;
}
function showDropIndicatorAt(ul, index) {
	clearDropIndicators();
	const items = Array.from(ul.children);
	if (!items.length || index >= items.length) {
		ul.classList.add("drop-at-end");
		return;
	}
	items[index].classList.add("drop-before");
}
function clearDropIndicators() {
	els.priorityList.classList.remove("drop-at-end");
	els.priorityList
		.querySelectorAll("li.drop-before")
		.forEach((el) => el.classList.remove("drop-before"));
}

/* ---------- Utilitas ---------- */
function groupBy(arr, key) {
	return arr.reduce((acc, it) => {
		const k = it[key] || "";
		(acc[k] ||= []).push(it);
		return acc;
	}, {});
}
function escapeHtml(s) {
	return String(s || "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}
