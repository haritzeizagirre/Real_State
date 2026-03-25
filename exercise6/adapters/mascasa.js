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

        return {
          title,
          price,
          location,
          detailUrl,
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

      return Array.from(byId.values());
    } finally {
      await browser.close();
    }
  },
};

module.exports = {
  mascasaAdapter,
};
