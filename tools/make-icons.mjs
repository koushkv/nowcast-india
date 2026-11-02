// Render the app icon (radar sweep + rain cell on a dark tile) to PNGs with headless Chromium.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const svg = (pad) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" fill="#0b1220"/>
  <g transform="translate(${pad} ${pad}) scale(${(512 - 2 * pad) / 512})">
    <circle cx="256" cy="256" r="196" fill="none" stroke="#22314a" stroke-width="18"/>
    <circle cx="256" cy="256" r="118" fill="none" stroke="#22314a" stroke-width="18"/>
    <path d="M256 256 L425 158 A196 196 0 0 0 256 60 Z" fill="#3b82f6"/>
    <circle cx="330" cy="178" r="34" fill="#93c5fd"/>
    <circle cx="330" cy="178" r="14" fill="#ffffff"/>
    <circle cx="256" cy="256" r="16" fill="#e8edf4"/>
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
await browser.close();
console.log('icons written');
