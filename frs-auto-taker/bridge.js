window.addEventListener("message", (ev) => {
	const msg = ev.data;
	if (!msg || msg.__from !== "frs_ext") return;
	// contoh:
	// if (msg.type === 'CALL_GOTAKE') { window.goTake(msg.tipe, 1); }
});
