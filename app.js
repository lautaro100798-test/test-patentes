/**
 * ============================================================
 *  PATENTES PERDIDAS SANTA FE — app.js
 *  Lógica principal: formulario, matching, búsqueda, CRUD
 *  Autor: LAE Strategy
 * ============================================================
 *
 *  CONFIGURACIÓN RÁPIDA:
 *  1. Desplegá el Apps Script de Google Sheets como Web App
 *  2. Reemplazá la URL en SHEETS_API_URL
 *  3. Cambiá USE_LOCAL_STORAGE a false para usar Sheets real
 */

// ============================================================
//  CONFIGURACIÓN
// ============================================================

/**
 * URL del endpoint Google Apps Script.
 * Reemplazá con la URL real después de desplegar.
 * Ejemplo: "https://script.google.com/macros/s/AKfyc.../exec"
 */
const SHEETS_API_URL = "TU_URL_DE_APPS_SCRIPT_AQUÍ";

/**
 * Modo de almacenamiento:
 * - true  → usa localStorage (demo / sin backend)
 * - false → usa Google Sheets como backend real
 */
const USE_LOCAL_STORAGE = true;

/**
 * Clave en localStorage para persistir datos localmente.
 */
const LOCAL_KEY = "patentes_sf_data";

// ============================================================
//  ESTADO GLOBAL
// ============================================================

/** @type {Array<{patente: string, estado: string, zona: string, contacto: string, fecha: string, id: string}>} */
let allRecords = [];

/** Texto de búsqueda activo */
let searchQuery = "";

/** Filtro de estado activo: "all" | "Perdida" | "Encontrada" */
let activeFilter = "all";

/** IDs de patentes que hacen match */
let matchedPlates = new Set();

// ============================================================
//  INICIALIZACIÓN
// ============================================================

document.addEventListener("DOMContentLoaded", () => {
  initForm();
  initSearch();
  initFilters();
  loadData();
});

// ============================================================
//  CARGA DE DATOS
// ============================================================

/**
 * Carga los registros desde el backend configurado.
 * Si USE_LOCAL_STORAGE=true, lee de localStorage.
 * Si USE_LOCAL_STORAGE=false, hace GET al Apps Script.
 */
async function loadData() {
  showLoading(true);

  try {
    if (USE_LOCAL_STORAGE) {
      // Modo demo: leer de localStorage
      const raw = localStorage.getItem(LOCAL_KEY);
      allRecords = raw ? JSON.parse(raw) : getSampleData();
    } else {
      // Modo real: fetch a Google Sheets
      const resp = await fetch(SHEETS_API_URL, { method: "GET" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      if (!json.ok) throw new Error(json.error || "Error del servidor");
      allRecords = json.data.map(normalizeRecord);
    }
  } catch (err) {
    console.error("Error cargando datos:", err);
    allRecords = getSampleData();
    showNotification("⚠️ Usando datos de demo. Configurá el backend para producción.", "warning");
  }

  updateStats();
  detectMatches();
  renderCards();
  showLoading(false);
}

/**
 * Persiste los registros en localStorage (modo demo).
 */
function saveLocal() {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(allRecords));
}

/**
 * Envía un nuevo registro al backend.
 * @param {{ patente: string, estado: string, zona: string, contacto: string, fecha: string }} record
 */
async function saveRecord(record) {
  if (USE_LOCAL_STORAGE) {
    allRecords.unshift(record);
    saveLocal();
    return { ok: true };
  }

  // POST a Google Apps Script
  const resp = await fetch(SHEETS_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(record),
  });
  const json = await resp.json();
  if (json.ok) allRecords.unshift(record);
  return json;
}

// ============================================================
//  FORMULARIO
// ============================================================

function initForm() {
  const form = document.getElementById("patenteForm");
  if (!form) return;

  // Normalizar patente en tiempo real: mayúsculas, sin espacios
  const inputPatente = document.getElementById("inputPatente");
  inputPatente.addEventListener("input", () => {
    inputPatente.value = normalizePatente(inputPatente.value);
    clearFieldError("inputPatente", "patenteError");
  });

  form.addEventListener("submit", handleFormSubmit);
}

/**
 * Handler del submit del formulario.
 * @param {SubmitEvent} e
 */
async function handleFormSubmit(e) {
  e.preventDefault();

  if (!validateForm()) return;

  const btn = document.getElementById("submitBtn");
  setButtonLoading(btn, true);

  const record = {
    id:       generateId(),
    patente:  normalizePatente(document.getElementById("inputPatente").value),
    estado:   document.getElementById("inputEstado").value,
    zona:     document.getElementById("inputZona").value.trim() || "Sin especificar",
    contacto: document.getElementById("inputContacto").value.trim(),
    fecha:    formatDate(new Date()),
  };

  try {
    const result = await saveRecord(record);

    if (result.ok) {
      updateStats();
      detectMatches();
      renderCards();

      // Mostrar mensaje de éxito con info de matching
      const matchMsg = getMatchMessageForRecord(record);
      document.getElementById("successMatchText").textContent = matchMsg;
      document.getElementById("patenteForm").classList.add("hidden");
      document.getElementById("successMsg").classList.remove("hidden");
    } else {
      showNotification("Error al guardar. Intentá de nuevo.", "error");
    }
  } catch (err) {
    console.error("Error guardando:", err);
    showNotification("Error de conexión. Intentá de nuevo.", "error");
  } finally {
    setButtonLoading(btn, false);
  }
}

/**
 * Valida el formulario y muestra errores inline.
 * @returns {boolean}
 */
function validateForm() {
  let isValid = true;

  const patente  = document.getElementById("inputPatente").value.trim();
  const estado   = document.getElementById("inputEstado").value;
  const contacto = document.getElementById("inputContacto").value.trim();

  // Patente
  if (!patente) {
    showFieldError("inputPatente", "patenteError", "El número de patente es obligatorio.");
    isValid = false;
  } else if (patente.length < 6) {
    showFieldError("inputPatente", "patenteError", "La patente debe tener al menos 6 caracteres.");
    isValid = false;
  }

  // Estado
  if (!estado) {
    showFieldError("inputEstado", "estadoError", "Seleccioná un estado.");
    isValid = false;
  }

  // Contacto
  if (!contacto) {
    showFieldError("inputContacto", "contactoError", "Ingresá un email o teléfono de contacto.");
    isValid = false;
  }

  return isValid;
}

/**
 * Resetea el formulario y vuelve al estado inicial.
 */
function resetForm() {
  document.getElementById("patenteForm").reset();
  document.getElementById("patenteForm").classList.remove("hidden");
  document.getElementById("successMsg").classList.add("hidden");
  clearAllErrors();
}

// ============================================================
//  MATCHING AUTOMÁTICO
// ============================================================

/**
 * Detecta pares de patentes donde una está como "Perdida"
 * y otra idéntica como "Encontrada".
 * Actualiza `matchedPlates` y controla los banners de alerta.
 */
function detectMatches() {
  const perdidas   = new Set();
  const encontradas = new Set();

  allRecords.forEach(r => {
    const plate = normalizePatente(r.patente);
    if (r.estado === "Perdida")    perdidas.add(plate);
    if (r.estado === "Encontrada") encontradas.add(plate);
  });

  matchedPlates.clear();
  perdidas.forEach(plate => {
    if (encontradas.has(plate)) matchedPlates.add(plate);
  });

  // Actualizar contador de coincidencias en las estadísticas
  document.getElementById("statMatches").textContent = matchedPlates.size;

  // Mostrar / ocultar banners de alerta
  const hasMatches = matchedPlates.size > 0;
  toggleElement("matchAlert", hasMatches);
  toggleElement("matchBanner", hasMatches);
}

/**
 * Retorna un mensaje personalizado según si el nuevo registro tiene match.
 * @param {{ patente: string, estado: string }} record
 * @returns {string}
 */
function getMatchMessageForRecord(record) {
  const plate = normalizePatente(record.patente);
  if (matchedPlates.has(plate)) {
    const opposite = record.estado === "Perdida" ? "encontrada" : "buscada por su dueño";
    return `¡Hay una patente ${plate} ${opposite}! Revisá las tarjetas resaltadas y contactate.`;
  }
  return `Tu publicación quedó activa. Si alguien reporta la misma patente, te verás aquí.`;
}

// ============================================================
//  RENDERIZADO DE TARJETAS
// ============================================================

/**
 * Filtra y renderiza las tarjetas según búsqueda y filtro activo.
 */
function renderCards() {
  const grid  = document.getElementById("cardGrid");
  const empty = document.getElementById("emptyState");

  const filtered = getFilteredRecords();

  if (filtered.length === 0) {
    grid.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");

  grid.innerHTML = filtered
    .map((r, index) => buildCardHTML(r, index))
    .join("");
}

/**
 * Aplica búsqueda y filtros al array de registros.
 * @returns {Array}
 */
function getFilteredRecords() {
  return allRecords.filter(r => {
    const plate = normalizePatente(r.patente);
    const query = normalizePatente(searchQuery);

    const matchesSearch = !query || plate.includes(query);
    const matchesFilter = activeFilter === "all" || r.estado === activeFilter;

    return matchesSearch && matchesFilter;
  });
}

/**
 * Construye el HTML de una tarjeta de patente.
 * @param {Object} record
 * @param {number} index - Para el delay de animación
 * @returns {string}
 */
function buildCardHTML(record, index) {
  const plate      = normalizePatente(record.patente);
  const isMatch    = matchedPlates.has(plate);
  const isLost     = record.estado === "Perdida";
  const badgeClass = isLost ? "patente-card__badge--perdida" : "patente-card__badge--encontrada";
  const badgeIcon  = isLost ? "🔴" : "🟢";
  const matchClass = isMatch ? "is-match" : "";

  // Delay escalonado para animación
  const delayStyle = `animation-delay: ${index * 60}ms;`;

  // Ocultar contacto parcialmente para privacidad
  const contactDisplay = maskContact(record.contacto);

  return `
    <article
      class="patente-card ${matchClass}"
      data-estado="${escapeHTML(record.estado)}"
      data-plate="${escapeHTML(plate)}"
      style="${delayStyle}"
      aria-label="Patente ${escapeHTML(plate)}, estado: ${escapeHTML(record.estado)}"
    >
      <div class="patente-card__plate">${escapeHTML(plate)}</div>

      <span class="patente-card__badge ${badgeClass}">
        ${badgeIcon} ${escapeHTML(record.estado)}
      </span>

      <div class="patente-card__meta">
        <div class="patente-card__meta-item">
          <span class="patente-card__meta-icon" aria-hidden="true">📍</span>
          <span>${escapeHTML(record.zona)}</span>
        </div>
        <div class="patente-card__meta-item">
          <span class="patente-card__meta-icon" aria-hidden="true">📅</span>
          <span>${escapeHTML(record.fecha)}</span>
        </div>
      </div>

      <div class="patente-card__footer">
        <span style="font-size:12px; color:var(--text-muted);">${escapeHTML(contactDisplay)}</span>
        <button
          class="btn--contact"
          onclick="handleContact('${escapeHTML(record.contacto)}', '${escapeHTML(plate)}')"
          aria-label="Contactar sobre patente ${escapeHTML(plate)}"
        >
          Contactar
        </button>
      </div>
    </article>
  `;
}

// ============================================================
//  BÚSQUEDA Y FILTROS
// ============================================================

function initSearch() {
  const input = document.getElementById("searchInput");
  if (!input) return;

  // Debounce para no re-renderizar en cada tecla
  let debounceTimer;
  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      searchQuery = input.value;
      renderCards();
    }, 200);
  });
}

function initFilters() {
  const tabs = document.querySelectorAll(".filter-tab");
  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      tabs.forEach(t => {
        t.classList.remove("active");
        t.setAttribute("aria-selected", "false");
      });
      tab.classList.add("active");
      tab.setAttribute("aria-selected", "true");
      activeFilter = tab.dataset.filter;
      renderCards();
    });
  });
}

// ============================================================
//  INTERACCIONES DE UI
// ============================================================

/**
 * Maneja el botón de contacto de una tarjeta.
 * Detecta si es email o teléfono y abre el canal correcto.
 * @param {string} contacto
 * @param {string} plate
 */
function handleContact(contacto, plate) {
  if (!contacto || contacto === "Sin especificar") {
    alert("Esta publicación no tiene datos de contacto disponibles.");
    return;
  }

  const isEmail = contacto.includes("@");
  const isPhone = /^\+?[\d\s\-()]{7,}$/.test(contacto.replace(/\s/g, ""));

  if (isEmail) {
    const subject = encodeURIComponent(`Patente ${plate} - Patentes Perdidas Santa Fe`);
    const body    = encodeURIComponent(`Hola, encontré tu publicación sobre la patente ${plate} en Patentes Perdidas Santa Fe. Me gustaría ponerme en contacto.`);
    window.open(`mailto:${contacto}?subject=${subject}&body=${body}`, "_blank");
  } else if (isPhone) {
    const cleaned = contacto.replace(/[\s\-()]/g, "");
    const msg     = encodeURIComponent(`Hola, vi tu publicación sobre la patente ${plate} en Patentes Perdidas Santa Fe.`);
    // Detectar mobile para abrir WhatsApp
    const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
    if (isMobile) {
      window.open(`https://wa.me/${cleaned}?text=${msg}`, "_blank");
    } else {
      window.open(`https://wa.me/${cleaned}?text=${msg}`, "_blank");
    }
  } else {
    // Mostrar el contacto en un popup simple
    const result = confirm(`Contacto: ${contacto}\n\n¿Querés copiar este dato?`);
    if (result) {
      navigator.clipboard?.writeText(contacto).then(() => {
        showNotification("Contacto copiado al portapapeles.", "success");
      }).catch(() => {
        prompt("Copiá este contacto:", contacto);
      });
    }
  }
}

/**
 * Cierra el banner de coincidencia superior.
 */
function closeBanner() {
  toggleElement("matchBanner", false);
}

/**
 * Alterna la visibilidad de la guía de integración.
 */
function toggleGuide() {
  const btn     = document.querySelector(".guide-toggle");
  const content = document.getElementById("guideContent");
  const isOpen  = btn.getAttribute("aria-expanded") === "true";

  btn.setAttribute("aria-expanded", String(!isOpen));
  content.classList.toggle("hidden", isOpen);
}

// ============================================================
//  ESTADÍSTICAS
// ============================================================

/**
 * Actualiza los contadores del hero con animación de conteo.
 */
function updateStats() {
  animateCount("statTotal",   allRecords.length);
  animateCount("statMatches", matchedPlates.size);

  // "Recuperadas" = patentes que tienen coincidencia (ambos estados)
  animateCount("statFound", matchedPlates.size);
}

/**
 * Anima un contador numérico desde 0 hasta el valor final.
 * @param {string} elementId
 * @param {number} target
 */
function animateCount(elementId, target) {
  const el = document.getElementById(elementId);
  if (!el) return;

  const current = parseInt(el.textContent) || 0;
  if (current === target) return;

  const duration = 600;
  const start    = performance.now();
  const startVal = 0;

  function step(now) {
    const elapsed  = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased    = 1 - Math.pow(1 - progress, 3); // easeOutCubic
    el.textContent = Math.round(startVal + (target - startVal) * eased);
    if (progress < 1) requestAnimationFrame(step);
  }

  requestAnimationFrame(step);
}

// ============================================================
//  ESTADO DE UI HELPERS
// ============================================================

function showLoading(show) {
  const loading = document.getElementById("loadingState");
  const grid    = document.getElementById("cardGrid");
  if (!loading) return;

  if (show) {
    loading.style.display = "flex";
    if (grid) grid.style.display = "none";
  } else {
    loading.style.display = "none";
    if (grid) grid.style.display = "";
  }
}

function showFieldError(inputId, errorId, msg) {
  const input = document.getElementById(inputId);
  const error = document.getElementById(errorId);
  if (input) input.classList.add("has-error");
  if (error) error.textContent = msg;
}

function clearFieldError(inputId, errorId) {
  const input = document.getElementById(inputId);
  const error = document.getElementById(errorId);
  if (input) input.classList.remove("has-error");
  if (error) error.textContent = "";
}

function clearAllErrors() {
  ["inputPatente", "inputEstado", "inputContacto"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove("has-error");
  });
  ["patenteError", "estadoError", "contactoError"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = "";
  });
}

function setButtonLoading(btn, isLoading) {
  if (!btn) return;
  btn.disabled = isLoading;
  if (isLoading) btn.classList.add("loading");
  else           btn.classList.remove("loading");
}

function toggleElement(id, show) {
  const el = document.getElementById(id);
  if (!el) return;
  if (show) el.classList.remove("hidden");
  else      el.classList.add("hidden");
}

/**
 * Muestra una notificación toast temporal.
 * @param {string} msg
 * @param {"success"|"error"|"warning"} type
 */
function showNotification(msg, type = "success") {
  // Crear toast si no existe el contenedor
  let container = document.getElementById("toastContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "toastContainer";
    Object.assign(container.style, {
      position:  "fixed",
      bottom:    "24px",
      right:     "20px",
      zIndex:    "9999",
      display:   "flex",
      flexDirection: "column",
      gap:       "10px",
      maxWidth:  "340px",
    });
    document.body.appendChild(container);
  }

  const colors = {
    success: { bg: "#f0faf4", border: "#27ae60", text: "#1a5c35" },
    error:   { bg: "#fdf2f0", border: "#e74c3c", text: "#7b1c12" },
    warning: { bg: "#fdf8ee", border: "#c9a84c", text: "#7a5c10" },
  };
  const c = colors[type] || colors.success;

  const toast = document.createElement("div");
  Object.assign(toast.style, {
    background:   c.bg,
    border:       `1.5px solid ${c.border}`,
    color:        c.text,
    padding:      "14px 18px",
    borderRadius: "12px",
    fontSize:     "14px",
    fontWeight:   "500",
    fontFamily:   "var(--font-body, sans-serif)",
    boxShadow:    "0 4px 20px rgba(0,0,0,0.12)",
    animation:    "fadeInUp 0.3s ease forwards",
    lineHeight:   "1.5",
  });
  toast.textContent = msg;
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");

  container.appendChild(toast);

  // Auto-remover después de 4 segundos
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.3s ease";
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ============================================================
//  UTILIDADES
// ============================================================

/**
 * Normaliza una patente: mayúsculas, sin espacios ni guiones.
 * @param {string} value
 * @returns {string}
 */
function normalizePatente(value) {
  return (value || "")
    .toUpperCase()
    .replace(/[\s\-_]/g, "")
    .trim();
}

/**
 * Normaliza un registro recibido del backend.
 * @param {Object} raw
 * @returns {Object}
 */
function normalizeRecord(raw) {
  return {
    id:       raw.id       || generateId(),
    patente:  normalizePatente(raw.patente  || ""),
    estado:   (raw.estado  || "").trim(),
    zona:     (raw.zona    || "Sin especificar").trim(),
    contacto: (raw.contacto|| "").trim(),
    fecha:    (raw.fecha   || formatDate(new Date())).toString(),
  };
}

/**
 * Oculta parcialmente el dato de contacto para privacidad.
 * @param {string} contacto
 * @returns {string}
 */
function maskContact(contacto) {
  if (!contacto) return "Sin contacto";
  if (contacto.includes("@")) {
    const [local, domain] = contacto.split("@");
    const masked = local.slice(0, 3) + "***";
    return `${masked}@${domain}`;
  }
  // Teléfono: mostrar últimos 4 dígitos
  const digits = contacto.replace(/\D/g, "");
  if (digits.length >= 4) {
    return `●●●● ${digits.slice(-4)}`;
  }
  return "****";
}

/**
 * Formatea una fecha como string legible en español.
 * @param {Date} date
 * @returns {string}
 */
function formatDate(date) {
  return new Intl.DateTimeFormat("es-AR", {
    day:   "2-digit",
    month: "2-digit",
    year:  "numeric",
    hour:  "2-digit",
    minute:"2-digit",
  }).format(date);
}

/**
 * Genera un ID único simple.
 * @returns {string}
 */
function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Escapa caracteres HTML para prevenir XSS.
 * @param {string} str
 * @returns {string}
 */
function escapeHTML(str) {
  const map = { "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" };
  return (str || "").replace(/[&<>"']/g, m => map[m]);
}

// ============================================================
//  DATOS DE DEMO (se usan cuando no hay backend ni localStorage)
// ============================================================

/**
 * Retorna un conjunto de registros de ejemplo para demostración.
 * Incluye deliberadamente un par con coincidencia (ABC123).
 * @returns {Array}
 */
function getSampleData() {
  return [
    {
      id:       "demo-1",
      patente:  "ABC123",
      estado:   "Perdida",
      zona:     "Centro",
      contacto: "carlos@ejemplo.com",
      fecha:    "22/03/2025, 09:30",
    },
    {
      id:       "demo-2",
      patente:  "ABC123",
      estado:   "Encontrada",
      zona:     "Sur",
      contacto: "maria@ejemplo.com",
      fecha:    "22/03/2025, 10:15",
    },
    {
      id:       "demo-3",
      patente:  "XY456GH",
      estado:   "Perdida",
      zona:     "Guadalupe",
      contacto: "3424456789",
      fecha:    "21/03/2025, 14:00",
    },
    {
      id:       "demo-4",
      patente:  "MNO789",
      estado:   "Encontrada",
      zona:     "Norte",
      contacto: "info@ejemplo.com",
      fecha:    "21/03/2025, 11:20",
    },
    {
      id:       "demo-5",
      patente:  "JKL321",
      estado:   "Perdida",
      zona:     "Oeste",
      contacto: "3423321100",
      fecha:    "20/03/2025, 16:45",
    },
  ];
}

// ============================================================
//  EXPOSE GLOBALS (usados en onclick del HTML)
// ============================================================

window.handleContact = handleContact;
window.closeBanner   = closeBanner;
window.toggleGuide   = toggleGuide;
window.resetForm     = resetForm;
