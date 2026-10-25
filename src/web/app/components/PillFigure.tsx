import { useId } from 'react';
import { t } from '../i18n';

/** A RAPT Pill drawn floating at its measured tilt. `decorative` hides it from screen readers (the tilt is shown elsewhere). */
export function PillFigure({
  color,
  tilt,
  size = 74,
  offline = false,
  decorative = false,
}: {
  color: string;
  tilt: number | null | undefined;
  size?: number;
  offline?: boolean;
  decorative?: boolean;
}) {
  const id = useId().replace(/:/g, '');
  const angle = tilt === null || tilt === undefined ? 30 : Math.max(0, Math.min(90, tilt));
  return (
    <svg
      className="pill-figure"
      width={size}
      height={size}
      viewBox="0 0 100 100"
      {...(decorative
        ? { 'aria-hidden': true, focusable: false }
        : { role: 'img', 'aria-label': t('Pill tilted {angle}°', { angle: Math.round(angle) }) })}
    >
      <defs>
        <linearGradient id={`b${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.9" />
          <stop offset="0.35" stopColor={color} />
          <stop offset="1" stopColor="#3b82f6" />
        </linearGradient>
        <linearGradient id={`w${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#60a5fa" stopOpacity="0.35" />
          <stop offset="1" stopColor="#60a5fa" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x="2" y="56" width="96" height="42" rx="8" fill={`url(#w${id})`} />
      <path d="M4 57c8-3 14 3 23 0s15-3 23 0 15 3 23 0 14-3 23 0" fill="none" stroke="#93c5fd" strokeOpacity="0.6" strokeWidth="1.6" />
      <g style={{ transform: `rotate(${angle}deg)`, transformOrigin: '50px 56px', opacity: offline ? 0.55 : 1 }}>
        <rect x="38" y="18" width="24" height="64" rx="12" fill={`url(#b${id})`} />
        <rect x="42.5" y="24" width="4" height="22" rx="2" fill="#fff" fillOpacity="0.5" />
        <path d="M38 56h24v14a12 12 0 0 1-24 0z" fill="#1e3a8a" fillOpacity="0.35" />
      </g>
    </svg>
  );
}
