const crypto = require('crypto');
const { chromium } = require('playwright');

const START_URL = 'https://mascasainmobiliaria.com/property-type/pisos/';

function clean(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function deriveStableId(detailUrl) {
  const match = detailUrl.match(/\/property\/([^/?#]+)\/?$/i);
  if (match) {
    return `property_${match[1]}`;
  }

  const hash = crypto.createHash('sha1').update(detailUrl).digest('hex').slice(0, 16);
  return `url_${hash}`;
}

function parsePositiveInt(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const rounded = Math.round(parsed);
  return rounded >= 0 ? rounded : null;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }

    const cleaned = clean(value);
    if (cleaned) {
      return cleaned;
    }
  }
  return '';
}

function firstNonNullNumber(...values) {
  for (const value of values) {
    const parsed = parsePositiveInt(value);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function mergeListingWithDetails(base, extra) {
  return {
    ...base,
    reference: firstNonEmptyString(extra.reference, base.reference),
    description: firstNonEmptyString(extra.description, base.description),
    transactionType: firstNonEmptyString(extra.transactionType, base.transactionType),
    size: firstNonEmptyString(extra.size, base.size),
    bedrooms: firstNonNullNumber(extra.bedrooms, base.bedrooms),
    bathrooms: firstNonNullNumber(extra.bathrooms, base.bathrooms),
    garages: firstNonNullNumber(extra.garages, base.garages),
    imageUrl: firstNonEmptyString(extra.imageUrl, base.imageUrl),
  };
}

function needsDetailEnrichment(listing) {
  return !listing.reference
    || !listing.description
    || !listing.transactionType
    || !listing.size
    || listing.bedrooms === null
    || listing.bathrooms === null
    || listing.garages === null
    || !listing.imageUrl;
}

async function scrapeListingDetail(detailPage, detailUrl) {
  await detailPage.goto(detailUrl, { waitUntil: 'domcontentloaded' });
  await detailPage.waitForTimeout(500);

  return detailPage.evaluate((url) => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const toNullableNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

    const readInt = (pattern, source) => {
      const match = normalize(source).match(pattern);
      if (!match) {
        return null;
      }
      const parsed = Number(match[1]);
      return Number.isFinite(parsed) ? Math.round(parsed) : null;
    };

    const readLabelValue = (labelPattern) => {
      const rows = Array.from(document.querySelectorAll('.ere-property-element li, .property-features li, .property-overview li'));
      for (const row of rows) {
        const text = normalize(row.textContent);
        if (!labelPattern.test(text)) {
          continue;
        }

        return text;
      }
      return '';
    };

    const pageText = normalize(document.body ? document.body.textContent : '');
    const infoHeader = normalize((document.querySelector('.property-info-header') || {}).textContent || '');
    const tabsSummary = normalize((document.querySelector('.ere-property-element, .tab-content') || {}).textContent || '');

    const referenceRaw = normalize((document.querySelector('.property-id .content-property-info, .property-id') || {}).textContent || '');
    const referenceFromLabel = readLabelValue(/\breferencia\b/i);
    const referenceFromIdNode = (referenceRaw.match(/^([A-Za-z0-9_-]+)\b/) || [])[1] || '';
    const referenceFromLabelMatch = (referenceFromLabel.match(/\breferencia\b\s*([A-Za-z0-9_-]+)/i) || [])[1] || '';
    const referenceMatch = `${referenceRaw} ${referenceFromLabel} ${tabsSummary}`.match(/\b(?:ref\.?|id)\b\s*[:#-]?\s*([A-Za-z0-9_-]+)/i);
    const fallbackRef = (url.match(/\/property\/([^/?#]+)\/?$/i) || [])[1] || '';
    const reference = normalize(referenceFromIdNode || referenceFromLabelMatch || (referenceMatch ? referenceMatch[1] : '') || fallbackRef);

    const transactionRaw = normalize((document.querySelector('.property-status, .property-label') || {}).textContent || '');
    const operationLine = readLabelValue(/\boperaci[oó]n\b/i);
    const transactionSource = normalize(`${transactionRaw} ${operationLine} ${infoHeader} ${tabsSummary}`).toLowerCase();
    const transactionType = /\b(alquiler|rent|to let|arrenda)\b/.test(transactionSource)
      ? 'rent'
      : /\b(venta|sale|for sale|vender)\b/.test(transactionSource)
        ? 'sale'
        : '';

    const sizeRaw = normalize((document.querySelector('.property-area .content-property-info, .property-area') || {}).textContent || '');
    const sizeFromLabel = readLabelValue(/\b(superficie|construido)\b/i);
    const sizeMatch = `${sizeRaw} ${sizeFromLabel} ${infoHeader} ${tabsSummary}`.match(/(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:m²|m2)\b/i);
    const size = normalize(sizeMatch ? `${sizeMatch[1]} m2` : '');

    const bedroomsRaw = normalize((document.querySelector('.property-bedrooms .content-property-info, .property-bedrooms') || {}).textContent || '');
    const bathroomsRaw = normalize((document.querySelector('.property-bathrooms .content-property-info, .property-bathrooms') || {}).textContent || '');
    const bedroomsLabel = readLabelValue(/\b(dormitorios?|habitaciones?)\b/i);
    const bathroomsLabel = readLabelValue(/\bbañ(?:o|os)\b/i);

    const bedrooms = readInt(/(\d+)/, bedroomsRaw)
      ?? readInt(/\b(\d+)\b/, bedroomsLabel)
      ?? readInt(/\b(\d+)\s*(?:dormitorios?|habitaciones?)\b/i, `${infoHeader} ${tabsSummary}`)
      ?? readInt(/\b(?:dormitorios?|habitaciones?)\s*(\d+)\b/i, `${infoHeader} ${tabsSummary}`);

    const bathrooms = readInt(/(\d+)/, bathroomsRaw)
      ?? readInt(/\b(\d+)\b/, bathroomsLabel)
      ?? readInt(/\b(\d+)\s*bañ(?:o|os)\b/i, `${infoHeader} ${tabsSummary}`)
      ?? readInt(/\bbañ(?:o|os)\s*(\d+)\b/i, `${infoHeader} ${tabsSummary}`);

    const garageLine = readLabelValue(/\b(garaje|garajes|parking|plaza)\b/i);
    const garages = readInt(/\b(\d+)\b/, garageLine)
      ?? (/(\bgaraje\b|\bgarajes\b|\bparking\b|\bplaza\b)/i.test(garageLine) ? 1 : null);

    const description = normalize(
      (document.querySelector('.property-content .tab-pane.active p, .property-content .tab-pane p, .single-property-element.property-description p, .property-description p') || {}).textContent
      || ''
    );

    const imageUrl = normalize(
      (document.querySelector('meta[property="og:image"]') || {}).content
      || (document.querySelector('.single-property-image-main img, .property-main-image img, .entry-content img, img') || {}).src
      || ''
    );

    return {
      reference,
      description,
      transactionType,
      size,
      bedrooms: toNullableNumber(bedrooms),
      bathrooms: toNullableNumber(bathrooms),
      garages: toNullableNumber(garages),
      imageUrl,
    };
  }, detailUrl);
}

async function acceptCookiesIfVisible(page) {
  const buttons = [
    page.getByRole('button', { name: /aceptar todas/i }).first(),
    page.getByRole('button', { name: /aceptar/i }).first(),
  ];

  for (const button of buttons) {
    if (await button.count()) {
      try {
        await button.click({ timeout: 1500 });
        return;
      } catch {
        // Cookie modal can vary and is optional.
      }
    }
  }
}

async function scrapeVisiblePageListings(page, scrapingTimestamp) {
  return page.evaluate((timestamp) => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const readInt = (pattern, source) => {
      const match = source.match(pattern);
      if (!match) {
        return null;
      }
      const parsed = Number(match[1]);
      return Number.isFinite(parsed) ? parsed : null;
    };

    const cards = Array.from(document.querySelectorAll('.ere-item-wrap')).filter((card) => {
      const style = window.getComputedStyle(card);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });

    return cards
      .map((card) => {
        const propertyLink = card.querySelector('a.property-link[href*="/property/"]')
          || card.querySelector('a[href*="/property/"]');

        const detailUrl = propertyLink ? propertyLink.href : '';

        const titleNode = card.querySelector('.property-title a, .property-title, h3 a, h4 a');
        const title = normalize(titleNode ? titleNode.textContent : propertyLink ? propertyLink.getAttribute('title') : '');

        const locationNode = card.querySelector('.property-location, .property-address, .property-city, .property-heading');
        const location = normalize(locationNode ? locationNode.textContent : '');

        const priceNode = card.querySelector('.property-price, .property-item-price, .price');
        const cardText = normalize(card.textContent);
        const fallbackPriceMatch = cardText.match(/(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?\s*€|\d{1,3}(?:[.,]\d{3})*(?:\s*\/\s*\d+)?)/i);
        const price = normalize(priceNode ? priceNode.textContent : fallbackPriceMatch ? fallbackPriceMatch[1] : '');

        const referenceNode = card.querySelector('.property-id, .property-ref, [class*="ref"]');
        const referenceMatch = cardText.match(/\b(?:ref(?:erencia)?|id)\b\s*[:#-]?\s*([A-Za-z0-9_-]+)/i);
        const detailRefMatch = detailUrl.match(/\/property\/([^/?#]+)\/?$/i);
        const reference = normalize(
          referenceNode
            ? referenceNode.textContent
            : referenceMatch
              ? referenceMatch[1]
              : detailRefMatch
                ? detailRefMatch[1]
                : ''
        );

        const descriptionNode = card.querySelector('.property-excerpt, .item-body p, .property-content, .property-description');
        const description = normalize(descriptionNode ? descriptionNode.textContent : '');

        const transactionBadge = card.querySelector('.item-type-wrap, .property-label, .label, .property-status');
        const transactionSource = normalize(transactionBadge ? transactionBadge.textContent : cardText).toLowerCase();
        const transactionType = /\b(alquiler|rent|to let|arrenda)\b/.test(transactionSource)
          ? 'rent'
          : /\b(venta|sale|for sale|vender)\b/.test(transactionSource)
            ? 'sale'
            : '';

        const sizeMatch = cardText.match(/(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:m²|m2)\b/i);
        const size = normalize(sizeMatch ? `${sizeMatch[1]} m2` : '');

        const bedrooms = readInt(/\b(\d+)\s*(?:hab(?:itaciones?)?|dorm(?:itorios?)?|bed(?:rooms?)?)\b/i, cardText);
        const bathrooms = readInt(/\b(\d+)\s*(?:bañ(?:o|os)|ban(?:o|os)|bath(?:room|rooms)?)\b/i, cardText);
        const garages = readInt(/\b(\d+)\s*(?:garajes?|garaje|plazas?\s+de\s+garaje|parking)\b/i, cardText);

        const imageNode = card.querySelector('img');
        const imageUrl = normalize(
          imageNode
            ? imageNode.getAttribute('data-src')
              || imageNode.getAttribute('data-lazy-src')
              || imageNode.getAttribute('src')
              || ''
            : ''
        );

        return {
          title,
          price,
          location,
          detailUrl,
          reference,
          description,
          transactionType,
          size,
          bedrooms,
          bathrooms,
          garages,
          imageUrl,
          scrapedAt: timestamp,
        };
      })
      .filter((item) => item.detailUrl);
  }, scrapingTimestamp);
}

async function goToNextPaginationPage(page) {
  const nextLink = page.locator('a.next.page-numbers, a.page-numbers.next, .pagination a.next').first();
  if (!(await nextLink.count())) {
    return false;
  }

  const currentUrl = page.url();
  await Promise.all([
    page.waitForLoadState('domcontentloaded'),
    nextLink.click(),
  ]);

  await page.waitForFunction(
    (prevUrl) => location.href !== prevUrl,
    currentUrl,
    { timeout: 10000 }
  );

  await page.waitForTimeout(200);
  return true;
}

const mascasaAdapter = {
  siteId: 'mascasa',

  /**
   * @param {{startUrl?: string, maxPages?: number, headless?: boolean}} params
   */
  async list(params = {}) {
    const startUrl = clean(params.startUrl || START_URL);
    const maxPages = Number.isFinite(Number(params.maxPages)) ? Number(params.maxPages) : 10;
    const detailEnrichment = params.detailEnrichment !== false;
    const maxDetailListings = Number.isFinite(Number(params.maxDetailListings)) ? Math.max(0, Number(params.maxDetailListings)) : 60;
    const headless = params.headless !== false;

    const browser = await chromium.launch({ headless });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      await acceptCookiesIfVisible(page);

      await page.waitForFunction(() => document.querySelectorAll('.ere-item-wrap').length > 0, null, {
        timeout: 15000,
      });

      const scrapingTimestamp = new Date().toISOString();
      const byId = new Map();
      let pageIndex = 1;

      while (pageIndex <= maxPages) {
        const pageItems = await scrapeVisiblePageListings(page, scrapingTimestamp);

        for (const item of pageItems) {
          const id = deriveStableId(item.detailUrl);
          if (!byId.has(id)) {
            byId.set(id, {
              id,
              ...item,
              siteId: this.siteId,
            });
          }
        }

        const moved = await goToNextPaginationPage(page);
        if (!moved) {
          break;
        }

        pageIndex += 1;
      }

      if (detailEnrichment && byId.size > 0) {
        const detailPage = await context.newPage();
        let enrichedCount = 0;

        try {
          for (const [id, listing] of byId.entries()) {
            if (enrichedCount >= maxDetailListings) {
              break;
            }
            if (!listing.detailUrl || !needsDetailEnrichment(listing)) {
              continue;
            }

            try {
              const detailData = await scrapeListingDetail(detailPage, listing.detailUrl);
              byId.set(id, mergeListingWithDetails(listing, detailData));
              enrichedCount += 1;
            } catch {
              // Keep card-level data when detail parsing fails.
            }
          }
        } finally {
          await detailPage.close();
        }
      }

      return Array.from(byId.values());
    } finally {
      await browser.close();
    }
  },
};

module.exports = {
  mascasaAdapter,
};
