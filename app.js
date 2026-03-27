/**
 * ============================================================
 *  PATENTES PERDIDAS — app.js v2.0
 *  Plataforma cívica digital · LAE Strategy
 * ============================================================
 *
 *  ARQUITECTURA:
 *  El código está organizado como módulos bajo el namespace
 *  global APP para evitar colisiones y facilitar mantenimiento.
 *
 *  APP.config   → configuración global
 *  APP.state    → estado reactivo centralizado
 *  APP.data     → carga/guardado (Google Sheets / localStorage)
 *  APP.form     → lógica del formulario
 *  APP.matching → algoritmo de matching automático
 *  APP.render   → renderizado de tarjetas
 *  APP.search   → búsqueda y filtros
 *  APP.geo      → geolocalización
 *  APP.map      → integración con Leaflet.js
 *  APP.notify   → sistema de notificaciones/alertas
 *  APP.share    → viralidad (WhatsApp)
 *  APP.city     → selector multi-ciudad
 *  APP.analytics→ tracking de datos (exportable a Power BI)
 *  APP.ui       → utilidades de interfaz
 *
 * ============================================================
 *
 *  IDEAS DE MONETIZACIÓN FUTURA (sin cobrar al usuario):
 *  1. Alianzas municipales: municipios pagan por el servicio
 *     y obtienen datos anonimizados de zonas de riesgo.
 *  2. Dashboard de analítica vendido a aseguradoras o
 *     municipalidades (hotspots de pérdida por lluvia).
 *  3. API de datos anonimizados para investigación urbana.
 *  4. White-label para otras ciudades/países (SaaS cívico).
 *  5. Consultoría basada en los patrones detectados (LAE Strategy).
 *
 * ============================================================
 */

// ============================================================
//  NAMESPACE GLOBAL
// ============================================================
const APP = {};

// ============================================================
//  CONFIG
// ============================================================
APP.config = {
  /**
   * URL del endpoint Google Apps Script.
   * Reemplazá con tu URL real después de desplegar.
   */
  SHEETS_API_URL: "TU_URL_DE_APPS_SCRIPT_AQUÍ",

  /**
   * true  → usa localStorage (demo/desarrollo)
   * false → usa Google Sheets real
   */
  USE_LOCAL_STORAGE: true,

  LOCAL_KEY:    "patentes_v2_data",
  NOTIFY_KEY:   "patentes_v2_notif",
  ANALYTICS_KEY:"patentes_v2_analytics",

  MAP_CENTER:   [-31.6333, -60.7000],  // Santa Fe, Argentina
  MAP_ZOOM:     13,

  /**
   * Ciudades disponibles con coordenadas.
   * Agregar más ciudades aquí para escalar.
   */
  CITIES: {
    santa_fe:     { name: "Santa Fe",      lat: -31.6333, lng: -60.7000 },
    rosario:      { name: "Rosario",       lat: -32.9468, lng: -60.6393 },
    buenos_aires: { name: "Buenos Aires",  lat: -34.6037, lng: -58.3816 },
    cordoba:      { name: "Córdoba",       lat: -31.4167, lng: -64.1833 },
    otra:         { name: "Otra ciudad",   lat: -31.6333, lng: -60.7000 },
  },
};

// ============================================================
//  STATE (estado reactivo centralizado)
// ============================================================
APP.state = {
  records:       [],          // todos los registros cargados
  searchQuery:   "",          // búsqueda activa
  activeFilter:  "all",       // "all"|"Perdida"|"Encontrada"|"Resuelta"
  activeCity:    "santa_fe",  // ciudad activa
  matchedPlates: new Set(),   // patentes con coincidencia
  resolvedPlates: new Set(),  // patentes marcadas como resueltas
  userLat:       null,        // coordenadas del usuario
  userLng:       null,
  lastPosted:    null,        // último registro publicado (para compartir)
  mapInstance:   null,        // instancia Leaflet
  mapMarkers:    [],          // marcadores del mapa

  /** Actualiza el estado y re-renderiza si es necesario */
  update(changes) {
    Object.assign(this, changes);
  },
};

// ============================================================
//  INICIALIZACIÓN
// ============================================================
document.addEventListener("DOMContentLoaded", () => {
  APP.form.init();
  APP.search.init();
  APP.city.init();
  APP.data.load();
  APP.map.init();
  APP.notify.checkPending();
  APP.analytics.init();

  // Lazy init mapa cuando entra en viewport
  const mapObs = new IntersectionObserver((entries) => {
    entries.forEach(e => { if (e.isIntersecting) { APP.map.render(); mapObs.disconnect(); } });
  }, { threshold: 0.1 });
  const mapSection = document.getElementById("mapa");
  if (mapSection) mapObs.observe(mapSection);
});

// ============================================================
//  DATA — carga y persistencia
// ============================================================
APP.data = {

  async load() {
    APP.ui.showLoading(true);
    try {
      if (APP.config.USE_LOCAL_STORAGE) {
        const raw = localStorage.getItem(APP.config.LOCAL_KEY);
        APP.state.records = raw ? JSON.parse(raw) : this.getSampleData();
      } else {
        const city = APP.config.CITIES[APP.state.activeCity]?.name || "Santa Fe";
        const url  = `${APP.config.SHEETS_API_URL}?ciudad=${encodeURIComponent(city)}`;
        const resp = await this._fetchWithTimeout(url, { method: "GET" }, 8000);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();
        if (!json.ok) throw new Error(json.error || "Error del servidor");
        APP.state.records = json.data.map(this._normalizeRecord);
      }
    } catch (err) {
      console.error("[APP.data.load]", err);
      APP.state.records = this.getSampleData();
      APP.ui.toast("⚠️ Modo demo activo. Configurá el backend para producción.", "warning");
    }

    APP.matching.detect();
    APP.render.cards();
    APP.analytics.update();
    APP.ui.showLoading(false);
  },

  saveLocal() {
    localStorage.setItem(APP.config.LOCAL_KEY, JSON.stringify(APP.state.records));
  },

  async saveRecord(record) {
    if (APP.config.USE_LOCAL_STORAGE) {
      APP.state.records.unshift(record);
      this.saveLocal();
      return { ok: true };
    }
    try {
      const resp = await this._fetchWithTimeout(APP.config.SHEETS_API_URL, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(record),
      }, 8000);
      const json = await resp.json();
      if (json.ok) APP.state.records.unshift(record);
      return json;
    } catch (err) {
      console.error("[APP.data.saveRecord]", err);
      throw err;
    }
  },

  async resolveRecord(id) {
    const record = APP.state.records.find(r => r.id === id);
    if (!record) return;
    record.estado    = "Resuelta";
    record.resuelto  = "true";

    if (APP.config.USE_LOCAL_STORAGE) {
      this.saveLocal();
      return { ok: true };
    }
    try {
      await this._fetchWithTimeout(APP.config.SHEETS_API_URL, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ _method: "PATCH", id }),
      }, 8000);
    } catch (err) {
      console.warn("[APP.data.resolveRecord] Fallo sincronización remota:", err);
    }
  },

  /** fetch con timeout para evitar cuelgues */
  _fetchWithTimeout(url, options, ms) {
    return Promise.race([
      fetch(url, options),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Request timeout")), ms)
      ),
    ]);
  },

  _normalizeRecord(raw) {
    return {
      id:        raw.id        || APP.ui.generateId(),
      patente:   APP.matching.normalize(raw.patente  || ""),
      estado:    (raw.estado   || "").trim(),
      ciudad:    (raw.ciudad   || "Santa Fe").trim(),
      zona:      (raw.zona     || "Sin especificar").trim(),
      contacto:  (raw.contacto || "").trim(),
      fecha:     (raw.fecha    || APP.ui.formatDate(new Date())).toString(),
      lat:       raw.lat       ? parseFloat(raw.lat) : null,
      lng:       raw.lng       ? parseFloat(raw.lng) : null,
      resuelto:  (raw.resuelto || "false").toString(),
      notificar: (raw.notificar|| "false").toString(),
    };
  },

  getSampleData() {
    // Datos de demo — incluyen deliberadamente una coincidencia (ABC123)
    // y una patente resuelta (MNO789) para mostrar todas las features.
    return [
      { id:"demo-1", patente:"ABC123",  estado:"Perdida",   ciudad:"Santa Fe", zona:"Centro",    contacto:"carlos@ejemplo.com", fecha:"22/03/2025, 09:30", lat:-31.628, lng:-60.699, resuelto:"false", notificar:"false" },
      { id:"demo-2", patente:"ABC123",  estado:"Encontrada",ciudad:"Santa Fe", zona:"Sur",       contacto:"maria@ejemplo.com",  fecha:"22/03/2025, 10:15", lat:-31.640, lng:-60.695, resuelto:"false", notificar:"false" },
      { id:"demo-3", patente:"XY456GH", estado:"Perdida",   ciudad:"Santa Fe", zona:"Guadalupe", contacto:"3424456789",         fecha:"21/03/2025, 14:00", lat:-31.620, lng:-60.720, resuelto:"false", notificar:"false" },
      { id:"demo-4", patente:"MNO789",  estado:"Resuelta",  ciudad:"Santa Fe", zona:"Norte",     contacto:"info@ejemplo.com",   fecha:"21/03/2025, 11:20", lat:-31.615, lng:-60.705, resuelto:"true",  notificar:"false" },
      { id:"demo-5", patente:"JKL321",  estado:"Perdida",   ciudad:"Santa Fe", zona:"Oeste",     contacto:"3423321100",         fecha:"20/03/2025, 16:45", lat:-31.635, lng:-60.730, resuelto:"false", notificar:"false" },
      { id:"demo-6", patente:"PQR654",  estado:"Encontrada",ciudad:"Santa Fe", zona:"Este",      contacto:"3425112233",         fecha:"20/03/2025, 18:00", lat:-31.625, lng:-60.680, resuelto:"false", notificar:"false" },
    ];
  },
};

// ============================================================
//  FORM
// ============================================================
APP.form = {

  init() {
    const form = document.getElementById("patenteForm");
    if (!form) return;

    // Normalizar patente en tiempo real
    const inputPatente = document.getElementById("inputPatente");
    inputPatente.addEventListener("input", () => {
      const val = APP.matching.normalize(inputPatente.value);
      inputPatente.value = val;
      APP.ui.clearFieldError("inputPatente", "patenteError");
      this._updatePatentePreview(val);
      this._checkLiveMatch(val);
    });

    form.addEventListener("submit", (e) => this.handleSubmit(e));
  },

  selectEstado(value) {
    document.getElementById("inputEstado").value = value;
    document.getElementById("btnPerdida").className   = "estado-btn" + (value === "Perdida"    ? " active-perdida"    : "");
    document.getElementById("btnPerdida").setAttribute("aria-pressed", value === "Perdida");
    document.getElementById("btnEncontrada").className = "estado-btn" + (value === "Encontrada" ? " active-encontrada" : "");
    document.getElementById("btnEncontrada").setAttribute("aria-pressed", value === "Encontrada");
    APP.ui.clearFieldError("inputEstado", "estadoError");
  },

  _updatePatentePreview(val) {
    const preview = document.getElementById("patentePreview");
    if (!preview) return;
    if (val.length >= 6) {
      const isViejo  = /^[A-Z]{3}\d{3}$/.test(val);
      const isNuevo  = /^[A-Z]{2}\d{3}[A-Z]{2}$/.test(val);
      preview.textContent  = isViejo ? "Formato viejo" : isNuevo ? "Formato nuevo" : "Formato libre";
      preview.className    = "patente-preview visible";
    } else {
      preview.className = "patente-preview";
    }
  },

  _checkLiveMatch(plate) {
    if (plate.length < 6) return;
    const normalized = APP.matching.normalize(plate);
    if (APP.state.matchedPlates.has(normalized)) {
      APP.ui.toast(`🎯 ¡La patente ${normalized} ya tiene una coincidencia activa!`, "success");
    }
  },

  async handleSubmit(e) {
    e.preventDefault();
    if (!this.validate()) return;

    const btn = document.getElementById("submitBtn");
    APP.ui.setButtonLoading(btn, true);

    const cityKey  = APP.state.activeCity;
    const cityName = APP.config.CITIES[cityKey]?.name
      || document.getElementById("inputCiudad").value.trim()
      || "Santa Fe";

    const record = {
      id:        APP.ui.generateId(),
      patente:   APP.matching.normalize(document.getElementById("inputPatente").value),
      estado:    document.getElementById("inputEstado").value,
      ciudad:    cityName,
      zona:      document.getElementById("inputZona").value.trim() || "Sin especificar",
      contacto:  document.getElementById("inputContacto").value.trim(),
      fecha:     APP.ui.formatDate(new Date()),
      lat:       APP.state.userLat,
      lng:       APP.state.userLng,
      resuelto:  "false",
      notificar: document.getElementById("inputNotify").checked ? "true" : "false",
    };

    try {
      const result = await APP.data.saveRecord(record);
      if (result.ok) {
        APP.state.lastPosted = record;
        APP.matching.detect();
        APP.render.cards();
        APP.map.addMarker(record);
        APP.analytics.update();

        // Notificaciones si el usuario lo pidió
        if (record.notificar === "true") {
          APP.notify.register(record.patente, record.contacto);
        }

        // Chequear si hay match inmediato
        const hasMatch = APP.state.matchedPlates.has(record.patente);
        const msg = hasMatch
          ? `🎯 ¡Coincidencia encontrada para ${record.patente}! Revisá las tarjetas resaltadas.`
          : `Tu publicación quedó activa. Si alguien reporta ${record.patente}, te aparecerá aquí.`;

        document.getElementById("successMatchText").textContent = msg;
        document.getElementById("successShareBtn").onclick = () =>
          APP.share.whatsapp(record.patente, record.estado, record.zona);

        document.getElementById("patenteForm").classList.add("hidden");
        document.getElementById("successMsg").classList.remove("hidden");

        APP.analytics.track("publish", { patente: record.patente, estado: record.estado });
      } else {
        APP.ui.toast("Error al guardar. Intentá de nuevo.", "error");
      }
    } catch (err) {
      console.error("[APP.form.handleSubmit]", err);
      APP.ui.toast("Error de conexión. Intentá de nuevo.", "error");
    } finally {
      APP.ui.setButtonLoading(btn, false);
    }
  },

  validate() {
    let valid = true;
    const patente  = document.getElementById("inputPatente").value.trim();
    const estado   = document.getElementById("inputEstado").value;
    const contacto = document.getElementById("inputContacto").value.trim();

    if (!patente) {
      APP.ui.showFieldError("inputPatente", "patenteError", "El número de patente es obligatorio.");
      valid = false;
    } else if (patente.length < 6) {
      APP.ui.showFieldError("inputPatente", "patenteError", "Mínimo 6 caracteres.");
      valid = false;
    }
    if (!estado) {
      APP.ui.showFieldError("inputEstado", "estadoError", "Seleccioná si la perdiste o la encontraste.");
      valid = false;
    }
    if (!contacto) {
      APP.ui.showFieldError("inputContacto", "contactoError", "Ingresá un email o teléfono de contacto.");
      valid = false;
    }
    return valid;
  },

  reset() {
    document.getElementById("patenteForm").reset();
    document.getElementById("patenteForm").classList.remove("hidden");
    document.getElementById("successMsg").classList.add("hidden");
    document.getElementById("inputEstado").value = "";
    document.getElementById("btnPerdida").className    = "estado-btn";
    document.getElementById("btnEncontrada").className = "estado-btn";
    document.getElementById("patentePreview").className = "patente-preview";
    APP.ui.clearAllErrors();
    APP.state.update({ userLat: null, userLng: null });
    document.getElementById("geoStatus").textContent = "";
    document.getElementById("geoBtn").classList.remove("active");
  },
};

// ============================================================
//  MATCHING — algoritmo de detección de coincidencias
// ============================================================
APP.matching = {

  /** Normaliza una patente para comparación uniforme */
  normalize(value) {
    return (value || "")
      .toUpperCase()
      .replace(/[\s\-_\.]/g, "")
      .trim();
  },

  /**
   * Detecta todos los pares de patentes con estado opuesto.
   * Actualiza matchedPlates y resolvedPlates en el estado.
   *
   * Mejora sobre v1: también detecta variantes comunes
   * (Ej: "O" vs "0", "I" vs "1") mediante normalización tolerante.
   */
  detect() {
    const perdidas    = new Map(); // plate → record
    const encontradas = new Map();

    APP.state.records.forEach(r => {
      const plate = this.normalize(r.patente);
      const tolerant = this._tolerantNormalize(plate);
      if (r.estado === "Perdida")    perdidas.set(plate,    r);
      if (r.estado === "Encontrada") encontradas.set(plate, r);
      // También indexar variante tolerante
      if (r.estado === "Perdida")    perdidas.set(tolerant,    r);
      if (r.estado === "Encontrada") encontradas.set(tolerant, r);
    });

    APP.state.matchedPlates.clear();
    perdidas.forEach((_, plate) => {
      if (encontradas.has(plate)) APP.state.matchedPlates.add(plate);
    });

    // Resueltas
    APP.state.resolvedPlates.clear();
    APP.state.records.forEach(r => {
      if (r.resuelto === "true" || r.estado === "Resuelta") {
        APP.state.resolvedPlates.add(this.normalize(r.patente));
      }
    });

    // UI banners
    const hasMatches = APP.state.matchedPlates.size > 0;
    APP.ui.toggleEl("matchAlert",  hasMatches);
    APP.ui.toggleEl("matchBanner", hasMatches);

    // Revisar notificaciones pendientes
    APP.notify.checkMatches();
  },

  /**
   * Normalización tolerante: reemplaza confusiones comunes.
   * Ej: "O" ↔ "0", "I" ↔ "1", "B" ↔ "8"
   */
  _tolerantNormalize(plate) {
    return plate
      .replace(/O/g, "0")
      .replace(/I/g, "1")
      .replace(/B/g, "8");
  },

  /**
   * Calcula un score de similitud entre dos patentes (0-1).
   * Útil para mostrar "posibles coincidencias" aunque no sean exactas.
   */
  similarityScore(a, b) {
    const na = this.normalize(a);
    const nb = this.normalize(b);
    if (na === nb) return 1;
    const ta = this._tolerantNormalize(na);
    const tb = this._tolerantNormalize(nb);
    if (ta === tb) return 0.9;

    // Levenshtein simplificado
    let matches = 0;
    const len = Math.max(na.length, nb.length);
    for (let i = 0; i < Math.min(na.length, nb.length); i++) {
      if (na[i] === nb[i]) matches++;
    }
    return matches / len;
  },
};

// ============================================================
//  RENDER — construcción del DOM de tarjetas
// ============================================================
APP.render = {

  cards() {
    const grid  = document.getElementById("cardGrid");
    const empty = document.getElementById("emptyState");
    const list  = this._filtered();

    if (!list.length) {
      grid.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");
    grid.innerHTML = list.map((r, i) => this._cardHTML(r, i)).join("");
  },

  _filtered() {
    const query  = APP.matching.normalize(APP.state.searchQuery);
    const filter = APP.state.activeFilter;
    const city   = APP.config.CITIES[APP.state.activeCity]?.name || "Santa Fe";

    return APP.state.records.filter(r => {
      const plate        = APP.matching.normalize(r.patente);
      const matchSearch  = !query || plate.includes(query);
      const matchFilter  = filter === "all" || r.estado === filter;
      const matchCity    = !r.ciudad || r.ciudad === city || APP.state.activeCity === "otra";
      return matchSearch && matchFilter && matchCity;
    });
  },

  _cardHTML(r, index) {
    const plate      = APP.matching.normalize(r.patente);
    const isMatch    = APP.state.matchedPlates.has(plate);
    const isResolved = r.resuelto === "true" || r.estado === "Resuelta";
    const estado     = isResolved ? "Resuelta" : r.estado;

    const badgeClass = estado === "Perdida"    ? "badge--perdida"
                     : estado === "Encontrada" ? "badge--encontrada"
                     :                           "badge--resuelta";
    const badgeIcon  = estado === "Perdida" ? "🔴" : estado === "Encontrada" ? "🟢" : "✅";
    const cardClass  = [
      "patente-card",
      isMatch    ? "is-match"    : "",
      isResolved ? "is-resolved" : "",
    ].filter(Boolean).join(" ");

    const delay = `animation-delay:${index * 55}ms`;
    const contact = APP.ui.maskContact(r.contacto);

    // Botón "Marcar resuelta" solo en cards activas con match
    const resolveBtn = isMatch && !isResolved
      ? `<button class="btn--resolve" onclick="APP.render.resolve('${APP.ui.esc(r.id)}')" title="Marcar como recuperada">✓ Resuelta</button>`
      : "";

    return `
      <article class="patente-card ${cardClass}" data-estado="${APP.ui.esc(estado)}" data-plate="${APP.ui.esc(plate)}" style="${delay}" aria-label="Patente ${APP.ui.esc(plate)}, ${APP.ui.esc(estado)}">
        <div class="patente-card__plate">${APP.ui.esc(plate)}</div>
        <span class="patente-card__badge ${badgeClass}">${badgeIcon} ${APP.ui.esc(estado)}</span>
        <div class="patente-card__meta">
          <div class="meta-item"><span class="meta-icon">📍</span><span>${APP.ui.esc(r.zona)}</span></div>
          ${r.ciudad ? `<div class="meta-item"><span class="meta-icon">🏙️</span><span>${APP.ui.esc(r.ciudad)}</span></div>` : ""}
          <div class="meta-item"><span class="meta-icon">📅</span><span>${APP.ui.esc(r.fecha)}</span></div>
        </div>
        <div class="patente-card__footer">
          <span class="card-contact-hint">${APP.ui.esc(contact)}</span>
          <div class="card-actions">
            ${resolveBtn}
            <button class="btn--share" onclick="APP.share.whatsapp('${APP.ui.esc(plate)}','${APP.ui.esc(estado)}','${APP.ui.esc(r.zona)}')" title="Compartir en WhatsApp" aria-label="Compartir">📲</button>
            <button class="btn--contact" onclick="APP.contact.open('${APP.ui.esc(r.contacto)}','${APP.ui.esc(plate)}')" aria-label="Contactar">Contactar</button>
          </div>
        </div>
      </article>`;
  },

  async resolve(id) {
    if (!confirm("¿Confirmás que esta patente fue recuperada?")) return;
    await APP.data.resolveRecord(id);
    APP.matching.detect();
    APP.render.cards();
    APP.analytics.update();
    APP.ui.toast("✅ Patente marcada como recuperada. ¡Gracias por actualizar!", "success");
    APP.analytics.track("resolve", { id });
  },
};

// ============================================================
//  SEARCH — búsqueda y filtros
// ============================================================
APP.search = {

  init() {
    const input = document.getElementById("searchInput");
    if (!input) return;
    let timer;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        APP.state.searchQuery = input.value;
        APP.render.cards();
        APP.analytics.track("search", { query: input.value });
      }, 220);
    });

    document.querySelectorAll(".filter-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".filter-tab").forEach(t => {
          t.classList.remove("active");
          t.setAttribute("aria-selected", "false");
        });
        tab.classList.add("active");
        tab.setAttribute("aria-selected", "true");
        APP.state.activeFilter = tab.dataset.filter;
        APP.render.cards();
      });
    });
  },
};

// ============================================================
//  GEO — geolocalización del usuario
// ============================================================
APP.geo = {

  requestLocation() {
    const btn    = document.getElementById("geoBtn");
    const status = document.getElementById("geoStatus");

    if (!navigator.geolocation) {
      status.textContent = "⚠️ Tu navegador no soporta geolocalización.";
      return;
    }

    btn.querySelector("#geoBtnText").textContent = "📍 Obteniendo ubicación…";
    btn.disabled = true;

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        APP.state.userLat = pos.coords.latitude;
        APP.state.userLng = pos.coords.longitude;
        btn.classList.add("active");
        btn.querySelector("#geoBtnText").textContent = "📍 Ubicación obtenida ✓";
        btn.disabled = false;
        status.textContent = `Lat ${pos.coords.latitude.toFixed(4)}, Lng ${pos.coords.longitude.toFixed(4)}`;

        // Intentar auto-completar zona con reverse geocoding simple (sin API)
        APP.geo._reverseGeocode(pos.coords.latitude, pos.coords.longitude);
      },
      (err) => {
        btn.querySelector("#geoBtnText").textContent = "📍 Usar mi ubicación";
        btn.disabled = false;
        status.textContent = err.code === 1
          ? "⚠️ Permiso denegado. Activá la ubicación en tu navegador."
          : "⚠️ No se pudo obtener la ubicación. Ingresá la zona manualmente.";
      },
      { timeout: 8000, maximumAge: 60000, enableHighAccuracy: false }
    );
  },

  _reverseGeocode(lat, lng) {
    // Nominatim (OSM) — gratuito, sin API key
    fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`)
      .then(r => r.json())
      .then(data => {
        const barrio = data.address?.suburb
          || data.address?.neighbourhood
          || data.address?.quarter
          || data.address?.city_district
          || "";
        if (barrio) {
          const zonaInput = document.getElementById("inputZona");
          if (zonaInput && !zonaInput.value) zonaInput.value = barrio;
        }
      })
      .catch(() => {}); // silencioso si falla
  },
};

// ============================================================
//  MAP — integración Leaflet.js
// ============================================================
APP.map = {

  init() {
    // Se inicializa en DOMContentLoaded pero renderiza lazy en viewport
  },

  render() {
    const container = document.getElementById("mapContainer");
    if (!container || APP.state.mapInstance) return;

    // Verificar que Leaflet esté disponible
    if (typeof L === "undefined") {
      container.innerHTML = '<p style="padding:20px;text-align:center;color:#888;">📡 Mapa no disponible. Requiere conexión a internet.</p>';
      return;
    }

    const city = APP.config.CITIES[APP.state.activeCity] || APP.config.CITIES.santa_fe;
    APP.state.mapInstance = L.map("mapContainer").setView([city.lat, city.lng], APP.config.MAP_ZOOM);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(APP.state.mapInstance);

    this._addAllMarkers();
  },

  _addAllMarkers() {
    const map = APP.state.mapInstance;
    if (!map) return;

    // Limpiar marcadores existentes
    APP.state.mapMarkers.forEach(m => m.remove());
    APP.state.mapMarkers = [];

    APP.state.records.forEach(r => this.addMarker(r, false));
  },

  addMarker(record, addToMap = true) {
    const map = APP.state.mapInstance;
    if (!map || typeof L === "undefined") return;

    // Coordenadas: si no tiene, usar aproximación de la ciudad + ruido aleatorio
    let lat = record.lat ? parseFloat(record.lat) : null;
    let lng = record.lng ? parseFloat(record.lng) : null;

    if (!lat || !lng) {
      const city = APP.config.CITIES[APP.state.activeCity] || APP.config.CITIES.santa_fe;
      lat = city.lat + (Math.random() - 0.5) * 0.04;
      lng = city.lng + (Math.random() - 0.5) * 0.04;
    }

    const plate   = APP.matching.normalize(record.patente);
    const isMatch = APP.state.matchedPlates.has(plate);
    const color   = record.estado === "Perdida" ? "#e74c3c"
                  : record.estado === "Encontrada" ? "#27ae60"
                  : "#c9a84c";
    const emoji   = isMatch ? "⭐" : record.estado === "Perdida" ? "🔴" : record.estado === "Encontrada" ? "🟢" : "✅";

    const icon = L.divIcon({
      html:      `<div style="background:${color};color:#fff;border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,0.3);border:2px solid #fff">${emoji}</div>`,
      className: "",
      iconSize:  [32, 32],
      iconAnchor:[16, 16],
    });

    const marker = L.marker([lat, lng], { icon })
      .bindPopup(`
        <div style="font-family:var(--font-body,sans-serif)">
          <strong style="font-size:1.1rem;letter-spacing:.05em">${APP.ui.esc(plate)}</strong><br/>
          <span style="color:${color};font-weight:600;font-size:13px">${APP.ui.esc(record.estado)}</span><br/>
          <span style="color:#666;font-size:12px">📍 ${APP.ui.esc(record.zona)}</span><br/>
          <span style="color:#888;font-size:11px">${APP.ui.esc(record.fecha)}</span>
          ${isMatch ? '<br/><strong style="color:#c9a84c;font-size:12px">🎯 ¡Coincidencia!</strong>' : ""}
        </div>
      `);

    if (addToMap || !APP.state.mapMarkers.includes(marker)) {
      marker.addTo(map);
      APP.state.mapMarkers.push(marker);
    }
  },

  updateCity(cityKey) {
    const map  = APP.state.mapInstance;
    const city = APP.config.CITIES[cityKey];
    if (!map || !city) return;
    map.setView([city.lat, city.lng], APP.config.MAP_ZOOM);
    this._addAllMarkers();
  },
};

// ============================================================
//  NOTIFY — sistema de alertas/notificaciones
// ============================================================
APP.notify = {

  /** Registra una alerta para una patente */
  register(plate, contacto) {
    const raw   = localStorage.getItem(APP.config.NOTIFY_KEY);
    const list  = raw ? JSON.parse(raw) : [];
    const norm  = APP.matching.normalize(plate);
    if (!list.find(n => n.plate === norm)) {
      list.push({ plate: norm, contacto, registeredAt: new Date().toISOString() });
      localStorage.setItem(APP.config.NOTIFY_KEY, JSON.stringify(list));
    }
    this._updateWidget();
  },

  clearAll() {
    localStorage.removeItem(APP.config.NOTIFY_KEY);
    this._updateWidget();
    APP.ui.toast("Alertas canceladas.", "warning");
  },

  checkPending() {
    this._updateWidget();
  },

  checkMatches() {
    const raw = localStorage.getItem(APP.config.NOTIFY_KEY);
    if (!raw) return;
    const list = JSON.parse(raw);
    list.forEach(n => {
      if (APP.state.matchedPlates.has(n.plate)) {
        APP.ui.toast(`🎯 ¡Tu patente ${n.plate} tiene una coincidencia! Revisá el listado.`, "success");
      }
    });
  },

  _updateWidget() {
    const raw    = localStorage.getItem(APP.config.NOTIFY_KEY);
    const list   = raw ? JSON.parse(raw) : [];
    const widget = document.getElementById("notifyWidget");
    const text   = document.getElementById("notifyWidgetText");
    if (!widget) return;

    if (list.length > 0) {
      widget.classList.remove("hidden");
      const plates = list.map(n => n.plate).join(", ");
      if (text) text.textContent = `Monitoreando: ${plates}`;
    } else {
      widget.classList.add("hidden");
    }
  },
};

// ============================================================
//  SHARE — viralidad (WhatsApp)
// ============================================================
APP.share = {

  whatsapp(plate, estado, zona) {
    const emoji   = estado === "Perdida" ? "🔴" : "🟢";
    const accion  = estado === "Perdida"
      ? "Se perdió en la lluvia. ¿La viste? Ayudá a que vuelva a su dueño."
      : "Fue encontrada. ¿Es tuya? Contactate para recuperarla.";

    const text = `${emoji} *Patente ${plate}* — ${estado.toUpperCase()}\n📍 Zona: ${zona}\n\n${accion}\n\n👉 Buscá o publicá tu patente en: ${window.location.href}\n\n_Plataforma cívica gratuita · Patentes Perdidas_`;

    const url = `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(url, "_blank", "noopener,noreferrer");
    APP.analytics.track("share_whatsapp", { plate, estado });
  },

  /** Genera URL de búsqueda directa para compartir */
  getSearchURL(plate) {
    return `${window.location.origin}${window.location.pathname}?q=${encodeURIComponent(plate)}`;
  },
};

// ============================================================
//  CONTACT — manejo del botón de contacto
// ============================================================
APP.contact = {

  open(contacto, plate) {
    if (!contacto || contacto === "Sin especificar") {
      APP.ui.toast("Esta publicación no tiene contacto disponible.", "warning");
      return;
    }

    const isEmail = contacto.includes("@");
    const isPhone = /^[\d\s\-\+\(\)]{7,}$/.test(contacto);

    if (isEmail) {
      const subj = encodeURIComponent(`Patente ${plate} — Patentes Perdidas`);
      const body = encodeURIComponent(`Hola, vi tu publicación sobre la patente *${plate}* en Patentes Perdidas.\n\nMe gustaría ponerme en contacto.`);
      window.open(`mailto:${contacto}?subject=${subj}&body=${body}`, "_blank");
    } else if (isPhone) {
      const clean = contacto.replace(/[\s\-\(\)]/g, "");
      const msg   = encodeURIComponent(`Hola, vi tu publicación sobre la patente *${plate}* en Patentes Perdidas. ¿Podemos coordinar?`);
      window.open(`https://wa.me/${clean}?text=${msg}`, "_blank", "noopener,noreferrer");
    } else {
      // Mostrar contacto con opción de copiar
      const confirmMsg = `Contacto: ${contacto}\n\n¿Copiar al portapapeles?`;
      if (confirm(confirmMsg)) {
        navigator.clipboard?.writeText(contacto)
          .then(() => APP.ui.toast("Contacto copiado.", "success"))
          .catch(()  => prompt("Copiá este dato:", contacto));
      }
    }
    APP.analytics.track("contact", { plate });
  },
};

// ============================================================
//  CITY — selector multi-ciudad
// ============================================================
APP.city = {

  init() {
    const cityInput = document.getElementById("inputCiudad");
    const cityKey   = APP.state.activeCity;
    if (cityInput) {
      cityInput.value = APP.config.CITIES[cityKey]?.name || "Santa Fe";
    }

    // Leer query param ?q= para búsqueda directa
    const params = new URLSearchParams(window.location.search);
    const q = params.get("q");
    if (q) {
      const searchInput = document.getElementById("searchInput");
      if (searchInput) {
        searchInput.value = q;
        APP.state.searchQuery = q;
      }
    }
  },

  change(cityKey) {
    APP.state.activeCity = cityKey;
    const city = APP.config.CITIES[cityKey];
    if (!city) return;

    document.getElementById("heroCityName").textContent = city.name;

    const cityInput = document.getElementById("inputCiudad");
    if (cityInput) cityInput.value = city.name;

    APP.map.updateCity(cityKey);
    APP.render.cards();
    APP.ui.toast(`📍 Ciudad cambiada a ${city.name}`, "success");
  },
};

// ============================================================
//  ANALYTICS — capa de datos para reporting
// ============================================================
APP.analytics = {

  /**
   * Estructura de analytics exportable a Power BI / dashboards.
   *
   * MONETIZACIÓN: Esta capa puede venderse como servicio a
   * municipios o aseguradoras para análisis urbano.
   */

  init() {
    const raw  = localStorage.getItem(APP.config.ANALYTICS_KEY);
    this._data = raw ? JSON.parse(raw) : this._empty();
  },

  _empty() {
    return {
      sessions:   0,
      publishes:  0,
      matches:    0,
      resolves:   0,
      searches:   0,
      shares:     0,
      contacts:   0,
      events:     [],
      startDate:  new Date().toISOString(),
    };
  },

  update() {
    const total    = APP.state.records.length;
    const matches  = APP.state.matchedPlates.size;
    const resolved = APP.state.records.filter(r => r.resuelto === "true" || r.estado === "Resuelta").length;

    APP.ui.animateCount("statTotal",    total);
    APP.ui.animateCount("statMatches",  matches);
    APP.ui.animateCount("statResolved", resolved);
  },

  track(event, data = {}) {
    if (!this._data) return;
    const entry = { event, data, timestamp: new Date().toISOString() };
    this._data.events.push(entry);
    if (this._data.events.length > 200) this._data.events.shift(); // limitar

    const counterMap = {
      publish:         "publishes",
      resolve:         "resolves",
      search:          "searches",
      share_whatsapp:  "shares",
      contact:         "contacts",
    };
    if (counterMap[event]) this._data[counterMap[event]]++;
    this._save();
  },

  _save() {
    try { localStorage.setItem(APP.config.ANALYTICS_KEY, JSON.stringify(this._data)); } catch {}
  },

  /**
   * Exporta datos para Power BI o cualquier herramienta externa.
   * Llamar desde consola: APP.analytics.export()
   */
  export() {
    const output = {
      metadata: { exportedAt: new Date().toISOString(), version: "2.0" },
      analytics: this._data,
      records: APP.state.records.map(r => ({
        id:      r.id,
        patente: r.patente,
        estado:  r.estado,
        ciudad:  r.ciudad,
        zona:    r.zona,
        fecha:   r.fecha,
        lat:     r.lat,
        lng:     r.lng,
        resuelto: r.resuelto,
        // ⚠️ NO exportar contacto por privacidad
      })),
    };
    console.log("[Analytics Export]", JSON.stringify(output, null, 2));
    return output;
  },
};

// ============================================================
//  UI — utilidades de interfaz
// ============================================================
APP.ui = {

  showLoading(show) {
    const loading = document.getElementById("loadingState");
    const grid    = document.getElementById("cardGrid");
    if (!loading) return;
    loading.style.display = show ? "flex" : "none";
    if (grid) grid.style.display = show ? "none" : "";
  },

  toggleEl(id, show) {
    const el = document.getElementById(id);
    if (!el) return;
    if (show) el.classList.remove("hidden");
    else      el.classList.add("hidden");
  },

  showFieldError(inputId, errorId, msg) {
    document.getElementById(inputId)?.classList.add("has-error");
    const err = document.getElementById(errorId);
    if (err) err.textContent = msg;
  },

  clearFieldError(inputId, errorId) {
    document.getElementById(inputId)?.classList.remove("has-error");
    const err = document.getElementById(errorId);
    if (err) err.textContent = "";
  },

  clearAllErrors() {
    ["inputPatente","inputEstado","inputContacto"].forEach(id =>
      document.getElementById(id)?.classList.remove("has-error"));
    ["patenteError","estadoError","contactoError"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = "";
    });
  },

  setButtonLoading(btn, isLoading) {
    if (!btn) return;
    btn.disabled = isLoading;
    btn.classList.toggle("loading", isLoading);
  },

  /** Toast notifications */
  toast(msg, type = "success") {
    let container = document.getElementById("toastContainer");
    if (!container) {
      container = document.createElement("div");
      container.id = "toastContainer";
      Object.assign(container.style, {
        position:"fixed", bottom:"24px", right:"20px", zIndex:"9999",
        display:"flex", flexDirection:"column", gap:"10px", maxWidth:"340px",
      });
      document.body.appendChild(container);
    }

    const colors = {
      success: { bg:"#f0faf4", border:"#27ae60", text:"#1a5c35" },
      error:   { bg:"#fdf2f0", border:"#e74c3c", text:"#7b1c12" },
      warning: { bg:"#fdf8ee", border:"#c9a84c", text:"#7a5c10" },
    };
    const c = colors[type] || colors.success;
    const toast = document.createElement("div");
    Object.assign(toast.style, {
      background:c.bg, border:`1.5px solid ${c.border}`, color:c.text,
      padding:"13px 16px", borderRadius:"12px", fontSize:"14px",
      fontWeight:"500", fontFamily:"var(--font-body,sans-serif)",
      boxShadow:"0 4px 20px rgba(0,0,0,.12)", animation:"fadeInUp .3s ease forwards",
      lineHeight:"1.5", maxWidth:"320px",
    });
    toast.textContent = msg;
    toast.setAttribute("role", "status");
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transition = "opacity .3s ease";
      setTimeout(() => toast.remove(), 300);
    }, 4500);
  },

  animateCount(id, target) {
    const el = document.getElementById(id);
    if (!el) return;
    const start    = performance.now();
    const duration = 700;
    function step(now) {
      const p = Math.min((now - start) / duration, 1);
      const e = 1 - Math.pow(1 - p, 3); // easeOutCubic
      el.textContent = Math.round(target * e);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  },

  maskContact(contacto) {
    if (!contacto) return "Sin contacto";
    if (contacto.includes("@")) {
      const [local, domain] = contacto.split("@");
      return `${local.slice(0,3)}***@${domain}`;
    }
    const digits = contacto.replace(/\D/g, "");
    return digits.length >= 4 ? `●●●● ${digits.slice(-4)}` : "****";
  },

  formatDate(date) {
    return new Intl.DateTimeFormat("es-AR", {
      day:"2-digit", month:"2-digit", year:"numeric",
      hour:"2-digit", minute:"2-digit",
    }).format(date);
  },

  generateId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`;
  },

  esc(str) {
    const map = { "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" };
    return (str || "").replace(/[&<>"']/g, m => map[m]);
  },

  closeBanner()  { APP.ui.toggleEl("matchBanner", false); },

  toggleGuide() {
    const btn  = document.getElementById("guideToggleBtn");
    const cont = document.getElementById("guideContent");
    const open = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", String(!open));
    cont.classList.toggle("hidden", open);
  },

  scrollTo(id) {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  },

  toggleMobileMenu() {
    const menu = document.getElementById("mobileMenu");
    const btn  = document.getElementById("hamburgerBtn");
    const open = !menu.classList.contains("hidden");
    menu.classList.toggle("hidden", open);
    btn.setAttribute("aria-expanded", String(!open));
  },
};

// ============================================================
//  EXPOSE GLOBALS (para onclick inline en HTML)
// ============================================================
window.APP = APP;
