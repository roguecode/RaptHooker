import type uPlot from 'uplot';
import { pngLayout } from './chartMath';
import { intlLocale } from '../format';
import { t } from '../i18n';

export interface PngLegendItem {
  label: string;
  color: string;
  dash?: boolean;
  dots?: boolean;
}

const cssVar = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/** Draws the chart with a title and legend on the page background and downloads it as a PNG. */
export async function exportChartPng(
  chart: uPlot,
  opts: { title: string; subtitle?: string; legend: PngLegendItem[]; fileName: string },
): Promise<void> {
  const src = chart.ctx.canvas;
  const scale = src.width / Math.max(1, chart.width);
  const font = (px: number, weight = 400) =>
    `${weight} ${Math.round(px * scale)}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;

  const measure = document.createElement('canvas').getContext('2d');
  if (!measure) throw new Error(t("This browser can't draw images"));
  measure.font = font(12);
  const legendWidths = opts.legend.map((l) => Math.ceil(measure.measureText(l.label).width + 22 * scale));
  const layout = pngLayout({ plotWidth: src.width, plotHeight: src.height, scale, legendWidths });

  const out = document.createElement('canvas');
  out.width = layout.width;
  out.height = layout.height;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error(t("This browser can't draw images"));

  const bg = cssVar('--bg', '#08071c');
  const text = cssVar('--text', '#f0edff');
  const muted = cssVar('--muted', '#a9a3d6');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, out.width, out.height);
  const glow = ctx.createRadialGradient(out.width * 0.1, 0, 0, out.width * 0.1, 0, out.width * 0.7);
  glow.addColorStop(0, cssVar('--bg-glow-1', 'rgba(124, 58, 237, 0.28)'));
  glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, out.width, out.height);

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = text;
  ctx.font = font(17, 700);
  ctx.fillText(opts.title, layout.pad, layout.titleY);
  if (opts.subtitle) {
    ctx.fillStyle = muted;
    ctx.font = font(12);
    ctx.fillText(opts.subtitle, layout.pad, layout.subtitleY);
  }

  ctx.drawImage(src, layout.plot.x, layout.plot.y);

  ctx.font = font(12);
  ctx.textBaseline = 'middle';
  opts.legend.forEach((item, i) => {
    const at = layout.legend[i]!;
    ctx.strokeStyle = item.color;
    ctx.fillStyle = item.color;
    ctx.lineWidth = 2.5 * scale;
    if (item.dots) {
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.arc(at.x + 7 * scale, at.y, 3.5 * scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    } else {
      ctx.setLineDash(item.dash ? [3 * scale, 3 * scale] : []);
      ctx.beginPath();
      ctx.moveTo(at.x, at.y);
      ctx.lineTo(at.x + 14 * scale, at.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = text;
    ctx.fillText(item.label, at.x + 20 * scale, at.y);
  });

  ctx.fillStyle = muted;
  ctx.font = font(11);
  ctx.textAlign = 'right';
  ctx.fillText(`RaptHooker · ${new Date().toLocaleString(intlLocale())}`, out.width - layout.pad, layout.footerY);

  const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error(t("Couldn't make the image"));
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = opts.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
