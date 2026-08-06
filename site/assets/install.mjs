export const DEFAULT_BUNDLE_URL =
  'https://github.com/marianfoo/sap-mcp-servers/releases/download/sap-notes-latest/sap-notes.mcpb';

export const PAGES_BASE_URL = 'https://marianfoo.github.io/sap-mcp-servers/';

export function normalizeBundleUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;

  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443')
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

export function buildWerkbankUrl(rawBundleUrl) {
  const bundleUrl = normalizeBundleUrl(rawBundleUrl);
  if (!bundleUrl) return null;
  return `werkbank://install-mcpb?url=${encodeURIComponent(bundleUrl)}`;
}

export function buildInstallPageUrl(rawBundleUrl, baseUrl = PAGES_BASE_URL) {
  const bundleUrl = normalizeBundleUrl(rawBundleUrl);
  if (!bundleUrl) return null;
  return new URL(`install-mcpb/?url=${encodeURIComponent(bundleUrl)}`, baseUrl).href;
}

function setText(document, selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
}

export function initializePage({ document, location, openProtocol } = {}) {
  if (!document || !location) return { mode: 'server' };

  const landingLinks = document.querySelectorAll('[data-default-install-link]');
  const installPageUrl = buildInstallPageUrl(DEFAULT_BUNDLE_URL, location.href);
  for (const link of landingLinks) link.href = installPageUrl;

  if (document.body?.dataset.page !== 'install') return { mode: 'landing' };

  const params = new URLSearchParams(location.search);
  const bundleUrl = normalizeBundleUrl(params.get('url') ?? '');
  const panel = document.querySelector('[data-install-panel]');
  const invalid = document.querySelector('[data-invalid-panel]');

  if (!bundleUrl) {
    panel?.setAttribute('hidden', '');
    invalid?.removeAttribute('hidden');
    return { mode: 'invalid' };
  }

  const deepLink = buildWerkbankUrl(bundleUrl);
  const host = new URL(bundleUrl).host;
  setText(document, '[data-bundle-host]', host);

  for (const link of document.querySelectorAll('[data-open-werkbank]')) {
    link.href = deepLink;
    link.addEventListener('click', () => {
      setText(document, '[data-install-status]', 'Werkbank launch requested. Confirm the connector inside the app.');
    });
  }

  const download = document.querySelector('[data-download-bundle]');
  if (download) download.href = bundleUrl;

  const copy = document.querySelector('[data-copy-link]');
  copy?.addEventListener('click', async () => {
    await navigator.clipboard?.writeText(deepLink);
    setText(document, '[data-copy-label]', 'Copied');
  });

  if (params.get('auto') !== '0') {
    globalThis.setTimeout(() => {
      setText(document, '[data-install-status]', 'Opening Werkbank…');
      openProtocol?.(deepLink);
    }, 450);
  }

  return { mode: 'install', bundleUrl, deepLink };
}

if (typeof document !== 'undefined' && typeof location !== 'undefined') {
  initializePage({
    document,
    location,
    openProtocol: (url) => location.assign(url),
  });
}
