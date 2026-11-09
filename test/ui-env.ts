/* Browser globals the app's data layer expects, for tests under Node. Import before any `src/ui` module. */
import 'fake-indexeddb/auto';

const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => (k in mem ? mem[k] : null),
  setItem: (k: string, v: string) => {
    mem[k] = String(v);
  },
  removeItem: (k: string) => {
    delete mem[k];
  },
};
(globalThis as any).document = { hidden: false, addEventListener() {} };
