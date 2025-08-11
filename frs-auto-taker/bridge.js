// Jembatan pesan opsional dari halaman ke Content Script (jika diperlukan)
// Saat ini tidak ada pesan khusus yang diproses.
window.addEventListener("message", (ev) => {
	const msg = ev.data;
	if (!msg || msg.__from !== "frs_ext") return;
	// Contoh penggunaan (nonaktif):
	// if (msg.type === 'CALL_GOTAKE') { window.goTake(msg.tipe, 1); }
});
