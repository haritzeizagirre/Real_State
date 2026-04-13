const state = {
  filters: {
    site: '',
    transactionType: '',
    priceMin: '',
    priceMax: '',
    bedrooms: '',
    watchlistOnly: false,
  },
  sort: {
    by: 'first_seen',
    dir: 'desc',
  },
  listings: [],
  watchlist: loadWatchlist(),
  geocodeCache: loadGeocodeCache(),
  map: null,
  markerLayer: null,
};

const elements = {
  refreshButton: document.getElementById('refreshButton'),
  lastRefreshLabel: document.getElementById('lastRefreshLabel'),
  siteFilter: document.getElementById('siteFilter'),
  transactionFilter: document.getElementById('transactionFilter'),
  priceMinFilter: document.getElementById('priceMinFilter'),
  priceMaxFilter: document.getElementById('priceMaxFilter'),
  bedroomsFilter: document.getElementById('bedroomsFilter'),
  watchlistOnly: document.getElementById('watchlistOnly'),
  statActive: document.getElementById('statActive'),
  statNew: document.getElementById('statNew'),
  statChanged: document.getElementById('statChanged'),
  statRemoved: document.getElementById('statRemoved'),
  listingsBody: document.getElementById('listingsBody'),
  changeLog: document.getElementById('changeLog'),
  avgChart: document.getElementById('avgChart'),
  histChart: document.getElementById('histChart'),
};

function loadWatchlist() {
  try {
    const raw = localStorage.getItem('dashboard.watchlist');
    const values = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(values) ? values : []);
  } catch {
    return new Set();
  }
}

function saveWatchlist() {
  localStorage.setItem('dashboard.watchlist', JSON.stringify(Array.from(state.watchlist.values())));
}

function loadGeocodeCache() {
  try {
    const raw = localStorage.getItem('dashboard.geocodeCache');
    const value = raw ? JSON.parse(raw) : {};
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function saveGeocodeCache() {
  localStorage.setItem('dashboard.geocodeCache', JSON.stringify(state.geocodeCache));
}

function listingKey(item) {
  return `${item.siteId}::${item.listingId}`;
}

function euro(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '-';
  }

  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  }).format(Number(value));
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }
  return date.toLocaleString();
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`Request failed (${response.status}): ${payload}`);
  }
  return response.json();
}

function buildListingsUrl() {
  const params = new URLSearchParams();
  if (state.filters.site) {
    params.set('site', state.filters.site);
  }
  if (state.filters.transactionType) {
    params.set('transactionType', state.filters.transactionType);
  }
  if (state.filters.priceMin) {
    params.set('priceMin', state.filters.priceMin);
  }
  if (state.filters.priceMax) {
    params.set('priceMax', state.filters.priceMax);
  }
  if (state.filters.bedrooms) {
    params.set('bedrooms', state.filters.bedrooms);
  }

  params.set('sortBy', state.sort.by);
  params.set('sortDir', state.sort.dir);
  return `/api/listings?${params.toString()}`;
}

function drawLineChart(canvas, points) {
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);

  if (!points.length) {
    ctx.fillStyle = '#4f5f5a';
    ctx.fillText('No trend data yet', 12, 20);
    return;
  }

  const values = points.map((p) => p.avgPrice).filter((v) => Number.isFinite(v));
  if (!values.length) {
    ctx.fillStyle = '#4f5f5a';
    ctx.fillText('No numeric prices in timeline', 12, 20);
    return;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const padX = 40;
  const padY = 22;
  const plotWidth = width - padX * 2;
  const plotHeight = height - padY * 2;

  ctx.strokeStyle = '#d1cbc0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padX, padY);
  ctx.lineTo(padX, height - padY);
  ctx.lineTo(width - padX, height - padY);
  ctx.stroke();

  ctx.strokeStyle = '#0f766e';
  ctx.lineWidth = 2;
  ctx.beginPath();

  points.forEach((point, index) => {
    const x = padX + (points.length === 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth);
    const ratio = max === min ? 0.5 : (point.avgPrice - min) / (max - min);
    const y = height - padY - ratio * plotHeight;

    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });

  ctx.stroke();

  ctx.fillStyle = '#13322a';
  ctx.font = '12px IBM Plex Sans';
  ctx.fillText(euro(min), 6, height - padY + 4);
  ctx.fillText(euro(max), 6, padY + 4);
}

function drawHistogram(canvas, bins) {
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);

  if (!bins.length) {
    ctx.fillStyle = '#4f5f5a';
    ctx.fillText('No histogram data yet', 12, 20);
    return;
  }

  const maxCount = Math.max(...bins.map((bin) => bin.count), 1);
  const padX = 24;
  const padY = 22;
  const innerWidth = width - padX * 2;
  const innerHeight = height - padY * 2;
  const barWidth = innerWidth / bins.length;

  bins.forEach((bin, index) => {
    const x = padX + index * barWidth + 4;
    const barHeight = (bin.count / maxCount) * (innerHeight - 28);
    const y = height - padY - barHeight;

    ctx.fillStyle = '#14b8a6';
    ctx.fillRect(x, y, Math.max(8, barWidth - 8), barHeight);

    ctx.fillStyle = '#304945';
    ctx.font = '10px IBM Plex Sans';
    ctx.fillText(String(bin.count), x + 2, y - 4);
  });
}

function renderSummary(summary) {
  elements.statActive.textContent = String(summary.totalActive ?? '-');
  elements.statNew.textContent = String(summary.latestRunChanges?.new ?? 0);

  const changed = (summary.latestRunChanges?.price_changed || 0) + (summary.latestRunChanges?.attributes_changed || 0);
  elements.statChanged.textContent = String(changed);
  elements.statRemoved.textContent = String(summary.latestRunChanges?.removed ?? 0);

  drawLineChart(elements.avgChart, summary.avgPriceTimeline || []);
  drawHistogram(elements.histChart, summary.priceHistogram || []);
}

function diffToText(diffItem) {
  const oldText = diffItem.old === null || diffItem.old === undefined || diffItem.old === '' ? 'empty' : String(diffItem.old);
  const newText = diffItem.new === null || diffItem.new === undefined || diffItem.new === '' ? 'empty' : String(diffItem.new);
  return `${diffItem.field}: ${oldText} -> ${newText}`;
}

function renderChangeLog(items) {
  elements.changeLog.innerHTML = '';
  if (!items.length) {
    elements.changeLog.innerHTML = '<li class="change-item">No change events found.</li>';
    return;
  }

  for (const item of items) {
    const li = document.createElement('li');
    li.className = `change-item ${item.changeType}`;

    const title = item.title || item.listingId;
    const link = item.detailUrl ? `<a href="${item.detailUrl}" target="_blank" rel="noreferrer">open listing</a>` : 'no url';
    const diffLines = (item.diff || []).slice(0, 6).map((entry) => `<li>${diffToText(entry)}</li>`).join('');

    li.innerHTML = `
      <strong>${item.changeType}</strong> - ${title}
      <div class="meta">${item.siteId} | run ${item.runId} | ${formatDate(item.createdAt)} | ${link}</div>
      ${diffLines ? `<ul class="diff">${diffLines}</ul>` : ''}
    `;

    elements.changeLog.appendChild(li);
  }
}

function renderListingsTable(items) {
  elements.listingsBody.innerHTML = '';

  if (!items.length) {
    elements.listingsBody.innerHTML = '<tr><td colspan="9">No listings match these filters.</td></tr>';
    return;
  }

  items.forEach((item, index) => {
    const row = document.createElement('tr');
    const key = listingKey(item);
    const isWatched = state.watchlist.has(key);

    row.innerHTML = `
      <td>
        <button type="button" class="watch ${isWatched ? 'active' : ''}" data-watch-key="${key}" title="Toggle watchlist">${isWatched ? '★' : '☆'}</button>
      </td>
      <td>${item.siteId}</td>
      <td>${item.title || '-'}</td>
      <td>${item.location || '-'}</td>
      <td>${item.price || euro(item.priceNum)}</td>
      <td>${item.bedrooms === null ? '-' : item.bedrooms}</td>
      <td>${formatDate(item.firstSeen)}</td>
      <td><canvas class="sparkline" id="spark_${index}" width="100" height="30"></canvas></td>
      <td>${item.detailUrl ? `<a href="${item.detailUrl}" target="_blank" rel="noreferrer">View</a>` : '-'}</td>
    `;

    elements.listingsBody.appendChild(row);
  });

  const watchButtons = elements.listingsBody.querySelectorAll('[data-watch-key]');
  for (const button of watchButtons) {
    button.addEventListener('click', () => {
      const key = button.getAttribute('data-watch-key');
      if (!key) {
        return;
      }

      if (state.watchlist.has(key)) {
        state.watchlist.delete(key);
      } else {
        state.watchlist.add(key);
      }

      saveWatchlist();
      refreshListingsOnly();
    });
  }
}

function drawSparkline(canvas, series) {
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);

  const values = series.map((row) => row.priceNum).filter((v) => Number.isFinite(v));
  if (values.length < 2) {
    ctx.fillStyle = '#9ca3af';
    ctx.fillRect(0, height / 2, width, 1);
    return;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);

  ctx.strokeStyle = '#0369a1';
  ctx.lineWidth = 1.7;
  ctx.beginPath();

  values.forEach((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const ratio = max === min ? 0.5 : (value - min) / (max - min);
    const y = height - ratio * (height - 2) - 1;
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });

  ctx.stroke();
}

async function loadSparklines(items) {
  const keys = items.slice(0, 90).map((item) => listingKey(item));
  if (!keys.length) {
    return;
  }

  const payload = await fetchJson(`/api/listing-histories?ids=${encodeURIComponent(keys.join(','))}`);
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const key = listingKey(item);
    const canvas = document.getElementById(`spark_${index}`);
    if (!canvas) {
      continue;
    }

    drawSparkline(canvas, payload.histories?.[key] || []);
  }
}

function initMapIfNeeded() {
  if (!window.L || state.map) {
    return;
  }

  state.map = L.map('map').setView([43.36, -1.79], 11);
  state.markerLayer = L.layerGroup().addTo(state.map);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(state.map);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function geocode(location) {
  const key = String(location || '').trim();
  if (!key) {
    return null;
  }

  if (state.geocodeCache[key]) {
    return state.geocodeCache[key];
  }

  const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(key)}`);
  if (!response.ok) {
    return null;
  }

  const result = await response.json();
  if (!Array.isArray(result) || !result[0]) {
    state.geocodeCache[key] = null;
    saveGeocodeCache();
    return null;
  }

  const coords = {
    lat: Number(result[0].lat),
    lng: Number(result[0].lon),
  };

  if (!Number.isFinite(coords.lat) || !Number.isFinite(coords.lng)) {
    return null;
  }

  state.geocodeCache[key] = coords;
  saveGeocodeCache();
  return coords;
}

async function renderMap(items) {
  initMapIfNeeded();
  if (!state.map || !state.markerLayer) {
    return;
  }

  state.markerLayer.clearLayers();

  const top = items.slice(0, 30);
  const distinctLocations = [];
  const seen = new Set();

  for (const item of top) {
    const key = String(item.location || '').trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    distinctLocations.push(key);
  }

  const toGeocode = distinctLocations.filter((loc) => state.geocodeCache[loc] === undefined).slice(0, 6);
  for (const location of toGeocode) {
    try {
      await geocode(location);
      await sleep(1000);
    } catch {
      // Geocoding is best-effort.
    }
  }

  const points = [];
  for (const item of top) {
    const coords = state.geocodeCache[item.location];
    if (!coords || !Number.isFinite(coords.lat) || !Number.isFinite(coords.lng)) {
      continue;
    }

    points.push([coords.lat, coords.lng]);
    const marker = L.marker([coords.lat, coords.lng]);
    const detailLink = item.detailUrl ? `<a href="${item.detailUrl}" target="_blank" rel="noreferrer">Open listing</a>` : 'No URL';
    marker.bindPopup(`<strong>${item.title || item.listingId}</strong><br>${item.location}<br>${item.price || euro(item.priceNum)}<br>${detailLink}`);
    marker.addTo(state.markerLayer);
  }

  if (points.length) {
    state.map.fitBounds(points, { padding: [20, 20] });
  }
}

function getFilteredWatchlistItems(items) {
  if (!state.filters.watchlistOnly) {
    return items;
  }

  return items.filter((item) => state.watchlist.has(listingKey(item)));
}

async function loadSummary() {
  const query = state.filters.site ? `?site=${encodeURIComponent(state.filters.site)}` : '';
  const summary = await fetchJson(`/api/summary${query}`);
  renderSummary(summary);
}

async function loadChanges() {
  const params = new URLSearchParams();
  if (state.filters.site) {
    params.set('site', state.filters.site);
  }
  params.set('limit', '160');

  const payload = await fetchJson(`/api/changes?${params.toString()}`);
  renderChangeLog(payload.items || []);
}

async function refreshListingsOnly() {
  const payload = await fetchJson(buildListingsUrl());
  state.listings = getFilteredWatchlistItems(payload.items || []);
  renderListingsTable(state.listings);
  await loadSparklines(state.listings);
  await renderMap(state.listings);
}

async function refreshAll() {
  elements.lastRefreshLabel.textContent = 'Refreshing...';
  await Promise.all([
    loadSummary(),
    loadChanges(),
    refreshListingsOnly(),
  ]);
  elements.lastRefreshLabel.textContent = `Last refresh: ${new Date().toLocaleTimeString()}`;
}

function bindSortHeaders() {
  document.querySelectorAll('th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const sortBy = th.getAttribute('data-sort');
      if (!sortBy) {
        return;
      }

      if (state.sort.by === sortBy) {
        state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sort.by = sortBy;
        state.sort.dir = sortBy === 'location' ? 'asc' : 'desc';
      }

      refreshListingsOnly().catch((error) => {
        console.error(error);
      });
    });
  });
}

function bindFilters() {
  const update = () => {
    state.filters.site = elements.siteFilter.value;
    state.filters.transactionType = elements.transactionFilter.value;
    state.filters.priceMin = elements.priceMinFilter.value;
    state.filters.priceMax = elements.priceMaxFilter.value;
    state.filters.bedrooms = elements.bedroomsFilter.value;
    state.filters.watchlistOnly = elements.watchlistOnly.checked;

    refreshAll().catch((error) => {
      console.error(error);
      alert(error.message);
    });
  };

  elements.siteFilter.addEventListener('change', update);
  elements.transactionFilter.addEventListener('change', update);
  elements.priceMinFilter.addEventListener('change', update);
  elements.priceMaxFilter.addEventListener('change', update);
  elements.bedroomsFilter.addEventListener('change', update);
  elements.watchlistOnly.addEventListener('change', update);
}

async function loadOptions() {
  const options = await fetchJson('/api/options');
  const sites = options.sites || [];

  for (const site of sites) {
    const option = document.createElement('option');
    option.value = site;
    option.textContent = site;
    elements.siteFilter.appendChild(option);
  }

  if (options.priceRange) {
    if (Number.isFinite(options.priceRange.min)) {
      elements.priceMinFilter.placeholder = String(options.priceRange.min);
    }
    if (Number.isFinite(options.priceRange.max)) {
      elements.priceMaxFilter.placeholder = String(options.priceRange.max);
    }
  }
}

async function boot() {
  bindSortHeaders();
  bindFilters();

  elements.refreshButton.addEventListener('click', () => {
    refreshAll().catch((error) => {
      console.error(error);
      alert(error.message);
    });
  });

  try {
    await loadOptions();
    await refreshAll();
  } catch (error) {
    console.error(error);
    alert(`Dashboard failed to load: ${error.message}`);
  }
}

boot();
