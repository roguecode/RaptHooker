# Translations

RaptHooker's web app is available in English, Deutsch, Español, Français, Italiano, Nederlands, Polski and
Português (Brasil). It follows the browser's language; anyone can pick another one in the top bar menu or under
**Settings > Hub > This browser**.

The translations were made with the help of AI and haven't all been reviewed by native speakers yet. If something reads
oddly, please open an issue or a pull request. Corrections are very welcome.

Text that comes from the hub itself (error messages from the server, hub warnings, and the text of alert notifications
and webhook templates) is in English for now.

## How it works

- English text is the key. In the code, visible text goes through `t('Start a brew')`, with placeholders like
  `t('{name} is at {temp}', { name, temp })`.
- Counts use `tp(count, '{count} reading', '{count} readings')`; each language gives the plural forms it needs
  ([CLDR plural rules](https://cldr.unicode.org/index/cldr-spec/plural-rules): Polish has one, few, many and other).
- A short word that means two things gets a context: `tc('smoothing', 'Light')` is translated separately from the theme
  `t('Light')` (the catalogue key is `smoothing::Light`).
- Labels kept in constants are marked with `tk('Dry hop')` and translated where they're shown.
- Catalogues are in [src/web/app/i18n/locales](../src/web/app/i18n/locales): one JSON file per language, loaded only
  when that language is picked. Anything missing falls back to English.

## Improving a translation

1. Edit `src/web/app/i18n/locales/<language>.json`. Keep every `{placeholder}` exactly as it is.
2. Run `npm run i18n`. It lists the strings to translate (with the files they're used in, in
   `src/web/app/i18n/source.json`) and reports missing strings and broken placeholders for every language.
3. Check it in the app: `npm run dev:server` and `npm run dev:web`, then pick the language in the top bar menu.

## Adding a language

1. Add it to `LOCALES` in [src/web/app/i18n/index.tsx](../src/web/app/i18n/index.tsx).
2. Copy an existing catalogue to `locales/<id>.json` and translate it.
3. `npm run i18n -- --strict` must show it fully translated with nothing broken.

When you add or change text in the app, wrap it as above and run `npm run i18n`; CI checks that every string can be
extracted and that no translation has broken placeholders. New strings show in English until they're translated.
