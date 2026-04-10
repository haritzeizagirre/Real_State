function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatValue(value) {
  if (value === null || value === undefined || value === '') {
    return '<i>empty</i>';
  }
  return `<code>${escapeHtml(String(value))}</code>`;
}

function getDiffValue(event, field) {
  const diffs = Array.isArray(event.diff) ? event.diff : [];
  for (const diff of diffs) {
    if (diff.field !== field) {
      continue;
    }
    if (diff.new !== null && diff.new !== undefined && diff.new !== '') {
      return diff.new;
    }
    if (diff.old !== null && diff.old !== undefined && diff.old !== '') {
      return diff.old;
    }
  }
  return '';
}

function resolveApartmentInfo(event) {
  const apartment = event.apartment || {};
  return {
    title: apartment.title || getDiffValue(event, 'title') || 'Untitled apartment',
    location: apartment.location || getDiffValue(event, 'location') || 'Location not available',
    price: apartment.price || getDiffValue(event, 'price') || 'Price not available',
    detailUrl: apartment.detailUrl || getDiffValue(event, 'detailUrl') || '',
  };
}

function changeTypeLabel(changeType) {
  switch (changeType) {
    case 'new':
      return 'New apartment';
    case 'price_changed':
      return 'Price update';
    case 'attributes_changed':
      return 'Details updated';
    case 'removed':
      return 'Apartment removed';
    case 'reappeared':
      return 'Apartment reappeared';
    default:
      return 'Apartment updated';
  }
}

function summarizeChange(event) {
  const diffs = Array.isArray(event.diff) ? event.diff : [];
  if (event.changeType === 'price_changed') {
    const priceDiff = diffs.find((diff) => diff.field === 'price');
    const priceNumDiff = diffs.find((diff) => diff.field === 'price_num');
    const oldValue = priceDiff ? priceDiff.old : priceNumDiff ? priceNumDiff.old : null;
    const newValue = priceDiff ? priceDiff.new : priceNumDiff ? priceNumDiff.new : null;
    return `Price changed from ${formatValue(oldValue)} to ${formatValue(newValue)}.`;
  }

  if (event.changeType === 'new') {
    return 'A new apartment was detected.';
  }

  if (event.changeType === 'removed') {
    return 'This apartment has been marked as removed after consecutive misses.';
  }

  if (event.changeType === 'reappeared') {
    return 'This apartment is available again.';
  }

  const changedFields = diffs
    .map((diff) => diff.field)
    .filter((field) => !['title', 'location', 'price', 'price_num', 'detailUrl', 'state'].includes(field));

  if (changedFields.length > 0) {
    return `Updated fields: <code>${escapeHtml(changedFields.join(', '))}</code>.`;
  }

  return 'Apartment details were updated.';
}

function formatChangeBlock(event) {
  const apartment = resolveApartmentInfo(event);
  const lines = [
    `<b>${escapeHtml(changeTypeLabel(event.changeType))}</b>`,
    `Title: <b>${escapeHtml(apartment.title)}</b>`,
    `Location: ${escapeHtml(apartment.location)}`,
    `Price: ${escapeHtml(apartment.price)}`,
    apartment.detailUrl && /^https?:\/\//i.test(String(apartment.detailUrl))
      ? `URL: <a href="${escapeHtml(String(apartment.detailUrl))}">open listing</a>`
      : `URL: ${formatValue(apartment.detailUrl)}`,
    `Ref: <code>${escapeHtml(event.listingId)}</code>`,
    summarizeChange(event),
  ];

  if (event.changeType === 'attributes_changed') {
    const importantDiffs = (event.diff || []).filter((diff) => ['title', 'location', 'detailUrl'].includes(diff.field));
    if (importantDiffs.length > 0) {
      lines.push('What changed:');
      for (const diff of importantDiffs.slice(0, 4)) {
        lines.push(`- ${escapeHtml(diff.field)}: ${formatValue(diff.old)} → ${formatValue(diff.new)}`);
      }
    }
  }

  return lines.join('\n');
}

function buildMessage(siteId, report) {
  const lines = [
    '<b>Real_State changes detected</b>',
    `Site: <b>${escapeHtml(siteId)}</b>`,
    report.runId ? `Run: <code>${escapeHtml(report.runId)}</code>` : null,
    `Listings found: <b>${escapeHtml(report.listingsFound)}</b>`,
    `Total changes: <b>${escapeHtml(report.totalChanges)}</b>`,
    '',
    '<b>Details</b>',
  ].filter(Boolean);

  const events = Array.isArray(report.changes) ? report.changes : [];
  const shownEvents = events.slice(0, 12);
  for (const event of shownEvents) {
    lines.push(formatChangeBlock(event));
    lines.push('');
  }

  if (events.length > shownEvents.length) {
    lines.push(`<i>${events.length - shownEvents.length} more change events omitted</i>`);
  }

  let text = lines.join('\n').trim();
  if (text.length > 3900) {
    text = `${text.slice(0, 3900)}\n\n<i>message truncated</i>`;
  }

  return text;
}

async function sendTelegramMessage(params) {
  const response = await fetch(`https://api.telegram.org/bot${params.botToken}/sendMessage`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: params.chatId,
      text: params.text,
      parse_mode: 'HTML',
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok !== true) {
    const detail = payload && payload.description ? payload.description : `${response.status} ${response.statusText}`;
    throw new Error(`Telegram sendMessage failed: ${detail}`);
  }

  return payload;
}

async function notifyChanges(params) {
  if (!params.enabled) {
    return { sent: false, reason: 'disabled' };
  }
  if (params.dryRun) {
    return { sent: false, reason: 'dry-run' };
  }
  if (!params.report || params.report.totalChanges <= 0) {
    return { sent: false, reason: 'no-changes' };
  }

  const botToken = params.botToken || process.env.BOT_TOKEN || process.env.BOT_API_KEY;
  const chatId = params.chatId || process.env.TELEGRAM_USER_ID;
  if (!botToken || !chatId) {
    return { sent: false, reason: 'missing-credentials' };
  }

  const text = buildMessage(params.siteId, params.report);
  await sendTelegramMessage({ botToken, chatId, text });
  return { sent: true };
}

module.exports = {
  notifyChanges,
};
