const crypto = require('crypto');
const { chromium } = require('playwright');

const BASE_URL = 'https://www.inmocolon.com';
const SEARCH_URL = `${BASE_URL}/buscar.php`;
const HOME_URL = `${BASE_URL}/`;

function clean(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function toAbsoluteUrl(urlLike) {
  const value = clean(urlLike);
  if (!value) {
    return '';
  }

  try {
    return new URL(value, BASE_URL).href;
  } catch {
    return '';
  }
}

function deriveStableId(detailUrl) {
  const match = detailUrl.match(/-(\d+)(?:[/?#]|$)/);
  if (match) {
    return `inmocolon_${match[1]}`;
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

function normalizeOperations(rawOperation) {
  const normalized = clean(rawOperation).toLowerCase();

  if (!normalized || ['all', 'both', 'any'].includes(normalized)) {
    return ['Venta', 'Alquiler'];
  }
  if (['sale', 'venta', 'sell'].includes(normalized)) {
    return ['Venta'];
  }
  if (['rent', 'alquiler', 'let'].includes(normalized)) {
    return ['Alquiler'];
  }

  return ['Venta', 'Alquiler'];
}

function buildSearchUrl({ operation, municipality, propertyType, pageNumber }) {
  const params = new URLSearchParams();

  params.set('br', '');
  params.set('o', operation);
  params.set('check_tipo_inmueble[]', propertyType || '');
  params.set('po[]', municipality || '');
  params.set('p', pageNumber > 1 ? String(pageNumber) : '');
  params.set('check_zona[]', municipality || '');
  params.set('md', '');
  params.set('pd', '');
  params.set('ph', '');

  return `${SEARCH_URL}?${params.toString()}`;
}

async function acceptCookiesIfVisible(page) {
  const selectors = [
    '#uso_cookies button',
    'button:has-text("Aceptar todas las cookies")',
    'button:has-text("Aceptar")',
  ];

  for (const selector of selectors) {
    const button = page.locator(selector).first();
    if (!(await button.count())) {
      continue;
    }

    try {
      await button.click({ timeout: 1500 });
      return;
    } catch {
      // Cookie popups are optional and vary by template.
    }
  }
}

async function scrapeSearchPageListings(page, scrapingTimestamp) {
  return page.evaluate((timestamp) => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();

    const toNullableInt = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.round(parsed) : null;
    };

    const readInt = (pattern, source) => {
      const match = source.match(pattern);
      if (!match) {
        return null;
      }
      return toNullableInt(match[1]);
    };

    const cards = Array.from(document.querySelectorAll('.listado5_contendor_inmueble'));

    return cards
      .map((card) => {
        const detailAnchor =
          card.querySelector('a.listado5_contendor_inmueble_datos[href]')
          || card.querySelector('a[href*="/Venta-"]')
          || card.querySelector('a[href*="/Alquiler-"]')
          || card.querySelector('a[href]');

        const detailUrl = detailAnchor ? new URL(detailAnchor.getAttribute('href') || '', location.origin).href : '';

        const title = normalize((card.querySelector('.listado5_contendor_inmueble_datos_titulo') || {}).textContent || '');
        const address = normalize((card.querySelector('.direccion-listado, .listado5_contendor_inmueble_datos_direccion') || {}).textContent || '');
        const titleLocationMatch = title.match(/en\s+(?:venta|alquiler)\s+en\s+(.+)$/i);
        const titleLocation = normalize(titleLocationMatch ? titleLocationMatch[1] : '');
        const listingLocation = normalize([titleLocation, address].filter(Boolean).join(' - '));

        const referenceText = normalize((card.querySelector('.listado5_contendor_inmueble_datos_referencia') || {}).textContent || '');
        const referenceMatch = referenceText.match(/\bref\.?\s*:\s*([A-Za-z0-9-]+)/i);

        const description = normalize((card.querySelector('.listado5_contendor_inmueble_datos_descripcion') || {}).textContent || '');
        const cardText = normalize(card.textContent);

        const allPrices = Array.from(cardText.matchAll(/(\d{1,3}(?:[.\s]\d{3})*(?:,\d{1,2})?\s*€)/g));
        const price = normalize(allPrices.length ? allPrices[allPrices.length - 1][1] : '');

        const transactionType = /\/Alquiler-|\balquiler\b/i.test(detailUrl + ' ' + cardText)
          ? 'rent'
          : /\/Venta-|\bventa\b/i.test(detailUrl + ' ' + cardText)
            ? 'sale'
            : '';

        const sizeSource = `${description} ${title} ${cardText}`;
        const builtSizeMatch = sizeSource.match(/(\d{1,4}(?:[.,]\d{1,2})?)\s*m(?:2|\u00b2)\s*construid[oa]s?/i);
        const anySizeMatch = sizeSource.match(/(\d{1,4}(?:[.,]\d{1,2})?)\s*m(?:2|\u00b2)/i);
        const sizeValue = builtSizeMatch ? builtSizeMatch[1] : anySizeMatch ? anySizeMatch[1] : '';
        const size = normalize(sizeValue ? `${sizeValue} m2` : '');

        const bedrooms = readInt(/\b(\d+)\s*dormitorios?\b/i, sizeSource)
          ?? readInt(/\bdormitorios?\s*(\d+)\b/i, sizeSource);

        const bathrooms =
          readInt(/\b(\d+)\s*ba(?:\u00f1|n)os?\b/i, sizeSource)
          ?? readInt(/\b(\d+)\s*aseos?\b/i, sizeSource)
          ?? readInt(/\bba(?:\u00f1|n)os?\s*(\d+)\b/i, sizeSource)
          ?? readInt(/\baseos?\s*(\d+)\b/i, sizeSource);

        const garages =
          readInt(/\b(\d+)\s*garaje(?:\/s)?\b/i, sizeSource)
          ?? readInt(/\bgaraje(?:\/s)?\s*(\d+)\b/i, sizeSource)
          ?? readInt(/\b(\d+)\s*parking\b/i, sizeSource)
          ?? (/\bgaraje|parking\b/i.test(sizeSource) ? 1 : null);

        const imageNode = card.querySelector('.carousel-item img.foto, img.foto, img');
        const imageUrl = normalize(
          imageNode
            ? imageNode.getAttribute('src')
              || imageNode.getAttribute('data-src')
              || imageNode.getAttribute('data-lazy-src')
              || ''
            : ''
        );

        return {
          title,
          price,
          location: listingLocation,
          detailUrl,
          reference: normalize(referenceMatch ? referenceMatch[1] : ''),
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
      .filter((listing) => listing.detailUrl);
  }, scrapingTimestamp);
}

async function scrapeHomepageFeaturedListings(page, scrapingTimestamp) {
  return page.evaluate((timestamp) => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();

    const toNullableInt = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.round(parsed) : null;
    };

    const readInt = (pattern, source) => {
      const match = source.match(pattern);
      if (!match) {
        return null;
      }
      return toNullableInt(match[1]);
    };

    const cards = Array.from(document.querySelectorAll('#destacados10 .card'));

    return cards
      .map((card) => {
        const onclick = normalize(card.getAttribute('onclick') || '');
        const onclickMatch = onclick.match(/window\.location\.href\s*=\s*['\"]([^'\"]+)['\"]/i);
        const detailUrl = onclickMatch ? new URL(onclickMatch[1], location.origin).href : '';

        const text = normalize(card.textContent);
        const titleMatch = text.match(/\b(?:\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?\s*€)\s+(.+?)\s+(?:\d{3,5}(?:-\d+)?)\b/i);
        const referenceMatch = text.match(/\b(\d{3,8}(?:-\d+)?)\b/);
        const priceMatch = text.match(/(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?\s*€)/);

        const transactionType = /\/Alquiler-/i.test(detailUrl + ' ' + text)
          ? 'rent'
          : /\/Venta-/i.test(detailUrl + ' ' + text)
            ? 'sale'
            : '';

        const bedrooms = readInt(/\b(\d+)\s*(?:dormitorios?|hab(?:itaciones?)?)\b/i, text);
        const bathrooms = readInt(/\b(\d+)\s*(?:ba(?:\u00f1|n)os?|aseos?)\b/i, text);
        const sizeMatch = text.match(/\b(\d{1,4}(?:[.,]\d{1,2})?)\b(?!.*\b\d{1,4}(?:[.,]\d{1,2})?\b)/);
        const size = normalize(sizeMatch ? `${sizeMatch[1]} m2` : '');

        const imageNode = card.querySelector('img');
        const imageUrl = normalize(
          imageNode
            ? imageNode.getAttribute('src')
              || imageNode.getAttribute('data-src')
              || imageNode.getAttribute('data-lazy-src')
              || ''
            : ''
        );

        return {
          title: normalize(titleMatch ? titleMatch[1] : ''),
          price: normalize(priceMatch ? priceMatch[1] : ''),
          location: '',
          detailUrl,
          reference: normalize(referenceMatch ? referenceMatch[1] : ''),
          description: normalize(text),
          transactionType,
          size,
          bedrooms,
          bathrooms,
          garages: null,
          imageUrl,
          scrapedAt: timestamp,
        };
      })
      .filter((listing) => listing.detailUrl);
  }, scrapingTimestamp);
}

async function findNextSearchPageUrl(page) {
  return page.evaluate(() => {
    const currentUrl = new URL(location.href);
    const currentParam = Number(currentUrl.searchParams.get('p') || '1');
    const currentPage = Number.isFinite(currentParam) && currentParam > 0 ? currentParam : 1;

    const links = Array.from(document.querySelectorAll('a[href*="buscar.php"]'))
      .map((anchor) => {
        try {
          return new URL(anchor.getAttribute('href') || '', location.origin).href;
        } catch {
          return '';
        }
      })
      .filter(Boolean);

    let bestUrl = '';
    let bestPage = Number.POSITIVE_INFINITY;

    for (const href of links) {
      const url = new URL(href);
      const raw = url.searchParams.get('p');
      const pageNumber = Number(raw || '0');
      if (!Number.isFinite(pageNumber) || pageNumber <= currentPage) {
        continue;
      }

      if (pageNumber < bestPage) {
        bestPage = pageNumber;
        bestUrl = url.href;
      }
    }

    return bestUrl;
  });
}

const inmocolonAdapter = {
  siteId: 'inmocolon',

  /**
   * @param {{operation?: string, municipality?: string, propertyType?: string, maxPages?: number, headless?: boolean}} params
   */
  async list(params = {}) {
    const operations = normalizeOperations(params.operation || params.transactionType);
    const municipality = clean(params.municipality || params.population || '');
    const propertyType = clean(params.propertyType || '');
    const maxPages = Number.isFinite(Number(params.maxPages)) ? Math.max(1, Number(params.maxPages)) : 8;
    const headless = params.headless !== false;

    const browser = await chromium.launch({ headless });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      const scrapingTimestamp = new Date().toISOString();
      const byId = new Map();

      for (const operation of operations) {
        let pageNumber = 1;
        let pageUrl = buildSearchUrl({
          operation,
          municipality,
          propertyType,
          pageNumber,
        });
        const visitedUrls = new Set();

        while (pageNumber <= maxPages && pageUrl && !visitedUrls.has(pageUrl)) {
          visitedUrls.add(pageUrl);

          await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(1200);
          await acceptCookiesIfVisible(page);

          try {
            await page.waitForFunction(() => document.querySelectorAll('.listado5_contendor_inmueble').length > 0, null, {
              timeout: 10000,
            });
          } catch {
            // Keep going: some filters can return empty pages.
          }

          const listings = await scrapeSearchPageListings(page, scrapingTimestamp);
          for (const item of listings) {
            const id = deriveStableId(item.detailUrl);
            if (!byId.has(id)) {
              byId.set(id, {
                id,
                ...item,
                bedrooms: parsePositiveInt(item.bedrooms),
                bathrooms: parsePositiveInt(item.bathrooms),
                garages: parsePositiveInt(item.garages),
                siteId: this.siteId,
              });
            }
          }

          const nextUrl = await findNextSearchPageUrl(page);
          if (!nextUrl || visitedUrls.has(nextUrl)) {
            break;
          }

          pageUrl = nextUrl;
          pageNumber += 1;
        }
      }

      if (byId.size === 0) {
        await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1200);
        await acceptCookiesIfVisible(page);

        const featuredListings = await scrapeHomepageFeaturedListings(page, scrapingTimestamp);
        for (const item of featuredListings) {
          const id = deriveStableId(item.detailUrl);
          if (!byId.has(id)) {
            byId.set(id, {
              id,
              ...item,
              bedrooms: parsePositiveInt(item.bedrooms),
              bathrooms: parsePositiveInt(item.bathrooms),
              garages: parsePositiveInt(item.garages),
              siteId: this.siteId,
            });
          }
        }
      }

      return Array.from(byId.values());
    } finally {
      await browser.close();
    }
  },
};

module.exports = {
  inmocolonAdapter,
};
