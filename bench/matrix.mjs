// BrowserStack Automate (Mobile тариф включает и desktop browsers) capabilities
// matrix для NSLab бенчмарка.
//
// Один Appium hub URL (hub-cloud.browserstack.com/wd/hub) принимает оба типа caps:
//  - mobile: 'bstack:options' с deviceName / osVersion / realMobile
//  - desktop: 'bstack:options' с os / osVersion / browserVersion
//
// Тариф Automate Mobile ($399/mo) даёт доступ к 3500+ desktop+mobile комбинациям.

const BUILD = `nslab-${new Date().toISOString().slice(0, 10)}`;
const TEST_URL = process.env.NSLAB_URL || 'https://speak.kn.pe/lab/noise-bench/';

export const TEST = { url: TEST_URL, build: BUILD };

export const matrix = [
  // === MOBILE (real devices) ===
  {
    kind: 'mobile', browserName: 'safari',
    deviceName: 'iPhone 15 Pro', osVersion: '17',
    name: 'iOS Safari · iPhone 15 Pro',
  },
  {
    kind: 'mobile', browserName: 'safari',
    deviceName: 'iPhone 13', osVersion: '15',
    name: 'iOS Safari · iPhone 13 (старее)',
  },
  {
    kind: 'mobile', browserName: 'chrome',
    deviceName: 'Google Pixel 8', osVersion: '14.0',
    name: 'Android Chrome · Pixel 8',
  },
  {
    kind: 'mobile', browserName: 'chrome',
    deviceName: 'Samsung Galaxy S24', osVersion: '14.0',
    name: 'Android Chrome · Galaxy S24',
  },
  {
    kind: 'mobile', browserName: 'chrome',
    deviceName: 'Samsung Galaxy A52', osVersion: '11.0',
    name: 'Android Chrome · Galaxy A52 (бюджет)',
  },

  // === DESKTOP ===
  // Windows 11 — самая массовая аудитория.
  {
    kind: 'desktop', browserName: 'Chrome',
    os: 'Windows', osVersion: '11', browserVersion: 'latest',
    name: 'Chrome · Windows 11',
  },
  {
    kind: 'desktop', browserName: 'Edge',
    os: 'Windows', osVersion: '11', browserVersion: 'latest',
    name: 'Edge · Windows 11',
  },
  {
    kind: 'desktop', browserName: 'Firefox',
    os: 'Windows', osVersion: '11', browserVersion: 'latest',
    name: 'Firefox · Windows 11',
  },
  // macOS — для Mac-юзеров Speak команды.
  {
    kind: 'desktop', browserName: 'Chrome',
    os: 'OS X', osVersion: 'Sequoia', browserVersion: 'latest',
    name: 'Chrome · macOS Sequoia',
  },
  {
    kind: 'desktop', browserName: 'Safari',
    os: 'OS X', osVersion: 'Sequoia', browserVersion: 'latest',
    name: 'Safari · macOS Sequoia',
  },
  {
    kind: 'desktop', browserName: 'Firefox',
    os: 'OS X', osVersion: 'Sequoia', browserVersion: 'latest',
    name: 'Firefox · macOS Sequoia',
  },
];

/**
 * Capability object для WebDriver (W3C формат с bstack:options).
 * Mobile и desktop отличаются содержимым bstack:options.
 */
export function toCaps(item) {
  const bstackBase = {
    projectName: 'NSLab',
    buildName: BUILD,
    sessionName: item.name,
    userName: process.env.BROWSERSTACK_USERNAME,
    accessKey: process.env.BROWSERSTACK_ACCESS_KEY,
    seleniumVersion: '4.0.0',
    idleTimeout: 300,
    consoleLogs: 'warnings',
    networkLogs: false,
  };

  if (item.kind === 'mobile') {
    return {
      browserName: item.browserName,
      'bstack:options': {
        ...bstackBase,
        deviceName: item.deviceName,
        osVersion: item.osVersion,
        realMobile: true,
      },
    };
  }
  // desktop
  return {
    browserName: item.browserName,
    browserVersion: item.browserVersion,
    'bstack:options': {
      ...bstackBase,
      os: item.os,
      osVersion: item.osVersion,
    },
  };
}
