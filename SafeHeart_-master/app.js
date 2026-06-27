// ========== SAFEHEART APP - EMERGENCIAS ADULTOS MAYORES ==========

// Constantes de almacenamiento
const STORAGE_KEY = 'safeheart_contacts';
const MESSAGE_KEY = 'safeheart_message';
const CHANNELS_KEY = 'safeheart_channels';
const TRACKING_KEY = 'safeheart_tracking';
const DEFAULT_MESSAGE = 'EMERGENCIA! Adulto mayor necesita ayuda urgente. Hora: {TIME} | Pulsaciones: {BPM} bpm | Bateria: {BATTERY}% | Ubicacion: {LOCATION}';

// Estado de la aplicacion
let contacts = [];
let emergencyMessage = DEFAULT_MESSAGE;
let appIsActivated = false;
let appProgress = 0;
let appHoldTimer = null;
let appProgressInterval = null;
let trackingInterval = null;
let trackingHistory = [];
let map = null;
let userMarker = null;
let trackingPath = null;

// Canales de alerta
let alertChannels = {
  sms: true,
  whatsapp: false,
  email: false,
  push: false
};

// ========== INICIALIZACION ==========
function initApp() {
  contacts = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  emergencyMessage = localStorage.getItem(MESSAGE_KEY) || DEFAULT_MESSAGE;
  alertChannels = JSON.parse(localStorage.getItem(CHANNELS_KEY) || JSON.stringify(alertChannels));
  trackingHistory = JSON.parse(localStorage.getItem(TRACKING_KEY) || '[]');
  
  setupNavigation();
  renderContacts();
  renderEmergencyTab();
  renderSettings();
  renderChannels();
  updateContactsBadge();
  initMap();
  initPWA();
  initPushNotifications();
  setupFloatingSOS();
}

// ========== NAVEGACION ==========
function setupNavigation() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      const tabElement = document.getElementById('tab-' + tab);
      if (tabElement) tabElement.classList.add('active');
    });
  });
}

// ========== MENSAJE INTELIGENTE ==========
async function buildSmartMessage(location) {
  const now = new Date();
  const timeStr = now.toLocaleString('es-AR', { 
    hour: '2-digit', 
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
  
  // Obtener nivel de bateria
  let batteryLevel = 'N/A';
  try {
    if (navigator.getBattery) {
      const battery = await navigator.getBattery();
      batteryLevel = Math.round(battery.level * 100);
    }
  } catch (e) {
    batteryLevel = 'N/A';
  }
  
  // Construir URL de Google Maps
  let locationInfo = 'Ubicacion no disponible';
  let mapsUrl = '';
  if (location && location.lat && location.lon) {
    mapsUrl = `https://maps.google.com/?q=${location.lat},${location.lon}`;
    locationInfo = mapsUrl;
  }
  
  // Obtener BPM simulado (en hardware real vendría del sensor)
  const bpmEl = document.getElementById('app-bpm-value');
  const bpmValue = bpmEl ? bpmEl.textContent : '72';
  
  // Reemplazar placeholders en el mensaje
  let message = emergencyMessage
    .replace('{TIME}', timeStr)
    .replace('{BATTERY}', batteryLevel)
    .replace('{BPM}', bpmValue)
    .replace('{LOCATION}', locationInfo);
  
  return { message, mapsUrl, timeStr, batteryLevel };
}

// ========== TRACKING EN TIEMPO REAL ==========
function startTracking() {
  if (trackingInterval) return;
  
  const statusEl = document.getElementById('tracking-status');
  if (statusEl) {
    statusEl.classList.remove('inactive');
    statusEl.innerHTML = '<span class="tracking-dot"></span> Rastreo activo - Enviando ubicacion cada 10s';
  }
  
  // Enviar ubicacion cada 10 segundos por 3 minutos
  let trackingDuration = 0;
  const maxDuration = 180000; // 3 minutos
  
  trackingInterval = setInterval(async () => {
    trackingDuration += 10000;
    
    if (trackingDuration >= maxDuration) {
      stopTracking();
      return;
    }
    
    try {
      const position = await getCurrentPosition();
      const trackingPoint = {
        lat: position.coords.latitude,
        lon: position.coords.longitude,
        timestamp: new Date().toISOString(),
        accuracy: position.coords.accuracy
      };
      
      trackingHistory.push(trackingPoint);
      localStorage.setItem(TRACKING_KEY, JSON.stringify(trackingHistory.slice(-50))); // Mantener ultimos 50 puntos
      
      // Actualizar mapa
      updateMapPosition(trackingPoint);
      
      // Enviar al backend
      await sendTrackingPoint(trackingPoint);
      
      // Actualizar historial visual
      renderLocationHistory();
      
    } catch (e) {
      console.error('Error obteniendo ubicacion:', e);
    }
  }, 10000); // Cada 10 segundos
}

function stopTracking() {
  if (trackingInterval) {
    clearInterval(trackingInterval);
    trackingInterval = null;
  }
  
  const statusEl = document.getElementById('tracking-status');
  if (statusEl) {
    statusEl.classList.add('inactive');
    statusEl.innerHTML = '<span class="tracking-dot"></span> Rastreo inactivo';
  }
}

async function sendTrackingPoint(point) {
  try {
    await fetch('/api/tracking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(point)
    });
  } catch (e) {
    console.error('Error enviando punto de tracking:', e);
  }
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0
    });
  });
}

// ========== MAPA EN VIVO ==========
function initMap() {
  const mapContainer = document.getElementById('live-map');
  if (!mapContainer) return;
  
  // Usar Leaflet para el mapa
  if (typeof L !== 'undefined') {
    map = L.map('live-map').setView([-34.6037, -58.3816], 13); // Buenos Aires por defecto
    
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap'
    }).addTo(map);
    
    // Intentar obtener ubicacion actual
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        map.setView([lat, lon], 15);
        
        userMarker = L.marker([lat, lon]).addTo(map)
          .bindPopup('Tu ubicacion actual')
          .openPopup();
        
        // Inicializar path de tracking
        trackingPath = L.polyline([], { color: '#7c3aed', weight: 3 }).addTo(map);
      },
      () => {
        console.log('No se pudo obtener ubicacion inicial');
      }
    );
  } else {
    // Fallback si Leaflet no esta disponible
    mapContainer.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--fg-muted);">Cargando mapa...</div>';
  }
}

function updateMapPosition(point) {
  if (!map || !point) return;
  
  const latlng = [point.lat, point.lon];
  
  // Actualizar marcador
  if (userMarker) {
    userMarker.setLatLng(latlng);
  } else {
    userMarker = L.marker(latlng).addTo(map);
  }
  
  // Actualizar path
  if (trackingPath) {
    trackingPath.addLatLng(latlng);
  }
  
  // Centrar mapa
  map.setView(latlng, map.getZoom());
}

function renderLocationHistory() {
  const historyList = document.getElementById('history-list');
  if (!historyList) return;
  
  const recentHistory = trackingHistory.slice(-10).reverse();
  
  if (recentHistory.length === 0) {
    historyList.innerHTML = '<p style="color:var(--fg-muted);text-align:center;padding:1rem;">Sin historial de ubicaciones</p>';
    return;
  }
  
  historyList.innerHTML = recentHistory.map(point => {
    const time = new Date(point.timestamp).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    return `
      <div class="history-item">
        <span class="time">${time}</span>
        <span class="coords">${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}</span>
      </div>
    `;
  }).join('');
}

// ========== MULTICANAL DE ALERTA ==========
function renderChannels() {
  const container = document.getElementById('channels-list');
  if (!container) return;
  
  container.innerHTML = `
    <div class="channel-card" onclick="toggleChannel('sms')">
      <div class="channel-icon sms">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      </div>
      <div class="channel-info">
        <h3>SMS</h3>
        <p>Mensaje de texto directo</p>
      </div>
      <div class="channel-toggle ${alertChannels.sms ? 'active' : ''}" id="toggle-sms"></div>
    </div>
    
    <div class="channel-card" onclick="toggleChannel('whatsapp')">
      <div class="channel-icon whatsapp">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/></svg>
      </div>
      <div class="channel-info">
        <h3>WhatsApp</h3>
        <p>Mensaje via WhatsApp Web</p>
      </div>
      <div class="channel-toggle ${alertChannels.whatsapp ? 'active' : ''}" id="toggle-whatsapp"></div>
    </div>
    
    <div class="channel-card" onclick="toggleChannel('email')">
      <div class="channel-icon email">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
      </div>
      <div class="channel-info">
        <h3>Email</h3>
        <p>Correo electronico de emergencia</p>
      </div>
      <div class="channel-toggle ${alertChannels.email ? 'active' : ''}" id="toggle-email"></div>
    </div>
    
    <div class="channel-card" onclick="toggleChannel('push')">
      <div class="channel-icon push">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
      </div>
      <div class="channel-info">
        <h3>Notificacion Push</h3>
        <p>Alerta en el navegador</p>
      </div>
      <div class="channel-toggle ${alertChannels.push ? 'active' : ''}" id="toggle-push"></div>
    </div>
  `;
}

function toggleChannel(channel) {
  alertChannels[channel] = !alertChannels[channel];
  localStorage.setItem(CHANNELS_KEY, JSON.stringify(alertChannels));
  renderChannels();
}

// ========== ENVIO DE ALERTAS MULTICANAL ==========
async function sendMultiChannelAlert(location, smartMessage) {
  const promises = [];
  
  // SMS
  if (alertChannels.sms && contacts.length > 0) {
    promises.push(sendSMSAlert(smartMessage.message));
  }
  
  // WhatsApp
  if (alertChannels.whatsapp && contacts.length > 0) {
    promises.push(sendWhatsAppAlert(smartMessage.message));
  }
  
  // Email (via backend)
  if (alertChannels.email) {
    promises.push(sendEmailAlert(smartMessage));
  }
  
  // Push Notification
  if (alertChannels.push) {
    promises.push(sendPushNotification());
  }
  
  await Promise.allSettled(promises);
}

function sendSMSAlert(message) {
  const phones = contacts.map(c => formatPhoneForSMS(c.phone)).join(',');
  const smsUrl = `sms:${phones}?body=${encodeURIComponent(message)}`;
  window.location.href = smsUrl;
  return Promise.resolve();
}

function sendWhatsAppAlert(message) {
  // Enviar a cada contacto via WhatsApp Web
  contacts.forEach((contact, index) => {
    setTimeout(() => {
      const phone = contact.phone.replace(/[^\d+]/g, '');
      const waUrl = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
      window.open(waUrl, '_blank');
    }, index * 500); // Espaciar las ventanas
  });
  return Promise.resolve();
}

async function sendEmailAlert(smartMessage) {
  try {
    await fetch('/api/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contacts: contacts,
        message: smartMessage.message,
        location: smartMessage.mapsUrl,
        time: smartMessage.timeStr
      })
    });
  } catch (e) {
    console.error('Error enviando email:', e);
  }
}

async function sendPushNotification() {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('SafeHeart - EMERGENCIA', {
      body: 'Se ha activado una alerta de emergencia',
      icon: '/logo.png',
      badge: '/logo.png',
      vibrate: [200, 100, 200],
      tag: 'emergency-alert'
    });
  }
}

// ========== NOTIFICACIONES PUSH ==========
async function initPushNotifications() {
  if ('Notification' in window) {
    if (Notification.permission === 'default') {
      // Mostrar boton para solicitar permisos
      const pushBtn = document.getElementById('enable-push-btn');
      if (pushBtn) {
        pushBtn.style.display = 'block';
        pushBtn.onclick = async () => {
          const permission = await Notification.requestPermission();
          if (permission === 'granted') {
            pushBtn.style.display = 'none';
            alertChannels.push = true;
            localStorage.setItem(CHANNELS_KEY, JSON.stringify(alertChannels));
            renderChannels();
          }
        };
      }
    }
  }
}

// ========== BOTON FLOTANTE SOS ==========
function setupFloatingSOS() {
  const floatingBtn = document.getElementById('floating-sos');
  if (!floatingBtn) return;
  
  let floatingHoldTimer = null;
  let floatingProgress = 0;
  
  floatingBtn.onmousedown = floatingBtn.ontouchstart = (e) => {
    e.preventDefault();
    if (appIsActivated || contacts.length === 0) return;
    
    floatingBtn.style.transform = 'scale(0.9)';
    
    floatingHoldTimer = setTimeout(() => {
      activateEmergency();
    }, 2000);
  };
  
  floatingBtn.onmouseup = floatingBtn.onmouseleave = floatingBtn.ontouchend = () => {
    floatingBtn.style.transform = '';
    if (floatingHoldTimer) {
      clearTimeout(floatingHoldTimer);
      floatingHoldTimer = null;
    }
  };
}

// ========== PWA ==========
function initPWA() {
  let deferredPrompt;
  
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    
    const pwaBanner = document.getElementById('pwa-banner');
    if (pwaBanner) {
      pwaBanner.classList.add('show');
      
      const installBtn = document.getElementById('pwa-install-btn');
      if (installBtn) {
        installBtn.onclick = async () => {
          pwaBanner.classList.remove('show');
          deferredPrompt.prompt();
          const { outcome } = await deferredPrompt.userChoice;
          deferredPrompt = null;
        };
      }
      
      const closeBtn = document.getElementById('pwa-close-btn');
      if (closeBtn) {
        closeBtn.onclick = () => {
          pwaBanner.classList.remove('show');
        };
      }
    }
  });
  
  // Registrar Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(err => {
      console.log('Service Worker no registrado:', err);
    });
  }
}

// ========== EMERGENCIA TAB ==========
function renderEmergencyTab() {
  const btn = document.getElementById('app-emergency-btn');
  const warning = document.getElementById('no-contacts-warning');
  const preview = document.getElementById('contacts-preview');
  
  if (!btn) return;
  
  if (contacts.length === 0) {
    if (warning) warning.style.display = 'flex';
    btn.disabled = true;
    btn.classList.remove('pulse-glow');
    if (preview) preview.innerHTML = '';
  } else {
    if (warning) warning.style.display = 'none';
    btn.disabled = false;
    btn.classList.add('pulse-glow');
    
    if (preview) {
      let avatarsHtml = '<span>SMS a:</span><div class="avatars">';
      contacts.slice(0, 4).forEach(c => {
        avatarsHtml += `<div class="avatar">${c.name.charAt(0).toUpperCase()}</div>`;
      });
      if (contacts.length > 4) {
        avatarsHtml += `<div class="avatar more">+${contacts.length - 4}</div>`;
      }
      avatarsHtml += '</div>';
      preview.innerHTML = avatarsHtml;
    }
  }
  
  btn.onmousedown = appStartHold;
  btn.onmouseup = appCancelHold;
  btn.onmouseleave = appCancelHold;
  btn.ontouchstart = appStartHold;
  btn.ontouchend = appCancelHold;
}

function appStartHold(e) {
  e.preventDefault();
  if (appIsActivated || contacts.length === 0) return;
  
  appProgress = 0;
  appProgressInterval = setInterval(() => {
    appProgress += 3.33;
    const progressBar = document.getElementById('app-progress');
    if (progressBar) progressBar.style.width = Math.min(appProgress, 100) + '%';
    if (appProgress >= 100) clearInterval(appProgressInterval);
  }, 100);

  appHoldTimer = setTimeout(() => {
    activateEmergency();
  }, 3000);
}

function appCancelHold() {
  if (!appIsActivated) {
    clearInterval(appProgressInterval);
    clearTimeout(appHoldTimer);
    const progressBar = document.getElementById('app-progress');
    if (progressBar) progressBar.style.width = '0%';
  }
}

async function activateEmergency() {
  playBeep(880, 150);
  setTimeout(() => playBeep(1100, 150), 200);
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  
  appIsActivated = true;
  const btn = document.getElementById('app-emergency-btn');
  const floatingBtn = document.getElementById('floating-sos');
  
  if (btn) {
    btn.classList.add('active');
    btn.classList.remove('pulse-glow');
  }
  if (floatingBtn) floatingBtn.classList.add('active');
  
  const iconPin = document.getElementById('btn-icon-pin');
  const iconCheck = document.getElementById('btn-icon-check');
  const statusTitle = document.getElementById('app-status-title');
  const statusSubtitle = document.getElementById('app-status-subtitle');
  const progressBar = document.getElementById('app-progress');
  
  if (iconPin) iconPin.style.display = 'none';
  if (iconCheck) iconCheck.style.display = 'none';
  if (statusTitle) statusTitle.textContent = 'Obteniendo ubicacion...';
  if (statusSubtitle) statusSubtitle.textContent = 'Emergencia activada';
  if (progressBar) progressBar.classList.add('success');

  // Obtener ubicacion y enviar alertas
  try {
    const position = await getCurrentPosition();
    const location = {
      lat: position.coords.latitude,
      lon: position.coords.longitude
    };
    
    // Construir mensaje inteligente
    const smartMessage = await buildSmartMessage(location);
    
    if (statusTitle) statusTitle.textContent = 'Enviando alertas...';
    
    // Enviar alertas multicanal
    await sendMultiChannelAlert(location, smartMessage);
    
    // Iniciar tracking
    startTracking();
    
    // Guardar emergencia en backend
    await saveEmergencyToBackend(location, smartMessage);
    
    // Mostrar exito
    setTimeout(() => {
      playBeep(523, 100);
      setTimeout(() => playBeep(784, 200), 100);
      if (iconCheck) iconCheck.style.display = 'block';
      if (statusTitle) {
        statusTitle.textContent = 'Alertas Enviadas';
        statusTitle.classList.add('success');
      }
      if (statusSubtitle) statusSubtitle.textContent = 'Rastreo activo por 3 minutos';
    }, 1000);
    
  } catch (error) {
    // Si falla la ubicacion, enviar sin ella
    const smartMessage = await buildSmartMessage(null);
    await sendMultiChannelAlert(null, smartMessage);
    
    if (statusTitle) statusTitle.textContent = 'Alertas enviadas (sin GPS)';
  }

  setTimeout(appReset, 10000);
}

async function saveEmergencyToBackend(location, smartMessage) {
  try {
    await fetch('/api/emergency', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contacts: contacts,
        location: location,
        message: smartMessage.message,
        time: smartMessage.timeStr,
        battery: smartMessage.batteryLevel,
        channels: alertChannels
      })
    });
  } catch (e) {
    console.error('Error guardando emergencia:', e);
  }
}

function appReset() {
  appIsActivated = false;
  appProgress = 0;
  
  const btn = document.getElementById('app-emergency-btn');
  const floatingBtn = document.getElementById('floating-sos');
  
  if (btn) {
    btn.classList.remove('active');
    btn.classList.add('pulse-glow');
  }
  if (floatingBtn) floatingBtn.classList.remove('active');
  
  const iconPin = document.getElementById('btn-icon-pin');
  const iconCheck = document.getElementById('btn-icon-check');
  const statusTitle = document.getElementById('app-status-title');
  const statusSubtitle = document.getElementById('app-status-subtitle');
  const progressBar = document.getElementById('app-progress');
  
  if (iconPin) iconPin.style.display = 'block';
  if (iconCheck) iconCheck.style.display = 'none';
  if (progressBar) {
    progressBar.style.width = '0%';
    progressBar.classList.remove('success');
  }
  if (statusTitle) {
    statusTitle.textContent = 'SafeHeart Listo';
    statusTitle.classList.remove('success');
  }
  if (statusSubtitle) statusSubtitle.textContent = 'Mantene presionado 3 segundos';
}

// ========== CONTACTOS ==========
function renderContacts() {
  const list = document.getElementById('contacts-list');
  const empty = document.getElementById('empty-contacts');
  const count = document.getElementById('contacts-count');
  
  if (count) {
    count.textContent = contacts.length + ' contacto' + (contacts.length !== 1 ? 's' : '') + ' guardado' + (contacts.length !== 1 ? 's' : '');
  }
  
  if (contacts.length === 0) {
    if (list) list.innerHTML = '';
    if (empty) empty.style.display = 'block';
  } else {
    if (empty) empty.style.display = 'none';
    if (list) {
      list.innerHTML = contacts.map(c => `
        <div class="contact-item">
          <div class="contact-avatar">${c.name.charAt(0).toUpperCase()}</div>
          <div class="contact-info">
            <h3>${c.name}</h3>
            <p>${c.phone}</p>
            <span>${c.relationship || 'Contacto'}</span>
          </div>
          <button class="delete-btn" onclick="deleteContact('${c.id}')">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      `).join('');
    }
  }
  
  setupContactForm();
}

function setupContactForm() {
  const form = document.getElementById('contact-form');
  const addBtn = document.getElementById('add-contact-btn');
  
  if (!addBtn || !form) return;
  
  addBtn.onclick = () => {
    form.style.display = form.style.display === 'none' ? 'block' : 'none';
    addBtn.innerHTML = form.style.display === 'none' 
      ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>'
      : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  };
  
  form.onsubmit = (e) => {
    e.preventDefault();
    const name = document.getElementById('contact-name').value.trim();
    const phone = document.getElementById('contact-phone').value.trim();
    const relationship = document.getElementById('contact-relationship').value.trim();
    const email = document.getElementById('contact-email')?.value.trim() || '';
    const error = document.getElementById('form-error');
    
    if (!name) { if (error) error.textContent = 'Ingresa un nombre'; return; }
    if (!phone) { if (error) error.textContent = 'Ingresa un numero de telefono'; return; }
    
    contacts.push({ 
      id: Date.now().toString(), 
      name, 
      phone, 
      email,
      relationship: relationship || 'Contacto' 
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(contacts));
    
    document.getElementById('contact-name').value = '';
    document.getElementById('contact-phone').value = '';
    document.getElementById('contact-relationship').value = '';
    if (document.getElementById('contact-email')) document.getElementById('contact-email').value = '';
    if (error) error.textContent = '';
    form.style.display = 'none';
    addBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
    
    renderContacts();
    renderEmergencyTab();
    updateContactsBadge();
  };
}

function deleteContact(id) {
  contacts = contacts.filter(c => c.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(contacts));
  renderContacts();
  renderEmergencyTab();
  updateContactsBadge();
}

function updateContactsBadge() {
  const badge = document.getElementById('contacts-badge');
  if (badge) {
    if (contacts.length > 0) {
      badge.style.display = 'flex';
      badge.textContent = contacts.length;
    } else {
      badge.style.display = 'none';
    }
  }
}

// ========== CONFIGURACION ==========
function renderSettings() {
  const textarea = document.getElementById('emergency-message');
  const charCount = document.getElementById('char-count');
  const saveBtn = document.getElementById('save-message-btn');
  const resetBtn = document.getElementById('reset-message-btn');
  
  if (textarea) {
    textarea.value = emergencyMessage;
    updateCharCount();
    textarea.oninput = updateCharCount;
  }
  
  function updateCharCount() {
    if (charCount && textarea) {
      const sampleMsg = textarea.value
        .replace('{LOCATION}', 'https://maps.google.com/?q=-34.6037,-58.3816')
        .replace('{TIME}', '15/04/2026, 14:30')
        .replace('{BATTERY}', '75');
      charCount.textContent = sampleMsg.length;
      charCount.style.color = sampleMsg.length > 160 ? '#7c3aed' : '#888';
    }
  }
  
  if (saveBtn) {
    saveBtn.onclick = () => {
      emergencyMessage = textarea.value;
      localStorage.setItem(MESSAGE_KEY, emergencyMessage);
      saveBtn.textContent = 'Guardado!';
      saveBtn.classList.add('saved');
      setTimeout(() => {
        saveBtn.textContent = 'Guardar Mensaje';
        saveBtn.classList.remove('saved');
      }, 2000);
    };
  }
  
  if (resetBtn) {
    resetBtn.onclick = () => {
      textarea.value = DEFAULT_MESSAGE;
      emergencyMessage = DEFAULT_MESSAGE;
      localStorage.setItem(MESSAGE_KEY, DEFAULT_MESSAGE);
      updateCharCount();
      saveBtn.textContent = 'Guardado!';
      saveBtn.classList.add('saved');
      setTimeout(() => {
        saveBtn.textContent = 'Guardar Mensaje';
        saveBtn.classList.remove('saved');
      }, 2000);
    };
  }
}

// ========== UTILIDADES ==========
function formatPhoneForSMS(phone) {
  let cleaned = phone.replace(/[\s\-()]/g, '');
  return cleaned;
}

function playBeep(freq = 800, duration = 200) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = freq;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration / 1000);
    osc.start();
    osc.stop(ctx.currentTime + duration / 1000);
  } catch (e) {}
}

// ========== LANDING PAGE FUNCTIONS ==========
let isActivated = false;
let progress = 0;
let holdTimer = null;
let progressInterval = null;

function toggleMenu() {
  const menu = document.getElementById('mobile-menu');
  if (menu) menu.classList.toggle('active');
}

window.addEventListener('scroll', () => {
  const navbar = document.getElementById('navbar');
  if (navbar) navbar.classList.toggle('scrolled', window.scrollY > 20);
});

function startHold() {
  if (isActivated) return;
  progress = 0;
  progressInterval = setInterval(() => {
    progress += 5;
    const progressBar = document.getElementById('progress');
    if (progressBar) progressBar.style.width = progress + '%';
    if (progress >= 100) clearInterval(progressInterval);
  }, 100);

  holdTimer = setTimeout(() => {
    playBeep(880, 150);
    setTimeout(() => playBeep(1100, 150), 200);
    isActivated = true;
    
    const btn = document.getElementById('emergency-btn');
    const statusTitle = document.getElementById('status-title');
    const statusSubtitle = document.getElementById('status-subtitle');
    
    if (btn) btn.classList.add('active');
    if (statusTitle) statusTitle.textContent = 'Enviando SMS...';
    if (statusSubtitle) statusSubtitle.textContent = 'Emergencia activada';

    setTimeout(() => { showCard('card-location'); playBeep(600, 80); }, 500);
    setTimeout(() => { showCard('card-sms'); playBeep(600, 80); }, 1200);
    setTimeout(() => { showCard('card-alert'); playBeep(600, 80); }, 1900);
    
    setTimeout(() => {
      playBeep(523, 100);
      setTimeout(() => playBeep(659, 100), 100);
      setTimeout(() => playBeep(784, 200), 200);
      if (statusTitle) { statusTitle.textContent = 'SMS Enviado'; statusTitle.classList.add('success'); }
      if (statusSubtitle) statusSubtitle.textContent = 'Ayuda en camino';
    }, 2600);

    setTimeout(resetDemo, 5000);
  }, 2000);
}

function cancelHold() {
  if (!isActivated) {
    clearInterval(progressInterval);
    clearTimeout(holdTimer);
    const progressBar = document.getElementById('progress');
    if (progressBar) progressBar.style.width = '0%';
  }
}

function showCard(id) {
  const card = document.getElementById(id);
  if (card) card.classList.add('show');
}

function resetDemo() {
  isActivated = false;
  progress = 0;
  const btn = document.getElementById('emergency-btn');
  const progressBar = document.getElementById('progress');
  const statusTitle = document.getElementById('status-title');
  const statusSubtitle = document.getElementById('status-subtitle');
  
  if (btn) btn.classList.remove('active');
  if (progressBar) progressBar.style.width = '0%';
  if (statusTitle) { statusTitle.textContent = 'SafeHeart Listo'; statusTitle.classList.remove('success'); }
  if (statusSubtitle) statusSubtitle.textContent = 'Mantene presionado para probar';
  
  ['card-location', 'card-sms', 'card-alert'].forEach(id => {
    const card = document.getElementById(id);
    if (card) card.classList.remove('show');
  });
}

// Reveal animations
const reveals = document.querySelectorAll(".reveal");
window.addEventListener("scroll", () => {
  reveals.forEach(el => {
    const top = el.getBoundingClientRect().top;
    if (top < window.innerHeight - 100) {
      el.classList.add("active");
    }
  });
});

// Inicializar cuando el DOM este listo
document.addEventListener('DOMContentLoaded', initApp);