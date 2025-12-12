
let map;
let userMarker;
let userCircle;
let gasStationsLayer;
let lastLocation = null;
let userMovedMap = false;
let foundStations = [];
let sortByDistance = true;

// script.js - Tambah di bagian Globals
let routingControl = null; // Untuk mengontrol layer rute
let currentRoute = null; // Untuk menyimpan rute yang aktif

const config = {
  searchRadius: 2000, // meters (default 2 km)
  maxStationsToShow: 20,
  osrmBatchSize: 5, // parallel OSRM requests per batch
  osrmBatchDelay: 150, // ms pause between batches
};

// -----------------------------
// Initialize map
// -----------------------------
function initMap() {
  const mapContainer = document.getElementById("map");
  if (!mapContainer) {
    console.error("Map container not found!");
    return;
  }

  map = L.map("map").setView([-7.797068, 110.370529], 11);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:
      '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  map.on("dragstart movestart zoomstart", () => {
    userMovedMap = true;
  });

  gasStationsLayer = L.markerClusterGroup({
    maxClusterRadius: 50,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    zoomToBoundsOnClick: true,
  });
  map.addLayer(gasStationsLayer);

  updateStatus("Map loaded. Klik 'Cari' untuk mencari SPBU.", "info");
  console.log("Map initialized");
}

// -----------------------------
// Get user location (promise)
// -----------------------------
function getUserLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject("Geolocation is not supported by your browser.");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        lastLocation = { lat: latitude, lng: longitude };
        resolve(lastLocation);
      },
      (error) => {
        let errorMessage = "Could not get your location. ";
        switch (error.code) {
          case error.PERMISSION_DENIED:
            errorMessage += "Please enable location permissions.";
            break;
          case error.POSITION_UNAVAILABLE:
            errorMessage += "Location information unavailable.";
            break;
          case error.TIMEOUT:
            errorMessage += "Location request timed out.";
            break;
        }
        reject(errorMessage);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });
}

// -----------------------------
// Main search flow
// -----------------------------
async function searchNearbyStations() {
  try {
    updateLoading(true);
    updateStatus("Mendapatkan lokasi kamu...", "info");

    const location = await getUserLocation();

    if (!userMovedMap) {
      map.setView([location.lat, location.lng], 14);
    }

    const locEl = document.getElementById("locationStatus");
    if (locEl)
      locEl.textContent = `${location.lat.toFixed(4)}, ${location.lng.toFixed(
        4
      )}`;
    updateUserMarker(location.lat, location.lng);

    updateStatus("Mencari SPBU di sekitar...", "info");
    await fetchGasStations(location.lat, location.lng);

    updateLastUpdated();
  } catch (error) {
    updateStatus(error, "error");
    console.error("Error getting location:", error);
  } finally {
    updateLoading(false);
  }
}

// -----------------------------
// Update / create user marker
// -----------------------------

function updateUserMarker(lat, lng) {
  if (!userMarker) {
    const userIcon = L.divIcon({
      className: "user-location-icon",
      html: '<div style="background-color: #3498db; width: 20px; height: 20px; border-radius: 50%; border: 3px solid white; box-shadow: 0 0 8px rgba(52,152,219,0.8);"></div>',
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });

    userMarker = L.marker([lat, lng], {
      icon: userIcon,
      zIndexOffset: 1000,
    }).addTo(map);

    userMarker.bindPopup(`
      <div class="user-location-popup">
        <strong><i class="fas fa-user"></i> Lokasimu</strong><br>
        Latitude: ${lat.toFixed(6)}<br>
        Longitude: ${lng.toFixed(6)}
      </div>
    `);
  } else {
    userMarker.setLatLng([lat, lng]);
  }

  if (!userCircle) {
    userCircle = L.circle([lat, lng], {
      radius: 50,
      color: "#3498db",
      fillOpacity: 0.05,
    }).addTo(map);
  } else {
    userCircle.setLatLng([lat, lng]);
  }
}

// -----------------------------
// Recenter map
// -----------------------------
function recenterToUser() {
  if (lastLocation) {
    userMovedMap = false;
    map.setView([lastLocation.lat, lastLocation.lng], 14);
    if (userMarker) userMarker.openPopup();
    updateStatus("Peta dipusatkan kembali ke lokasi kamu.", "success");
  } else {
    updateStatus("Lokasi belum tersedia. Klik 'Cari' dulu.", "warning");
  }
}

// -----------------------------
// Fetch from Overpass, then enrich with OSRM distances
// -----------------------------
async function fetchGasStations(lat, lng) {
  // Build Overpass QL; use config.searchRadius (meters)
  const overpassQuery = `
    [out:json][timeout:25];
    (
      node["amenity"="fuel"](around:${config.searchRadius},${lat},${lng});
      way["amenity"="fuel"](around:${config.searchRadius},${lat},${lng});
      relation["amenity"="fuel"](around:${config.searchRadius},${lat},${lng});
    );
    out center;
  `;

  const encodedQuery = encodeURIComponent(overpassQuery);
  const overpassUrl = `https://overpass-api.de/api/interpreter?data=${encodedQuery}`;

  try {
    const response = await fetch(overpassUrl);
    if (!response.ok) throw new Error("Overpass API error: " + response.status);
    const data = await response.json();

    // Map to station objects with initial straight-line distance (km)
    foundStations = (data.elements || [])
      .map((st) => {
        let stationLat, stationLng;
        if (st.type === "node") {
          stationLat = st.lat;
          stationLng = st.lon;
        } else if (st.center) {
          stationLat = st.center.lat;
          stationLng = st.center.lon;
        }
        if (!stationLat || !stationLng) return null;
        const straightKm = calculateDistance(lat, lng, stationLat, stationLng);
        return {
          ...st,
          lat: stationLat,
          lng: stationLng,
          distance: straightKm, // will be overwritten by OSRM if available (km)
        };
      })
      .filter(Boolean);

    // quick sort by straight-line and slice to nearest N to reduce OSRM calls
    foundStations.sort((a, b) => a.distance - b.distance);
    if (foundStations.length > config.maxStationsToShow) {
      foundStations = foundStations.slice(0, config.maxStationsToShow);
    }

    // Enrich with OSRM driving distance (batched)
    await enrichStationsWithOSRM(foundStations, lat, lng);

    // FILTER: only keep stations whose driving distance <= configured searchRadius (converted to km)
    const radiusKm = config.searchRadius / 1000;
    const filtered = foundStations.filter(
      (s) => typeof s.distance === "number" && s.distance <= radiusKm
    );

    if (filtered.length > 0) {
      foundStations = filtered;
      updateStatus(
        `Menampilkan ${foundStations.length} SPBU dalam radius ${radiusKm} km (berdasarkan rute).`,
        "success"
      );
    } else {
      // fallback: no stations within driving radius — show nearest results anyway (but inform user)
      updateStatus(
        `Tidak ada SPBU dalam radius ${radiusKm} km menurut rute. Menampilkan ${foundStations.length} SPBU terdekat (jarak rute mungkin > radius).`,
        "warning"
      );
    }

    // sort by (driving) distance if needed and display
    sortStations();
    displayGasStations(foundStations, lat, lng);
    updateStationsList();
  } catch (err) {
    console.error("Error fetching Overpass:", err);
    updateStatus("Gagal memuat data SPBU. Coba lagi nanti.", "error");
  }
}

// -----------------------------
// Enrich stations with OSRM distances in batches
// -----------------------------
async function enrichStationsWithOSRM(stations, userLat, userLng) {
  if (!stations || stations.length === 0) return;

  const batchSize = config.osrmBatchSize || 5;
  for (let i = 0; i < stations.length; i += batchSize) {
    const batch = stations.slice(i, i + batchSize);
    const promises = batch.map((s) =>
      calculateDrivingDistanceOSRM(userLat, userLng, s.lat, s.lng)
    );
    const results = await Promise.all(promises);
    for (let j = 0; j < batch.length; j++) {
      const s = batch[j];
      const osrmKm = results[j];
      if (typeof osrmKm === "number" && !isNaN(osrmKm)) {
        s.distance = osrmKm; // override with driving km
      } // else keep straight-line in s.distance
    }
    // polite delay
    await new Promise((r) => setTimeout(r, config.osrmBatchDelay));
  }
}

// -----------------------------
// OSRM call per station -> returns km or null
// -----------------------------
async function calculateDrivingDistanceOSRM(lat1, lng1, lat2, lng2) {
  const url = `https://router.project-osrm.org/route/v1/driving/${lng1},${lat1};${lng2},${lat2}?overview=false`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn("OSRM status", res.status);
      return null;
    }
    const data = await res.json();
    if (
      data.routes &&
      data.routes[0] &&
      typeof data.routes[0].distance === "number"
    ) {
      return data.routes[0].distance / 1000; // meters -> km
    } else {
      console.warn("OSRM no route for", lat2, lng2);
      return null;
    }
  } catch (err) {
    console.warn("OSRM fetch error:", err);
    return null;
  }
}


// -----------------------------
// Show driving route using OSRM
// -----------------------------
async function showRouteToStation(stationLat, stationLng) {
  removeExistingRoute();

  if (!lastLocation) {
    updateStatus("Lokasi kamu belum tersedia. Klik 'Cari' dulu.", "warning");
    return;
  }

  updateStatus("Menghitung rute terbaik...", "info");

  const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${lastLocation.lng},${lastLocation.lat};${stationLng},${stationLat}?overview=full&geometries=polyline`;

  try {
    const response = await fetch(osrmUrl);
    if (!response.ok) throw new Error("OSRM error");

    const data = await response.json();
    if (!data.routes || !data.routes[0]) throw new Error("No route");

    const route = data.routes[0];
    const distanceKm = (route.distance / 1000).toFixed(2);
    const durationMin = Math.round(route.duration / 60);

    // Leaflet Routing Machine
    routingControl = L.Routing.control({
      waypoints: [
        L.latLng(lastLocation.lat, lastLocation.lng),
        L.latLng(stationLat, stationLng)
      ],
      show: false,
      addWaypoints: false,
      draggableWaypoints: false,
      lineOptions: {
        styles: [{ color: "#3498db", weight: 5, opacity: 0.8 }]
      },
      createMarker: () => null
    }).addTo(map);

    updateStatus(`Rute ditemukan: ${distanceKm} km (${durationMin} menit)`, "success");

  } catch (err) {
    console.error("Route error:", err);
    updateStatus("Gagal menghitung rute. Coba lagi.", "error");
  }
}


// -----------------------------
// Remove existing route
// -----------------------------
function removeExistingRoute() {
  if (routingControl) {
    map.removeControl(routingControl);
    routingControl = null;
  }
  
  // Remove any route-related layers
  map.eachLayer(function(layer) {
    if (layer instanceof L.Polyline && layer.options.color === '#3498db') {
      map.removeLayer(layer);
    }
    if (layer instanceof L.Marker && 
        (layer.options.icon?.options?.className === 'route-start-icon' || 
         layer.options.icon?.options?.className === 'route-end-icon')) {
      map.removeLayer(layer);
    }
  });
  
  // Hide route info panel
  const routeInfoPanel = document.getElementById("routeInfoPanel");
  if (routeInfoPanel) {
    routeInfoPanel.style.display = "none";
  }
  
  currentRoute = null;
}

// -----------------------------
// Show route info panel
// -----------------------------
function showRouteInfoPanel(distance, duration, steps) {
  let panel = document.getElementById("routeInfoPanel");
  
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "routeInfoPanel";
    panel.className = "route-info-panel";
    panel.innerHTML = `
      <div class="route-info-header">
        <h4><i class="fas fa-route"></i> Rute Perjalanan</h4>
        <button id="closeRoutePanel" class="close-btn">&times;</button>
      </div>
      <div class="route-summary">
        <div class="route-stat">
          <i class="fas fa-route"></i>
          <span class="route-value">${distance} km</span>
          <span class="route-label">Jarak</span>
        </div>
        <div class="route-stat">
          <i class="fas fa-clock"></i>
          <span class="route-value">${duration} mnt</span>
          <span class="route-label">Waktu</span>
        </div>
        <button id="clearRouteBtn" class="clear-route-btn">
          <i class="fas fa-times"></i> Hapus Rute
        </button>
      </div>
      <div class="route-steps">
        <h5><i class="fas fa-list-ol"></i> Petunjuk Perjalanan:</h5>
        <div class="steps-container"></div>
      </div>
    `;
    document.querySelector(".map-container").appendChild(panel);
    
    // Add event listeners
    document.getElementById("closeRoutePanel").addEventListener("click", removeExistingRoute);
    document.getElementById("clearRouteBtn").addEventListener("click", removeExistingRoute);
  }
  
  // Update steps
  const stepsContainer = panel.querySelector(".steps-container");
  if (steps && steps.length > 0) {
    stepsContainer.innerHTML = steps.slice(0, 10).map((step, index) => `
      <div class="route-step">
        <div class="step-number">${index + 1}</div>
        <div class="step-text">${step.maneuver.instruction || ''}</div>
        <div class="step-distance">${(step.distance / 1000).toFixed(2)} km</div>
      </div>
    `).join('');
  }
  
  panel.style.display = "block";
}

function displayGasStations(stations, userLat, userLng) {
  gasStationsLayer.clearLayers();
  if (!stations || stations.length === 0) {
    console.log("No gas stations to display");
    return;
  }

  const gasIcon = L.divIcon({
    className: "gas-station-icon",
    html: '<div style="background-color: #e74c3c; width: 24px; height: 24px; border-radius: 50%; border:2px solid white; box-shadow:0 0 6px rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center;"><i class="fas fa-gas-pump" style="color:white;font-size:12px;"></i></div>',
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });

  stations.forEach((st) => {
    const marker = L.marker([st.lat, st.lng], { icon: gasIcon });
    const name = st.tags?.name || "Unnamed Gas Station";
    const brand = st.tags?.brand || st.tags?.operator || "Unknown";
    const distText =
      typeof st.distance === "number" && !isNaN(st.distance)
        ? `${st.distance.toFixed(2)} km`
        : "N/A";

    const popupContent = `
  <div class="gas-station-popup">
    <h4><i class="fas fa-gas-pump"></i> ${name}</h4>
    <p><strong>Brand:</strong> ${brand}</p>
    <p><strong>Jarak (rute):</strong> ${distText}</p>
    <hr>
    <div class="popup-buttons">
      <button class="show-route-btn" data-lat="${st.lat}" data-lng="${st.lng}"
        style="background:#3498db;color:white;border:none;padding:6px 10px;border-radius:3px;cursor:pointer;width:100%;margin-bottom:5px;">
        <i class="fas fa-route"></i> Tampilkan Rute
      </button>
      <button class="navigate-btn" data-lat="${st.lat}" data-lng="${st.lng}"
        style="background:#2ecc71;color:white;border:none;padding:6px 10px;border-radius:3px;cursor:pointer;width:100%;">
        <i class="fas fa-directions"></i> Buka di Google Maps
      </button>
    </div>
  </div>
`;

gasStationsLayer.on("popupopen", (e) => {
  const popupNode = e.popup.getElement();
  if (!popupNode) return;

  const showRouteBtn = popupNode.querySelector(".show-route-btn");
  if (showRouteBtn) {
    showRouteBtn.addEventListener("click", function () {
      const lat = parseFloat(this.dataset.lat);
      const lng = parseFloat(this.dataset.lng);
      showRouteToStation(lat, lng);
      e.popup.close();
    });
  }

  const navigateBtn = popupNode.querySelector(".navigate-btn");
  if (navigateBtn) {
    navigateBtn.addEventListener("click", function () {
      const lat = parseFloat(this.dataset.lat);
      const lng = parseFloat(this.dataset.lng);
      navigateToStation(lat, lng);
    });
  }
});

    marker.bindPopup(popupContent);
    gasStationsLayer.addLayer(marker);
  });
}

// -----------------------------
// Update stations list in sidebar
// -----------------------------
function updateStationsList() {
  const container = document.getElementById("stationsContainer");
  const countElement = document.getElementById("listCount");
  const stationsCount = document.getElementById("stationsCount");

  if (!container) return;

  countElement.textContent = foundStations.length;
  if (stationsCount) stationsCount.textContent = foundStations.length;

  if (foundStations.length === 0) {
    container.innerHTML = `
      <div class="empty-list">
        <i class="fas fa-gas-pump"></i>
        <p>Belum ada SPBU ditemukan.<br>Klik "Cari" untuk mencari.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = foundStations
    .map((st, idx) => {
      const name = st.tags?.name || "Unnamed Gas Station";
      const brand = st.tags?.brand || st.tags?.operator || "Unknown";
      const address =
        st.tags?.["addr:street"] || st.tags?.address || "Alamat tidak tersedia";
      const distText =
        typeof st.distance === "number" && !isNaN(st.distance)
          ? `${st.distance.toFixed(2)}`
          : "N/A";

      return `
      <div class="station-item" data-index="${idx}">
        <div class="station-number">${idx + 1}</div>
        <div class="station-info">
          <div class="station-name">${name}</div>
          <div class="station-brand">${brand}</div>
          <div class="station-address">${address}</div>
        </div>
        <div class="station-distance">
          <span class="distance-value">${distText}</span>
          <span class="distance-unit">km</span>
        </div>
        <button class="station-action" data-lat="${st.lat}" data-lng="${
        st.lng
      }" title="Get Directions">
          <i class="fas fa-directions"></i>
        </button>
      </div>
    `;
    })
    .join("");

  // Click handlers: zoom to station & open popup
  container.querySelectorAll(".station-item").forEach((item) => {
    item.addEventListener("click", function (e) {
      if (e.target.closest(".station-action")) return;
      const index = parseInt(this.getAttribute("data-index"));
      const st = foundStations[index];
      map.setView([st.lat, st.lng], 16);

      const epsilon = 0.0001;
      gasStationsLayer.getLayers().forEach((layer) => {
        if (!layer.getLatLng) return;
        const latlng = layer.getLatLng();
        if (
          Math.abs(latlng.lat - st.lat) < epsilon &&
          Math.abs(latlng.lng - st.lng) < epsilon
        ) {
          layer.openPopup();
        }
      });
    });
  });

  // Buttons for direct navigation
  container.querySelectorAll(".station-action").forEach((btn) => {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      const lat = parseFloat(this.getAttribute("data-lat"));
      const lng = parseFloat(this.getAttribute("data-lng"));
      navigateToStation(lat, lng);
    });
  });
}

// -----------------------------
// Sort stations
// -----------------------------
function sortStations() {
  if (sortByDistance) {
    foundStations.sort((a, b) => {
      const da = typeof a.distance === "number" ? a.distance : Infinity;
      const db = typeof b.distance === "number" ? b.distance : Infinity;
      return da - db;
    });
  } else {
    foundStations.sort((a, b) => {
      const nameA = a.tags?.name || "";
      const nameB = b.tags?.name || "";
      return nameA.localeCompare(nameB);
    });
  }
}

// -----------------------------
// Haversine fallback (km)
// -----------------------------
function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// -----------------------------
// Navigate (open Google Maps with origin if available)
// -----------------------------
// Update fungsi navigateToStation
function navigateToStation(lat, lng) {
  // Show route on map first
  showRouteToStation(lat, lng);
  
  // Then open Google Maps in new tab
  setTimeout(() => {
    let url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
    if (lastLocation && lastLocation.lat && lastLocation.lng) {
      url += `&origin=${lastLocation.lat},${lastLocation.lng}`;
    }
    window.open(url, '_blank');
  }, 1000);
}

// -----------------------------
// UI helpers: status / loading / last updated
// -----------------------------
function updateStatus(message, type = "info") {
  console.log(`[Status:${type}] ${message}`);
  const statusPanel = document.getElementById("status");
  if (!statusPanel) return;
  const statusContent = statusPanel.querySelector(".status-content");
  if (!statusContent) return;
  // show a small transient message inside status-content top area
  // We'll add a small inline message element (keeps existing structure)
  let short = statusContent.querySelector(".status-short");
  if (!short) {
    short = document.createElement("div");
    short.className = "status-short";
    short.style.margin = "6px 0";
    statusContent.insertBefore(short, statusContent.firstChild);
  }
  short.textContent = message;
  // style by type (basic)
  short.style.color =
    type === "error" ? "#e74c3c" : type === "warning" ? "#e67e22" : "#3498db";
}

function updateLoading(isLoading) {
  const loadingEl = document.getElementById("loading");
  if (!loadingEl) return;
  loadingEl.style.display = isLoading ? "block" : "none";
}

function updateLastUpdated() {
  const lastUpdatedEl = document.getElementById("lastUpdated");
  if (!lastUpdatedEl) return;
  const now = new Date();
  lastUpdatedEl.textContent = now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// -----------------------------
// DOM ready: wire events
// -----------------------------
document.addEventListener("DOMContentLoaded", function () {
  initMap();

  const searchBtn = document.getElementById("searchBtn");
  if (searchBtn) searchBtn.addEventListener("click", searchNearbyStations);

  const recenterBtn = document.getElementById("recenterBtn");
  if (recenterBtn) recenterBtn.addEventListener("click", recenterToUser);

  const sortToggle = document.getElementById("sortToggle");
  if (sortToggle) {
    sortToggle.addEventListener("click", function () {
      sortByDistance = !sortByDistance;
      this.innerHTML = sortByDistance
        ? '<i class="fas fa-sort-amount-down"></i>'
        : '<i class="fas fa-sort-alpha-down"></i>';
      this.title = sortByDistance ? "Sort by distance" : "Sort by name";
      sortStations();
      updateStationsList();
    });
  }

  const radiusSlider = document.getElementById("searchRadius");
  const radiusValue = document.getElementById("searchRadiusValue");
  if (radiusSlider && radiusValue) {
    radiusSlider.addEventListener("input", function () {
      const radiusKm = parseFloat(this.value);
      radiusValue.textContent = radiusKm;
      config.searchRadius = radiusKm * 1000;
    });
  }

  const maxResultsSlider = document.getElementById("maxResults");
  const maxResultsValue = document.getElementById("maxResultsValue");
  if (maxResultsSlider && maxResultsValue) {
    maxResultsSlider.addEventListener("input", function () {
      const maxStations = parseInt(this.value);
      maxResultsValue.textContent = maxStations;
      config.maxStationsToShow = maxStations;
    });
  }

  document.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      searchNearbyStations();
    }
  });

  // resize fixes (map.invalidateSize)
  window.addEventListener("load", () =>
    setTimeout(() => {
      if (map) map.invalidateSize();
    }, 500)
  );
  window.addEventListener("resize", () =>
    setTimeout(() => {
      if (map) map.invalidateSize();
    }, 200)
  );

  console.log("Gas Station Finder initialized");
});
