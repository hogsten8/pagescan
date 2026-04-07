(() => {
  if (window.ebokCaptureTool) {
    try { window.ebokCaptureTool.panel.remove(); } catch(e) {}
    delete window.ebokCaptureTool;
  }

  const state = {
    pages: [],
    pagesByNo: new Map(),
    figures: [],
    figureKeys: new Set(),
    autoRunning: false,
    autoMode: "text",
    lastCapturedSig: null
  };

  const SELECTORS = {
    pageInput: 'input#pageNumber, input[name="page"], input[aria-label*="page" i], .pq-page-input',
    nextBtn: 'button[aria-label*="Next" i], button[title*="Next" i], .next, .pq-next-page, .reader-next',
    iframes: 'iframe'
  };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const TURBO = {
    textPolls: 2,
    textPollDelay: 25,
    textFinalDelay: 5,
    imagePolls: 3,
    imagePollDelay: 40,
    imageFinalDelay: 15,
    renderEvery: 25
  };

  function escapeHtml(str = "") {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function normalizeWhitespace(txt = "") {
    return txt
      .replace(/\u00A0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function getPageNumber() {
    try {
      const url = new URL(window.location.href);
      const ppg = url.searchParams.get("ppg");
      if (ppg) return String(ppg).trim();
    } catch(e) {}
    const input = document.querySelector(SELECTORS.pageInput);
    if (input && input.value) return String(input.value).trim();
    return "[OK\u00C4ND]";
  }

  function getReaderDocs() {
    const docs = [];
    document.querySelectorAll(SELECTORS.iframes).forEach(frame => {
      try {
        if (frame.contentDocument) docs.push(frame.contentDocument);
      } catch(e) {}
    });
    if (!docs.length) docs.push(document);
    return docs;
  }

  function getReaderRegions() {
    const out = [];
    for (const doc of getReaderDocs()) {
      try {
        const region =
          doc.getElementById("readerRegion") ||
          doc.querySelector('[id*="readerRegion"]') ||
          doc.body;
        if (region) out.push(region);
      } catch(e) {}
    }
    return out;
  }

  function getCurrentText() {
    const regions = getReaderRegions();
    const chunks = [];
    for (const region of regions) {
      try {
        const txt = normalizeWhitespace(region.innerText || "");
        if (txt.length > 80) chunks.push(txt);
      } catch(e) {}
    }
    return chunks.join("\n\n");
  }

  function getTextSignature(text) {
    const t = normalizeWhitespace(text || getCurrentText());
    return t.slice(0, 500);
  }

  function detectTitle(text) {
    const lines = (text || "")
      .split("\n")
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 20);
    if (!lines.length) return "Saknar titel";
    if (lines[1]) {
      const a = lines[0].replace(/\s*[\u2013-]\s*\d+\s*$/, "").trim();
      const b = lines[1].trim();
      if (a && a === b) return b;
    }
    const numbered = lines.find(l => /^\d+(\.\d+)+\s+/.test(l));
    if (numbered) return numbered.replace(/\s*[\u2013-]\s*\d+\s*$/, "").trim();
    return lines[0];
  }

  function detectFigureId(text = "") {
    const m = text.match(/\b(?:Figure|Fig\.?)\s+(\d+(?:\.\d+)+)\b/i);
    return m ? "Figure " + m[1] : "";
  }

  function logicalImageKey(src = "") {
    if (!src) return "";
    try {
      const u = new URL(src, window.location.href);
      const path = decodeURIComponent(u.pathname).toLowerCase();
      let base = path.split("/").pop() || path;
      base = base.replace(/\.(png|jpe?g|gif|webp|svg)$/i, "");
      base = base
        .replace(/[-_](thumb|small|medium|large|orig|original|full|display|inline)$/i, "")
        .replace(/[-_]\d{2,4}x\d{2,4}$/i, "")
        .replace(/[-_](\d{2,4})$/i, "");
      const full = path + " " + base;
      const figMatch =
        full.match(/\bfig(?:ure)?[-_ ]?(\d+)[-_ ]+(\d+)\b/i) ||
        full.match(/\bfigure[-_ ]?(\d+(?:[-_]\d+)+)\b/i);
      if (figMatch) {
        if (figMatch[2]) return "figure-" + figMatch[1] + "." + figMatch[2];
        return "figure-" + String(figMatch[1]).replace(/[-_]/g, ".");
      }
      const parts = path.split("/").filter(Boolean);
      return parts.slice(-3).join("/") + "|" + base;
    } catch(e) {
      return src.split("?")[0].split("#")[0].toLowerCase();
    }
  }

  function isProbablyRealFigure(imgEl) {
    try {
      const w = imgEl.naturalWidth || imgEl.clientWidth || 0;
      const h = imgEl.naturalHeight || imgEl.clientHeight || 0;
      const area = w * h;
      if (w < 80 || h < 80) return false;
      if (area < 25000) return false;
      const src = (imgEl.currentSrc || imgEl.src || "").toLowerCase();
      if (!src) return false;
      if (src.includes("icon") || src.includes("sprite") || src.includes("logo")) return false;
      return true;
    } catch(e) {
      return false;
    }
  }

  function getQuickFigureMeta(img) {
    let figureId = "";
    let caption = "";
    try {
      const container =
        img.closest("figure, .figure, [class*='figure'], [class*='fig']") ||
        img.parentElement;
      if (container) {
        const capEl = container.querySelector("figcaption, .caption, .figure-caption");
        if (capEl) caption = normalizeWhitespace(capEl.innerText || "");
        const containerText = normalizeWhitespace(container.innerText || "").slice(0, 240);
        if (!figureId) figureId = detectFigureId(containerText);
        if (!caption && figureId) caption = figureId;
      }
    } catch(e) {}
    if (!caption) {
      const alt = normalizeWhitespace(img.getAttribute("alt") || "");
      if (alt && !/^image$/i.test(alt)) caption = alt;
    }
    return { figureId, caption };
  }

  function captureFiguresFast(page, silent = false) {
    let added = 0;
    const regions = getReaderRegions();
    for (const region of regions) {
      let imgs = [];
      try { imgs = [...region.querySelectorAll("img")]; } catch(e) {}
      for (const img of imgs) {
        try {
          if (!isProbablyRealFigure(img)) continue;
          const src = img.currentSrc || img.src || img.getAttribute("data-src") || "";
          if (!src) continue;
          const { figureId, caption } = getQuickFigureMeta(img);
          const logicalKey = logicalImageKey(src);
          const dedupeKey = (figureId || logicalKey || src).toLowerCase();
          if (!dedupeKey || state.figureKeys.has(dedupeKey)) continue;
          state.figureKeys.add(dedupeKey);
          state.figures.push({
            page,
            figureId,
            caption: caption || "Bild p\u00E5 sida " + page,
            src,
            logicalKey
          });
          added++;
        } catch(e) {}
      }
    }
    if (!silent) console.log("\uD83D\uDCF8 +" + added + " nya bilder p\u00E5 sida " + page);
  }

  function captureCurrentPage(options = {}) {
    const includeFigures = !!options.includeFigures;
    const silent = !!options.silent;
    const page = getPageNumber();
    const text = getCurrentText();
    const sig = getTextSignature(text);
    const title = detectTitle(text);
    const existing = state.pagesByNo.get(page);
    if (!existing || existing.sig !== sig) {
      const pageObj = { page, title, text, sig };
      state.pagesByNo.set(page, pageObj);
      const idx = state.pages.findIndex(p => p.page === page);
      if (idx >= 0) state.pages[idx] = pageObj;
      else state.pages.push(pageObj);
    }
    if (includeFigures) captureFiguresFast(page, true);
    state.lastCapturedSig = sig;
    if (!silent) {
      renderList(true);
      console.log("\uD83D\uDCD8 Sida " + page + " f\u00E5ngad | " + title + (includeFigures ? " | text+bilder" : " | text"));
    }
  }

  function dispatchPageInput(input, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value"
    )?.set;
    input.focus();
    if (nativeSetter) nativeSetter.call(input, String(value));
    else input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", which: 13, keyCode: 13, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", which: 13, keyCode: 13, bubbles: true }));
  }

  async function gotoPage(targetPage) {
    const prevSig = getTextSignature();
    if (String(targetPage) === String(getPageNumber())) return;
    const input = document.querySelector(SELECTORS.pageInput);
    if (!input) return;
    dispatchPageInput(input, targetPage);
    for (let i = 0; i < 20; i++) {
      await sleep(50);
      const sig = getTextSignature();
      if (String(getPageNumber()) === String(targetPage) || (sig && sig !== prevSig)) break;
    }
    await sleep(50);
  }

  async function gotoNextPageFast(mode = "text") {
    const prevSig = getTextSignature();
    const prevPage = getPageNumber();
    const nextBtn = document.querySelector(SELECTORS.nextBtn);
    if (nextBtn) {
      nextBtn.click();
    } else {
      const input = document.querySelector(SELECTORS.pageInput);
      if (input) {
        const current = parseInt(getPageNumber(), 10);
        if (!isNaN(current)) dispatchPageInput(input, current + 1);
      }
    }
    const polls = mode === "text+images" ? TURBO.imagePolls : TURBO.textPolls;
    const pollDelay = mode === "text+images" ? TURBO.imagePollDelay : TURBO.textPollDelay;
    const finalDelay = mode === "text+images" ? TURBO.imageFinalDelay : TURBO.textFinalDelay;
    for (let i = 0; i < polls; i++) {
      await sleep(pollDelay);
      const currentSig = getTextSignature();
      const currentPage = getPageNumber();
      if (String(currentPage) !== String(prevPage) || (currentSig && currentSig !== prevSig)) break;
    }
    if (finalDelay > 0) await sleep(finalDelay);
  }

  async function autoCapture(startPage, endPage, mode = "text") {
    if (state.autoRunning) return;
    state.autoRunning = true;
    state.autoMode = mode;
    renderList(true);
    const start = parseInt(startPage, 10);
    const end = parseInt(endPage, 10);
    if (isNaN(start) || isNaN(end) || start > end) {
      alert("Ogiltigt sidintervall.");
      state.autoRunning = false;
      renderList(true);
      return;
    }
    await gotoPage(start);
    const includeFigures = mode === "text+images";
    const totalSteps = (end - start) + 1;
    for (let step = 0; step < totalSteps; step++) {
      if (!state.autoRunning) break;
      if (step > 0) await gotoNextPageFast(mode);
      captureCurrentPage({ includeFigures, silent: true });
      if (step % TURBO.renderEvery === 0 || step === totalSteps - 1) renderList(true);
    }
    state.autoRunning = false;
    renderList(true);
    alert("\u2705 Klar. L\u00E4ge: " + mode + ". F\u00E5ngade " + totalSteps + " steg fr\u00E5n sida " + start + ". Sidor: " + state.pages.length + ", figurer: " + state.figures.length);
  }

  function cleanParagraphsFromText(text = "") {
    return normalizeWhitespace(text)
      .split(/\n{2,}/)
      .map(p => normalizeWhitespace(p))
      .filter(Boolean)
      .filter(p => !/^Bild p\u00E5 sida\s+\d+$/i.test(p))
      .filter(p => !/^Figure\s+\d+(\.\d+)+\s*:?\s*Long Description$/i.test(p))
      .filter(p => !/^Figure\s+\d+(\.\d+)+$/i.test(p));
  }

  function buildInlineExportHtml() {
    const sortedPages = [...state.pages].sort((a, b) => Number(a.page) - Number(b.page));
    const figuresByPage = new Map();
    for (const f of state.figures) {
      if (!figuresByPage.has(f.page)) figuresByPage.set(f.page, []);
      figuresByPage.get(f.page).push(f);
    }
    let html = `<!DOCTYPE html>
<html lang="sv">
<head>
<meta charset="utf-8">
<title>Export fr\u00E5n ebok</title>
<style>
  body { font-family: Arial, sans-serif; margin: 0; background:#f5f7fa; color:#111827; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 28px; }
  .toc { background:#fff; border:1px solid #dbe2ea; border-radius:12px; padding:18px; margin-bottom:24px; }
  .toc h1 { margin:0 0 12px 0; font-size:22px; }
  .toc ul { margin:0; padding-left:20px; }
  .page { background:#fff; border:1px solid #dbe2ea; border-radius:12px; padding:24px; margin-bottom:24px; }
  .page h2 { margin:0 0 8px 0; font-size:24px; }
  .meta { color:#4b5563; margin-bottom:16px; font-size:14px; }
  p { line-height:1.6; white-space:pre-wrap; margin:0 0 14px 0; }
  .figure { border:1px solid #e5e7eb; border-radius:10px; padding:12px; margin:16px 0 18px 0; background:#fafafa; }
  .figure img { max-width:100%; height:auto; display:block; margin:0 auto 10px auto; }
  .figcap { font-size:14px; color:#374151; }
  .tag { display:inline-block; font-size:12px; background:#e0f2fe; color:#075985; padding:3px 8px; border-radius:999px; margin-bottom:8px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="toc">
    <h1>Inneh\u00E5ll</h1>
    <ul>
      ${sortedPages.map(p => "<li><a href=\"#page-" + escapeHtml(p.page) + "\">" + escapeHtml(p.title) + " \u2013 sida " + escapeHtml(p.page) + "</a></li>").join("")}
    </ul>
  </div>
`;
    for (const page of sortedPages) {
      const figs = [...(figuresByPage.get(page.page) || [])];
      const used = new Set();
      const paras = cleanParagraphsFromText(page.text);
      html += "  <section class=\"page\" id=\"page-" + escapeHtml(page.page) + "\">\n";
      html += "    <h2>" + escapeHtml(page.title) + "</h2>\n";
      html += "    <div class=\"meta\">Sida " + escapeHtml(page.page) + "</div>\n";
      for (const para of paras) {
        html += "<p>" + escapeHtml(para) + "</p>";
        const matched = figs.filter(f => {
          const key = f.logicalKey || f.figureId || f.src;
          if (used.has(key)) return false;
          if (!f.figureId) return false;
          const rx = new RegExp("\\b" + f.figureId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
          return rx.test(para);
        });
        for (const f of matched) {
          const key = f.logicalKey || f.figureId || f.src;
          used.add(key);
          html += "    <div class=\"figure\">\n";
          if (f.figureId) html += "      <div class=\"tag\">" + escapeHtml(f.figureId) + "</div>\n";
          html += "      <img src=\"" + escapeHtml(f.src) + "\">\n";
          html += "      <div class=\"figcap\">" + escapeHtml(f.caption || "Bild p\u00E5 sida " + page.page) + "</div>\n    </div>\n";
        }
      }
      const leftovers = figs.filter(f => !used.has(f.logicalKey || f.figureId || f.src));
      if (leftovers.length) {
        html += "<hr style=\"border:none;border-top:1px solid #e5e7eb;margin:20px 0;\">";
        for (const f of leftovers) {
          html += "    <div class=\"figure\">\n";
          if (f.figureId) html += "      <div class=\"tag\">" + escapeHtml(f.figureId) + "</div>\n";
          html += "      <img src=\"" + escapeHtml(f.src) + "\">\n";
          html += "      <div class=\"figcap\">" + escapeHtml(f.caption || "Bild p\u00E5 sida " + page.page) + "</div>\n    </div>\n";
        }
      }
      html += "  </section>";
    }
    html += "\n</div>\n</body>\n</html>";
    return html;
  }

  function openInlineExport() {
    if (!state.pages.length) { alert("Inga sidor f\u00E5ngade \u00E4n."); return; }
    const win = window.open("", "_blank");
    win.document.write(buildInlineExportHtml());
    win.document.close();
  }

  function openGallery() {
    if (!state.figures.length) { alert("Inga figurer f\u00E5ngade \u00E4n."); return; }
    const figures = [...state.figures].sort((a, b) => {
      const pa = Number(a.page), pb = Number(b.page);
      if (pa !== pb) return pa - pb;
      return (a.figureId || "").localeCompare(b.figureId || "");
    });
    const cards = figures.map(f =>
      "<div style=\"border:1px solid #ddd;background:#fff;padding:12px;border-radius:8px;\">" +
      "<img src=\"" + escapeHtml(f.src) + "\" style=\"max-width:100%;height:auto;display:block;margin-bottom:10px;\">" +
      "<div><strong>Sida " + escapeHtml(f.page) + "</strong>" + (f.figureId ? " \u2014 " + escapeHtml(f.figureId) : "") + "</div>" +
      "<div style=\"font-size:14px;color:#374151;margin-top:6px;\">" + escapeHtml(f.caption || "") + "</div>" +
      "<div style=\"font-size:12px;color:#6b7280;margin-top:6px;\">" + escapeHtml(f.logicalKey || "") + "</div>" +
      "</div>"
    ).join("");
    const win = window.open("", "_blank");
    win.document.write("<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Bildgalleri</title>" +
      "<style>body{font-family:Arial,sans-serif;background:#f8f8f8;padding:20px;}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:20px;}</style>" +
      "</head><body><h1>Alla unika figurer</h1><div class=\"grid\">" + cards + "</div></body></html>");
    win.document.close();
  }

  function buildTxtExport() {
    const sortedPages = [...state.pages].sort((a, b) => Number(a.page) - Number(b.page));
    if (!sortedPages.length) return "";
    const groups = [];
    for (const page of sortedPages) {
      const last = groups[groups.length - 1];
      if (last && last.title === page.title) last.pages.push(page);
      else groups.push({ title: page.title, pages: [page] });
    }
    const out = [];
    let lastPara = "";
    for (const group of groups) {
      const firstPage = group.pages[0].page;
      const lastPage = group.pages[group.pages.length - 1].page;
      const pageSpan = firstPage === lastPage ? "s. " + firstPage : "s. " + firstPage + "\u2013" + lastPage;
      out.push(group.title + " [" + pageSpan + "]");
      out.push("");
      for (const page of group.pages) {
        const paras = cleanParagraphsFromText(page.text);
        for (const para of paras) {
          if (para === group.title) continue;
          if (para === lastPara) continue;
          out.push(para);
          out.push("");
          lastPara = para;
        }
      }
      out.push("");
      out.push("");
    }
    return out.join("\n").replace(/\n{4,}/g, "\n\n\n").trim();
  }

  function downloadTxtExport() {
    if (!state.pages.length) { alert("Inga sidor f\u00E5ngade \u00E4n."); return; }
    const txt = buildTxtExport();
    const blob = new Blob(["\uFEFF" + txt], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ebok_export.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function clearAll() {
    state.pages = [];
    state.pagesByNo = new Map();
    state.figures = [];
    state.figureKeys = new Set();
    state.lastCapturedSig = null;
    renderList(true);
  }

  function renderList(force = false) {
    if (!force && state.autoRunning) return;
    const pagesEl = panel.querySelector("#pagesList");
    const figsEl = panel.querySelector("#figList");
    const statEl = panel.querySelector("#stats");
    const sortedPages = [...state.pages].sort((a, b) => Number(a.page) - Number(b.page));
    pagesEl.innerHTML = sortedPages.length
      ? sortedPages.map(p =>
          "<div style=\"padding:6px 8px;border-bottom:1px solid #1f2937;\">" +
          "<strong>Sida " + escapeHtml(p.page) + "</strong><br>" +
          "<span style=\"color:#cbd5e1;\">" + escapeHtml(p.title) + "</span></div>"
        ).join("")
      : "<div style=\"opacity:.65;padding:12px;\">Inga sidor f\u00E5ngade \u00E4n</div>";
    const sortedFigs = [...state.figures].sort((a, b) => Number(a.page) - Number(b.page));
    figsEl.innerHTML = sortedFigs.length
      ? sortedFigs.slice(0, 50).map((f, i) =>
          "<div style=\"padding:6px 8px;border-bottom:1px solid #1f2937;\">" +
          "<strong>" + (i + 1) + ". Sida " + escapeHtml(f.page) + "</strong>" +
          (f.figureId ? " \u2014 " + escapeHtml(f.figureId) : "") + "</div>"
        ).join("")
      : "<div style=\"opacity:.65;padding:12px;\">Inga figurer f\u00E5ngade \u00E4n</div>";
    statEl.innerHTML =
      "<strong>" + state.pages.length + "</strong> sidor &middot; " +
      "<strong>" + state.figures.length + "</strong> unika figurer" +
      (state.autoRunning ? " &middot; <span style=\"color:#86efac;\">auto k\u00F6r (" + escapeHtml(state.autoMode) + ")</span>" : "");
  }

  const panel = document.createElement("div");
  panel.style.cssText =
    "position:fixed;top:18px;right:18px;width:500px;max-height:92vh;overflow:auto;" +
    "background:#0f172a;color:#e5e7eb;border-radius:14px;box-shadow:0 25px 50px -12px rgb(0 0 0 / 0.45);" +
    "z-index:2147483647;font-family:system-ui,sans-serif;padding:16px;border:1px solid #334155;";

  panel.innerHTML =
    "<div style=\"display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px;\">" +
    "<h3 style=\"margin:0;color:#67e8f9;font-size:18px;\">\uD83D\uDCDA ProQuest-f\u00E5ngare</h3>" +
    "<div id=\"stats\" style=\"font-size:12px;color:#cbd5e1;\"></div></div>" +

    "<div style=\"font-size:12px;color:#cbd5e1;background:#111827;padding:10px;border-radius:8px;margin-bottom:10px;line-height:1.4;\">" +
    "Auto navigerar till startsidan f\u00F6re loopen b\u00F6rjar.</div>" +

    "<button id=\"captureBtn\" style=\"width:100%;padding:12px;background:#22c55e;color:#052e16;border:none;border-radius:8px;font-weight:700;margin-bottom:10px;\">" +
    "F\u00E5nga aktuell sida</button>" +

    "<div style=\"background:#111827;padding:12px;border-radius:10px;margin-bottom:10px;\">" +
    "<div style=\"font-weight:700;color:#67e8f9;margin-bottom:8px;\">Auto-bl\u00E4ddring</div>" +
    "<div style=\"display:flex;gap:8px;align-items:end;margin-bottom:8px;\">" +
    "<div style=\"flex:1;\"><small>Fr\u00E5n sida</small><br>" +
    "<input id=\"startPage\" type=\"number\" value=\"41\" style=\"width:100%;padding:8px;background:#1e293b;border:1px solid #475569;border-radius:6px;color:#f8fafc;\"></div>" +
    "<div style=\"flex:1;\"><small>Till sida</small><br>" +
    "<input id=\"endPage\" type=\"number\" value=\"50\" style=\"width:100%;padding:8px;background:#1e293b;border:1px solid #475569;border-radius:6px;color:#f8fafc;\"></div></div>" +
    "<div style=\"display:flex;gap:8px;align-items:end;\">" +
    "<div style=\"flex:1;\"><small>L\u00E4ge</small><br>" +
    "<select id=\"modeSelect\" style=\"width:100%;padding:8px;background:#1e293b;border:1px solid #475569;border-radius:6px;color:#f8fafc;\">" +
    "<option value=\"text\">Bara text (snabbast)</option>" +
    "<option value=\"text+images\">Text + bilder (lite l\u00E5ngsammare)</option></select></div>" +
    "<button id=\"autoBtn\" style=\"padding:10px 22px;background:#3b82f6;color:white;border:none;border-radius:8px;font-weight:700;\">Starta auto</button></div>" +
    "<div style=\"font-size:11px;color:#94a3b8;margin-top:8px;\">Bilder f\u00E5ngas bara i l\u00E4get \"Text + bilder\".</div>" +
    "<button id=\"stopBtn\" style=\"display:none;width:100%;margin-top:8px;padding:10px;background:#ef4444;color:white;border:none;border-radius:8px;\">Stoppa auto</button></div>" +

    "<div style=\"display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px;\">" +
    "<button id=\"exportBtn\" style=\"padding:12px;background:#a855f7;color:white;border:none;border-radius:8px;font-weight:700;\">Visa export inline</button>" +
    "<button id=\"galleryBtn\" style=\"padding:12px;background:#2563eb;color:white;border:none;border-radius:8px;font-weight:700;\">Visa galleri</button>" +
    "<button id=\"txtBtn\" style=\"padding:12px;background:#0ea5e9;color:white;border:none;border-radius:8px;font-weight:700;\">Ladda ner TXT</button></div>" +

    "<button id=\"clearBtn\" style=\"width:100%;padding:10px;background:#ef4444;color:white;border:none;border-radius:8px;margin-bottom:12px;\">Rensa allt</button>" +

    "<div style=\"display:grid;grid-template-columns:1fr 1fr;gap:10px;\">" +
    "<div style=\"background:#111827;border-radius:10px;overflow:hidden;\">" +
    "<div style=\"padding:8px 10px;background:#1f2937;font-weight:700;\">Sidor / kapitel</div>" +
    "<div id=\"pagesList\" style=\"max-height:240px;overflow:auto;font-size:13px;\"></div></div>" +
    "<div style=\"background:#111827;border-radius:10px;overflow:hidden;\">" +
    "<div style=\"padding:8px 10px;background:#1f2937;font-weight:700;\">Figurer</div>" +
    "<div id=\"figList\" style=\"max-height:240px;overflow:auto;font-size:13px;\"></div></div></div>";

  document.body.appendChild(panel);

  panel.querySelector("#captureBtn").onclick = () => {
    const mode = panel.querySelector("#modeSelect").value;
    captureCurrentPage({ includeFigures: mode === "text+images", silent: false });
  };
  panel.querySelector("#autoBtn").onclick = async () => {
    const mode = panel.querySelector("#modeSelect").value;
    panel.querySelector("#stopBtn").style.display = "block";
    await autoCapture(
      panel.querySelector("#startPage").value,
      panel.querySelector("#endPage").value,
      mode
    );
    panel.querySelector("#stopBtn").style.display = "none";
  };
  panel.querySelector("#stopBtn").onclick = () => {
    state.autoRunning = false;
    panel.querySelector("#stopBtn").style.display = "none";
    renderList(true);
  };
  panel.querySelector("#exportBtn").onclick = openInlineExport;
  panel.querySelector("#galleryBtn").onclick = openGallery;
  panel.querySelector("#txtBtn").onclick = downloadTxtExport;
  panel.querySelector("#clearBtn").onclick = () => {
    if (confirm("Rensa allt f\u00E5ngat inneh\u00E5ll?")) clearAll();
  };

  window.ebokCaptureTool = {
    panel, state, captureCurrentPage, autoCapture, openInlineExport, openGallery, downloadTxtExport
  };

  renderList(true);
  console.log("%c\u2705 Ultra-turbo-version av ProQuest-f\u00E5ngare aktiv", "color:#67e8f9;font-weight:bold;font-size:15px");
})();
