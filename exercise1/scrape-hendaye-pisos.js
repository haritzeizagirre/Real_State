const { chromium } = require('playwright');
const crypto = require('crypto');

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

async function acceptCookiesIfVisible(page) {
  const cookieButton = page.getByText(/aceptar cookies/i).first();
  if (await cookieButton.count()) {
    try {
      await cookieButton.click({ timeout: 2000 });
    } catch {
      // Cookie banner is optional and sometimes not visible.
    }
  }
}

async function scrapeVisiblePageListings(page, scrapingTimestamp) {
  return page.evaluate((timestamp) => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();

    const rows = Array.from(document.querySelectorAll('.property-list-list')).filter((row) => {
      const style = window.getComputedStyle(row);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });

    return rows.map((row) => {
      const detailAnchors = Array.from(row.querySelectorAll('a[href*="/inmuebles/inmueble_detalles/"]'));
      const detailUrl = detailAnchors.length ? detailAnchors[0].href : '';

      const heading = row.querySelector('h3, h4');
      const title = normalize(heading ? heading.textContent : detailAnchors.map((a) => a.textContent).find((t) => normalize(t) && !/ver detalles/i.test(t)) || '');

      const locationParagraph = Array.from(row.querySelectorAll('p')).map((p) => normalize(p.textContent)).find((txt) => /\d{5}\s+[^,]+,\s*[A-Z]{2}/.test(txt)) || '';
      const location = normalize(locationParagraph);

      const priceNode = row.querySelector('.price');
      const rowText = normalize(row.textContent);
      const fallbackPriceMatch = rowText.match(/(\d{1,3}(?:\.\d{3})*,\d{2}\s*€|Precio\s+consultar)/i);
      const price = normalize(priceNode ? priceNode.textContent : (fallbackPriceMatch ? fallbackPriceMatch[1] : ''));

      return {
        title,
        price,
        location,
        detailUrl,
        scrapingTimestamp: timestamp,
      };
    }).filter((item) => item.detailUrl);
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
      if (!active) {
        return false;
      }
      return active.getAttribute('rel') === String(expectedPage);
    },
    nextPage,
    { timeout: 10000 }
  );

  await page.waitForTimeout(250);
  return true;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const searchForm = page.locator('form.findus').first();
    await searchForm.locator('select[name="tipoInmueble[]"]').selectOption('piso');
    await searchForm.locator('select[name="municipio[]"]').selectOption('Hendaye');

    await Promise.all([
      page.waitForLoadState('domcontentloaded'),
      searchForm.locator('button[type="submit"]').click(),
    ]);

    await page.waitForTimeout(2500);

    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => document.querySelectorAll('.property-list-list').length > 0, null, { timeout: 15000 });

    const scrapingTimestamp = new Date().toISOString();
    const byUrl = new Map();

    let pageIndex = 1;
    while (true) {
      const pageItems = await scrapeVisiblePageListings(page, scrapingTimestamp);
      for (const item of pageItems) {
        if (!byUrl.has(item.detailUrl)) {
          byUrl.set(item.detailUrl, {
            ...item,
            stableId: deriveStableId(item.detailUrl),
          });
        }
      }

      const moved = await goToNextPaginationPage(page);
      if (!moved) {
        break;
      }

      pageIndex += 1;
      if (pageIndex > 25) {
        break;
      }
    }

    const results = Array.from(byUrl.values());
    console.log(JSON.stringify(results, null, 2));
  } finally {
    await browser.close();
  }
})();
