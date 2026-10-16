/* PDF joints aux cours, conservés uniquement dans IndexedDB sur cet appareil.
 * API publique : Med2Pdf.mount(node, { courseId, courseTitle }) -> { ready, refresh, unmount }
 * Med2Pdf.unmount(node?) ; Med2Pdf.list(courseId), add(courseId, File), remove(id, courseId).
 * Les méthodes de stockage rejettent leur promesse si l'opération n'a pas été validée.
 */
(function () {
  "use strict";

  const DB_NAME = "med2.semestre1.pdf.v1";
  const STORE = "documents";
  const mounted = new Map();
  let dbPromise = null;

  function courseKey(value) {
    if (typeof value !== "string" || !value.trim()) throw new Error("Le cours de destination est introuvable.");
    return value;
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

  async function list(courseId) {
    const key = courseKey(courseId);
    const records = await transaction("readonly", (store, done) => {
      const request = store.index("courseId").getAll(key);
      request.onsuccess = () => done(request.result);
    });
    return records.sort((a, b) => b.addedAt - a.addedAt || a.name.localeCompare(b.name, "fr"));
  }

  async function add(courseId, file) {
    const key = courseKey(courseId);
    if (!file || typeof file.name !== "string" || !/\.pdf$/i.test(file.name)) {
      throw new Error("Choisis un fichier dont le nom se termine par .pdf.");
    }
    if (!(file instanceof Blob) || file.size < 5) throw new Error("Ce fichier PDF est vide ou invalide.");
    const bytes = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
    // Les lecteurs PDF acceptent une signature précédée de quelques octets (ex. BOM).
    let header = "";
    for (const byte of bytes) header += String.fromCharCode(byte);
    if (!header.includes("%PDF-")) throw new Error("Ce fichier n’est pas un PDF reconnu. Renommer un autre fichier en .pdf ne suffit pas.");
    const id = window.crypto && window.crypto.randomUUID
      ? window.crypto.randomUUID()
      : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + "-" + Math.random().toString(36).slice(2);
    const record = {
      id,
      courseId: key,
      name: file.name,
      size: file.size,
      addedAt: Date.now(),
      blob: file.slice(0, file.size, "application/pdf"),
    };
    await transaction("readwrite", (store) => { store.add(record); });
    return record;
  }

  async function remove(id, courseId) {
    const key = courseKey(courseId);
    return transaction("readwrite", (store, done, fail) => {
      const request = store.get(id);
      request.onsuccess = () => {
        const record = request.result;
        if (!record) { done(false); return; }
        if (record.courseId !== key) { fail(new Error("Ce PDF est rattaché à un autre cours.")); return; }
        store.delete(id);
        done(true);
      };
    });
  }

  function errorText(error) {
    if (error && (error.name === "QuotaExceededError" || /quota/i.test(error.message || ""))) {
      return "L’espace de stockage de cet appareil est insuffisant. Libère de l’espace ou supprime un PDF déjà importé, puis réessaie. Le fichier concerné n’a pas été enregistré.";
    }
    if (error && ["SecurityError", "InvalidStateError", "UnknownError"].includes(error.name)) {
      return "Le navigateur ne permet pas d’accéder au stockage local des PDF. Vérifie ses réglages ou utilise une fenêtre normale, puis réessaie.";
    }
    return error && error.message ? error.message : "Impossible d’accéder aux PDF sur cet appareil. Réessaie.";
  }

  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
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
.med2-pdf-status { margin: 12px 0; font-size: 0.9375rem; }
.med2-pdf-status:empty { display: none; }
.med2-pdf-status[data-error="true"] { color: var(--ko, #c42f3a); }
.med2-pdf-list { padding: 0; margin: 16px 0 0; list-style: none; }
.med2-pdf-item { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; padding: 16px 0; border-top: 1px solid var(--line, #cdd6e2); }
.med2-pdf-file { flex: 1 1 200px; min-width: 0; }
.med2-pdf-name { display: block; overflow-wrap: anywhere; font-weight: 650; }
.med2-pdf-meta { display: block; margin-top: 4px; }
.med2-pdf-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.med2-pdf .btn { min-height: 44px; font-size: 0.875rem; }
.med2-pdf .btn:focus-visible { outline: 3px solid var(--focus, #2563eb); outline-offset: 3px; }
@media (max-width: 480px) { .med2-pdf { padding: 16px; } .med2-pdf-actions { width: 100%; } .med2-pdf-actions .btn { flex: 1 1 auto; padding-inline: 10px; } }
`;
    document.head.append(style);
  }

  function fileSize(bytes) {
    return bytes < 1024 * 1024
      ? Math.max(1, Math.round(bytes / 1024)).toLocaleString("fr-FR") + " Ko"
      : (bytes / (1024 * 1024)).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " Mo";
  }

  function mount(container, options) {
    if (!container || container.nodeType !== 1) throw new Error("L’emplacement des PDF est introuvable.");
    const key = courseKey(options && options.courseId);
    unmount(container);
    styles();
    const root = node("section", "med2-pdf");
    root.setAttribute("aria-label", "Mes PDF pour ce cours");
    const title = node("h3", "", "Mes PDF pour ce cours");
    const note = node("p", "med2-pdf-note", "Enregistrés sur cet appareil, disponibles hors ligne. La sauvegarde des résultats n’inclut pas ces PDF ; garde tes originaux.");
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
    const hint = node("p", "med2-pdf-note", "Si ton navigateur ne peut pas afficher un PDF, utilise Télécharger pour l’ouvrir dans ton lecteur habituel.");
    root.append(title, note, destination, upload, input, status, files, hint);
    container.replaceChildren(root);

    let disposed = false;
    let sequence = 0;
    let busy = false;
    let urls = [];
    const touched = new Set();
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
      files.querySelectorAll("button").forEach((button) => { button.disabled = value; });
    }

    function releaseUrls() {
      for (const url of urls) {
        // Un clic ouvre directement le Blob : lui laisser le temps de charger dans un nouvel onglet.
        if (touched.has(url)) window.setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
        else URL.revokeObjectURL(url);
      }
      urls = [];
      touched.clear();
    }

    function render(records) {
      if (!active()) return;
      releaseUrls();
      files.replaceChildren();
      if (!records.length) {
        files.append(node("li", "med2-pdf-note", "Aucun PDF importé pour ce cours. Ajoute tes documents avec le bouton ci-dessus."));
        return;
      }
      records.forEach((record) => {
        const row = node("li", "med2-pdf-item");
        const info = node("div", "med2-pdf-file");
        info.append(node("span", "med2-pdf-name", record.name));
        info.append(node("span", "med2-pdf-meta", fileSize(record.size) + " · Ajouté le " + new Date(record.addedAt).toLocaleDateString("fr-FR")));
        const actions = node("div", "med2-pdf-actions");
        const url = URL.createObjectURL(record.blob);
        urls.push(url);
        const open = node("a", "btn secondary", "Ouvrir");
        open.href = url;
        open.target = "_blank";
        open.rel = "noopener noreferrer";
        open.dataset.pdfAction = "open";
        open.setAttribute("aria-label", "Ouvrir " + record.name);
        open.addEventListener("click", () => { touched.add(url); });
        const download = node("a", "btn secondary", "Télécharger");
        download.href = url;
        download.download = record.name;
        download.dataset.pdfAction = "download";
        download.setAttribute("aria-label", "Télécharger " + record.name);
        download.addEventListener("click", () => { touched.add(url); });
        const erase = node("button", "btn danger", "Supprimer");
        erase.type = "button";
        erase.disabled = busy;
        erase.dataset.pdfAction = "delete";
        erase.setAttribute("aria-label", "Supprimer " + record.name);
        erase.addEventListener("click", async () => {
          if (!active() || busy || !window.confirm("Supprimer « " + record.name + " » des PDF enregistrés pour ce cours sur cet appareil ? Garde ton fichier original avant de continuer.")) return;
          setBusy(true);
          announce("Suppression du PDF…");
          try {
            await remove(record.id, key);
            if (await refresh(false)) announce("PDF supprimé de cet appareil.");
          } catch (error) { announce(errorText(error), true); }
          finally { setBusy(false); }
        });
        actions.append(open, download, erase);
        row.append(info, actions);
        files.append(row);
      });
    }

    async function refresh(showLoading = true) {
      const generation = ++sequence;
      if (showLoading) announce("Chargement des PDF enregistrés…");
      try {
        const records = await list(key);
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
        try { await add(key, selected[i]); imported++; }
        catch (error) { errors.push(selected[i].name + " : " + errorText(error)); }
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
      releaseUrls();
      if (mounted.get(container) === ctx) mounted.delete(container);
      root.remove();
    }

    const ready = refresh();
    return { ready, refresh, unmount: dispose };
  }

  function unmount(container) {
    if (container) {
      const ctx = mounted.get(container);
      if (ctx) ctx.unmount();
    } else Array.from(mounted.values()).forEach((ctx) => { ctx.unmount(); });
  }

  window.Med2Pdf = Object.freeze({ mount, unmount, list, add, remove });
})();
