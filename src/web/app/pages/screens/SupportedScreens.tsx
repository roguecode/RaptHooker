import { SCREEN_MODELS, SCREEN_STOCKS, type ScreenModel } from '@rapthooker/shared';
import { t, tk } from '../../i18n';
import { Icon } from '../../components/Icon';

/** How each model is set up, and what to know about it: Wi-Fi screens by the firmware they come with. */
const ABOUT: Record<string, { how: string; note: string }> = {
  sdpro: {
    how: tk('Set up over its own Wi-Fi'),
    note: tk(
      'Unbranded, on the firmware it comes with ("SD Pro"): a new one opens a Wi-Fi network called "Smart weather clock". A genuine GeekMagic Ultra looks the same but has other firmware (see below).',
    ),
  },
  'esp32-2432s028': {
    how: tk('Set up plugged into the hub (USB)'),
    note: tk(
      'An ESP32 with a 2.8" touch screen and one micro USB socket, sold as ESP32-2432S028 or "Cheap Yellow Display". The display chip differs between batches: RaptHooker knows the ones it has seen, and can turn, mirror or recolour the picture.',
    ),
  },
};

function ModelCard({
  model,
  name,
  about,
  confirmed,
}: {
  model: ScreenModel;
  name: string;
  about?: string;
  confirmed: ScreenModel['confirmed'];
}) {
  const a = about ? ABOUT[about] : undefined;
  return (
    <li className="supported-model">
      <div className="row supported-model-head">
        <Icon name="screen" />
        <div className="grow">
          <strong>{name}</strong>
          <span className="small muted">
            <span className="num">
              {model.width} × {model.height}
            </span>
            {a ? ` · ${t(a.how)}` : ''}
          </span>
        </div>
      </div>
      {a && <p className="small">{t(a.note)}</p>}
      {confirmed.map((l) => (
        <a key={l.url} className="small supported-model-link" href={l.url} target="_blank" rel="noreferrer noopener nofollow">
          <Icon name="external" size={13} /> {t('Where a working one was bought ({site})', { site: l.site })}
        </a>
      ))}
    </li>
  );
}

/** A card for each screen confirmed working: Wi-Fi ones by the firmware they come with, as that's how they're bought. */
function confirmedCards() {
  return SCREEN_MODELS.flatMap((m) =>
    m.install === 'hotspot'
      ? SCREEN_STOCKS.filter((s) => s.model === m.id && s.tested).map((s) => (
          <ModelCard key={s.kind} model={m} name={s.name} about={s.kind} confirmed={s.confirmed} />
        ))
      : [<ModelCard key={m.id} model={m} name={m.name} about={m.id} confirmed={m.confirmed} />],
  );
}

/**
 * The screens RaptHooker can set up, with where users bought ones that worked (not endorsements), and what else may or
 * may not work. Screens are experimental, and this says so.
 */
export function SupportedScreens() {
  return (
    <section className="panel supported-screens" id="supported-screens" aria-labelledby="supported-screens-title">
      <div className="panel-head">
        <div>
          <h2 id="supported-screens-title">
            <Icon name="screen" /> {t('Supported screens')} <span className="chip warning">{t('Experimental')}</span>
          </h2>
          <p>{t('These have been confirmed working. RaptHooker puts its own firmware on them and looks after them from here.')}</p>
        </div>
      </div>
      <ul className="supported-models">{confirmedCards()}</ul>
      <p className="small muted supported-disclaimer">
        <Icon name="info" size={13} />{' '}
        {t(
          "The links only show where users bought a screen that then worked. They aren't endorsements: RaptHooker has nothing to do with the sellers, and a listing can change what it sends, so check the model in its pictures before you buy.",
        )}
      </p>

      <h3 className="subhead">{t('Other screens')}</h3>
      <ul className="small supported-others">
        <li>
          <span className="chip">{t('Might work')}</span>
          <span>
            {t(
              "A genuine GeekMagic Ultra, on GeekMagic's own firmware (a new one opens a Wi-Fi network called \"GIFTV\"), is untested. It's the same hardware as the Smart weather clock, and RaptHooker checks it's an Ultra before changing anything. GeekMagic's firmware can go back on from the screen's details.",
            )}
          </span>
        </li>
        <li>
          <span className="chip">{t('Might work')}</span>
          <span>
            {t(
              'ESP32-2432S028 boards with two USB sockets (USB-C and micro USB) are untested. They usually have another display chip, which RaptHooker tries: check it with "Does the screen look right?" after setting one up.',
            )}
          </span>
        </li>
        <li>
          <span className="chip danger">{t("Won't work")}</span>
          <span>
            {t(
              'Other GeekMagic models (the Pro is an ESP32), and weather clocks on other firmware. RaptHooker checks a screen before changing anything, so trying one does no harm.',
            )}
          </span>
        </li>
        <li>
          <span className="chip danger">{t("Won't work")}</span>
          <span>
            {t(
              'Other ESP32 boards and sizes (2.4", 3.5", ESP32-S3 boards): their displays are wired differently and would stay blank. Don\'t set one up as an ESP32-2432S028: that replaces what\'s on the board.',
            )}
          </span>
        </li>
        <li>
          <span className="chip success">{t('Any screen')}</span>
          <span>
            {t(
              "Anything that can show a picture from a web address can use an image link (on the dashboard, or a pill's page) instead, with no new firmware.",
            )}
          </span>
        </li>
      </ul>
    </section>
  );
}
