/* KaiOS 3.0+ (Gecko 84/123) APIs the app uses that the DOM typings don't describe. */

interface B2gDomRequest<T = unknown> {
  result: T;
  error: Error | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

interface B2gDeviceStorage {
  addNamed(blob: Blob, name: string): B2gDomRequest<unknown> | Promise<unknown>;
  /** The storage area's mount point on the file system, or "unknown". */
  storagePath?: string;
}

interface B2gExternalApi {
  /** A token for a session with the phone's system services (api-daemon). */
  getToken(): Promise<string>;
}

interface B2gAlarm {
  id: number;
  data?: { type?: string };
}

interface B2gAlarmManager {
  add(opts: { date: Date; data: unknown; ignoreTimezone: boolean }): B2gDomRequest<number> | Promise<number>;
  getAll?(): B2gDomRequest<B2gAlarm[]> | Promise<B2gAlarm[]>;
  remove?(id: number): void;
}

interface B2gNavigator {
  getDeviceStorage?(kind: string): B2gDeviceStorage | null;
  alarmManager?: B2gAlarmManager;
  externalapi?: B2gExternalApi;
}

interface Navigator {
  b2g?: B2gNavigator;
}

declare class WebActivity {
  constructor(name: string, data?: unknown);
  start(): Promise<any>;
}

interface ServiceWorkerRegistration {
  systemMessageManager?: { subscribe(name: string): Promise<void> };
}

declare module '*.css';
