/* MED2 S1 — PDF personnels des cours, enregistrés uniquement dans IndexedDB sur cet appareil.
 *
 * V0.45 : onglet « Fiches » de chaque cours (import d'une ou plusieurs fiches PDF et lecture intégrée :
 * zoom, plein écran, partage vers Fichiers). Les PDF de l'onglet « Source » s'ouvrent eux aussi dans
 * l'application. Le rendu utilise PDF.js 4.10.38 (Mozilla, licence Apache-2.0, fichiers
 * Assets/pdfjs-4.10.38.*), mis en cache par le service worker : une fiche importée se lit sans
 * connexion. Les fichiers restent sur l'appareil ; ils ne partent jamais sur Internet.
 *
 * API publique (window.Med2Pdf) :
 *   mount(node, { courseId, courseTitle })                  « Mes PDF » (onglet Source, cours indexés)
 *   mountFiches(node, { courseId, courseTitle, onCount })    onglet Fiches : import et lecteur intégré
 *   unmount(node?) · list(courseId, kind?) · add(courseId, file, kind?) · remove(id, courseId)
 *   view(record, opener?)                                     lecteur plein écran
 *   count(courseId, kind)                                     nombre mémorisé (synchrone, pour les badges)
 * Les méthodes de stockage rejettent leur promesse si l'opération n'a pas été validée.
 */
(function () {
  "use strict";

  const DB_NAME = "med2.semestre1.pdf.v1";
  const STORE = "documents";
  const COUNT_KEY = "med2.pdf.counts.v1";
  const PICK_KEY = "med2.pdf.fiche.selected.v1";
  const PDFJS_LIB = "Assets/pdfjs-4.10.38.min.mjs";
  const PDFJS_WORKER = "Assets/pdfjs-4.10.38.worker.min.mjs";
  const MAX_BYTES = 250 * 1024 * 1024;
  const KINDS = ["fiche", "source"];
  const mounted = new Map();
  const zoomMemo = new Map();
  let dbPromise = null;

  /* ------------------------------------------------------------------ stockage */
  function courseKey(value) {
    if (typeof value !== "string" || !value.trim()) throw new Error("Le cours de destination est introuvable.");
    return value;
  }

  function kindOf(record) {
    return record && record.kind === "fiche" ? "fiche" : "source";
  }

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("Le stockage local des PDF n’est pas disponible dans ce navigateur."));
        return;
      }
      const request = window.indexedDB.open(DB_NAME, 1);
      let settled = false;
      const fail = (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      request.onupgradeneeded = () => {
        const db = request.result;
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("courseId", "courseId", { unique: false });
      };
      request.onblocked = () => fail(new Error("Le stockage des PDF est bloqué par un autre onglet. Ferme les autres onglets de l’application puis réessaie."));
      request.onerror = () => fail(request.error || new Error("Impossible d’ouvrir le stockage local des PDF."));
      request.onsuccess = () => {
        const db = request.result;
        if (settled) {
          db.close();
          return;
        }
        settled = true;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        db.onclose = () => { dbPromise = null; };
        resolve(db);
      };
    }).catch((error) => {
      dbPromise = null;
      throw error;
    });
    return dbPromise;
  }

  async function transaction(mode, operation) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      let tx;
      let result;
      let error;
      try {
        tx = db.transaction(STORE, mode);
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(error || tx.error || new Error("L’enregistrement local a été interrompu. Réessaie."));
        tx.onerror = () => { error = tx.error; };
        operation(tx.objectStore(STORE), (value) => { result = value; }, (reason) => {
          error = reason;
          tx.abort();
        });
      } catch (reason) {
        if (tx) {
          error = reason;
          try { tx.abort(); } catch (_) { reject(reason); }
        } else reject(reason);
      }
    });
  }

  function readCounts() {
    try {
      const value = JSON.parse(window.localStorage.getItem(COUNT_KEY) || "{}");
      return value && typeof value === "object" ? value : {};
    } catch (_) {
      return {};
    }
  }

  function rememberCounts(courseId, records) {
    try {
      const all = readCounts();
      for (const kind of KINDS) {
        const n = records.filter((record) => kindOf(record) === kind).length;
        const key = courseId + "|" + kind;
        if (n) all[key] = n;
        else delete all[key];
      }
      window.localStorage.setItem(COUNT_KEY, JSON.stringify(all));
    } catch (_) {}
  }

  function count(courseId, kind) {
    const n = readCounts()[String(courseId) + "|" + (kind === "source" ? "source" : "fiche")];
    return typeof n === "number" && n > 0 ? n : 0;
  }

  async function list(courseId, kind) {
    const key = courseKey(courseId);
    const records = await transaction("readonly", (store, done) => {
      const request = store.index("courseId").getAll(key);
      request.onsuccess = () => done(request.result || []);
    });
    rememberCounts(key, records);
    return records
      .filter((record) => !kind || kindOf(record) === kind)
      .sort((a, b) => b.addedAt - a.addedAt || String(a.name).localeCompare(String(b.name), "fr"));
  }

  function newId() {
    return window.crypto && window.crypto.randomUUID
      ? window.crypto.randomUUID()
      : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + "-" + Math.random().toString(36).slice(2);
  }

  function isQuota(error) {
    return !!error && (error.name === "QuotaExceededError" || /quota/i.test(error.message || ""));
  }

  async function add(courseId, file, kind) {
    const key = courseKey(courseId);
    const type = kind === "fiche" ? "fiche" : "source";
    if (!file || !(file instanceof Blob)) throw new Error("Choisis un fichier PDF.");
    const rawName = typeof file.name === "string" && file.name.trim() ? file.name.trim() : "document.pdf";
    if (!/\.pdf$/i.test(rawName) && file.type !== "application/pdf") {
      throw new Error("Choisis un fichier dont le nom se termine par .pdf.");
    }
    if (file.size < 5) throw new Error("Ce fichier PDF est vide ou invalide.");
    if (file.size > MAX_BYTES) throw new Error("Ce PDF dépasse 250 Mo : enregistre-le en taille réduite, puis réessaie.");
    const bytes = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
    // Les lecteurs PDF acceptent une signature précédée de quelques octets (ex. BOM).
    let header = "";
    for (const byte of bytes) header += String.fromCharCode(byte);
    if (!header.includes("%PDF-")) throw new Error("Ce fichier n’est pas un PDF reconnu. Renommer un autre fichier en .pdf ne suffit pas.");
    const record = {
      id: newId(),
      courseId: key,
      kind: type,
      name: /\.pdf$/i.test(rawName) ? rawName : rawName + ".pdf",
      size: file.size,
      addedAt: Date.now(),
    };
    try {
      await transaction("readwrite", (store) => { store.add(Object.assign({ blob: file.slice(0, file.size, "application/pdf") }, record)); });
    } catch (error) {
      if (isQuota(error)) throw error;
      // Certains Safari refusent d'enregistrer un Blob dans IndexedDB : repli sur une copie binaire.
      const data = await file.arrayBuffer();
      await transaction("readwrite", (store) => { store.add(Object.assign({ data }, record)); });
    }
    try {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    } catch (_) {}
    return record;
  }

  async function remove(id, courseId) {
    const key = courseKey(courseId);
    const removed = await transaction("readwrite", (store, done, fail) => {
      const request = store.get(id);
      request.onsuccess = () => {
        const record = request.result;
        if (!record) { done(false); return; }
        if (record.courseId !== key) { fail(new Error("Ce PDF est rattaché à un autre cours.")); return; }
        store.delete(id);
        done(true);
      };
    });
    dropDoc(id);
    return removed;
  }

  function recordBlob(record) {
    if (record.blob instanceof Blob) return record.blob;
    return new Blob([record.data || new ArrayBuffer(0)], { type: "application/pdf" });
  }

  function errorText(error) {
    if (isQuota(error)) {
      return "L’espace de stockage de cet appareil est insuffisant. Libère de l’espace ou supprime un PDF déjà importé, puis réessaie. Le fichier concerné n’a pas été enregistré.";
    }
    if (error && ["SecurityError", "InvalidStateError", "UnknownError"].includes(error.name)) {
      return "Le navigateur ne permet pas d’accéder au stockage local des PDF. Vérifie ses réglages ou utilise une fenêtre normale, puis réessaie.";
    }
    return error && error.message ? error.message : "Impossible d’accéder aux PDF sur cet appareil. Réessaie.";
  }

  function viewerErrorText(error) {
    const name = error && error.name;
    if (name === "PasswordException") return "Ce PDF est protégé par un mot de passe : l’application ne peut pas l’afficher. « Partager » permet de l’ouvrir dans Fichiers ou Livres.";
    if (name === "InvalidPDFException" || name === "MissingPDFException") return "Ce PDF est endommagé ou incomplet. Supprime-le puis importe à nouveau le fichier d’origine.";
    if (error && error.med2Old) return "Ce navigateur est trop ancien pour le lecteur intégré (iPhone : iOS 16.4 ou plus récent). Mets l’iPhone à jour ; en attendant, « Partager » ouvre la fiche dans Fichiers ou Livres.";
    if (error && error.med2Loader) return "Le lecteur PDF n’est pas encore enregistré sur cet appareil. Connecte-toi une fois à Internet, rouvre l’application (ou lance Réglages › Installation et hors ligne), puis réessaie. En attendant, « Partager » ouvre la fiche dans une autre app.";
    return "Ce PDF n’a pas pu être affiché" + (error && error.message ? " (" + error.message + ")" : "") + ". « Partager » permet de l’ouvrir dans une autre app.";
  }

  /* ------------------------------------------------------------------ PDF.js (chargé à la demande, mis en cache hors ligne) */
  let pdfjsPromise = null;
  function loadPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import(new URL(PDFJS_LIB, document.baseURI).href)
        .then((lib) => {
          lib.GlobalWorkerOptions.workerSrc = new URL(PDFJS_WORKER, document.baseURI).href;
          return lib;
        })
        .catch((error) => {
          pdfjsPromise = null;
          const wrapped = new Error(error && error.message ? error.message : "PDF.js indisponible");
          wrapped.med2Loader = true;
          wrapped.med2Old = !!error && error.name === "SyntaxError";
          throw wrapped;
        });
    }
    return pdfjsPromise;
  }

  /* Documents ouverts, partagés entre le lecteur de l'onglet et le plein écran. */
  const docs = new Map();
  function acquireDoc(record) {
    let entry = docs.get(record.id);
    if (!entry) {
      entry = { refs: 0, used: 0, promise: null };
      entry.promise = (async () => {
        const lib = await loadPdfjs();
        const data = new Uint8Array(await recordBlob(record).arrayBuffer());
        const task = lib.getDocument({ data, isEvalSupported: false, enableXfa: false, useSystemFonts: true });
        entry.task = task;
        return task.promise;
      })();
      entry.promise.catch(() => {
        if (docs.get(record.id) === entry) docs.delete(record.id);
      });
      docs.set(record.id, entry);
    }
    entry.refs++;
    entry.used = Date.now();
    return entry.promise;
  }

  function destroyEntry(entry) {
    entry.promise.then((doc) => doc.destroy()).catch(() => {});
  }

  function releaseDoc(id) {
    const entry = docs.get(id);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    entry.used = Date.now();
    // Garder au plus deux documents inutilisés en mémoire (retour rapide sur l'onglet), libérer les autres.
    const idle = [...docs.entries()].filter(([, e]) => e.refs === 0).sort((a, b) => b[1].used - a[1].used);
    for (const [key, e] of idle.slice(2)) {
      docs.delete(key);
      destroyEntry(e);
    }
  }

  function dropDoc(id) {
    const entry = docs.get(id);
    if (!entry) return;
    docs.delete(id);
    destroyEntry(entry);
  }

  /* ------------------------------------------------------------------ interface : utilitaires */
  const ICON = {
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    minus: '<path d="M5 12h14"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
    share: '<path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M9 7V4h6v3"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    book: '<path d="M2 5.5c3-1.5 6.5-1.5 10 1 3.5-2.5 7-2.5 10-1v13c-3-1.5-6.5-1.5-10 1-3.5-2.5-7-2.5-10-1z"/><path d="M12 6.5v13"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5M5 21h14"/>',
    offline: '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.5" r="1" fill="currentColor" stroke="none"/>',
  };

  function svg(path, size) {
    const s = size || 18;
    return '<svg class="ico" viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + "</svg>";
  }

  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function button(className, icon, label, aria) {
    const el = node("button", className);
    el.type = "button";
    el.innerHTML = (icon ? svg(icon, className.includes("icon-btn") ? 20 : 17) : "") + (label ? "<span></span>" : "");
    if (label) el.querySelector("span").textContent = label;
    if (aria) el.setAttribute("aria-label", aria);
    return el;
  }

  function fileSize(bytes) {
    return bytes < 1024 * 1024
      ? Math.max(1, Math.round(bytes / 1024)).toLocaleString("fr-FR") + " Ko"
      : (bytes / (1024 * 1024)).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " Mo";
  }

  function day(ms) {
    try { return new Date(ms).toLocaleDateString("fr-FR"); } catch (_) { return ""; }
  }

  let shareProbe = null;
  function canShareFiles() {
    if (shareProbe !== null) return shareProbe;
    try {
      shareProbe = !!(navigator.share && navigator.canShare && typeof File === "function" &&
        navigator.canShare({ files: [new File(["%PDF-1.4"], "fiche.pdf", { type: "application/pdf" })] }));
    } catch (_) {
      shareProbe = false;
    }
    return shareProbe;
  }

  /* À appeler directement dans le geste de l'utilisateur (Safari exige une action récente pour partager). */
  function shareRecord(record) {
    const blob = recordBlob(record);
    if (canShareFiles()) {
      const file = new File([blob], record.name, { type: "application/pdf" });
      return navigator.share({ files: [file], title: record.name }).then(
        () => true,
        (error) => {
          if (error && error.name === "AbortError") return false;
          throw error;
        },
      );
    }
    const url = URL.createObjectURL(blob);
    const link = node("a");
    link.href = url;
    link.download = record.name;
    link.rel = "noopener";
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
    return Promise.resolve(true);
  }

  function readPick() {
    try {
      const value = JSON.parse(window.localStorage.getItem(PICK_KEY) || "{}");
      return value && typeof value === "object" ? value : {};
    } catch (_) {
      return {};
    }
  }

  function writePick(courseId, id) {
    try {
      const all = readPick();
      if (id) all[courseId] = id;
      else delete all[courseId];
      window.localStorage.setItem(PICK_KEY, JSON.stringify(all));
    } catch (_) {}
  }

  function styles() {
    if (document.getElementById("med2-pdf-styles")) return;
    const style = node("style");
    style.id = "med2-pdf-styles";
    style.textContent = `
.med2-pdf { margin: 24px 0; padding: 20px; border: 1px solid var(--line, #cdd6e2); border-radius: 12px; background: var(--surface-2, #f8fafc); color: var(--ink, #142038); }
.med2-pdf h3 { margin: 0 0 8px; font-size: 1.15em; }
.med2-pdf p { line-height: 1.5; }
.med2-pdf-note, .med2-pdf-meta { color: var(--muted, #586579); font-size: 0.875rem; }
.med2-pdf-note { margin: 8px 0 16px; }
.med2-pdf-status, .m2f-status { margin: 12px 0; font-size: 0.9375rem; }
.med2-pdf-status:empty, .m2f-status:empty { display: none; }
.med2-pdf-status[data-error="true"], .m2f-status[data-error="true"] { color: var(--ko, #c42f3a); }
.med2-pdf-list { padding: 0; margin: 16px 0 0; list-style: none; }
.med2-pdf-item { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; padding: 16px 0; border-top: 1px solid var(--line, #cdd6e2); }
.med2-pdf-file { flex: 1 1 200px; min-width: 0; }
.med2-pdf-name { display: block; overflow-wrap: anywhere; font-weight: 650; }
.med2-pdf-meta { display: block; margin-top: 4px; }
.med2-pdf-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.med2-pdf .btn, .m2f .btn { min-height: 44px; font-size: 0.875rem; }
.med2-pdf .btn:focus-visible, .m2f button:focus-visible, .m2pv-overlay button:focus-visible { outline: 3px solid var(--focus, #2563eb); outline-offset: 3px; }
@media (max-width: 480px) { .med2-pdf { padding: 16px; } .med2-pdf-actions { width: 100%; } .med2-pdf-actions .btn { flex: 1 1 auto; padding-inline: 10px; } }

.m2f { margin: 18px 0 30px; color: var(--ink, #16294a); }
.m2f-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 10px 16px; }
.m2f-head h2 { margin: 0; font-size: calc(var(--rs, 17px) + 6px); letter-spacing: -0.02em; }
.m2f-lead { flex: 1 1 100%; order: 3; margin: 0; color: var(--muted, #5f6e87); font-size: 15px; line-height: 1.6; }
.m2f-add[hidden] { display: none; }
.m2f-chips { display: flex; gap: 8px; margin: 14px 0 0; padding: 2px 2px 6px; overflow-x: auto; scrollbar-width: none; }
.m2f-chips::-webkit-scrollbar { display: none; }
.m2f-chips[hidden] { display: none; }
.m2f-chip { flex: none; display: inline-flex; align-items: center; gap: 6px; max-width: min(72vw, 320px); min-height: 38px; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--line-2, #d6deea); background: var(--surface, #fff); color: var(--ink-2, #3a4d6b); font-size: 14px; font-weight: 650; }
.m2f-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.m2f-chip[aria-pressed="true"] { background: var(--accent-soft, #e8f0fd); border-color: var(--accent-line, #bcd0f7); color: var(--accent-ink, #1e4a8c); }
.m2f-card { margin-top: 14px; border: 1px solid var(--line, #e3e9f2); border-radius: var(--r-lg, 20px); background: var(--surface, #fff); box-shadow: var(--sh-1, 0 8px 24px rgba(16,40,80,.07)); overflow: clip; }
.m2f-card[hidden] { display: none; }
.m2f-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; padding: 12px 14px; border-bottom: 1px solid var(--line, #e3e9f2); }
.m2f-file { flex: 1 1 220px; min-width: 0; display: flex; gap: 10px; align-items: flex-start; }
.m2f-file > .ico { flex: none; margin-top: 2px; color: var(--accent, #2a64d6); }
.m2f-name { display: block; font-weight: 700; line-height: 1.35; overflow-wrap: anywhere; }
.m2f-meta { display: block; margin-top: 2px; color: var(--muted, #5f6e87); font-size: 13.5px; font-variant-numeric: tabular-nums; }
.m2f-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.m2f-tools .btn { min-height: 38px; padding: 7px 12px; border-radius: 10px; }
.m2f-zoom { display: inline-flex; align-items: center; height: 38px; border: 1px solid var(--line-2, #d6deea); border-radius: 999px; background: var(--surface, #fff); }
.m2f-zoom button { display: inline-grid; place-items: center; width: 40px; height: 36px; border-radius: 999px; color: var(--ink-2, #3a4d6b); }
.m2f-zoom button:disabled { opacity: .35; }
.m2f-zoom output { min-width: 50px; text-align: center; font-size: 13.5px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--ink-2, #3a4d6b); }
.m2f-body { position: relative; }
.m2f-loading, .m2f-error { margin: 0; padding: 28px 18px; text-align: center; color: var(--muted, #5f6e87); font-size: 15px; line-height: 1.6; }
.m2f-error { color: var(--ink, #16294a); }
.m2f-error b { display: block; margin-bottom: 4px; color: var(--ko, #c63039); }
.m2f-pager { position: sticky; bottom: calc(14px + env(safe-area-inset-bottom)); z-index: 2; display: block; width: max-content; margin: -40px auto 10px; padding: 6px 12px; border-radius: 999px; background: rgba(20, 32, 56, .84); color: #fff; font-size: 13px; font-weight: 650; font-variant-numeric: tabular-nums; pointer-events: none; }
.m2f-pager[hidden] { display: none; }
.m2f-empty { margin-top: 16px; padding: 28px 20px; border: 1.5px dashed var(--line-2, #d6deea); border-radius: var(--r-lg, 20px); background: var(--surface, #fff); text-align: center; }
.m2f-empty[hidden] { display: none; }
.m2f-empty-ico { display: inline-grid; place-items: center; width: 56px; height: 56px; margin-bottom: 10px; border-radius: 16px; background: var(--accent-soft, #e8f0fd); color: var(--accent, #2a64d6); }
.m2f-empty b { display: block; font-size: 17px; }
.m2f-empty p { max-width: 46ch; margin: 6px auto 0; color: var(--muted, #5f6e87); font-size: 14.5px; line-height: 1.6; }
.m2f-empty .btn { margin-top: 16px; }
.m2f-foot { display: flex; gap: 8px; align-items: flex-start; margin: 12px 2px 0; color: var(--muted, #5f6e87); font-size: 13px; line-height: 1.55; }
.m2f-foot .ico { flex: none; margin-top: 1px; }

.m2pv-scroll { position: relative; overflow-x: auto; overflow-y: hidden; -webkit-overflow-scrolling: touch; touch-action: pan-x pan-y; padding: 12px 10px 18px; background: var(--sunken, #eef2f8); }
.m2pv-col { width: max-content; min-width: 100%; transform-origin: 0 0; }
.m2pv-page { position: relative; margin: 0 auto 12px; background: #fff; border-radius: 3px; overflow: hidden; box-shadow: 0 1px 2px rgba(16, 40, 80, .16), 0 4px 14px rgba(16, 40, 80, .10); }
.m2pv-page:last-child { margin-bottom: 0; }
.m2pv-page canvas { position: absolute; inset: 0; display: block; width: 100%; height: 100%; }
.m2pv-page:not(.is-ready)::before { content: ""; position: absolute; inset: 9% 11%; background: repeating-linear-gradient(180deg, rgba(16, 40, 80, .07) 0 9px, transparent 9px 24px); border-radius: 2px; animation: m2pv-pulse 1.4s ease-in-out infinite; }
.m2pv-page.is-error::before { animation: none; background: none; }
.m2pv-page.is-error::after { content: "Page illisible"; position: absolute; inset: 0; display: grid; place-items: center; color: #8a96a8; font-size: 14px; }
.m2pv-num { position: absolute; right: 8px; bottom: 8px; z-index: 1; padding: 2px 8px; border-radius: 999px; background: rgba(20, 32, 56, .6); color: #fff; font-size: 11.5px; font-weight: 650; font-variant-numeric: tabular-nums; }
@keyframes m2pv-pulse { 50% { opacity: .45; } }
@media (prefers-reduced-motion: reduce) { .m2pv-page:not(.is-ready)::before { animation: none; } }

/* Plein écran : aucun geste ne doit agrandir toute l'application (sinon les boutons Fermer sortent de l'écran).
   Seule la zone des pages défile ; le pincement y agrandit le PDF lui-même. */
.m2pv-overlay { background: rgb(6, 14, 28); touch-action: none; -webkit-user-select: none; user-select: none; }
.m2pv-overlay .figure-overlay-bar { gap: 8px; padding-left: max(10px, env(safe-area-inset-left)); padding-right: max(10px, env(safe-area-inset-right)); }
.m2pv-title { flex: 1; min-width: 0; color: #fff; text-align: center; }
.m2pv-title b { display: block; overflow: hidden; font-size: 15px; white-space: nowrap; text-overflow: ellipsis; }
.m2pv-title small { display: block; margin-top: 2px; color: #c8d2e0; font-size: 12.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
.m2pv-tools { display: flex; gap: 6px; }
.m2pv-stage { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.m2pv-overlay .m2pv-scroll { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; touch-action: pan-x pan-y; padding: 6px max(8px, env(safe-area-inset-right)) calc(92px + env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-left)); background: transparent; }
.m2pv-close-pill { position: absolute; left: 50%; bottom: calc(16px + env(safe-area-inset-bottom)); z-index: 3; transform: translateX(-50%); display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-width: 136px; min-height: 50px; margin: 0; padding: 0 24px 0 20px; border: 1px solid rgba(255, 255, 255, .30); border-radius: 999px; background: rgba(13, 24, 44, .92); color: #fff; font: inherit; font-size: 16px; font-weight: 700; letter-spacing: .01em; line-height: 1; box-shadow: 0 8px 26px rgba(0, 0, 0, .5); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); cursor: pointer; -webkit-tap-highlight-color: transparent; }
.m2pv-close-pill .ico { flex: none; }
.m2pv-close-pill:active { background: rgba(37, 62, 104, .96); }
.m2pv-overlay .m2pv-close-pill:focus-visible { outline: 3px solid #8fb4ff; outline-offset: 3px; }
.m2pv-overlay .m2pv-page { box-shadow: 0 2px 10px rgba(0, 0, 0, .45); }
.m2pv-overlay .m2f-error, .m2pv-overlay .m2f-loading { color: #dfe6f0; }
.m2pv-overlay .m2f-error b { color: #ffb4b8; }
@media (max-width: 520px) {
  .m2f-bar { padding: 10px 12px; }
  .m2f-tools { width: 100%; }
  .m2f-tools .m2f-zoom { margin-right: auto; }
  .m2f-tools .btn span { display: none; }
  .m2f-tools .btn { width: 42px; padding: 0; }
  .m2pv-scroll { padding: 10px 6px 16px; }
  .m2pv-overlay .figure-overlay-bar { gap: 4px; padding-left: max(6px, env(safe-area-inset-left)); padding-right: max(6px, env(safe-area-inset-right)); }
  .m2pv-tools, .m2pv-overlay .fo-zoom { gap: 4px; }
}
`;
    document.head.append(style);
  }

  /* ------------------------------------------------------------------ lecteur (pages dessinées à la demande) */
  async function createViewer(host, opts) {
    const doc = opts.doc;
    const overlay = !!opts.overlay;
    const total = doc.numPages;
    const levels = overlay ? [1, 1.25, 1.5, 2, 2.5, 3, 4] : [1, 1.25, 1.5, 2, 2.5, 3];
    const first = await doc.getPage(1);
    const firstBase = first.getViewport({ scale: 1 });
    const ratio = firstBase.height / firstBase.width || Math.SQRT2;
    const scroller = node("div", "m2pv-scroll");
    const col = node("div", "m2pv-col");
    scroller.append(col);
    host.append(scroller);
    const ioRoot = overlay ? scroller : host.closest(".modal") || null;
    const vEl = overlay ? scroller : ioRoot || document.scrollingElement || document.documentElement;
    const scrollTarget = overlay ? scroller : ioRoot || window;
    let zoom = Math.max(levels[0], Math.min(levels[levels.length - 1], opts.zoom || 1));
    let disposed = false;
    let running = 0;
    let current = 0;
    const near = new Set();
    const pages = [];
    for (let i = 0; i < total; i++) {
      const slot = node("div", "m2pv-page");
      slot.dataset.page = String(i);
      slot.setAttribute("role", "img");
      slot.setAttribute("aria-label", "Page " + (i + 1) + " sur " + total);
      const num = node("span", "m2pv-num", String(i + 1));
      num.setAttribute("aria-hidden", "true");
      slot.append(num);
      col.append(slot);
      pages.push({ slot, num, canvas: null, task: null, token: 0, width: 0, ratio: i === 0 ? ratio : 0, page: i === 0 ? first : null });
    }

    function basePad() {
      const cs = window.getComputedStyle(scroller);
      return (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    }
    function pageWidth() {
      const avail = Math.max(160, scroller.clientWidth - basePad());
      return Math.round(Math.min(avail, overlay ? 1100 : 900) * zoom);
    }
    function layout() {
      const w = pageWidth();
      for (const p of pages) {
        p.slot.style.width = w + "px";
        p.slot.style.height = Math.round(w * (p.ratio || ratio)) + "px";
      }
    }
    function rootRect() {
      if (ioRoot) return ioRoot.getBoundingClientRect();
      return { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth, height: window.innerHeight, width: window.innerWidth };
    }
    // Rapport entre pixels de mise en page et pixels écran du lecteur (≠ 1 quand le plein écran est
    // réduit pour suivre une page déjà agrandie) : les écarts mesurés à l'écran sont convertis avant de défiler.
    function localScale() {
      const w = scroller.getBoundingClientRect().width;
      return w > 0 && scroller.offsetWidth > 0 ? scroller.offsetWidth / w : 1;
    }
    function freeCanvas(canvas) {
      try { canvas.width = 0; canvas.height = 0; } catch (_) {}
      canvas.remove();
    }
    function release(i) {
      const p = pages[i];
      p.token++;
      if (p.task) {
        try { p.task.cancel(); } catch (_) {}
        p.task = null;
      }
      if (p.canvas) {
        freeCanvas(p.canvas);
        p.canvas = null;
      }
      p.width = 0;
      p.slot.classList.remove("is-ready");
      if (p.page && i > 0) {
        try { p.page.cleanup(); } catch (_) {}
      }
    }
    function emit() {
      if (!disposed && opts.onState) opts.onState({ page: current + 1, pages: total, zoom, min: zoom <= levels[0] + 0.001, max: zoom >= levels[levels.length - 1] - 0.001 });
    }
    function distance(i) {
      const r = pages[i].slot.getBoundingClientRect();
      const rr = rootRect();
      return Math.abs(r.top + r.height / 2 - (rr.top + rr.height / 2));
    }
    function pump() {
      if (disposed) return;
      const w = pageWidth();
      const wanted = [...near].filter((i) => !pages[i].task && pages[i].width !== w).sort((a, b) => distance(a) - distance(b));
      while (running < 2 && wanted.length) draw(wanted.shift());
    }
    async function draw(i) {
      const p = pages[i];
      const token = ++p.token;
      let canvas = null;
      let task = null;
      running++;
      try {
        const page = p.page || (p.page = await doc.getPage(i + 1));
        if (disposed || token !== p.token) return;
        const base = page.getViewport({ scale: 1 });
        const r = base.height / base.width || ratio;
        const w = pageWidth();
        const h = Math.round(w * r);
        if (Math.abs(r - (p.ratio || ratio)) > 0.0005) p.slot.style.height = h + "px";
        p.ratio = r;
        let scale = Math.min(window.devicePixelRatio || 1, 2);
        // Mémoire des canvas limitée sur iPhone : moins de pixels par page quand on zoome fort.
        const limit = zoom > 1.6 ? 4500000 : 7000000;
        if (w * h * scale * scale > limit) scale = Math.max(0.6, Math.sqrt(limit / (w * h)));
        const viewport = page.getViewport({ scale: (w / base.width) * scale });
        canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        const context = canvas.getContext("2d", { alpha: false });
        task = page.render({ canvasContext: context, viewport, background: "#ffffff" });
        p.task = task;
        await task.promise;
        if (disposed || token !== p.token) return;
        if (p.canvas) freeCanvas(p.canvas);
        p.canvas = canvas;
        canvas = null;
        p.width = w;
        p.slot.insertBefore(p.canvas, p.num);
        p.slot.classList.add("is-ready");
        p.slot.classList.remove("is-error");
      } catch (error) {
        if (!(error && error.name === "RenderingCancelledException") && token === p.token && !disposed) {
          p.slot.classList.add("is-error");
          p.width = pageWidth();
        }
      } finally {
        if (canvas) freeCanvas(canvas);
        if (task && p.task === task) p.task = null;
        running--;
        if (!disposed) pump();
      }
    }

    layout();
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const i = Number(entry.target.dataset.page);
          if (entry.isIntersecting) near.add(i);
          else if (near.delete(i)) release(i);
        }
        pump();
        track();
      },
      { root: ioRoot, rootMargin: overlay ? "120% 60%" : "110% 0px" },
    );
    pages.forEach((p) => io.observe(p.slot));

    let ticking = false;
    function track() {
      if (ticking || disposed) return;
      ticking = true;
      window.requestAnimationFrame(() => {
        ticking = false;
        if (disposed) return;
        const rr = rootRect();
        let best = current;
        let bestSeen = -1;
        for (const i of near) {
          const r = pages[i].slot.getBoundingClientRect();
          const seen = Math.min(r.bottom, rr.bottom) - Math.max(r.top, rr.top);
          if (seen > bestSeen) {
            bestSeen = seen;
            best = i;
          }
        }
        current = best;
        emit();
      });
    }
    scrollTarget.addEventListener("scroll", track, { passive: true });

    function anchorFor(at) {
      const rr = rootRect();
      const y = at ? at.y : rr.top + Math.min(80, rr.height / 4);
      const x = at ? at.x : scroller.getBoundingClientRect().left + scroller.clientWidth / 2;
      let index = current;
      for (const i of near) {
        const r = pages[i].slot.getBoundingClientRect();
        if (y >= r.top && y <= r.bottom + 12) { index = i; break; }
      }
      const r = pages[index].slot.getBoundingClientRect();
      return { i: index, fy: (y - r.top) / (r.height || 1), fx: (x - r.left) / (r.width || 1), x, y };
    }
    function setZoom(value, at) {
      const z = Math.max(levels[0], Math.min(levels[levels.length - 1], value));
      if (disposed || Math.abs(z - zoom) < 0.001) return;
      const a = anchorFor(at);
      zoom = z;
      for (const p of pages) {
        if (p.task) {
          p.token++;
          try { p.task.cancel(); } catch (_) {}
          p.task = null;
        }
      }
      layout();
      const r = pages[a.i].slot.getBoundingClientRect();
      const k = localScale();
      vEl.scrollTop += (r.top + a.fy * r.height - a.y) * k;
      scroller.scrollLeft += (r.left + a.fx * r.width - a.x) * k;
      pump();
      emit();
    }
    function step(direction) {
      if (direction > 0) setZoom(levels.find((z) => z > zoom + 0.001) || zoom);
      else setZoom([...levels].reverse().find((z) => z < zoom - 0.001) || zoom);
    }

    let resizeTimer = 0;
    let lastWidth = scroller.clientWidth;
    function onResize() {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (disposed || Math.abs(scroller.clientWidth - lastWidth) < 2) return;
        lastWidth = scroller.clientWidth;
        const a = anchorFor(null);
        layout();
        const r = pages[a.i].slot.getBoundingClientRect();
        vEl.scrollTop += (r.top + a.fy * r.height - a.y) * localScale();
        pump();
      }, 160);
    }
    const ro = window.ResizeObserver ? new ResizeObserver(onResize) : null;
    if (ro) ro.observe(scroller);
    else window.addEventListener("resize", onResize);

    /* Pincer ou toucher deux fois agrandit le PDF lui-même (pages redessinées nettes), dans l'onglet comme
       en plein écran. Avant la V0.46.1, dans l'onglet, le pincement agrandissait toute l'application : les
       boutons de retour et de fermeture pouvaient alors sortir de l'écran. */
    const cleanups = [];
    {
      let pinch = null;
      const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
      const onStart = (e) => {
        if (e.touches.length !== 2) return;
        const t = e.touches;
        const cr = col.getBoundingClientRect();
        const k = localScale();
        pinch = { d: dist(t) || 1, z: zoom, s: 1, x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 };
        col.style.transformOrigin = (pinch.x - cr.left) * k + "px " + (pinch.y - cr.top) * k + "px";
      };
      const onMove = (e) => {
        if (!pinch || e.touches.length !== 2) return;
        if (e.cancelable) e.preventDefault();
        const target = Math.max(levels[0], Math.min(levels[levels.length - 1], (pinch.z * dist(e.touches)) / pinch.d));
        pinch.s = target / pinch.z;
        col.style.transform = "scale(" + pinch.s + ")";
      };
      const onEnd = (e) => {
        if (!pinch || e.touches.length >= 2) return;
        const p = pinch;
        pinch = null;
        col.style.transform = "";
        col.style.transformOrigin = "";
        if (Math.abs(p.s - 1) > 0.03) setZoom(p.z * p.s, { x: p.x, y: p.y });
      };
      const onDouble = (e) => setZoom(zoom > 1.01 ? 1 : 2, { x: e.clientX, y: e.clientY });
      const noGesture = (e) => { if (e.cancelable) e.preventDefault(); };
      const listeners = [
        ["touchstart", onStart, { passive: true }],
        ["touchmove", onMove, { passive: false }],
        ["touchend", onEnd, { passive: true }],
        ["touchcancel", onEnd, { passive: true }],
        ["dblclick", onDouble, false],
        ["gesturestart", noGesture, { passive: false }],
        ["gesturechange", noGesture, { passive: false }],
      ];
      listeners.forEach(([type, fn, o]) => scroller.addEventListener(type, fn, o));
      cleanups.push(() => listeners.forEach(([type, fn, o]) => scroller.removeEventListener(type, fn, o)));
    }

    function destroy() {
      if (disposed) return;
      disposed = true;
      io.disconnect();
      if (ro) ro.disconnect();
      else window.removeEventListener("resize", onResize);
      window.clearTimeout(resizeTimer);
      scrollTarget.removeEventListener("scroll", track);
      cleanups.forEach((fn) => fn());
      for (let i = 0; i < pages.length; i++) release(i);
      scroller.remove();
    }

    emit();
    return {
      destroy,
      zoomIn: () => step(1),
      zoomOut: () => step(-1),
      setZoom,
      get zoom() { return zoom; },
      get pages() { return total; },
    };
  }

  /* ------------------------------------------------------------------ plein écran */
  let overlayCtx = null;
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || !overlayCtx) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      overlayCtx.close();
    },
    true,
  );

  function closeOverlay() {
    if (overlayCtx) overlayCtx.close();
  }

  function safely(fn) {
    try { fn(); } catch (_) {}
  }

  /* Si l'application est déjà agrandie (pincement, zoom automatique d'iOS) quand le plein écran s'ouvre,
     le calque se cale sur la zone réellement visible et garde sa taille normale : la croix et le bouton
     « Fermer » restent toujours à l'écran. Sans agrandissement, rien ne change (la feuille de style suffit). */
  function pinToVisualViewport(el) {
    const vv = window.visualViewport;
    if (!vv) return () => {};
    const props = ["left", "top", "right", "bottom", "width", "height", "transform", "transform-origin"];
    let frame = 0;
    let pinned = false;
    const apply = () => {
      frame = 0;
      if (!el.isConnected) return;
      const s = vv.scale > 0 ? vv.scale : 1;
      const x = vv.offsetLeft || 0;
      const y = vv.offsetTop || 0;
      if (Math.abs(s - 1) < 0.01 && Math.abs(x) < 1 && Math.abs(y) < 1) {
        if (pinned) props.forEach((p) => el.style.removeProperty(p));
        pinned = false;
        return;
      }
      pinned = true;
      el.style.left = "0px";
      el.style.top = "0px";
      el.style.right = "auto";
      el.style.bottom = "auto";
      el.style.width = vv.width * s + "px";
      el.style.height = vv.height * s + "px";
      el.style.transformOrigin = "0 0";
      el.style.transform = "translate(" + x + "px, " + y + "px) scale(" + 1 / s + ")";
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(apply); };
    apply();
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    window.addEventListener("orientationchange", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
      window.removeEventListener("orientationchange", schedule);
    };
  }

  /* Pendant la lecture en plein écran, aucun geste n'agrandit l'application entière (Safari iOS ignore
     parfois touch-action pour le pincement) : seul le PDF s'agrandit, dans la zone des pages. */
  function blockPageZoom(el) {
    const stop = (e) => { if (e.cancelable) e.preventDefault(); };
    const multi = (e) => {
      if (!e.touches || e.touches.length < 2 || !e.cancelable) return;
      const t = e.target;
      if (t && t.closest && t.closest(".m2pv-scroll")) return; // pincement du PDF, géré par le lecteur
      e.preventDefault();
    };
    document.addEventListener("gesturestart", stop, { passive: false });
    document.addEventListener("gesturechange", stop, { passive: false });
    el.addEventListener("touchmove", multi, { passive: false });
    return () => {
      document.removeEventListener("gesturestart", stop, { passive: false });
      document.removeEventListener("gesturechange", stop, { passive: false });
      el.removeEventListener("touchmove", multi, { passive: false });
    };
  }

  function view(record, opener) {
    closeOverlay();
    styles();
    const back = opener || document.activeElement;
    const over = node("div", "figure-overlay m2pv-overlay");
    over.setAttribute("role", "dialog");
    over.setAttribute("aria-modal", "true");
    over.setAttribute("aria-label", "PDF : " + record.name);
    const bar = node("div", "figure-overlay-bar m2pv-bar");
    const close = button("icon-btn light", ICON.close, "", "Fermer le PDF");
    const title = node("div", "m2pv-title");
    const name = node("b", "", record.name);
    const info = node("small", "", "Ouverture…");
    info.setAttribute("aria-live", "polite");
    title.append(name, info);
    const tools = node("span", "m2pv-tools");
    const zoomBox = node("span", "fo-zoom m2pv-zoom");
    zoomBox.setAttribute("role", "group");
    zoomBox.setAttribute("aria-label", "Zoom");
    const minus = button("icon-btn light", ICON.minus, "", "Dézoomer");
    const plus = button("icon-btn light", ICON.plus, "", "Zoomer");
    zoomBox.append(minus, plus);
    const share = button("icon-btn light", canShareFiles() ? ICON.share : ICON.download, "", canShareFiles() ? "Partager ou enregistrer dans Fichiers" : "Télécharger le PDF");
    tools.append(zoomBox, share);
    bar.append(close, title, tools);
    const stage = node("div", "m2pv-stage");
    // Grand bouton en bas, à portée du pouce : toujours visible, loin de l'encoche et de la barre d'état.
    const closeBig = button("m2pv-close-pill", ICON.close, "Fermer");
    closeBig.dataset.pdfAction = "close-viewer";
    over.append(bar, stage, closeBig);
    document.body.append(over);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const unpin = pinToVisualViewport(over);
    const unblock = blockPageZoom(over);
    safely(() => close.focus({ preventScroll: true }));

    let viewer = null;
    let closed = false;
    let acquired = false;
    let watcher = null;
    const ctx = {
      close() {
        if (closed) return;
        closed = true;
        // Chaque étape est protégée : quoi qu'il arrive, le plein écran disparaît et l'application redevient utilisable.
        safely(() => { if (watcher) watcher.disconnect(); });
        safely(() => { if (viewer) viewer.destroy(); });
        safely(() => { if (acquired) releaseDoc(record.id); });
        safely(unpin);
        safely(unblock);
        safely(() => over.remove());
        document.body.style.overflow = previousOverflow;
        if (overlayCtx === ctx) overlayCtx = null;
        safely(() => { if (back && back.isConnected && typeof back.focus === "function") back.focus({ preventScroll: true }); });
      },
    };
    overlayCtx = ctx;
    // Calque retiré par un autre écran de l'application : on libère quand même le document et les gestes.
    if (window.MutationObserver) {
      watcher = new MutationObserver(() => { if (!over.isConnected) ctx.close(); });
      watcher.observe(document.body, { childList: true });
    }
    close.addEventListener("click", () => ctx.close());
    closeBig.addEventListener("click", () => ctx.close());
    over.addEventListener("click", (e) => {
      if (e.target === over) ctx.close();
    });
    minus.addEventListener("click", () => viewer && viewer.zoomOut());
    plus.addEventListener("click", () => viewer && viewer.zoomIn());
    share.addEventListener("click", () => {
      shareRecord(record).catch((error) => { info.textContent = errorText(error); });
    });
    const loading = node("p", "m2f-loading", "Préparation des pages…");
    stage.append(loading);
    acquired = true;
    acquireDoc(record)
      .then((doc) => {
        if (closed) return null;
        return createViewer(stage, {
          doc,
          overlay: true,
          zoom: 1,
          onState(s) {
            const text = "Page " + s.page + " sur " + s.pages + " · " + Math.round(s.zoom * 100) + " %";
            if (info.textContent !== text) info.textContent = text;
            minus.disabled = s.min;
            plus.disabled = s.max;
          },
        });
      })
      .then((v) => {
        loading.remove();
        if (!v) return;
        if (closed) v.destroy();
        else viewer = v;
      })
      .catch((error) => {
        loading.remove();
        if (closed) return;
        info.textContent = "Lecture impossible";
        const box = node("div", "m2f-error");
        box.append(node("b", "", "Lecture impossible"), node("span", "", viewerErrorText(error)));
        stage.append(box);
      });
    return ctx;
  }

  /* ------------------------------------------------------------------ « Mes PDF » (onglet Source, cours indexés) */
  function mount(container, options) {
    if (!container || container.nodeType !== 1) throw new Error("L’emplacement des PDF est introuvable.");
    const key = courseKey(options && options.courseId);
    unmount(container);
    styles();
    const root = node("section", "med2-pdf");
    root.setAttribute("aria-label", "Mes PDF pour ce cours");
    const title = node("h3", "", "Mes PDF pour ce cours");
    const note = node("p", "med2-pdf-note", "Enregistrés sur cet appareil, lisibles dans l’application même hors ligne. La sauvegarde des résultats n’inclut pas ces PDF ; garde tes originaux.");
    const destination = node("p", "med2-pdf-note", options.courseTitle ? "Cours : " + options.courseTitle : "Les PDF importés ici seront rattachés à ce cours.");
    const upload = node("button", "btn secondary", "Importer des PDF");
    upload.type = "button";
    upload.dataset.pdfAction = "import";
    const input = node("input");
    input.type = "file";
    input.accept = ".pdf,application/pdf";
    input.multiple = true;
    input.hidden = true;
    input.dataset.pdfInput = "";
    input.setAttribute("aria-label", "Choisir les PDF à joindre à ce cours");
    const status = node("p", "med2-pdf-status", "Chargement des PDF enregistrés…");
    status.dataset.pdfStatus = "";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("aria-atomic", "true");
    const files = node("ul", "med2-pdf-list");
    files.dataset.pdfList = "";
    const inReader = !!container.closest(".modal.reader");
    const hint = node("p", "med2-pdf-note", "« Lire » ouvre le PDF dans l’application. « " + (canShareFiles() ? "Partager" : "Télécharger") + " » l’envoie vers Fichiers, Livres ou une autre app." + (inReader ? " Pour une fiche à relire souvent, utilise plutôt l’onglet Fiches du cours." : ""));
    root.append(title, note, destination, upload, input, status, files, hint);
    container.replaceChildren(root);

    let disposed = false;
    let sequence = 0;
    let busy = false;
    const ctx = { unmount: dispose };
    mounted.set(container, ctx);
    const active = () => !disposed && mounted.get(container) === ctx && root.parentNode === container;

    function announce(text, error) {
      if (!active()) return;
      status.textContent = text;
      status.dataset.error = error ? "true" : "false";
    }

    function setBusy(value) {
      busy = value;
      if (!active()) return;
      root.setAttribute("aria-busy", String(value));
      upload.disabled = value;
      input.disabled = value;
      files.querySelectorAll("button").forEach((b) => { b.disabled = value; });
    }

    function render(records) {
      if (!active()) return;
      files.replaceChildren();
      if (!records.length) {
        files.append(node("li", "med2-pdf-note", "Aucun PDF importé pour ce cours. Ajoute tes documents avec le bouton ci-dessus."));
        return;
      }
      records.forEach((record) => {
        const row = node("li", "med2-pdf-item");
        const infoBox = node("div", "med2-pdf-file");
        infoBox.append(node("span", "med2-pdf-name", record.name));
        infoBox.append(node("span", "med2-pdf-meta", fileSize(record.size) + " · Ajouté le " + day(record.addedAt)));
        const actions = node("div", "med2-pdf-actions");
        const open = button("btn secondary", ICON.book, "Lire", "Lire " + record.name);
        open.dataset.pdfAction = "open";
        open.addEventListener("click", () => view(record, open));
        const shared = canShareFiles();
        const out = button("btn secondary", shared ? ICON.share : ICON.download, shared ? "Partager" : "Télécharger", (shared ? "Partager " : "Télécharger ") + record.name);
        out.dataset.pdfAction = shared ? "share" : "download";
        out.addEventListener("click", () => {
          shareRecord(record).catch((error) => announce(errorText(error), true));
        });
        const erase = button("btn danger", ICON.trash, "Supprimer", "Supprimer " + record.name);
        erase.disabled = busy;
        erase.dataset.pdfAction = "delete";
        erase.addEventListener("click", async () => {
          if (!active() || busy || !window.confirm("Supprimer « " + record.name + " » des PDF enregistrés pour ce cours sur cet appareil ? Garde ton fichier original avant de continuer.")) return;
          setBusy(true);
          announce("Suppression du PDF…");
          try {
            await remove(record.id, key);
            if (await refresh(false)) announce("PDF supprimé de cet appareil.");
          } catch (error) {
            announce(errorText(error), true);
          } finally {
            setBusy(false);
          }
        });
        actions.append(open, out, erase);
        row.append(infoBox, actions);
        files.append(row);
      });
    }

    async function refresh(showLoading = true) {
      const generation = ++sequence;
      if (showLoading) announce("Chargement des PDF enregistrés…");
      try {
        const records = await list(key, "source");
        if (!active() || generation !== sequence) return false;
        render(records);
        if (showLoading) announce(records.length ? records.length + (records.length > 1 ? " PDF disponibles hors ligne." : " PDF disponible hors ligne.") : "");
        return true;
      } catch (error) {
        if (active() && generation === sequence) announce(errorText(error), true);
        return false;
      }
    }

    upload.addEventListener("click", () => { if (!busy) input.click(); });
    input.addEventListener("change", async () => {
      const selected = Array.from(input.files || []);
      input.value = "";
      if (!selected.length || busy || !active()) return;
      setBusy(true);
      let imported = 0;
      const errors = [];
      for (let i = 0; i < selected.length; i++) {
        announce("Enregistrement du PDF " + (i + 1) + " sur " + selected.length + "…");
        try {
          await add(key, selected[i], "source");
          imported++;
        } catch (error) {
          errors.push(selected[i].name + " : " + errorText(error));
        }
      }
      const listed = await refresh(false);
      if (listed) {
        const saved = imported ? imported + (imported > 1 ? " PDF enregistrés pour ce cours, disponibles hors ligne." : " PDF enregistré pour ce cours, disponible hors ligne.") : "";
        announce([saved, errors.join(" ")].filter(Boolean).join(" "), errors.length > 0);
      }
      setBusy(false);
    });

    function dispose() {
      if (disposed) return;
      disposed = true;
      sequence++;
      if (mounted.get(container) === ctx) mounted.delete(container);
      root.remove();
    }

    const ready = refresh();
    return { ready, refresh, unmount: dispose };
  }

  /* ------------------------------------------------------------------ onglet Fiches : import + lecture intégrée */
  function mountFiches(container, options) {
    if (!container || container.nodeType !== 1) throw new Error("L’emplacement des fiches est introuvable.");
    const key = courseKey(options && options.courseId);
    unmount(container);
    styles();
    const uid = "m2f-" + Math.random().toString(36).slice(2, 8);
    const root = node("section", "m2f");
    root.setAttribute("aria-labelledby", uid + "-h");
    const head = node("div", "m2f-head");
    const h = node("h2", "", "Ma fiche PDF");
    h.id = uid + "-h";
    const lead = node("p", "m2f-lead", "Ta fiche de ce cours, enregistrée dans l’application : elle s’ouvre ici, même sans connexion.");
    const addBtn = button("btn small secondary m2f-add", ICON.plus, "Ajouter une fiche");
    addBtn.dataset.pdfAction = "import-fiche";
    addBtn.hidden = true;
    head.append(h, addBtn, lead);
    const input = node("input");
    input.type = "file";
    input.accept = ".pdf,application/pdf";
    input.multiple = true;
    input.hidden = true;
    input.dataset.ficheInput = "";
    input.setAttribute("aria-label", "Choisir la fiche PDF de ce cours");
    const status = node("p", "m2f-status", "Chargement de tes fiches…");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("aria-atomic", "true");
    const chips = node("div", "m2f-chips");
    chips.setAttribute("role", "group");
    chips.setAttribute("aria-label", "Choisir la fiche à afficher");
    chips.hidden = true;
    const empty = node("div", "m2f-empty");
    empty.hidden = true;
    const emptyIco = node("span", "m2f-empty-ico");
    emptyIco.innerHTML = svg(ICON.file, 28);
    const emptyTitle = node("b", "", "Ajoute ta fiche de ce cours");
    const emptyText = node("p", "", "Choisis un PDF sur ton iPhone (Fichiers, iCloud Drive, Google Drive…). Il est copié dans l’application et reste lisible hors ligne.");
    const emptyBtn = button("btn", ICON.upload, "Importer une fiche PDF");
    emptyBtn.dataset.pdfAction = "import-fiche";
    empty.append(emptyIco, emptyTitle, emptyText, emptyBtn);
    const card = node("div", "m2f-card");
    card.hidden = true;
    const bar = node("div", "m2f-bar");
    const fileBox = node("div", "m2f-file");
    fileBox.innerHTML = svg(ICON.file, 20);
    const fileText = node("div");
    const fileName = node("span", "m2f-name");
    const fileMeta = node("span", "m2f-meta");
    fileText.append(fileName, fileMeta);
    fileBox.append(fileText);
    const tools = node("div", "m2f-tools");
    const zoomBox = node("span", "m2f-zoom");
    zoomBox.setAttribute("role", "group");
    zoomBox.setAttribute("aria-label", "Zoom");
    const minus = button("", ICON.minus, "", "Dézoomer");
    const zoomOut = node("output", "", "100 %");
    zoomOut.setAttribute("aria-live", "polite");
    const plus = button("", ICON.plus, "", "Zoomer");
    zoomBox.append(minus, zoomOut, plus);
    const full = button("btn small secondary", ICON.expand, "Plein écran", "Lire la fiche en plein écran");
    full.dataset.pdfAction = "fullscreen";
    const shared = canShareFiles();
    const out = button("btn small ghost", shared ? ICON.share : ICON.download, shared ? "Partager" : "Télécharger", shared ? "Partager ou enregistrer la fiche dans Fichiers" : "Télécharger la fiche");
    out.dataset.pdfAction = shared ? "share" : "download";
    const erase = button("btn small danger", ICON.trash, "Supprimer", "Supprimer cette fiche de l’appareil");
    erase.dataset.pdfAction = "delete-fiche";
    tools.append(zoomBox, full, out, erase);
    bar.append(fileBox, tools);
    const body = node("div", "m2f-body");
    const pager = node("p", "m2f-pager");
    pager.hidden = true;
    pager.setAttribute("aria-hidden", "true");
    card.append(bar, body, pager);
    const foot = node("p", "m2f-foot");
    foot.innerHTML = svg(ICON.offline, 16);
    foot.append(node("span", "", "Tes fiches restent sur cet appareil : elles ne font pas partie de « Exporter mes résultats » et ne passent pas d’un appareil à l’autre. Garde le fichier d’origine."));
    root.append(head, input, status, chips, empty, card, foot);
    container.replaceChildren(root);

    let disposed = false;
    let busy = false;
    let sequence = 0;
    let records = [];
    let currentId = null;
    let viewer = null;
    let shownId = null;
    let showToken = 0;
    const ctx = { unmount: dispose };
    mounted.set(container, ctx);
    const active = () => !disposed && mounted.get(container) === ctx && root.parentNode === container;

    let clearTimer = 0;
    function announce(text, error) {
      if (!active()) return;
      window.clearTimeout(clearTimer);
      status.textContent = text || "";
      status.dataset.error = error ? "true" : "false";
      // Les confirmations s'effacent ; les erreurs restent jusqu'à la prochaine action.
      if (text && !error) clearTimer = window.setTimeout(() => { if (active() && status.textContent === text) status.textContent = ""; }, 7000);
    }
    function setBusy(value) {
      busy = value;
      if (!active()) return;
      root.setAttribute("aria-busy", String(value));
      [addBtn, emptyBtn, erase, input].forEach((el) => { el.disabled = value; });
    }
    function currentRecord() {
      return records.find((r) => r.id === currentId) || null;
    }
    function closeViewer() {
      showToken++;
      if (viewer) {
        viewer.destroy();
        viewer = null;
      }
      if (shownId) {
        releaseDoc(shownId);
        shownId = null;
      }
      body.replaceChildren();
      pager.hidden = true;
    }
    function updateZoom(s) {
      const text = Math.round(s.zoom * 100) + " %";
      if (zoomOut.textContent !== text) zoomOut.textContent = text;
      minus.disabled = s.min;
      plus.disabled = s.max;
    }
    function renderChips() {
      chips.replaceChildren();
      chips.hidden = records.length < 2;
      if (records.length < 2) return;
      records.forEach((record) => {
        const chip = node("button", "m2f-chip");
        chip.type = "button";
        chip.setAttribute("aria-pressed", String(record.id === currentId));
        chip.innerHTML = svg(ICON.file, 15);
        chip.append(node("span", "", record.name.replace(/\.pdf$/i, "")));
        chip.title = record.name;
        chip.addEventListener("click", () => {
          if (record.id === currentId) return;
          currentId = record.id;
          writePick(key, record.id);
          renderChips();
          show();
        });
        chips.append(chip);
      });
    }
    function show() {
      const record = currentRecord();
      closeViewer();
      if (!record) return;
      const token = showToken;
      fileName.textContent = record.name;
      fileMeta.textContent = fileSize(record.size) + " · ajoutée le " + day(record.addedAt);
      zoomOut.textContent = "100 %";
      minus.disabled = true;
      plus.disabled = true;
      const loading = node("p", "m2f-loading", "Préparation des pages…");
      body.append(loading);
      shownId = record.id;
      acquireDoc(record)
        .then((doc) => {
          if (!active() || token !== showToken) return null;
          fileMeta.textContent = doc.numPages + (doc.numPages > 1 ? " pages" : " page") + " · " + fileSize(record.size) + " · ajoutée le " + day(record.addedAt);
          return createViewer(body, {
            doc,
            overlay: false,
            zoom: zoomMemo.get(record.id) || 1,
            onState(s) {
              updateZoom(s);
              zoomMemo.set(record.id, s.zoom);
              pager.hidden = s.pages < 2;
              const text = "Page " + s.page + " / " + s.pages;
              if (pager.textContent !== text) pager.textContent = text;
            },
          });
        })
        .then((v) => {
          loading.remove();
          if (!v) return;
          if (!active() || token !== showToken) v.destroy();
          else viewer = v;
        })
        .catch((error) => {
          loading.remove();
          if (!active() || token !== showToken) return;
          const box = node("div", "m2f-error");
          box.append(node("b", "", "Lecture impossible"), node("span", "", viewerErrorText(error)));
          body.append(box);
        });
    }
    function paint() {
      if (!active()) return;
      const has = records.length > 0;
      empty.hidden = has;
      card.hidden = !has;
      addBtn.hidden = !has;
      h.textContent = records.length > 1 ? "Mes fiches PDF" : "Ma fiche PDF";
      if (!records.some((r) => r.id === currentId)) {
        const pick = readPick()[key];
        currentId = (records.find((r) => r.id === pick) || records[0] || {}).id || null;
      }
      renderChips();
      if (!has) {
        closeViewer();
        return;
      }
      if (shownId !== currentId || !viewer) show();
    }
    async function refresh(quiet) {
      const generation = ++sequence;
      try {
        const list_ = await list(key, "fiche");
        if (!active() || generation !== sequence) return false;
        records = list_;
        if (!quiet) announce("");
        paint();
        if (options.onCount) {
          try { options.onCount(records.length); } catch (_) {}
        }
        return true;
      } catch (error) {
        if (active() && generation === sequence) {
          announce(errorText(error), true);
          empty.hidden = false;
        }
        return false;
      }
    }

    const pickFile = () => { if (!busy) input.click(); };
    addBtn.addEventListener("click", pickFile);
    emptyBtn.addEventListener("click", pickFile);
    input.addEventListener("change", async () => {
      const selected = Array.from(input.files || []);
      input.value = "";
      if (!selected.length || busy || !active()) return;
      setBusy(true);
      let imported = 0;
      let lastId = null;
      const errors = [];
      for (let i = 0; i < selected.length; i++) {
        announce(selected.length > 1 ? "Enregistrement de la fiche " + (i + 1) + " sur " + selected.length + "…" : "Enregistrement de la fiche…");
        try {
          const record = await add(key, selected[i], "fiche");
          lastId = lastId || record.id;
          imported++;
        } catch (error) {
          errors.push(selected[i].name + " : " + errorText(error));
        }
      }
      if (lastId) {
        currentId = lastId;
        writePick(key, lastId);
      }
      const listed = await refresh(true);
      if (listed) {
        const saved = imported ? (imported > 1 ? imported + " fiches enregistrées sur cet appareil, lisibles hors ligne." : "Fiche enregistrée sur cet appareil, lisible hors ligne.") : "";
        announce([saved, errors.join(" ")].filter(Boolean).join(" "), errors.length > 0);
      }
      setBusy(false);
    });
    minus.addEventListener("click", () => viewer && viewer.zoomOut());
    plus.addEventListener("click", () => viewer && viewer.zoomIn());
    full.addEventListener("click", () => {
      const record = currentRecord();
      if (record) view(record, full);
    });
    out.addEventListener("click", () => {
      const record = currentRecord();
      if (record) shareRecord(record).catch((error) => announce(errorText(error), true));
    });
    erase.addEventListener("click", async () => {
      const record = currentRecord();
      if (!record || busy || !active()) return;
      if (!window.confirm("Supprimer la fiche « " + record.name + " » de cet appareil ? Garde ton fichier d’origine : elle n’est pas sauvegardée ailleurs.")) return;
      setBusy(true);
      announce("Suppression de la fiche…");
      try {
        closeViewer();
        await remove(record.id, key);
        if (zoomMemo.has(record.id)) zoomMemo.delete(record.id);
        currentId = null;
        writePick(key, null);
        if (await refresh(true)) announce("Fiche supprimée de cet appareil.");
      } catch (error) {
        announce(errorText(error), true);
        show();
      } finally {
        setBusy(false);
      }
    });

    function dispose() {
      if (disposed) return;
      closeViewer();
      disposed = true;
      sequence++;
      if (mounted.get(container) === ctx) mounted.delete(container);
      root.remove();
    }

    const ready = refresh(false);
    return { ready, refresh, unmount: dispose };
  }

  function unmount(container) {
    if (container) {
      const ctx = mounted.get(container);
      if (ctx) ctx.unmount();
    } else Array.from(mounted.values()).forEach((ctx) => { ctx.unmount(); });
  }

  window.Med2Pdf = Object.freeze({ mount, mountFiches, unmount, list, add, remove, view, count });
})();
