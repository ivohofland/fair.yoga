import { describe, it, expect } from 'vitest';
import { classifyInstall, canOfferInstall, installStepsVariant, type InstallEnv, type InstallSupport, type OfferableInstallSupport } from './install-support';

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ipadDesktopSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  iosChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1',
  iosFirefox: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15',
  iosEdge: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/125.0.2535.87 Mobile/15E148 Safari/605.1.15',
  iosGoogleApp: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/322.0.648915268 Mobile/15E148 Safari/604.1',
  iosInstagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 334.0.4.32.98 (iPhone15,2; iOS 17_5; en_US; en)',
  // Made up: a browser no denylist names, so only the Version/ rule excludes it.
  iosUnlisted: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1 ExampleBrowser/1.0',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  desktopChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
} as const;

function env(overrides: Partial<InstallEnv>): InstallEnv {
  return {
    userAgent: UA.desktopChrome,
    maxTouchPoints: 0,
    displayModeStandalone: false,
    navigatorStandalone: false,
    promptHeld: false,
    promptUsed: false,
    appInstalled: false,
    ...overrides,
  };
}

describe('classifyInstall', () => {
  it.each([
    ['iPhone Safari', env({ userAgent: UA.iphoneSafari, maxTouchPoints: 5 }), 'ios-safari'],
    ['iPad Safari with the desktop user agent', env({ userAgent: UA.ipadDesktopSafari, maxTouchPoints: 5 }), 'ios-safari'],
    ['Chrome on iOS', env({ userAgent: UA.iosChrome, maxTouchPoints: 5 }), 'unsupported'],
    ['Firefox on iOS', env({ userAgent: UA.iosFirefox, maxTouchPoints: 5 }), 'unsupported'],
    ['Edge on iOS', env({ userAgent: UA.iosEdge, maxTouchPoints: 5 }), 'unsupported'],
    ['the Google app on iOS', env({ userAgent: UA.iosGoogleApp, maxTouchPoints: 5 }), 'unsupported'],
    ['an Instagram webview', env({ userAgent: UA.iosInstagram, maxTouchPoints: 5 }), 'unsupported'],
    ['an unlisted iOS browser that omits Version/', env({ userAgent: UA.iosUnlisted, maxTouchPoints: 5 }), 'unsupported'],
    ['Safari on a Mac', env({ userAgent: UA.macSafari, maxTouchPoints: 0 }), 'unsupported'],
    ['Android Chrome holding a prompt', env({ userAgent: UA.androidChrome, promptHeld: true }), 'prompt'],
    ['Android Chrome with no prompt yet', env({ userAgent: UA.androidChrome }), 'unsupported'],
    ['Android Chrome after its prompt was used', env({ userAgent: UA.androidChrome, promptUsed: true }), 'manual'],
    ['a fresh prompt after a used one', env({ userAgent: UA.androidChrome, promptUsed: true, promptHeld: true }), 'prompt'],
    ['desktop Chrome holding a prompt', env({ promptHeld: true }), 'prompt'],
    ['standalone by display-mode', env({ userAgent: UA.androidChrome, displayModeStandalone: true, promptHeld: true }), 'installed'],
    ['standalone by navigator.standalone', env({ userAgent: UA.iphoneSafari, maxTouchPoints: 5, navigatorStandalone: true }), 'installed'],
    ['a tab after appinstalled fired', env({ userAgent: UA.androidChrome, appInstalled: true }), 'installed'],
  ] as const)('%s → %s', (_label, input, expected) => {
    expect(classifyInstall(input)).toBe(expected);
  });
});

describe('canOfferInstall', () => {
  it.each([
    ['unknown', false],
    ['installed', false],
    ['ios-safari', true],
    ['prompt', true],
    ['manual', true],
    ['unsupported', false],
  ] as const satisfies readonly (readonly [InstallSupport, boolean])[])('%s → %s', (support, expected) => {
    expect(canOfferInstall(support)).toBe(expected);
  });
});

describe('installStepsVariant', () => {
  it.each([
    ['ios-safari', 'ios'],
    ['prompt', 'manual'],
    ['manual', 'manual'],
  ] as const satisfies readonly (readonly [OfferableInstallSupport, 'ios' | 'manual'])[])('%s → %s', (support, expected) => {
    expect(installStepsVariant(support)).toBe(expected);
  });
});
