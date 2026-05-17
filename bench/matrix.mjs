// BrowserStack App Automate (Appium) capabilities matrix для mobile-web бенчмарка.
// Docs: https://www.browserstack.com/docs/app-automate/appium/getting-started
//
// План «Automate Mobile» позволяет гонять Safari iOS / Chrome Android через
// Appium-WebDriver. Десктоп под этим планом недоступен — для Chrome/Edge/Firefox/Safari
// на macOS/Windows нужен отдельный «Automate» plan, либо локальный запуск.
//
// Зачем мобайл интересен: ARM CPU + ограниченные браузерные backends
// (iOS Safari = WebKit без WebGPU, Android Chrome = Blink с WebGPU
// под флагом) — это самые «жёсткие» условия, где разница между
// шумодавами проявится максимально.

const BUILD = `nslab-${new Date().toISOString().slice(0, 10)}`;
const TEST_URL = process.env.NSLAB_URL || 'https://speak.kn.pe/lab/noise-bench/';

export const TEST = { url: TEST_URL, build: BUILD };

export const matrix = [
  {
    deviceName: 'iPhone 15 Pro',
    osVersion: '17',
    browserName: 'safari',
    name: 'iOS Safari · iPhone 15 Pro',
  },
  {
    deviceName: 'iPhone 13',
    osVersion: '15',
    browserName: 'safari',
    name: 'iOS Safari · iPhone 13 (старее)',
  },
  {
    deviceName: 'Google Pixel 8',
    osVersion: '14.0',
    browserName: 'chrome',
    name: 'Android Chrome · Pixel 8',
  },
  {
    deviceName: 'Samsung Galaxy S24',
    osVersion: '14.0',
    browserName: 'chrome',
    name: 'Android Chrome · Galaxy S24',
  },
  {
    deviceName: 'Samsung Galaxy A14',
    osVersion: '13.0',
    browserName: 'chrome',
    name: 'Android Chrome · Galaxy A14 (бюджетный)',
  },
];

/** Capability object для WebDriver (Appium W3C формат с bstack:options). */
export function toCaps(item) {
  return {
    browserName: item.browserName,
    'bstack:options': {
      deviceName: item.deviceName,
      osVersion: item.osVersion,
      projectName: 'NSLab',
      buildName: BUILD,
      sessionName: item.name,
      userName: process.env.BROWSERSTACK_USERNAME,
      accessKey: process.env.BROWSERSTACK_ACCESS_KEY,
      seleniumVersion: '4.0.0',
      idleTimeout: 300,
      consoleLogs: 'warnings',
      networkLogs: false,
      // realMobile=true → реальное устройство, не симулятор (тариф позволяет).
      realMobile: true,
    },
  };
}
