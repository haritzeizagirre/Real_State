const crypto = require('crypto');
const { chromium } = require('playwright');

const START_URL = 'https://inmobiliariaiparralde.com/';

function clean(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function deriveStableId(detailUrl) {
  const match = detailUrl.match(/\/inmuebles\/inmueble_detalles\/([^/?#]+)/i);
  if (match) {
    return `inmueble_${match[1]}`;
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
    reference: firstNonEmptyString(base.reference, extra.reference),
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

    const detailTitle = normalize((document.querySelector('h1, h2') || {}).textContent || '');

    const summaryHeading = Array.from(document.querySelectorAll('h1,h2,h3,h4')).find((node) => /resumen del inmueble/i.test(normalize(node.textContent)));
    let summaryText = '';
    if (summaryHeading) {
      const parts = [];
      let cursor = summaryHeading.nextElementSibling;
      while (cursor && parts.length < 5) {
        const text = normalize(cursor.textContent);
        if (/caracter[ií]sticas del inmueble|contacta con un agente|b[úu]squeda avanzada/i.test(text)) {
          break;
        }
        if (text) {
          parts.push(text);
        }
        cursor = cursor.nextElementSibling;
      }
      summaryText = normalize(parts.join(' '));
    }

    const descriptionHeading = Array.from(document.querySelectorAll('h1,h2,h3,h4')).find((node) => /descripci[oó]n del inmueble/i.test(normalize(node.textContent)));
    let description = '';
    if (descriptionHeading) {
      const parts = [];
      let cursor = descriptionHeading.nextElementSibling;
      while (cursor && parts.length < 3) {
        const text = normalize(cursor.textContent);
        if (/resumen del inmueble|caracter[ií]sticas del inmueble/i.test(text)) {
          break;
        }
        if (text) {
          parts.push(text);
        }
        cursor = cursor.nextElementSibling;
      }
      description = normalize(parts.join(' '));
    }

    if (!description) {
      description = normalize((document.querySelector('.description, .property-description, .detail-paragraph') || {}).textContent || '');
    }

    const transactionRaw = normalize((document.querySelector('.feature') || {}).textContent || '');
    const transactionSource = normalize(`${transactionRaw} ${summaryText} ${description} ${detailTitle}`).toLowerCase();
    const transactionType = /\b(alquiler|rent|to let|arrenda)\b/.test(transactionSource)
      ? 'rent'
      : /\b(venta|sale|for sale|vender)\b/.test(transactionSource)
        ? 'sale'
        : '';

    const referenceMatch = `${summaryText} ${description}`.match(/\b(?:referencia|ref\.?|id)\b\s*[:#-]?\s*([A-Za-z0-9_-]+)/i);
    const fallbackRef = (url.match(/\/inmuebles\/inmueble_detalles\/([^/?#]+)/i) || [])[1] || '';
    const reference = normalize(referenceMatch ? referenceMatch[1] : fallbackRef);

    const sizeMatch = `${summaryText} ${description} ${detailTitle}`.match(/(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:m²|m2)\b/i);
    const size = normalize(sizeMatch ? `${sizeMatch[1]} m2` : '');

    const scopedFacts = `${summaryText} ${description} ${detailTitle}`;
    const bedrooms = readInt(/\b(\d+)\s*(?:hab(?:itaciones?)?|dorm(?:itorios?)?)\b/i, scopedFacts)
      ?? readInt(/\b(?:hab(?:itaciones?)?|dorm(?:itorios?)?)\s*(\d+)\b/i, scopedFacts);
    const bathrooms = readInt(/\b(\d+)\s*(?:bañ(?:o|os)|ban(?:o|os)|aseos?)\b/i, scopedFacts)
      ?? readInt(/\b(?:bañ(?:o|os)|ban(?:o|os)|aseos?)\s*(\d+)\b/i, scopedFacts);
    const garages = readInt(/\b(\d+)\s*(?:garajes?|garaje|plazas?\s+de\s+parking|parking)\b/i, scopedFacts)
      ?? readInt(/\b(?:garajes?|garaje|plazas?\s+de\s+parking|parking)\s*(\d+)\b/i, scopedFacts);

    const imageUrl = normalize(
      (document.querySelector('meta[property="og:image"]') || {}).content
      || (document.querySelector('.owl-carousel .item img, .property-slider img, img') || {}).src
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

    const rows = Array.from(document.querySelectorAll('.property-list-list')).filter((row) => {
      const style = window.getComputedStyle(row);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });

    return rows
      .map((row) => {
        const detailAnchors = Array.from(row.querySelectorAll('a[href*="/inmuebles/inmueble_detalles/"]'));
        const detailUrl = detailAnchors.length ? detailAnchors[0].href : '';

        const heading = row.querySelector('h3, h4');
        const title = normalize(
          heading
            ? heading.textContent
            : detailAnchors.map((a) => a.textContent).find((t) => normalize(t) && !/ver detalles/i.test(t)) || ''
        );

        const locationParagraph =
          Array.from(row.querySelectorAll('p'))
            .map((p) => normalize(p.textContent))
            .find((txt) => /\d{5}\s+[^,]+,\s*[A-Z]{2}/.test(txt)) || '';

        const priceNode = row.querySelector('.price');
        const rowText = normalize(row.textContent);
        const fallbackPriceMatch = rowText.match(/(\d{1,3}(?:\.\d{3})*,\d{2}\s*€|Precio\s+consultar)/i);
        const price = normalize(priceNode ? priceNode.textContent : fallbackPriceMatch ? fallbackPriceMatch[1] : '');

        const referenceMatch = rowText.match(/\b(?:ref(?:erencia)?|id)\b\s*[:#-]?\s*([A-Za-z0-9_-]+)/i);
        const detailRefMatch = detailUrl.match(/\/inmuebles\/inmueble_detalles\/([^/?#]+)/i);
        const reference = normalize(referenceMatch ? referenceMatch[1] : detailRefMatch ? detailRefMatch[1] : '');

        const paragraphTexts = Array.from(row.querySelectorAll('p')).map((p) => normalize(p.textContent));
        const description =
          paragraphTexts.find((txt) => txt && txt !== locationParagraph && txt !== price && txt.length > 20)
          || '';

        const transactionType = /\b(alquiler|arrenda|rent|to let)\b/i.test(rowText)
          ? 'rent'
          : /\b(venta|sale|for sale|vender)\b/i.test(rowText)
            ? 'sale'
            : '';

        const sizeMatch = rowText.match(/(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:m²|m2)\b/i);
        const size = normalize(sizeMatch ? `${sizeMatch[1]} m2` : '');

        const bedrooms = readInt(/\b(\d+)\s*(?:hab(?:itaciones?)?|dorm(?:itorios?)?|bed(?:rooms?)?)\b/i, rowText);
        const bathrooms = readInt(/\b(\d+)\s*(?:bañ(?:o|os)|ban(?:o|os)|bath(?:room|rooms)?)\b/i, rowText);
        const garages = readInt(/\b(\d+)\s*(?:garajes?|garaje|plazas?\s+de\s+garaje|parking)\b/i, rowText);

        const imageNode = row.querySelector('img');
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
          location: normalize(locationParagraph),
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
  const currentLink = page.locator('.easyPaginateNav a.current').first();
  if (!(await currentLink.count())) {
    return false;
  }

  const currentRel = await currentLink.getAttribute('rel');
  const currentPage = Number(currentRel || '0');
  if (!Number.isFinite(currentPage) || currentPage <= 0) {
    return false;
  }

  const nextPage = currentPage + 1;
  const nextLink = page.locator(`.easyPaginateNav a.page[rel="${nextPage}"]`).first();
  if (!(await nextLink.count())) {
    return false;
  }

  await nextLink.click();
  await page.waitForFunction(
    (expectedPage) => {
      const active = document.querySelector('.easyPaginateNav a.current');
      return !!active && active.getAttribute('rel') === String(expectedPage);
    },
    nextPage,
    { timeout: 10000 }
  );

  await page.waitForTimeout(250);
  return true;
}

const iparraldeAdapter = {
  siteId: 'iparralde',

  /**
   * @param {{propertyType?: string, municipality?: string, maxPages?: number, headless?: boolean}} params
   */
  async list(params = {}) {
    const propertyType = clean(params.propertyType || 'piso');
    const municipality = clean(params.municipality || 'Hendaye');
    const maxPages = Number.isFinite(Number(params.maxPages)) ? Number(params.maxPages) : 25;
    const detailEnrichment = params.detailEnrichment !== false;
    const maxDetailListings = Number.isFinite(Number(params.maxDetailListings)) ? Math.max(0, Number(params.maxDetailListings)) : 60;
    const headless = params.headless !== false;

    const browser = await chromium.launch({ headless });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);

      const searchForm = page.locator('form.findus').first();
      await searchForm.locator('select[name="tipoInmueble[]"]').selectOption(propertyType);
      await searchForm.locator('select[name="municipio[]"]').selectOption(municipality);

      await Promise.all([
        page.waitForLoadState('domcontentloaded'),
        searchForm.locator('button[type="submit"]').click(),
      ]);

      await page.waitForFunction(() => document.querySelectorAll('.property-list-list').length > 0, null, {
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
              // Keep partial listing data if a detail page fails.
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
  iparraldeAdapter,
};
