import { chromium } from 'playwright';

const URL = process.argv[2];
const found = new Set();

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
  viewport: { width: 1280, height: 800 },
});
const page = await ctx.newPage();

// Capture any media-looking request/response URLs.
const grab = (u) => {
  if (/\.(mp4|m3u8|ts)(\?|$)/i.test(u) || /get_file|\/function\/0\//i.test(u)) found.add(u);
};
page.on('request', (r) => grab(r.url()));
page.on('response', (r) => grab(r.url()));

try {
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  // KVS players init the source on user gesture sometimes — try clicking the player.
  await page.waitForTimeout(4000);
  for (const sel of ['#kt_player', '.fp-player', 'video', '.play-button', '.kt_play']) {
    try { await page.click(sel, { timeout: 1500 }); } catch {}
  }
  await page.waitForTimeout(6000);
  // Also pull flashvars / video_url straight out of page scripts.
  const inline = await page.evaluate(() => {
    const out = [];
    for (const k of ['video_url','video_alt_url','video_url_text']) {
      try { if (window.flashvars && window.flashvars[k]) out.push(window.flashvars[k]); } catch {}
    }
    const html = document.documentElement.innerHTML;
    const m = html.match(/(https?:[^'"\\\s]+\.(?:mp4|m3u8)[^'"\\\s]*)/g);
    if (m) out.push(...m);
    const vurl = html.match(/video_url\s*:\s*'([^']+)'/);
    if (vurl) out.push('flashvars.video_url=' + vurl[1]);
    const lic = html.match(/license_code\s*:\s*'([^']+)'/);
    if (lic) out.push('flashvars.license_code=' + lic[1]);
    const src = document.querySelector('video source, video');
    if (src && src.src) out.push(src.src);
    return out;
  });
  inline.forEach((u) => found.add(u));
} catch (e) {
  console.error('NAV ERROR:', e.message);
}

console.log(JSON.stringify([...found], null, 2));
await browser.close();
