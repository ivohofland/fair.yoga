/**
 * What this browser can do about installing fair.yoga. `unknown` is the
 * server's answer and the first client render's; `classifyInstall` never
 * returns it.
 */
export type InstallSupport = 'unknown' | 'installed' | 'ios-safari' | 'prompt' | 'manual' | 'unsupported';

export interface InstallEnv {
  userAgent: string;
  maxTouchPoints: number;
  /** `(display-mode: standalone)` matches. */
  displayModeStandalone: boolean;
  /** iOS's own flag for a home-screen launch. */
  navigatorStandalone: boolean;
  /** A `beforeinstallprompt` is captured and unused. */
  promptHeld: boolean;
  /** A captured prompt was spent; Chromium allows one `prompt()` per event. */
  promptUsed: boolean;
  /** `appinstalled` fired in this page. */
  appInstalled: boolean;
}

/** iPadOS Safari sends a Mac user agent; a touch screen gives it away. */
function isIos(env: InstallEnv): boolean {
  return /iPhone|iPad|iPod/.test(env.userAgent) || (/Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1);
}

/** iOS browsers and webviews that are not Safari; their Add to Home Screen
 *  route, where one exists, is not Safari's Share sheet. */
const NOT_SAFARI = /CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|GSA\/|DuckDuckGo|YaBrowser|FBAN|FBAV|Instagram|Line\/|Snapchat|LinkedInApp|Pinterest/;

function isIosSafari(env: InstallEnv): boolean {
  return /Version\/[\d.]+.*Safari\//.test(env.userAgent) && !NOT_SAFARI.test(env.userAgent);
}

export function classifyInstall(env: InstallEnv): Exclude<InstallSupport, 'unknown'> {
  if (env.displayModeStandalone || env.navigatorStandalone || env.appInstalled) return 'installed';
  if (isIos(env)) return isIosSafari(env) ? 'ios-safari' : 'unsupported';
  if (env.promptHeld) return 'prompt';
  if (env.promptUsed) return 'manual';
  return 'unsupported';
}
