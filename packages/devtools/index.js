// @calmapi/devtools: the browser UI for CalmAPI devtools (served at /_calm in development).
// The collector and JSON API live in your app (calm/devtools/index.js); this package only
// ships static files. Your app finds them through `uiDir`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Absolute path of the folder with index.html, app.js and styles.css. */
export const uiDir = join(import.meta.dirname, 'ui');

/** Version of this UI package. */
export const version = JSON.parse(readFileSync(join(import.meta.dirname, 'package.json'), 'utf8')).version;

export default { uiDir, version };
