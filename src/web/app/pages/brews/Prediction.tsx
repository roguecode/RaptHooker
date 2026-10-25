import type { Brew, BrewPrediction } from '@rapthooker/shared';
import { useLive } from '../../live';
import { useUnits } from '../../units';
import { t, tk } from '../../i18n';
import { CONFIDENCE_WORDS, finishText, formulaOf, STAGES } from './brewText';
import './brews.css';

export { abvOf, finishText, formulaOf, formulaWords, STAGES } from './brewText';

const CONFIDENCE: Record<BrewPrediction['confidence'], string> = {
  low: tk("A rough guess: the curve hasn't turned yet, or the readings are noisy."),
  medium: tk('Most of the drop is in: a fair guess.'),
  high: tk("The readings follow the curve closely and it's nearly there."),
};

export function StageChip({ brew }: { brew: Brew }) {
  const p = brew.stats.prediction;
  if (brew.endedAt !== null) return <span className="chip success">{t('Finished')}</span>;
  if (!p) return <span className="chip brew">{t('Fermenting')}</span>;
  const st = STAGES[p.stage];
  return (
    <span className={`chip ${st.chip}`} title={t(st.hint)}>
      {t(st.label)}
    </span>
  );
}

/** Stat tiles for a running brew's prediction: stage, where it's heading and when it'll get there. */
export function PredictionStats({ brew, now }: { brew: Brew; now: number }) {
  const u = useUnits();
  const p = brew.stats.prediction;
  if (brew.endedAt !== null) return null;
  if (!p) {
    return (
      <div className="stat prediction-wait">
        <div className="k">{t('Prediction')}</div>
        <div className="small muted">{t('After 12 hours of readings and a start to the drop, RaptHooker predicts the FG and finish.')}</div>
      </div>
    );
  }
  const st = STAGES[p.stage];
  return (
    <>
      <div className="stat" title={t(st.hint)}>
        <div className="k">{t('Stage')}</div>
        <div className="v">
          <span className={`stage-dot ${p.stage}`} />
          {t(st.label)}
        </div>
      </div>
      <div className="stat" title={t(CONFIDENCE[p.confidence])}>
        <div className="k">{p.stage === 'done' ? t('Final gravity') : t('Predicted FG')}</div>
        <div className="v">{p.stage === 'lag' ? '–' : u.gravityText(p.fg)}</div>
        <div className="small muted">
          {[
            p.stage === 'active' || p.stage === 'finishing' ? t(CONFIDENCE_WORDS[p.confidence]) : null,
            brew.targetFg !== null ? t('target {gravity}', { gravity: u.gravityText(brew.targetFg) }) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
      </div>
      <div className="stat">
        <div className="k">{p.stage === 'done' ? t('Finished') : t('Expected finish')}</div>
        <div className="v small-v">{finishText(p, now)}</div>
      </div>
    </>
  );
}

/** "Standard: (OG − FG) × 131.25", the hub's ABV formula. */
export function useAbvFormula() {
  const { hub } = useLive();
  return formulaOf(hub.abvFormula);
}
