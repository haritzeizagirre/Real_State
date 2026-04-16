const state = {
  filters: {
    site: '',
    transactionType: '',
    priceMin: '',
    priceMax: '',
    bedrooms: '',
    bathrooms: '',
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
  bathroomsFilter: document.getElementById('bathroomsFilter'),
  watchlistOnly: document.getElementById('watchlistOnly'),
  statActive: document.getElementById('statActive'),
  statNew: document.getElementById('statNew'),
  statChanged: document.getElementById('statChanged'),
  statRemoved: document.getElementById('statRemoved'),
  avgCurrentValue: document.getElementById('avgCurrentValue'),
  histSummaryLabel: document.getElementById('histSummaryLabel'),
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

function compactPriceLabel(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return '-';
  }

  const sign = numeric < 0 ? '-' : '';
  const abs = Math.abs(numeric);
  const scales = [
    { value: 1_000_000_000_000, suffix: 'T' },
    { value: 1_000_000_000, suffix: 'B' },
    { value: 1_000_000, suffix: 'M' },
    { value: 1_000, suffix: 'k' },
  ];

  for (const scale of scales) {
    if (abs < scale.value) {
      continue;
    }

    const scaled = abs / scale.value;
    const decimals = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
    return `${sign}${Number(scaled.toFixed(decimals))}${scale.suffix}`;
  }

  return `${sign}${Math.round(abs)}`;
}

function compactEuro(value) {
  const compact = compactPriceLabel(value);
  return compact === '-' ? compact : `${compact} €`;
}

function compactRangeLabel(minValue, maxValue) {
  const minLabel = compactPriceLabel(minValue);
  const maxLabel = compactPriceLabel(maxValue);
  const minSuffixMatch = minLabel.match(/[kMBT]$/);
  const maxSuffixMatch = maxLabel.match(/[kMBT]$/);

  if (!minSuffixMatch || !maxSuffixMatch) {
    return `${minLabel}-${maxLabel}`;
  }

  const minSuffix = minSuffixMatch[0];
  const maxSuffix = maxSuffixMatch[0];
  if (minSuffix !== maxSuffix) {
    return `${minLabel}-${maxLabel}`;
  }

  return `${minLabel.slice(0, -1)}-${maxLabel}`;
}

function formatSiteName(value) {
  const site = String(value || '').trim();
  if (!site) {
    return '-';
  }

  return site.charAt(0).toUpperCase() + site.slice(1);
}

function getCanvasDrawContext(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width || canvas.width || 1));
  const height = Math.max(1, Math.round(rect.height || canvas.height || 1));
  const renderWidth = Math.round(width * dpr);
  const renderHeight = Math.round(height * dpr);

  if (canvas.width !== renderWidth || canvas.height !== renderHeight) {
    canvas.width = renderWidth;
    canvas.height = renderHeight;
  }

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
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
  appendActiveFilters(params);

  params.set('sortBy', state.sort.by);
  params.set('sortDir', state.sort.dir);
  return `/api/listings?${params.toString()}`;
}

function appendActiveFilters(params) {
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
  if (state.filters.bathrooms) {
    params.set('bathrooms', state.filters.bathrooms);
  }
}

function drawLineChart(canvas, points) {
  const { ctx, width, height } = getCanvasDrawContext(canvas);

  if (!points.length) {
    ctx.fillStyle = '#c4c7c7';
    ctx.fillText('No trend data yet', 12, 20);
    return;
  }

  const values = points.map((p) => p.avgPrice).filter((v) => Number.isFinite(v));
  if (!values.length) {
    ctx.fillStyle = '#c4c7c7';
    ctx.fillText('No numeric prices in timeline', 12, 20);
    return;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const padX = 88;
  const padY = 24;
  const plotWidth = width - padX * 2;
  const plotHeight = height - padY * 2;

  // Axes
  ctx.strokeStyle = '#434747';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padX, padY);
  ctx.lineTo(padX, height - padY);
  ctx.lineTo(width - padX, height - padY);
  ctx.stroke();

  // Draw fill
  const fillGrad = ctx.createLinearGradient(0, padY, 0, height - padY);
  fillGrad.addColorStop(0, 'rgba(233, 193, 118, 0.25)');
  fillGrad.addColorStop(1, 'rgba(233, 193, 118, 0.0)');
  ctx.fillStyle = fillGrad;
  ctx.beginPath();
  ctx.moveTo(padX, height - padY);
  
  points.forEach((point, index) => {
    const x = padX + (points.length === 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth);
    const ratio = max === min ? 0.5 : (point.avgPrice - min) / (max - min);
    const y = height - padY - ratio * plotHeight;
    ctx.lineTo(x, y);
  });
  
  ctx.lineTo(padX + plotWidth, height - padY);
  ctx.closePath();
  ctx.fill();

  // Draw line
  const grad = ctx.createLinearGradient(0, padY, 0, height - padY);
  grad.addColorStop(0, '#e9c176');
  grad.addColorStop(1, '#997735');
  ctx.strokeStyle = grad;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
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

  ctx.fillStyle = '#d7d9d8';
  ctx.font = '600 14px Manrope';
  ctx.textAlign = 'right';
  ctx.fillText(euro(min), padX - 12, height - padY + 4);
  ctx.fillText(euro(max), padX - 12, padY + 4);
  ctx.textAlign = 'left';
}

function drawHistogram(canvas, bins) {
  const { ctx, width, height } = getCanvasDrawContext(canvas);

  if (!bins.length) {
    ctx.fillStyle = '#c4c7c7';
    ctx.fillText('No histogram data yet', 12, 20);
    return;
  }

  const maxCount = Math.max(...bins.map((bin) => bin.count), 1);
  const padLeft = 68;
  const padRight = 18;
  const padTop = 34;
  const padBottom = 78;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const slotWidth = plotWidth / bins.length;
  const barWidth = Math.max(6, slotWidth - 10);

  ctx.strokeStyle = '#434747';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padLeft, padTop);
  ctx.lineTo(padLeft, height - padBottom);
  ctx.lineTo(width - padRight, height - padBottom);
  ctx.stroke();

  const tickValues = Array.from(new Set([0, Math.ceil(maxCount / 2), maxCount]));
  tickValues.forEach((tick) => {
    const ratio = maxCount === 0 ? 0 : tick / maxCount;
    const y = height - padBottom - ratio * plotHeight;

    ctx.strokeStyle = 'rgba(142, 145, 145, 0.18)';
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(width - padRight, y);
    ctx.stroke();

    ctx.fillStyle = '#a7acac';
    ctx.font = '600 12px Inter';
    ctx.textAlign = 'right';
    ctx.fillText(String(tick), padLeft - 8, y + 3);
  });

  bins.forEach((bin, index) => {
    const x = padLeft + index * slotWidth + (slotWidth - barWidth) / 2;
    const barHeight = (bin.count / maxCount) * (plotHeight - 6);
    const y = height - padBottom - barHeight;

    const barGrad = ctx.createLinearGradient(0, y, 0, height - padBottom);
    barGrad.addColorStop(0, '#95d3ba');
    barGrad.addColorStop(1, '#0b513d');

    ctx.fillStyle = barGrad;
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, barHeight, [4, 4, 0, 0]);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, barWidth, barHeight);
    }

    ctx.fillStyle = '#e5e2e1';
    ctx.font = '700 13px Inter';
    ctx.textAlign = 'center';
    const countLabelY = Math.max(12, y - 10);
    ctx.fillText(String(bin.count), x + barWidth / 2, countLabelY);

    ctx.fillStyle = '#a7acac';
    ctx.font = '600 12px Inter';
    const labelRowOffset = index % 2 === 0 ? 0 : 14;
    ctx.fillText(compactRangeLabel(bin.min, bin.max), x + barWidth / 2, height - padBottom + 18 + labelRowOffset);
  });

  ctx.fillStyle = '#8e9191';
  ctx.font = '600 12px Inter';
  ctx.save();
  ctx.translate(16, padTop + plotHeight / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillText('Count', 0, 0);
  ctx.restore();
  ctx.textAlign = 'center';
  ctx.fillText('Price range (EUR)', padLeft + plotWidth / 2, height - 8);
  ctx.textAlign = 'left';
}

function renderHistogramSummary(bins) {
  if (!elements.histSummaryLabel) {
    return;
  }

  if (!bins.length) {
    elements.histSummaryLabel.textContent = 'No distribution data for current filters.';
    return;
  }

  const totalListings = bins.reduce((acc, bin) => acc + (Number(bin.count) || 0), 0);
  const minPrice = Math.max(0, Math.min(...bins.map((bin) => Number(bin.min)).filter(Number.isFinite)));
  const maxPrice = Math.max(0, Math.max(...bins.map((bin) => Number(bin.max)).filter(Number.isFinite)));

  elements.histSummaryLabel.textContent = `${totalListings} listings from ${compactEuro(minPrice)} to ${compactEuro(maxPrice)}. Each bar shows how many listings fall inside that price range.`;
}

function renderSummary(summary) {
  elements.statActive.textContent = String(summary.totalActive ?? '-');
  elements.statNew.textContent = String(summary.latestRunChanges?.new ?? 0);

  const changed = (summary.latestRunChanges?.price_changed || 0) + (summary.latestRunChanges?.attributes_changed || 0);
  elements.statChanged.textContent = String(changed);
  elements.statRemoved.textContent = String(summary.latestRunChanges?.removed ?? 0);

  if (elements.avgCurrentValue) {
    elements.avgCurrentValue.textContent = euro(summary.avgPriceCurrent);
  }

  drawLineChart(elements.avgChart, summary.avgPriceTimeline || []);
  const bins = summary.priceHistogram || [];
  drawHistogram(elements.histChart, bins);
  renderHistogramSummary(bins);
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
    let liBorderClass = "border-zinc-500";
    if (item.changeType === "new") liBorderClass = "border-secondary";
    else if (item.changeType === "price_changed") liBorderClass = "border-primary";
    else if (item.changeType === "attributes_changed") liBorderClass = "border-yellow-500";
    else if (item.changeType === "removed") liBorderClass = "border-error";

    li.className = `flex flex-col gap-1 p-4 rounded-lg bg-zinc-900/30 items-start border-l-2 mb-4 shadow-[0_2px_10px_rgba(0,0,0,0.2)] ${liBorderClass}`;

    const title = item.title || item.listingId;
    const link = item.detailUrl ? `<a href="${item.detailUrl}" target="_blank" rel="noreferrer" class="text-primary hover:underline font-bold">open listing</a>` : 'no url';
    const diffLines = (item.diff || []).slice(0, 6).map((entry) => `<li>${diffToText(entry)}</li>`).join('');

    li.innerHTML = `
      <strong class="text-sm font-bold uppercase tracking-wider text-white mb-1">${item.changeType}</strong> - ${title}
      <div class="text-xs text-zinc-500 mt-1">${formatSiteName(item.siteId)} | run ${item.runId} | ${formatDate(item.createdAt)} | ${link}</div>
      ${diffLines ? `<ul class="text-xs text-zinc-400 mt-2 pl-4 list-disc marker:text-zinc-600">${diffLines}</ul>` : ''}
    `;

    elements.changeLog.appendChild(li);
  }
}

function renderListingsTable(items) {
  elements.listingsBody.innerHTML = '';

  if (!items.length) {
    elements.listingsBody.innerHTML = '<tr><td colspan="11">No listings match these filters.</td></tr>';
    return;
  }

  items.forEach((item, index) => {
    const row = document.createElement('tr');
    const key = listingKey(item);
    const isWatched = state.watchlist.has(key);

    row.className = "hover:bg-white/5 transition-colors group";
    row.innerHTML = `
      <td class="px-6 py-4 items-center justify-start text-sm text-zinc-400">
        <button type="button" class="text-lg focus:outline-none transition-colors ${isWatched ? 'text-yellow-400' : 'text-zinc-600 hover:text-yellow-400'}" data-watch-key="${key}" title="Toggle watchlist">${isWatched ? '★' : '☆'}</button>
      </td>
      <td class="px-6 py-4 text-sm text-zinc-400 font-semibold">${formatSiteName(item.siteId)}</td>
      <td class="px-6 py-4 text-sm text-zinc-400 font-semibold">${item.title || '-'}</td>
      <td class="px-6 py-4 text-sm text-zinc-400">${item.location || '-'}</td>
      <td class="px-6 py-4 text-right font-manrope text-on-surface font-bold text-sm">${euro(item.priceNum)}</td>
      <td class="px-6 py-4 text-sm text-zinc-400">${item.size || '-'}</td>
      <td class="px-6 py-4 text-sm text-zinc-400">${item.bedrooms == null ? '-' : item.bedrooms}</td>
      <td class="px-6 py-4 text-sm text-zinc-400">${item.bathrooms == null ? '-' : item.bathrooms}</td>
      <td class="px-6 py-4 text-sm text-zinc-400">${formatDate(item.firstSeen)}</td>
      <td class="px-6 py-4 text-sm text-zinc-400"><canvas class="sparkline bg-transparent" id="spark_${index}" width="100" height="30"></canvas></td>
      <td class="px-6 py-4 text-sm text-zinc-400">
        ${item.detailUrl ? `<a href="${item.detailUrl}" target="_blank" rel="noreferrer" class="bg-surface-container-highest px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-primary hover:text-on-primary transition-all inline-block text-center border border-white/5 text-on-surface">View</a>` : '-'}
      </td>
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
    ctx.fillStyle = '#434747';
    ctx.fillRect(0, height / 2, width, 1);
    return;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);

  ctx.strokeStyle = '#e9c176';
  ctx.lineWidth = 1.7;
  ctx.lineJoin = 'round';
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
    marker.bindPopup(`<strong>${item.title || item.listingId}</strong><br>${item.location}<br>${euro(item.priceNum)}<br>${detailLink}`);
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
  const params = new URLSearchParams();
  appendActiveFilters(params);
  const summary = await fetchJson(`/api/summary?${params.toString()}`);
  renderSummary(summary);
}

async function loadChanges() {
  const params = new URLSearchParams();
  appendActiveFilters(params);
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
    state.filters.bathrooms = elements.bathroomsFilter.value;
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
  elements.bathroomsFilter.addEventListener('change', update);
  elements.watchlistOnly.addEventListener('change', update);
}

async function loadOptions() {
  const options = await fetchJson('/api/options');
  const sites = options.sites || [];
  const bedrooms = Array.isArray(options.bedrooms) ? options.bedrooms : [];
  const bathrooms = Array.isArray(options.bathrooms) ? options.bathrooms : [];

  for (const site of sites) {
    const option = document.createElement('option');
    option.value = site;
    option.textContent = formatSiteName(site);
    elements.siteFilter.appendChild(option);
  }

  populateCountSelect(elements.bedroomsFilter, bedrooms);
  populateCountSelect(elements.bathroomsFilter, bathrooms);

  if (options.priceRange) {
    if (Number.isFinite(options.priceRange.min)) {
      elements.priceMinFilter.placeholder = String(options.priceRange.min);
    }
    if (Number.isFinite(options.priceRange.max)) {
      elements.priceMaxFilter.placeholder = String(options.priceRange.max);
    }
  }
}

function populateCountSelect(selectElement, values) {
  const previous = selectElement.value;
  selectElement.innerHTML = '<option value="">Any</option>';

  const uniqueSorted = Array.from(new Set(values.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0 && value <= 20)))
    .sort((a, b) => a - b);

  for (const value of uniqueSorted) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = String(value);
    selectElement.appendChild(option);
  }

  if (previous && uniqueSorted.includes(Number(previous))) {
    selectElement.value = previous;
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
  } catch (error) {
    console.error('Failed to load /api/options. Continuing with default filters.', error);
    elements.lastRefreshLabel.textContent = 'Filters unavailable; loading data...';
  }

  try {
    await refreshAll();
  } catch (error) {
    console.error(error);
    alert(`Dashboard failed to load data: ${error.message}`);
  }
}

boot();
