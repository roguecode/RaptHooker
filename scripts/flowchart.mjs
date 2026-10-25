// Builds docs/images/how-it-works.svg (and .png) in the app's dark style. Run: node scripts/flowchart.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const iconSource = readFileSync('src/web/app/components/Icon.tsx', 'utf8').replace(/\r\n/g, '\n');
const icon = (name) => {
  const m =
    new RegExp(`\\n  ${name}: \\(\\n([\\s\\S]*?)\\n  \\),`).exec(iconSource) ?? new RegExp(`\\n  ${name}: (<[^\\n]*/>),`).exec(iconSource);
  if (!m) throw new Error(`no icon ${name}`);
  return m[1]
    .replace(/<\/?>/g, '')
    .replace(/strokeWidth/g, 'stroke-width')
    .trim();
};

const W = 1400;
const H = 800;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function card({ x, y, w, h, title, lines, iconName, accent = false }) {
  const fill = accent ? 'url(#accentFill)' : 'rgba(255,255,255,0.045)';
  const stroke = accent ? 'url(#accentStroke)' : 'rgba(167,139,250,0.28)';
  const sw = accent ? 2 : 1.2;
  const textX = x + 84;
  const titleY = y + (lines.length > 1 ? 44 : 52);
  return `
  <g filter="url(#shadow)">
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="20" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>
  </g>
  <circle cx="${x + 44}" cy="${y + h / 2}" r="24" fill="rgba(139,92,246,0.18)" stroke="rgba(167,139,250,0.35)"/>
  <g transform="translate(${x + 44 - 14.4} ${y + h / 2 - 14.4}) scale(1.2)" fill="none" stroke="${accent ? '#c4b5fd' : '#a78bfa'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon(iconName)}</g>
  <text x="${textX}" y="${titleY}" class="title">${esc(title)}</text>
  ${lines.map((l, i) => `<text x="${textX}" y="${titleY + 26 + i * 21}" class="sub">${esc(l)}</text>`).join('\n  ')}`;
}

function arrow(d, { both = false, dashed = false } = {}) {
  return `<path d="${d}" fill="none" stroke="url(#arrowStroke)" stroke-width="2.4" ${dashed ? 'stroke-dasharray="7 7"' : ''} marker-end="url(#head)" ${both ? 'marker-start="url(#tail)"' : ''}/>`;
}

function label(x, y, text) {
  const w = text.length * 7.6 + 24;
  return `<rect x="${x - w / 2}" y="${y - 15}" width="${w}" height="28" rx="14" fill="#151236" stroke="rgba(167,139,250,0.35)"/>
  <text x="${x}" y="${y + 4.5}" class="label" text-anchor="middle">${esc(text)}</text>`;
}

const pi = { x: 392, y: 96, w: 536, h: 640 };
const outputs = [
  { title: 'Web app', lines: ['Phone, PC and TV mode, live'], iconName: 'tv' },
  { title: 'Webhooks', lines: ["Brewfather, Grainfather, Brewer's", 'Friend, Discord, anything with a URL'], iconName: 'webhook' },
  { title: 'MQTT', lines: ['Home Assistant devices, Node-RED…'], iconName: 'zap' },
  { title: 'Alerts', lines: ['ntfy, Pushover, Telegram, Discord,', 'email, browser notifications'], iconName: 'bell' },
  { title: 'Backups', lines: ['USB stick, S3 storage, downloads'], iconName: 'cloud' },
];
const out = { x: 1010, w: 360, h: 112, gap: 26, top: 74 };
const core = { x: 432, y: 352, w: 456, h: 156 };
const coreRight = core.x + core.w;
const coreMid = core.y + core.h / 2;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="glowA" cx="18%" cy="12%" r="55%"><stop offset="0" stop-color="#7c3aed" stop-opacity="0.38"/><stop offset="1" stop-color="#7c3aed" stop-opacity="0"/></radialGradient>
    <radialGradient id="glowB" cx="88%" cy="92%" r="55%"><stop offset="0" stop-color="#2563eb" stop-opacity="0.32"/><stop offset="1" stop-color="#2563eb" stop-opacity="0"/></radialGradient>
    <linearGradient id="accentFill" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c3aed" stop-opacity="0.32"/><stop offset="1" stop-color="#2563eb" stop-opacity="0.26"/></linearGradient>
    <linearGradient id="accentStroke" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#60a5fa"/></linearGradient>
    <linearGradient id="arrowStroke" gradientUnits="userSpaceOnUse" x1="330" y1="0" x2="1010" y2="0"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#60a5fa"/></linearGradient>
    <marker id="head" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#8fa4ff"/></marker>
    <marker id="tail" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#a78bfa"/></marker>
    <filter id="shadow" x="-10%" y="-20%" width="120%" height="150%"><feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#000" flood-opacity="0.35"/></filter>
    <style>
      text { font-family: 'Segoe UI', Inter, system-ui, -apple-system, Roboto, sans-serif; }
      .title { font-size: 21px; font-weight: 650; fill: #efeaff; }
      .sub { font-size: 14.5px; fill: #aaa3d8; }
      .label { font-size: 13px; font-weight: 600; fill: #c9c2f5; }
      .pi { font-size: 15px; font-weight: 700; fill: #c4b5fd; letter-spacing: 0.12em; }
    </style>
  </defs>
  <rect width="${W}" height="${H}" fill="#08071c"/>
  <rect width="${W}" height="${H}" fill="url(#glowA)"/>
  <rect width="${W}" height="${H}" fill="url(#glowB)"/>

  <!-- The Raspberry Pi -->
  <rect x="${pi.x}" y="${pi.y}" width="${pi.w}" height="${pi.h}" rx="30" fill="rgba(255,255,255,0.025)" stroke="rgba(167,139,250,0.35)" stroke-width="1.5" stroke-dasharray="2 0"/>
  <g transform="translate(${pi.x + 30} ${pi.y + 22}) scale(0.95)" fill="none" stroke="#a78bfa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon('cpu')}</g>
  <text x="${pi.x + 62}" y="${pi.y + 41}" class="pi">RASPBERRY PI</text>

  ${card({ x: 432, y: 162, w: 456, h: 108, title: 'BlueZ', lines: ['Listens quietly for RAPT broadcasts'], iconName: 'bluetooth' })}
  ${card({ ...core, title: 'RaptHooker', lines: ['Records every reading around the clock,', 'tracks brews, predicts, forwards'], iconName: 'gauge', accent: true })}
  ${card({ x: 432, y: 590, w: 456, h: 108, title: 'Database', lines: ['Every reading, on your own SD card'], iconName: 'hardDrive' })}

  <!-- Inputs -->
  ${card({ x: 30, y: 162, w: 300, h: 108, title: 'RAPT Pills', lines: ['As many as you like,', 'set to Bluetooth mode'], iconName: 'beer' })}
  ${card({ x: 30, y: 400, w: 300, h: 108, title: 'ESP32 relay', lines: ['Optional: for pills', 'further away'], iconName: 'signal' })}

  ${arrow(`M 330 216 L 424 216`)}
  ${label(377, 186, 'Bluetooth')}
  ${arrow(`M 330 454 C 380 454 380 ${coreMid + 14} 424 ${coreMid + 14}`, { dashed: true })}
  ${label(366, 478, 'Wi-Fi')}
  ${arrow(`M 660 270 L 660 344`)}
  ${arrow(`M 660 516 L 660 582`, { both: true })}

  <!-- Outputs -->
  ${outputs
    .map((o, i) => {
      const y = out.top + i * (out.h + out.gap);
      const cy = y + out.h / 2;
      return `${card({ x: out.x, y, w: out.w, h: out.h, ...o })}
  ${arrow(`M ${coreRight} ${coreMid} C ${coreRight + 70} ${coreMid} ${out.x - 70} ${cy} ${out.x - 8} ${cy}`)}`;
    })
    .join('\n  ')}
</svg>
`;

writeFileSync('docs/images/how-it-works.svg', svg);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1.5 });
await page.setContent(`<html><body style="margin:0;background:#08071c">${svg}</body></html>`);
await page.waitForTimeout(300);
await page.locator('svg').screenshot({ path: 'docs/images/how-it-works.png' });
await browser.close();
console.log('written docs/images/how-it-works.svg and .png');
