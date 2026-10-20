/* =====================================================================
   Tesseract Studio: application
   ---------------------------------------------------------------------
   Files -> models.js (any format, no size limit) -> viewer.js (preview)
   -> ar.js (WebXR, AR Quick Look or the camera view).
   This file holds the interface: language, theme, the sheet, the
   inspector and opening files.
   ===================================================================== */
(function () {
  "use strict";

  var VERSION = "1.0.0";
  var ASSET_QS = (function () {
    var src = document.currentScript && document.currentScript.src || "";
    var i = src.indexOf("?");
    return i === -1 ? "" : src.slice(i);
  })();

  /* Single source of truth for every reset. Change defaults here only. */
  var DEFAULT_PREFERENCES = Object.freeze({
    startSize: 20,       // centimetres, longest side of the model when AR opens
    autoRotate: false,
  });
  var LIMITS = Object.freeze({ startSizeMin: 5, startSizeMax: 100 });
  var STORAGE = { theme: "preferredTheme", lang: "preferredLanguage", prefs: "tesseractStudio.preferences" };

  /* ----------------------------------------------------------- helpers */
  var $ = function (id) { return document.getElementById(id); };
  var root = document.documentElement;
  function store(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* private mode */ } }
  function load(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function formatBytes(n) {
    if (n < 1024) return n + " B";
    var u = ["KB", "MB", "GB"], i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return (n >= 100 ? n.toFixed(0) : n.toFixed(1)) + " " + u[i];
  }

  function loadPreferences() {
    var prefs = Object.assign({}, DEFAULT_PREFERENCES);
    try {
      var saved = JSON.parse(load(STORAGE.prefs) || "{}");
      if (isFinite(saved.startSize)) prefs.startSize = clamp(Math.round(saved.startSize / 5) * 5, LIMITS.startSizeMin, LIMITS.startSizeMax);
      if (typeof saved.autoRotate === "boolean") prefs.autoRotate = saved.autoRotate;
    } catch (e) { /* ignore corrupt data */ }
    return prefs;
  }

  /* ------------------------------------------------------------- state */
  var state = {
    prefs: loadPreferences(),
    themePref: "dark",
    lang: "en",
    model: null,        // { name, format, size, stats, zUp, dims }
    upAxis: "y",
    arMode: "none",
    loading: false,
  };

  var dom = {
    stageBody: $("stageBody"), dropzone: $("dropzone"), viewport: $("viewport"), fileInput: $("fileInput"),
    fileMeta: $("fileMeta"), replaceBtn: $("replaceBtn"),
    arHint: $("arHint"), arBtn: $("arBtn"), arMode: $("arMode"),
    startSize: $("startSize"), startSizeValue: $("startSizeValue"),
    infoFormat: $("infoFormat"), infoFileSize: $("infoFileSize"), infoTriangles: $("infoTriangles"), infoVertices: $("infoVertices"), infoDimensions: $("infoDimensions"),
    upSeg: $("upSeg"), spinSwitch: $("spinSwitch"), resetViewBtn: $("resetViewBtn"),
    arLayer: $("arLayer"), arVideo: $("arVideo"), arStatus: $("arStatus"), arScale: $("arScale"), arClose: $("arClose"), arReset: $("arReset"),
    busy: $("busy"), busyText: $("busyText"), toast: $("toast"), toastText: $("toastText"),
    themeBtn: $("themeBtn"), helpBtn: $("helpBtn"), langBtn: $("langBtn"),
    sheet: $("sheet"), sheetBackdrop: $("sheetBackdrop"), sheetTitle: $("sheetTitle"), sheetBack: $("sheetBack"),
    sheetBackLabel: $("sheetBackLabel"), sheetDone: $("sheetDone"), sheetBody: $("sheetBody"), langList: $("langList"),
  };
  dom.arLayer.tabIndex = -1;

  /* ============================================================== i18n */
  var LANGUAGES = window.TSS_LANGUAGES || [];
  var DICT = window.TSS_TRANSLATIONS = window.TSS_TRANSLATIONS || {};
  function hasLanguage(code) { return LANGUAGES.some(function (l) { return l.code === code; }); }

  var langLoads = {};
  function loadLanguage(code) {
    if (DICT[code]) return Promise.resolve(true);
    if (!langLoads[code]) {
      langLoads[code] = new Promise(function (resolve) {
        var s = document.createElement("script");
        s.src = "assets/i18n/" + code + ".js" + ASSET_QS;
        s.onload = function () { resolve(!!DICT[code]); };
        s.onerror = function () { delete langLoads[code]; resolve(false); };
        document.head.appendChild(s);
      });
    }
    return langLoads[code];
  }

  function t(key, vars) {
    var d = DICT[state.lang];
    var s = (d && d[key] != null) ? d[key] : (DICT.en && DICT.en[key] != null) ? DICT.en[key] : key;
    if (vars) s = s.replace(/\{(\w+)\}/g, function (m, k) { return vars[k] != null ? vars[k] : m; });
    return s;
  }

  function detectLanguage() {
    var saved = load(STORAGE.lang);
    if (saved && hasLanguage(saved)) return saved;
    var prefs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || "en"];
    for (var i = 0; i < prefs.length; i++) {
      var base = String(prefs[i] || "").toLowerCase().split("-")[0];
      if (base === "tl") base = "fil";
      if (hasLanguage(base)) return base;
    }
    return "en";
  }

  function applyTranslations() {
    document.querySelectorAll("[data-i18n]").forEach(function (el) { el.textContent = t(el.getAttribute("data-i18n")); });
    document.querySelectorAll("[data-i18n-aria]").forEach(function (el) { el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria"))); });
    document.querySelectorAll("[data-i18n-aria-label]").forEach(function (el) { el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria-label"))); });
    document.querySelectorAll("[data-i18n-title]").forEach(function (el) { el.setAttribute("title", t(el.getAttribute("data-i18n-title"))); });
    // Text with one inline link, written as "before [[link text]] after".
    document.querySelectorAll("[data-i18n-rich]").forEach(function (el) {
      var parts = t(el.getAttribute("data-i18n-rich")).split(/\[\[|\]\]/);
      var target = el.getAttribute("data-link");
      el.textContent = "";
      parts.forEach(function (part, i) {
        if (i % 2 === 0) { if (part) el.appendChild(document.createTextNode(part)); return; }
        var link;
        if (target === "privacy") {
          link = document.createElement("button");
          link.type = "button";
          link.className = "inline-link";
          link.setAttribute("data-open-privacy", "");
        } else {
          link = document.createElement("a");
          link.href = target;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
        }
        link.textContent = part;
        el.appendChild(link);
      });
    });
    updateThemeButton();
    updateSheetChrome();
    refreshBusyText();
    syncControls();
    renderInfo();
    renderArMode();
    if (ar && ar.statusKey) dom.arStatus.textContent = t(ar.statusKey);
  }

  var langRequest = 0;
  function setLanguage(code, persist) {
    if (!hasLanguage(code)) code = "en";
    var request = ++langRequest;
    return loadLanguage(code).then(function (ok) {
      if (request !== langRequest) return;
      if (!ok) return code === "en" ? null : setLanguage("en", persist);
      state.lang = code;
      var lang = LANGUAGES.find(function (l) { return l.code === code; });
      root.setAttribute("lang", code);
      root.setAttribute("dir", lang && lang.rtl ? "rtl" : "ltr");
      if (persist) store(STORAGE.lang, code);
      renderLanguageList();
      applyTranslations();
      root.classList.remove("i18n-wait");
      document.dispatchEvent(new CustomEvent("tss:languagechange", { detail: { lang: code } }));
    });
  }

  function renderLanguageList() {
    var list = dom.langList;
    if (!list.childElementCount) {
      LANGUAGES.forEach(function (lang) {
        var li = document.createElement("li");
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "row";
        btn.setAttribute("role", "radio");
        btn.setAttribute("data-lang", lang.code);
        var main = document.createElement("span");
        main.className = "row-main";
        var name = document.createElement("span");
        name.className = "row-label";
        name.setAttribute("lang", lang.code);
        name.setAttribute("dir", lang.rtl ? "rtl" : "ltr");
        name.textContent = lang.name;
        main.appendChild(name);
        btn.appendChild(main);
        btn.insertAdjacentHTML("beforeend", '<svg class="check" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 9.5l3.5 3.5 7.5-8"/></svg>');
        btn.addEventListener("click", function () { setLanguage(lang.code, true); });
        li.appendChild(btn);
        list.appendChild(li);
      });
    }
    list.querySelectorAll("[data-lang]").forEach(function (btn) {
      btn.setAttribute("aria-checked", String(btn.getAttribute("data-lang") === state.lang));
    });
  }

  /* ============================================================= theme */
  var lightQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
  function resolveTheme(pref) { return pref === "system" ? (lightQuery && lightQuery.matches ? "light" : "dark") : pref; }

  function updateThemeButton() {
    var label = t(root.getAttribute("data-theme") === "dark" ? "themeToLight" : "themeToDark");
    [dom.themeBtn, $("homeThemeBtn")].forEach(function (b) {
      if (!b) return;
      b.setAttribute("aria-label", label);
      b.setAttribute("title", label);
    });
  }

  function setThemePreference(pref, animate) {
    if (pref !== "dark" && pref !== "light" && pref !== "system") pref = "dark";
    state.themePref = pref;
    store(STORAGE.theme, pref);
    var theme = resolveTheme(pref);
    if (root.getAttribute("data-theme") === theme) { updateThemeButton(); return; }
    var apply = function () {
      root.setAttribute("data-theme", theme);
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", theme === "light" ? "#f5f5f7" : "#0a0a0b");
      updateThemeButton();
    };
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!animate || reduce) { apply(); return; }
    if (typeof document.startViewTransition === "function") {
      try { document.startViewTransition(apply); return; } catch (e) { /* fall through */ }
    }
    root.classList.add("theme-switching");
    apply();
    setTimeout(function () { root.classList.remove("theme-switching"); }, 450);
  }

  /* ======================================================== controls UI */
  function setSegmented(group, attr, value) {
    if (!group) return;
    group.querySelectorAll("[" + attr + "]").forEach(function (b) {
      var on = b.getAttribute(attr) === value;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    });
  }

  function bindSegmented(group, attr, onSelect) {
    var buttons = Array.prototype.slice.call(group.querySelectorAll("[" + attr + "]"));
    buttons.forEach(function (b, i) {
      b.addEventListener("click", function () { if (!b.disabled) onSelect(b.getAttribute(attr)); });
      b.addEventListener("keydown", function (e) {
        var dir = 0;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") dir = 1;
        if (e.key === "ArrowLeft" || e.key === "ArrowUp") dir = -1;
        if (!dir) return;
        if (root.getAttribute("dir") === "rtl" && (e.key === "ArrowRight" || e.key === "ArrowLeft")) dir = -dir;
        e.preventDefault();
        var next = buttons[(i + dir + buttons.length) % buttons.length];
        if (next.disabled) return;
        next.focus();
        onSelect(next.getAttribute(attr));
      });
    });
  }

  function paintRange(input) {
    var min = Number(input.min), max = Number(input.max), v = Number(input.value);
    input.style.setProperty("--p", ((v - min) / (max - min)) * 100 + "%");
  }

  function sizeLabel(cm) { return cm >= 100 ? (cm / 100) + " m" : cm + " cm"; }

  function syncControls() {
    var p = state.prefs;
    dom.startSize.value = String(p.startSize);
    dom.startSizeValue.textContent = sizeLabel(p.startSize);
    dom.startSize.setAttribute("aria-valuetext", sizeLabel(p.startSize));
    paintRange(dom.startSize);
    dom.spinSwitch.setAttribute("aria-checked", String(p.autoRotate));
    setSegmented(dom.upSeg, "data-up", state.upAxis);
    var has = !!state.model;
    dom.upSeg.querySelectorAll("button").forEach(function (b) { b.disabled = !has || state.loading; });
    dom.resetViewBtn.disabled = !has || state.loading;
    dom.arBtn.disabled = !has || state.loading || state.arMode === "none";
  }

  function setPreference(key, value) {
    state.prefs[key] = value;
    store(STORAGE.prefs, JSON.stringify(state.prefs));
    syncControls();
  }

  /* =========================================================== toasts */
  var toastTimer = null;
  function toast(message, tone) {
    dom.toastText.textContent = message;
    dom.toast.setAttribute("data-tone", tone || "info");
    dom.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { dom.toast.classList.remove("show"); }, tone === "error" ? 6500 : 2600);
  }

  /* ============================================================= busy */
  var busy = { key: null, vars: null, timer: null };
  function refreshBusyText() { dom.busyText.textContent = t(busy.key || "working", busy.vars); }
  function setBusy(key, vars) {
    busy.key = key; busy.vars = vars || null;
    refreshBusyText();
    clearTimeout(busy.timer);
    if (key) busy.timer = setTimeout(function () { dom.busy.classList.add("show"); }, 140);
    else dom.busy.classList.remove("show");
    root.toggleAttribute("data-busy", !!key);
  }

  /* ============================================================ viewer */
  var viewer = null, ar = null;
  function ensureViewer() {
    if (viewer) return true;
    if (!window.TSSViewer) return false;
    try {
      viewer = new window.TSSViewer(dom.viewport);
    } catch (e) {
      console.error(e);
      return false;
    }
    viewer.setAutoRotate(state.prefs.autoRotate);
    ar = new window.TSSAR(viewer, {
      layer: dom.arLayer, video: dom.arVideo, status: dom.arStatus, scale: dom.arScale,
      close: dom.arClose, reset: dom.arReset,
      t: t, toast: toast, busy: setBusy, lang: function () { return state.lang; },
      onExit: function () { viewer.setAutoRotate(state.prefs.autoRotate); dom.arBtn.focus({ preventScroll: true }); },
    });
    ar.setStartSize(state.prefs.startSize / 100);
    ar.detect().then(function (mode) { state.arMode = mode; renderArMode(); syncControls(); });
    return true;
  }

  function renderArMode() {
    var m = state.arMode;
    var name = { webxr: "WebXR", quicklook: "AR Quick Look", camera: t("arModeCamera"), none: "–" }[m] || "–";
    dom.arMode.textContent = name;
    dom.arHint.textContent = t({ webxr: "arHintWebxr", quicklook: "arHintQuicklook", camera: "arHintCamera", none: "arHintNone" }[m] || "arHintNone");
  }

  function formatNumber(n, digits) {
    try { return n.toLocaleString(state.lang, digits != null ? { maximumFractionDigits: digits } : undefined); }
    catch (e) { return String(n); }
  }

  function renderInfo() {
    var m = state.model;
    if (!m) {
      dom.infoFormat.textContent = dom.infoFileSize.textContent = dom.infoTriangles.textContent = dom.infoVertices.textContent = dom.infoDimensions.textContent = "–";
      return;
    }
    dom.infoFormat.textContent = m.format;
    dom.infoFileSize.textContent = formatBytes(m.size);
    dom.infoTriangles.textContent = m.stats.triangles ? formatNumber(m.stats.triangles) : (m.stats.points ? t("pointsN", { n: formatNumber(m.stats.points) }) : "–");
    dom.infoVertices.textContent = formatNumber(m.stats.vertices);
    var s = viewer ? viewer.size : null;
    if (s) {
      var longest = Math.max(s.x, s.y, s.z);
      var d = longest >= 100 ? 0 : longest >= 10 ? 1 : longest >= 1 ? 2 : 3;
      dom.infoDimensions.textContent = [s.x, s.y, s.z].map(function (v) { return formatNumber(v, d); }).join(" × ");
    }
  }

  /* ======================================================= open files */
  var openRequest = 0;
  function openFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) { toast(t("errorNoFile"), "error"); return Promise.resolve(false); }
    if (!ensureViewer()) { toast(t("errorWebgl"), "error"); return Promise.resolve(false); }
    if (ar.active) ar.stop();
    var request = ++openRequest;
    state.loading = true;
    syncControls();
    setBusy("opening");
    return window.TSSModels.load(files, {
      renderer: viewer.renderer,
      onProgress: function (stage) { if (request === openRequest) setBusy(stage === "parsing" ? "parsing" : "reading"); },
    }).then(function (loaded) {
      if (request !== openRequest) { window.TSSModels.disposeObject(loaded.object); loaded.dispose(); return false; }
      if (state.model && state.model.dispose) state.model.dispose();
      dom.dropzone.hidden = true;
      dom.viewport.hidden = false;
      dom.replaceBtn.hidden = false;
      dom.stageBody.classList.add("has-model");
      viewer.resize();
      viewer.setModel(loaded, loaded.zUp);
      state.upAxis = viewer.upAxis;
      state.model = { name: loaded.name, format: loaded.format, size: loaded.size, stats: loaded.stats, dispose: loaded.dispose };
      dom.fileMeta.textContent = loaded.name + " · " + formatBytes(loaded.size);
      dom.fileMeta.title = loaded.name;
      state.loading = false;
      setBusy(null);
      syncControls();
      renderInfo();
      if (loaded.missing.length) toast(t("toastMissing", { list: loaded.missing.slice(0, 3).join(", ") + (loaded.missing.length > 3 ? "…" : "") }), "error");
      else toast(t("toastLoaded", { name: loaded.name }));
      if (ar.mode === "quicklook") setTimeout(function () { ar.prepareQuickLook().catch(function () {}); }, 400);
      return true;
    }).catch(function (err) {
      if (request !== openRequest) return false;
      state.loading = false;
      setBusy(null);
      syncControls();
      var code = (err && err.code) || "errorParse";
      toast(t(code, { ext: err && err.detail ? err.detail : "" }), "error");
      return false;
    });
  }

  function startAr() {
    if (!state.model || !ar) return;
    ar.setStartSize(state.prefs.startSize / 100);
    ar.start();
  }

  /* ============================================================= sheet */
  var TITLES = { language: "langLabel", privacy: "privacyTitle", guide: "guideTitle" };
  var sheet = { stack: [], opener: null };
  function pages() { return Array.prototype.slice.call(document.querySelectorAll("[data-page]")); }

  function updateSheetChrome() {
    var top = sheet.stack[sheet.stack.length - 1];
    dom.sheetTitle.textContent = top ? t(TITLES[top]) : "";
    dom.sheetBack.hidden = sheet.stack.length < 2;
    dom.sheetBackLabel.textContent = t("back");
    dom.sheetBack.setAttribute("aria-label", t("back"));
  }

  function showView(name, direction) {
    dom.sheetBody.querySelectorAll(".view").forEach(function (v) {
      var on = v.getAttribute("data-view") === name;
      v.hidden = !on;
      v.classList.remove("enter", "enter-back");
      if (on && direction) { void v.offsetWidth; v.classList.add(direction === "back" ? "enter-back" : "enter"); }
    });
    dom.sheetBody.scrollTop = 0;
    if (name === "language") renderLanguageList();
    updateSheetChrome();
  }

  function openSheet(view) {
    if (!sheet.stack.length) sheet.opener = document.activeElement;
    sheet.stack = [view];
    showView(view, null);
    dom.sheet.classList.add("open");
    dom.sheetBackdrop.classList.add("open");
    dom.sheet.setAttribute("aria-hidden", "false");
    pages().forEach(function (el) { el.inert = true; el.setAttribute("aria-hidden", "true"); });
    root.style.overflow = "hidden";
    setTimeout(function () {
      dom.sheet.focus({ preventScroll: true });
      if (view === "language") {
        var current = dom.langList.querySelector('[aria-checked="true"]');
        if (current) current.scrollIntoView({ block: "center" });
      }
    }, 30);
  }
  function pushView(view) { sheet.stack.push(view); showView(view, "forward"); dom.sheet.focus({ preventScroll: true }); }
  function popView() {
    if (sheet.stack.length < 2) return;
    sheet.stack.pop();
    showView(sheet.stack[sheet.stack.length - 1], "back");
  }
  function closeSheet() {
    if (!sheet.stack.length) return;
    sheet.stack = [];
    dom.sheet.classList.remove("open");
    dom.sheetBackdrop.classList.remove("open");
    dom.sheet.setAttribute("aria-hidden", "true");
    pages().forEach(function (el) { el.inert = false; el.removeAttribute("aria-hidden"); });
    root.style.overflow = "";
    var back = sheet.opener;
    sheet.opener = null;
    if (back && typeof back.focus === "function") back.focus({ preventScroll: true });
  }
  function trapFocus(e) {
    if (e.key !== "Tab" || !sheet.stack.length) return;
    var focusables = Array.prototype.filter.call(
      dom.sheet.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'),
      function (el) { return el.offsetParent !== null; }
    );
    if (!focusables.length) return;
    var first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /* ============================================================ events */
  function bindEvents() {
    var pick = function () { dom.fileInput.click(); };
    dom.dropzone.addEventListener("click", pick);
    dom.dropzone.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); }
    });
    dom.replaceBtn.addEventListener("click", pick);
    dom.fileInput.addEventListener("change", function () {
      var files = dom.fileInput.files;
      if (files && files.length) openFiles(Array.prototype.slice.call(files));
      dom.fileInput.value = "";
    });

    // Drag and drop onto the whole stage: files, several files or a folder.
    var depth = 0;
    var hasFiles = function (e) {
      var types = e.dataTransfer && e.dataTransfer.types;
      return !!types && Array.prototype.indexOf.call(types, "Files") !== -1;
    };
    dom.stageBody.addEventListener("dragenter", function (e) { if (!hasFiles(e)) return; e.preventDefault(); depth++; dom.stageBody.classList.add("dragging"); });
    dom.stageBody.addEventListener("dragover", function (e) { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
    dom.stageBody.addEventListener("dragleave", function () { depth = Math.max(0, depth - 1); if (!depth) dom.stageBody.classList.remove("dragging"); });
    dom.stageBody.addEventListener("drop", function (e) {
      e.preventDefault(); depth = 0; dom.stageBody.classList.remove("dragging");
      window.TSSModels.filesFromDataTransfer(e.dataTransfer).then(function (files) {
        if (files.length) openFiles(files); else toast(t("errorNoFile"), "error");
      });
    });
    window.addEventListener("dragover", function (e) { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener("drop", function (e) { if (hasFiles(e)) e.preventDefault(); });

    // Inspector.
    dom.arBtn.addEventListener("click", startAr);
    dom.startSize.addEventListener("input", function () {
      setPreference("startSize", clamp(Number(dom.startSize.value), LIMITS.startSizeMin, LIMITS.startSizeMax));
      if (ar) ar.setStartSize(state.prefs.startSize / 100);
    });
    dom.startSize.addEventListener("change", function () {
      if (ar && ar.mode === "quicklook" && state.model) ar.prepareQuickLook().catch(function () {});
    });
    dom.spinSwitch.addEventListener("click", function () {
      setPreference("autoRotate", !state.prefs.autoRotate);
      if (viewer) viewer.setAutoRotate(state.prefs.autoRotate);
    });
    bindSegmented(dom.upSeg, "data-up", function (val) {
      if (!viewer || !state.model) return;
      state.upAxis = val;
      viewer.setUpAxis(val);
      syncControls();
      renderInfo();
      if (ar.mode === "quicklook") ar.prepareQuickLook().catch(function () {});
    });
    dom.resetViewBtn.addEventListener("click", function () { if (viewer && state.model) viewer.frame(); });

    // Toolbar.
    dom.themeBtn.addEventListener("click", function () { setThemePreference(root.getAttribute("data-theme") === "dark" ? "light" : "dark", true); });
    dom.helpBtn.addEventListener("click", function () { openSheet("guide"); });
    dom.langBtn.addEventListener("click", function () { openSheet("language"); });

    // Sheet navigation.
    dom.sheetDone.addEventListener("click", closeSheet);
    dom.sheetBackdrop.addEventListener("click", closeSheet);
    dom.sheetBack.addEventListener("click", popView);
    dom.sheetBody.addEventListener("click", function (e) {
      var push = e.target.closest("[data-push]");
      if (push) pushView(push.getAttribute("data-push"));
    });

    document.addEventListener("keydown", function (e) {
      if (sheet.stack.length) {
        if (e.key === "Escape") { e.preventDefault(); closeSheet(); return; }
        trapFocus(e);
      }
    });

    if (lightQuery) {
      var onScheme = function () { if (state.themePref === "system") setThemePreference("system", true); };
      lightQuery.addEventListener ? lightQuery.addEventListener("change", onScheme) : lightQuery.addListener(onScheme);
    }
  }

  /* ============================================================== boot */
  function init() {
    var savedTheme = load(STORAGE.theme);
    state.themePref = savedTheme === "light" || savedTheme === "system" || savedTheme === "dark" ? savedTheme : "dark";
    setThemePreference(state.themePref, false);
    bindEvents();
    syncControls();
    renderInfo();
    // AR support is known before a model is opened, so the hint is right from the start.
    if (window.TSSAR) {
      var probe = { detect: window.TSSAR.prototype.detect };
      probe.detect().then(function (mode) { if (!ar) { state.arMode = mode; renderArMode(); syncControls(); } });
    }
    setLanguage(detectLanguage(), false).then(function () { root.setAttribute("data-ready", "true"); });
  }

  // Small, stable surface for the home page, automated tests and debugging.
  window.TesseractStudio = Object.freeze({
    version: VERSION,
    DEFAULT_PREFERENCES: DEFAULT_PREFERENCES,
    getState: function () {
      return {
        prefs: Object.assign({}, state.prefs),
        model: state.model ? { name: state.model.name, format: state.model.format, size: state.model.size, stats: Object.assign({}, state.model.stats) } : null,
        upAxis: state.upAxis, arMode: state.arMode, arActive: ar ? ar.active : null,
        lang: state.lang, theme: root.getAttribute("data-theme"),
      };
    },
    openFiles: openFiles,
    filesFromDataTransfer: function (dt) { return window.TSSModels.filesFromDataTransfer(dt); },
    startAr: startAr,
    stopAr: function () { if (ar) ar.stop(); },
    setArMode: function (mode) { ensureViewer(); state.arMode = ar.mode = mode; renderArMode(); syncControls(); },
    t: t,
    openSheet: openSheet,
    closeSheet: closeSheet,
    toggleTheme: function () { setThemePreference(root.getAttribute("data-theme") === "dark" ? "light" : "dark", true); },
    relayout: function () { if (viewer) viewer.resize(); },
  });

  init();
})();
