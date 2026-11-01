/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />

interface ImportMetaEnv {
  /** Where the primary (Pi) copy of the app lives, e.g. https://pi.tailnet.ts.net. Unset = failover off. */
  readonly VITE_PRIMARY_URL?: string;
  /** Where the standby (Vercel) copy lives, e.g. https://splittingwisdom-client.vercel.app. */
  readonly VITE_STANDBY_URL?: string;
}
