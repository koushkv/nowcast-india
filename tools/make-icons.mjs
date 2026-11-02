// Render the app icon (radar sweep + rain cell on a black tile) to PNGs with headless Chromium.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const svg = (pad) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" fill="#000000"/>
  <g transform="translate(${pad} ${pad}) scale(${(512 - 2 * pad) / 512})">
    <circle cx="256" cy="256" r="196" fill="none" stroke="#2c2c2c" stroke-width="14"/>
    <circle cx="256" cy="256" r="118" fill="none" stroke="#2c2c2c" stroke-width="14"/>
    <path d="M256 256 L425 158 A196 196 0 0 0 256 60 Z" fill="#38bdf8"/>
    <circle cx="330" cy="178" r="30" fill="#ffffff"/>
    <circle cx="256" cy="256" r="18" fill="#f5f5f5"/>
  </g>
</svg>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
const shots = [
  ['public/icons/icon-512.png', 512, 0],
  ['public/icons/icon-192.png', 192, 0],
  ['public/icons/apple-touch-icon.png', 180, 0],
  ['public/icons/icon-maskable-512.png', 512, 70],
];
for (const [file, size, pad] of shots) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0">${svg(pad).replace('width="512" height="512"', `width="${size}" height="${size}"`)}</body></html>`);
  await page.screenshot({ path: file, clip: { x: 0, y: 0, width: size, height: size } });
}

// share card (Open Graph, 1200x630) in the app's own type and colours
const fs = await import('node:fs');
const font = (f) => `data:font/woff2;base64,${fs.readFileSync(`public/fonts/${f}`).toString('base64')}`;
await page.setViewportSize({ width: 1200, height: 630 });
await page.setContent(`<html><head><style>
  @font-face { font-family: G; src: url(${font('geist-latin.woff2')}); font-weight: 100 900; }
  @font-face { font-family: M; src: url(${font('geist-mono-latin.woff2')}); font-weight: 100 900; }
  body { margin: 0; width: 1200px; height: 630px; background: #000; color: #f5f5f5; font-family: G; position: relative; overflow: hidden; }
  .grid { position: absolute; inset: 0; background-image: linear-gradient(#141414 1px, transparent 1px), linear-gradient(90deg, #141414 1px, transparent 1px); background-size: 60px 60px; }
  .sweep { position: absolute; right: -120px; top: -40px; }
  .wrap { position: absolute; left: 80px; top: 76px; right: 80px; }
  .brand { font: 600 26px/1 M; letter-spacing: .2em; display: flex; align-items: center; gap: 16px; }
  .brand span { font: 500 14px/1 M; letter-spacing: .14em; color: #8e8e8e; border: 1px solid #2c2c2c; padding: 6px 8px 5px; border-radius: 4px; }
  h1 { margin: 52px 0 0; font: 600 72px/1.02 G; letter-spacing: -.035em; max-width: 760px; }
  p { margin: 24px 0 0; font: 400 27px/1.4 G; color: #cfcfcf; max-width: 700px; }
  .line { position: absolute; left: 80px; right: 80px; bottom: 64px; display: flex; gap: 0; font: 400 19px/1 M; color: #8e8e8e; border-top: 1px solid #1d1d1d; padding-top: 22px; }
  .line b { color: #f5f5f5; font-weight: 500; } .line i { font-style: normal; padding: 0 22px; border-left: 1px solid #2c2c2c; } .line i:first-child { padding-left: 0; border: 0; }
  .ok { color: #4ade80 !important; }
</style></head><body><div class="grid"></div>
<svg class="sweep" width="640" height="640" viewBox="0 0 512 512"><circle cx="256" cy="256" r="196" fill="none" stroke="#1f1f1f" stroke-width="3"/><circle cx="256" cy="256" r="118" fill="none" stroke="#1f1f1f" stroke-width="3"/><path d="M256 256 L425 158 A196 196 0 0 0 256 60 Z" fill="#38bdf8" opacity=".9"/><circle cx="330" cy="178" r="22" fill="#fff"/><circle cx="256" cy="256" r="10" fill="#f5f5f5"/></svg>
<div class="wrap"><div class="brand">NOWCAST <span>IN</span></div>
<h1>Rain in the next 5 hours, minute by minute.</h1>
<p>Live radar, an AI model trained on Indian radar and ten weather models, for any spot in India.</p></div>
<div class="line"><i><b class="ok">● LIVE</b></i><i>RADAR <b>10 min</b></i><i>MODELS <b>8</b> · ENSEMBLE <b>140</b></i><i>AI <b>nightly</b></i></div>
</body></html>`);
await page.waitForTimeout(150);
await page.screenshot({ path: 'public/icons/og-image.png', clip: { x: 0, y: 0, width: 1200, height: 630 } });
await browser.close();
console.log('icons and share card written');
