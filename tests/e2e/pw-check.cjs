const { chromium } = require('@playwright/test');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('console', msg => console.log('CONSOLE', msg.type(), msg.text()));
  page.on('pageerror', err => console.log('PAGEERROR', err.message));
  await page.goto('http://127.0.0.1:4173', { waitUntil: 'commit', timeout: 30000 });
  await page.waitForSelector('#preview-img', { state: 'attached', timeout: 30000 });
  console.log('loaded');
  const img='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGQAAAA8CAIAAAAfXYiZAAAAA3NCSVQICAjb4U/gAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAAKtJREFUeNrs0jENACAQwED3v2Y2gQ0M6g2E7Y9h0qf4JgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwM0F7QABBgA3xQf7v2Y5bQAAAABJRU5ErkJggg==';
  await page.evaluate((img) => {
    const imgEl = document.querySelector('#preview-img');
    const empty = document.querySelector('#image-empty');
    imgEl.src = img;
    imgEl.classList.remove('hidden');
    empty.classList.add('hidden');
  }, img);
  await page.click('#preview-img', { timeout: 10000 });
  console.log('clicked preview');
  await page.waitForSelector('[data-preproc-modal]:not([hidden])', { timeout: 10000 });
  console.log('modal visible');
  await page.click('#preproc-close', { timeout: 10000 });
  console.log('clicked close');
  await page.waitForSelector('[data-preproc-modal][hidden]', { timeout: 10000 });
  console.log('modal hidden');
  await browser.close();
})();
