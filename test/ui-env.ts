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
if (!(globalThis as any).FileReader) {
  (globalThis as any).FileReader = class {
    result: string | null = null;
    error: Error | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL(blob: Blob): void {
      blob.arrayBuffer().then(
        (buf) => {
          this.result = 'data:' + (blob.type || 'application/octet-stream') + ';base64,' + Buffer.from(buf).toString('base64');
          if (this.onload) this.onload();
        },
        (e) => {
          this.error = e;
          if (this.onerror) this.onerror();
        }
      );
    }
  };
}
