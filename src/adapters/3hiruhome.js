const crypto = require('crypto');
const { chromium } = require('playwright');

const BASE_URL = 'https://www.3hiruhome.com/';

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
  const match = clean(detailUrl).match(/-es(\d+)\.html(?:[?#].*)?$/i);
  if (match) {
    return `es_${match[1]}`;
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
    reference: firstNonEmptyString(base.reference, extra.reference),
    description: firstNonEmptyString(base.description, extra.description),
    transactionType: firstNonEmptyString(base.transactionType, extra.transactionType),
    size: firstNonEmptyString(base.size, extra.size),
    bedrooms: firstNonNullNumber(base.bedrooms, extra.bedrooms),
    bathrooms: firstNonNullNumber(base.bathrooms, extra.bathrooms),
    garages: firstNonNullNumber(base.garages, extra.garages),
    imageUrl: firstNonEmptyString(base.imageUrl, extra.imageUrl),
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

function normalizeOperations(rawOperation) {
  const normalized = clean(rawOperation).toLowerCase();

  if (!normalized || ['all', 'any', 'both'].includes(normalized)) {
    return ['venta', 'alquiler'];
  }
  if (['sale', 'sell', 'venta'].includes(normalized)) {
    return ['venta'];
  }
  if (['rent', 'let', 'alquiler'].includes(normalized)) {
    return ['alquiler'];
  }

  return ['venta', 'alquiler'];
}

function isAllowedOperation(url, allowedOperations) {
  const normalized = clean(url).toLowerCase();
  if (normalized.includes('-en-venta-')) {
    return allowedOperations.includes('venta');
  }
  if (normalized.includes('-en-alquiler-')) {
    return allowedOperations.includes('alquiler');
  }
  return true;
}

async function acceptCookiesIfVisible(page) {
  const buttons = [
    page.getByRole('button', { name: /aceptar/i }).first(),
    page.locator('button:has-text("Aceptar")').first(),
    page.locator('#cookie_action_accept').first(),
  ];

  for (const button of buttons) {
    if (!(await button.count())) {
      continue;
    }

    try {
      await button.click({ timeout: 1200 });
      return;
    } catch {
      // Cookie banner can be absent or rendered differently.
    }
  }
}

async function discoverCategoryUrls(page, allowedOperations) {
  const discovered = await page.evaluate(() => {
    const allLinks = Array.from(document.querySelectorAll('a[href]'))
      .map((a) => {
        const href = (a.getAttribute('href') || '').trim();
        if (!href) {
          return '';
        }

        try {
          return new URL(href, location.origin).href;
        } catch {
          return '';
        }
      })
      .filter(Boolean);

    // Base type pages: /pisos-en-venta-24-1.html, /pisos-en-alquiler-24-2.html
    const categoryPattern = /-en-(venta|alquiler)-\d+-[12]\.html(?:[?#].*)?$/i;
    return allLinks.filter((url) => categoryPattern.test(url));
  });

  const deduped = [];
  const seen = new Set();

  for (const url of discovered) {
    const normalized = clean(url);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    if (!isAllowedOperation(normalized, allowedOperations)) {
      continue;
    }

    seen.add(normalized);
    deduped.push(normalized);
  }

  return deduped;
}

async function scrapeVisiblePageListings(page, scrapingTimestamp) {
  return page.evaluate((timestamp) => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();

    const toNullableInt = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.round(parsed) : null;
    };

    const readInt = (pattern, source) => {
      const match = normalize(source).match(pattern);
      if (!match) {
        return null;
      }
      return toNullableInt(match[1]);
    };

    const toAbsolute = (urlLike) => {
      const value = normalize(urlLike);
      if (!value) {
        return '';
      }

      try {
        return new URL(value, location.origin).href;
      } catch {
        return '';
      }
    };

    const blocks = Array.from(document.querySelectorAll('article#offers #listOffers div[id]')).filter((node) => {
      if (!/^\d+$/.test(node.id || '')) {
        return false;
      }
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') {
        return false;
      }

      return node.classList.contains('venta') || node.classList.contains('alquiler') || node.classList.length === 0;
    });

    return blocks
      .map((block) => {
        const blockText = normalize(block.textContent);
        if (/\b(vendido|alquilado|reservado)\b/i.test(blockText)) {
          return null;
        }

        const detailAnchor =
          block.querySelector('a.masInfoPropiedad[href]')
          || block.querySelector('h4.subTitulo a[href]')
          || block.querySelector('.sliderPrincipal[data-enlace]')
          || block.querySelector('a[href$=".html"]');

        const detailUrl = toAbsolute(
          detailAnchor
            ? detailAnchor.getAttribute('href') || detailAnchor.getAttribute('data-enlace') || ''
            : ''
        );

        const title = normalize((block.querySelector('h4.subTitulo a, h4.subTitulo') || {}).textContent || '');
        const location = normalize((block.querySelector('h3') || {}).textContent || '');

        const priceRaw = normalize((block.querySelector('.precio .actual, .precio p, .precio') || {}).textContent || '');
        const price = normalize(priceRaw.replace(/\s+/g, ' '));

        const referenceText = normalize((block.querySelector('.numeroRef') || {}).textContent || '')
          || normalize((block.querySelector('.referencia') || {}).textContent || '');
        const referenceMatch = referenceText.match(/\b([A-Za-z]{1,8}\d{2,10})\b/);
        const reference = normalize(referenceMatch ? referenceMatch[1] : '');

        const description = normalize((block.querySelector('p.descripcion') || {}).textContent || '');

        const operationSource = normalize(`${block.className} ${referenceText}`).toLowerCase();
        const transactionType = /alquiler|rent|arrenda/i.test(operationSource)
          ? 'rent'
          : /venta|sale|vender/i.test(operationSource)
            ? 'sale'
            : '';

        const featuresText = Array.from(block.querySelectorAll('ul.caracteristicas li')).map((li) => normalize(li.textContent)).join(' ');

        const sizeMatch = featuresText.match(/(\d{1,4}(?:[.,]\d{1,2})?)\s*m(?:2|\u00b2)/i);
        const size = normalize(sizeMatch ? `${sizeMatch[1]} m2` : '');

        const bedrooms = readInt(/habitaciones?\s*:?\s*(\d+)/i, featuresText)
          ?? readInt(/(\d+)\s*habitaciones?/i, featuresText);

        const bathrooms = readInt(/ba(?:n|\u00f1)os?\s*:?\s*(\d+)/i, featuresText)
          ?? readInt(/(\d+)\s*ba(?:n|\u00f1)os?/i, featuresText);

        const garages = readInt(/garajes?\s*:?\s*(\d+)/i, featuresText)
          ?? readInt(/(\d+)\s*(?:garajes?|parking|plazas?)/i, featuresText)
          ?? (/(garaje|parking)/i.test(featuresText) ? 1 : null);

        const imageNode =
          block.querySelector('.swiper-slide:not(.swiper-slide-duplicate) img')
          || block.querySelector('.sliderPrincipal img')
          || block.querySelector('img');

        const imageUrl = toAbsolute(
          imageNode
            ? imageNode.getAttribute('src') || imageNode.getAttribute('data-src') || ''
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
      .filter(Boolean)
      .filter((item) => item.detailUrl);
  }, scrapingTimestamp);
}

async function discoverPaginationUrls(page) {
  return page.evaluate(() => {
    const toAbsolute = (urlLike) => {
      const value = (urlLike || '').trim();
      if (!value) {
        return '';
      }
      try {
        return new URL(value, location.origin).href;
      } catch {
        return '';
      }
    };

    const current = location.href;
    const links = Array.from(document.querySelectorAll('a[href]'));
    const paginationCandidates = links
      .map((a) => toAbsolute(a.getAttribute('href') || ''))
      .filter((href) => href && href !== current && /[?&]i=\d+/i.test(href));

    return Array.from(new Set(paginationCandidates));
  });
}

async function scrapeListingDetail(detailPage, detailUrl) {
  await detailPage.goto(detailUrl, { waitUntil: 'domcontentloaded' });
  await detailPage.waitForTimeout(700);

  return detailPage.evaluate((url) => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const toNullableNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null);

    const readInt = (pattern, source) => {
      const match = normalize(source).match(pattern);
      if (!match) {
        return null;
      }

      const parsed = Number(match[1]);
      return Number.isFinite(parsed) ? Math.round(parsed) : null;
    };

    const paragraphs = Array.from(document.querySelectorAll('p'))
      .map((node) => normalize(node.textContent))
      .filter(Boolean);

    const bodyText = normalize(document.body ? document.body.textContent : '');

    const referenceFromParagraph = paragraphs
      .map((text) => text.match(/N\W*de\W*referencia\W*:\W*([A-Za-z0-9_-]+)/i))
      .find(Boolean);
    const fallbackRef = (normalize(url).match(/-es(\d+)\.html(?:[?#].*)?$/i) || [])[1] || '';
    const reference = normalize(referenceFromParagraph ? referenceFromParagraph[1] : fallbackRef);

    const transactionType = /\balquiler\b|\brent\b/i.test(bodyText)
      ? 'rent'
      : /\bventa\b|\bsale\b/i.test(bodyText)
        ? 'sale'
        : '';

    const description = paragraphs.find((text) => (
      text.length > 160
      && !/acepto la politica|simulador de hipotecas|mas informacion|aviso de cookies/i.test(text)
      && !/^precio\s*:/i.test(text)
    )) || '';

    const sizeMatch = bodyText.match(/Sup\.\s*Construida\W*(\d{1,4}(?:[.,]\d{1,2})?)\s*m(?:2|\u00b2)/i)
      || bodyText.match(/(\d{1,4}(?:[.,]\d{1,2})?)\s*m(?:2|\u00b2)/i);
    const size = normalize(sizeMatch ? `${sizeMatch[1]} m2` : '');

    const bedrooms = readInt(/Habitaciones\W*(\d+)/i, bodyText)
      ?? readInt(/(\d+)\W*Habitaciones/i, bodyText);

    const bathrooms = readInt(/Ba(?:n|\u00f1)os\W*(\d+)/i, bodyText)
      ?? readInt(/(\d+)\W*Ba(?:n|\u00f1)os/i, bodyText);

    const garages = readInt(/(?:Garajes?|Parking|Plazas?)\W*(\d+)/i, bodyText)
      ?? (/(garaje|parking)/i.test(bodyText) ? 1 : null);

    const imageUrl = normalize(
      (document.querySelector('meta[property="og:image"]') || {}).content
      || (document.querySelector('.fotorama__stage img, .fotorama img, img[src*="/property/"]') || {}).src
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

const threeHiruHomeAdapter = {
  siteId: '3hiruhome',

  /**
   * @param {{
   * operation?: string,
   * maxPages?: number,
   * maxCategoryUrls?: number,
   * detailEnrichment?: boolean,
   * maxDetailListings?: number,
   * headless?: boolean
   * }} params
   */
  async list(params = {}) {
    const headless = params.headless !== false;
    const operation = clean(params.operation || 'all');
    const maxPages = Number.isFinite(Number(params.maxPages)) ? Math.max(1, Number(params.maxPages)) : 4;
    const maxCategoryUrls = Number.isFinite(Number(params.maxCategoryUrls)) ? Math.max(1, Number(params.maxCategoryUrls)) : 24;
    const detailEnrichment = params.detailEnrichment === true;
    const maxDetailListings = Number.isFinite(Number(params.maxDetailListings)) ? Math.max(0, Number(params.maxDetailListings)) : 60;

    const browser = await chromium.launch({ headless });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2200);
      await acceptCookiesIfVisible(page);

      const allowedOperations = normalizeOperations(operation);
      const categoryUrls = await discoverCategoryUrls(page, allowedOperations);
      const selectedCategoryUrls = categoryUrls.slice(0, maxCategoryUrls);

      const scrapingTimestamp = new Date().toISOString();
      const byId = new Map();

      for (const categoryUrl of selectedCategoryUrls) {
        const queue = [categoryUrl];
        const seenPages = new Set();

        while (queue.length > 0 && seenPages.size < maxPages) {
          const nextUrl = queue.shift();
          if (!nextUrl || seenPages.has(nextUrl)) {
            continue;
          }

          seenPages.add(nextUrl);

          await page.goto(nextUrl, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(900);
          await acceptCookiesIfVisible(page);

          const pageListings = await scrapeVisiblePageListings(page, scrapingTimestamp);
          for (const listing of pageListings) {
            const detailUrl = toAbsoluteUrl(listing.detailUrl);
            if (!detailUrl) {
              continue;
            }

            const id = deriveStableId(detailUrl);
            if (!byId.has(id)) {
              byId.set(id, {
                id,
                ...listing,
                detailUrl,
                imageUrl: toAbsoluteUrl(listing.imageUrl),
                siteId: this.siteId,
              });
            }
          }

          if (seenPages.size >= maxPages) {
            break;
          }

          const paginationUrls = await discoverPaginationUrls(page);
          for (const url of paginationUrls) {
            if (!seenPages.has(url) && !queue.includes(url)) {
              queue.push(url);
            }
          }
        }
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
              byId.set(id, mergeListingWithDetails(listing, {
                ...detailData,
                imageUrl: toAbsoluteUrl(detailData.imageUrl),
              }));
              enrichedCount += 1;
            } catch {
              // Keep card-level data if detail parsing fails.
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
  threeHiruHomeAdapter,
};
