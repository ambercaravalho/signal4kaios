/* Entry of `build/backup.js`, the archive decoder loaded only while message history is imported, so the Backups codecs stay out of `app.js`. */

import { createFrameMapper } from './frames';
import { BACKUP_GLOBAL } from './load';

(globalThis as any)[BACKUP_GLOBAL] = { createFrameMapper };
