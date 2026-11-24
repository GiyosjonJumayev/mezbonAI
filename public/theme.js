// Runs before the first paint so the chosen theme never flashes.
try { const t = localStorage.getItem("mezbon.theme"); if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; } catch {}
