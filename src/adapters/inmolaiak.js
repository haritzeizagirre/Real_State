const crypto = require('crypto');
const { chromium } = require('playwright');

const DEFAULT_START_URL = 'https://www.inmolaiak.com/find/?buy_op=selling';

function clean(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function deriveStableId(detailUrl) {
  const idMatch = detailUrl.match(/\/house\/(\d+)(?:-|\/|$)/i);
  if (idMatch) {
    return `house_${idMatch[1]}`;
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

    const normalized = clean(value);
    if (normalized) {
      return normalized;
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

async function acceptCookiesIfVisible(page) {
  const buttons = [
    page.getByRole('button', { name: /acceptar todas|aceptar todas|accept all/i }).first(),
    page.getByRole('button', { name: /acceptar|aceptar|accept/i }).first(),
  ];

  for (const button of buttons) {
    if (!(await button.count())) {
      continue;
    }

    try {
      await button.click({ timeout: 2000 });
      return;
    } catch {
      // Cookie modal is optional and can vary by locale.
    }
  }
}

async function scrapeVisiblePageListings(page, scrapingTimestamp) {
  return page.evaluate((timestamp) => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();

    const deriveTitleFromUrl = (url) => {
      const match = normalize(url).match(/\/house\/\d+-([^/?#]+?)(?:-\d+)?\/?$/i);
      if (!match) {
        return '';
      }
      return normalize(match[1].replace(/-/g, ' ').replace(/\s+\d+eur$/i, ''));
    };

    const deriveLocationFromUrl = (url) => {
      const normalizedUrl = normalize(url);
      const primary = normalizedUrl.match(/-en-(?:venta|alquiler)-en-([^-]+(?:-[^-]+)*)-de-\d+-m2-/i);
      if (primary) {
        return normalize(primary[1]);
      }

      const fallback = normalizedUrl.match(/-en-([^-]+(?:-[^-]+)*)-de-\d+-m2-/i);
      return normalize(fallback ? fallback[1] : '');
    };

    const deriveTransactionFromUrl = (url) => {
      const source = normalize(url).toLowerCase();
      if (/\b(en-alquiler|alquiler|rent|for-rent|renting)\b/.test(source)) {
        return 'rent';
      }
      if (/\b(en-venta|venta|sale|for-sale|selling)\b/.test(source)) {
        return 'sale';
      }
      return '';
    };

    const parseIntFrom = (pattern, source) => {
      const match = source.match(pattern);
      if (!match) {
        return null;
      }

      const parsed = Number(match[1]);
      return Number.isFinite(parsed) ? Math.round(parsed) : null;
    };

    const cards = Array.from(document.querySelectorAll('a.house-web-block[href*="/house/"]')).filter((card) => {
      const style = window.getComputedStyle(card);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });

    return cards
      .map((card) => {
        const detailUrl = card.href || '';
        const cardText = normalize(card.textContent);

        const titleNode = card.querySelector('h3,h4,.tw-text-lg,.tw-font-semibold');
        const title = normalize(titleNode ? titleNode.textContent : deriveTitleFromUrl(detailUrl));

        const priceNode = card.querySelector('.tw-text-primary-main, .house-web-price, [class*="price"]');
        const priceMatch = cardText.match(/(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?\s*€)/i);
        const price = normalize(priceNode ? priceNode.textContent : priceMatch ? priceMatch[1] : '');

        const locationMatch = cardText.match(/([^\n]+?)\s*See map/i);
        const location = normalize(locationMatch ? locationMatch[1] : deriveLocationFromUrl(detailUrl).replace(/-/g, ' '));

        const transactionSource = normalize(`${title} ${cardText}`).toLowerCase();
        const transactionType = deriveTransactionFromUrl(detailUrl)
          || (/\b(alquiler|rent|for rent|to let|renting)\b/.test(transactionSource)
            ? 'rent'
            : /\b(venta|sale|for sale|selling)\b/.test(transactionSource)
              ? 'sale'
              : '');

        const referenceMatch = cardText.match(/\bref\.?\s*[:#-]?\s*([A-Za-z0-9_-]+)/i);
        const urlRefMatch = detailUrl.match(/-(\d+)(?:\/?$)/);
        const reference = normalize(referenceMatch ? referenceMatch[1] : urlRefMatch ? urlRefMatch[1] : '');

        const sizeMatch = cardText.match(/(\d{1,4}(?:[.,]\d{1,2})?)\s*m2\b/i);
        const size = normalize(sizeMatch ? `${sizeMatch[1]} m2` : '');

        const bedrooms = parseIntFrom(/\b(\d+)\s*(?:hab\.?|habitaciones?|rooms?)\b/i, cardText);
        const bathrooms = parseIntFrom(/\b(\d+)\s*(?:ba(?:ñ|n)\.?|bañ(?:o|os)|ban(?:o|os)|bath(?:room|rooms)?)\b/i, cardText)
          ?? parseIntFrom(/\b(\d+)\s*ba\w*/i, cardText);

        const garages = parseIntFrom(/\b(\d+)\s*(?:plazas?\s+de\s+garaje|garajes?|parking)\b/i, cardText)
          ?? (/\b(plaza\s+de\s+garaje\s+incluida|garaje|parking)\b/i.test(cardText) ? 1 : null);

        const imageNode = card.querySelector('img');
        const imageUrl = normalize(
          imageNode
            ? imageNode.getAttribute('data-src')
              || imageNode.getAttribute('src')
              || imageNode.getAttribute('data-lazy-src')
              || ''
            : ''
        );

        return {
          title,
          price,
          location,
          detailUrl,
          reference,
          description: '',
          transactionType,
          size,
          bedrooms,
          bathrooms,
          garages,
          imageUrl,
          scrapedAt: timestamp,
        };
      })
      .filter((listing) => !!listing.detailUrl);
  }, scrapingTimestamp);
}

async function scrapeListingDetail(detailPage, detailUrl) {
  await detailPage.goto(detailUrl, { waitUntil: 'domcontentloaded' });
  await detailPage.waitForTimeout(600);

  return detailPage.evaluate((url) => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const toNullableNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

    const deriveTransactionFromUrl = (sourceUrl) => {
      const source = normalize(sourceUrl).toLowerCase();
      if (/\b(en-alquiler|alquiler|rent|for-rent|renting)\b/.test(source)) {
        return 'rent';
      }
      if (/\b(en-venta|venta|sale|for-sale|selling)\b/.test(source)) {
        return 'sale';
      }
      return '';
    };

    const readInt = (pattern, source) => {
      const match = normalize(source).match(pattern);
      if (!match) {
        return null;
      }

      const parsed = Number(match[1]);
      return Number.isFinite(parsed) ? Math.round(parsed) : null;
    };

    const pageText = normalize(document.body ? document.body.textContent : '');
    const heading = normalize((document.querySelector('h1') || {}).textContent || '');

    const descriptionHeading = Array.from(document.querySelectorAll('h1,h2,h3,h4')).find((node) => /property description|descripci[oó]n/i.test(normalize(node.textContent)));
    let description = '';
    if (descriptionHeading) {
      const parts = [];
      let cursor = descriptionHeading.nextElementSibling;
      while (cursor && parts.length < 8) {
        const text = normalize(cursor.textContent);
        if (!text) {
          cursor = cursor.nextElementSibling;
          continue;
        }

        if (/property features|energy certification|property location|contact/i.test(text)) {
          break;
        }

        parts.push(text);
        cursor = cursor.nextElementSibling;
      }

      description = normalize(parts.join(' '));
    }

    if (!description) {
      description = normalize(
        (document.querySelector('.ad-detail-description, .property-description, [class*="description"]') || {}).textContent || ''
      );
    }

    const referenceMatch = pageText.match(/\bref\.?\s*[:#-]?\s*([A-Za-z0-9_-]+)/i);
    const fallbackReference = (url.match(/-(\d+)(?:\/?$)/) || [])[1] || '';
    const reference = normalize(referenceMatch ? referenceMatch[1] : fallbackReference);

    const transactionSource = normalize(`${heading} ${pageText}`).toLowerCase();
    const transactionType = deriveTransactionFromUrl(url)
      || (/\b(venta|sale|for sale|selling)\b/.test(transactionSource)
        ? 'sale'
        : /\b(alquiler|rent|for rent|to let|renting)\b/.test(transactionSource)
          ? 'rent'
          : '');

    const sizeMatch = `${heading} ${pageText}`.match(/(?:\barea\b\s*:?\s*)?(\d{1,4}(?:[.,]\d{1,2})?)\s*m2\b/i);
    const size = normalize(sizeMatch ? `${sizeMatch[1]} m2` : '');

    const bedrooms = readInt(/\b(\d+)\s*(?:rooms?|hab\.?|habitaciones?)\b/i, pageText)
      ?? readInt(/\brooms?\s*:?\s*(\d+)\b/i, pageText);

    const bathrooms = readInt(/\b(\d+)\s*(?:ba(?:ñ|n)\.?|bath(?:room|rooms)?|bañ(?:o|os)|ban(?:o|os))\b/i, pageText)
      ?? readInt(/\bbath(?:room|rooms)?\s*:?\s*(\d+)\b/i, pageText)
      ?? readInt(/\b(\d+)\s*ba\w*/i, pageText);

    const garages = readInt(/\b(\d+)\s*(?:plazas?\s+de\s+garaje|garajes?|parking)\b/i, pageText)
      ?? (/\b(plaza\s+de\s+garaje\s+incluida|garaje|parking)\b/i.test(pageText) ? 1 : null);

    const imageUrl = normalize(
      (document.querySelector('meta[property="og:image"]') || {}).content
      || (document.querySelector('img[src*="cloudfront.net/pics/"], .swiper img, .slick-slide img, img') || {}).src
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

async function goToNextPaginationPage(page) {
  const nextButtons = page.locator('.pagination__next');
  const totalButtons = await nextButtons.count();
  if (!totalButtons) {
    return false;
  }

  let nextButton = null;
  for (let index = 0; index < totalButtons; index += 1) {
    const candidate = nextButtons.nth(index);
    const isVisible = await candidate.isVisible().catch(() => false);
    if (!isVisible) {
      continue;
    }

    const className = clean((await candidate.getAttribute('class')) || '');
    const ariaDisabled = clean((await candidate.getAttribute('aria-disabled')) || '').toLowerCase();
    if (ariaDisabled === 'true' || /disabled|cursor-not-allowed|d-none|hidden/.test(className)) {
      continue;
    }

    nextButton = candidate;
    break;
  }

  if (!nextButton) {
    return false;
  }

  const firstCurrentLink = page.locator('a.house-web-block[href*="/house/"]').first();
  const previousFirstUrl = (await firstCurrentLink.count()) ? await firstCurrentLink.getAttribute('href') : '';

  try {
    await nextButton.click({ timeout: 5000 });
  } catch {
    return false;
  }

  try {
    await page.waitForFunction(
      (previousHref) => {
        const anchor = document.querySelector('a.house-web-block[href*="/house/"]');
        if (!anchor || !anchor.getAttribute('href')) {
          return false;
        }
        return !previousHref || anchor.getAttribute('href') !== previousHref;
      },
      previousFirstUrl,
      { timeout: 12000 }
    );
  } catch {
    return false;
  }

  await page.waitForTimeout(250);
  return true;
}

const inmolaiakAdapter = {
  siteId: 'inmolaiak',

  /**
   * @param {{startUrl?: string, maxPages?: number, headless?: boolean}} params
   */
  async list(params = {}) {
    const startUrl = clean(params.startUrl || DEFAULT_START_URL);
    const maxPages = Number.isFinite(Number(params.maxPages)) ? Number(params.maxPages) : 12;
    const detailEnrichment = params.detailEnrichment !== false;
    const maxDetailListings = Number.isFinite(Number(params.maxDetailListings)) ? Math.max(0, Number(params.maxDetailListings)) : 60;
    const headless = params.headless !== false;

    const browser = await chromium.launch({ headless });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2200);
      await acceptCookiesIfVisible(page);

      await page.waitForFunction(() => document.querySelectorAll('a.house-web-block[href*="/house/"]').length > 0, null, {
        timeout: 20000,
      });

      const scrapingTimestamp = new Date().toISOString();
      const byId = new Map();
      const pageSignatures = new Set();
      let pageIndex = 1;

      while (pageIndex <= maxPages) {
        const pageItems = await scrapeVisiblePageListings(page, scrapingTimestamp);
        const signature = pageItems.slice(0, 5).map((item) => item.detailUrl).join('|');
        if (signature && pageSignatures.has(signature)) {
          break;
        }
        if (signature) {
          pageSignatures.add(signature);
        }

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
              // Keep listing-level data if detail extraction fails.
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
  inmolaiakAdapter,
};