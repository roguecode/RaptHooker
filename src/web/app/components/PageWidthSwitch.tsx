import { PAGE_WIDTHS, usePageWidth, type PageWidth } from '../pageWidth';
import { t, tc } from '../i18n';

const label = (width: PageWidth): string =>
  width === 'wide' ? tc('page width', 'Wide') : width === 'full' ? tc('page width', 'Full') : tc('page width', 'Standard');

/** Standard, Wide or Full pages, for this browser. */
export function PageWidthSwitch() {
  const [width, setWidth] = usePageWidth();
  return (
    <div className="segmented" role="group" aria-label={t('Page width')}>
      {PAGE_WIDTHS.map((w) => (
        <button key={w} type="button" className={width === w ? 'on' : ''} aria-pressed={width === w} onClick={() => setWidth(w)}>
          {label(w)}
        </button>
      ))}
    </div>
  );
}
