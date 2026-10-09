import {type APIRequestContext, type APIResponse, expect, test as base} from '@playwright/test';
import {baseUrl} from './people';
import {httpCredentials} from './stomp';

// What the server tells a browser before anyone enters a room: the page and its security headers, how long the
// browser may keep each file, the manifest for installing the site as an app, which pages may open a room
// WebSocket, and that nothing but the feedback API and the WebSocket is reachable through the site. No browser
// is needed for this, a plain HTTP client asks the same questions, so no room is created and nothing is left behind.
// QA asks for its login from outside the home network; the client takes it from httpCredentials.

const site = new URL(baseUrl);
const siteOrigin = site.origin;
// The page origin the backend lets in (STOMP_ALLOWED_ORIGINS on the server). On QA and PROD that is the site itself;
// a local copy may be configured with the real site's origin, which STOMP_ALLOWED_ORIGIN then names.
const allowedOrigin = process.env.STOMP_ALLOWED_ORIGIN ?? siteOrigin;
const foreignOrigin = 'https://evil.example';
const isQa = /^qa\./.test(site.hostname);
// A WebSocket connection the server accepts is switched away from HTTP: the client never gets an answer it can
// show, so the request hangs. A refusal comes back at once. So waiting this long and getting nothing means "accepted".
const UPGRADE_TIMEOUT_MS = 5_000;

const test = base.extend<{api: APIRequestContext}>({
  api: async ({playwright}, use) => {
    const api = await playwright.request.newContext({baseURL: baseUrl, httpCredentials});
    await use(api);
    await api.dispose();
  }
});

const describe = (response: APIResponse) => `${response.status()} ${response.headers()['content-type'] ?? '(no content type)'}`;

// Logged so the run log tells what each address answered on the real server, not only when something is off
function log(what: string, response: APIResponse, more = '') {
  console.log(`${what} -> ${describe(response)}${more ? ` ${more}` : ''}`);
}

// The headers every page of the site carries, put on by the reverse proxy in front of the web server
function expectSecurityHeaders(what: string, response: APIResponse) {
  const headers = response.headers();
  const csp = headers['content-security-policy'] ?? '';
  expect(csp, `${what}: the Content-Security-Policy allows the site itself by default`).toContain("default-src 'self'");
  expect(csp, `${what}: nobody may put the site in a frame`).toContain("frame-ancestors 'none'");
  expect(csp, `${what}: scripts come from the site only, none inline`).toMatch(/(^|;\s*)script-src 'self'\s*(;|$)/);
  expect(headers['permissions-policy'], `${what}: the camera is switched off`).toContain('camera=()');
  expect(headers['referrer-policy'], `${what}: other sites learn only where a visitor came from`).toBe('strict-origin-when-cross-origin');
  expect(headers['x-content-type-options'], `${what}: the browser must not guess content types`).toBe('nosniff');
  expect(headers['x-frame-options'], `${what}: older browsers may not frame the site either`).toBe('DENY');
  expect(headers['strict-transport-security'], `${what}: the browser stays on HTTPS`).toMatch(/max-age=\d+/);
  if (headers['server'] !== undefined) {
    // nginx serves the files and Caddy stands in front, with Cloudflare before it on the real domains. None of them
    // may tell its version, which would tell an attacker which known holes to try.
    expect(headers['server'], `${what}: the Server header gives no version away`).toMatch(/^(nginx|Caddy|cloudflare)$/);
  }
}

// The hashed files the page loads: a new release gives them new names, so a browser may keep them for good
function hashedFilesIn(html: string): string[] {
  return [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)="([^"]+)"/g)]
    .map(match => match[1])
    .filter(file => /-[A-Z0-9]{8}\.(js|css)$/i.test(file));
}

test('a browser gets the start page with the security headers and never keeps it', async ({api}) => {
  const response = await api.get('/');
  log('GET /', response, `cache-control: ${response.headers()['cache-control']}`);

  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toMatch(/^text\/html/);
  // The page names the current bundles, so a browser must ask for it on every visit to pick up a release
  expect(response.headers()['cache-control']).toContain('no-cache');
  expect(response.headers()['cache-control']).not.toContain('immutable');
  expectSecurityHeaders('the start page', response);
  const html = await response.text();
  expect(html).toContain('<app-root');
  expect(html, 'the page does not run inline scripts, which the policy would block').not.toMatch(/<script(?![^>]*\ssrc=)(?![^>]*type="application\/ld\+json")[^>]*>/);
});

test('a browser may keep the hashed bundles named in the page for good', async ({api}) => {
  const html = await (await api.get('/')).text();
  const files = hashedFilesIn(html);
  console.log(`the page loads: ${files.join(', ')}`);
  expect(files.find(file => file.startsWith('main-')), 'the page names its main bundle, main-XXXXXXXX.js').toBeDefined();
  expect(files.length, 'the main bundle comes with the polyfills and the styles').toBeGreaterThanOrEqual(2);

  for (const file of files) {
    const response = await api.get(`/${file}`);
    log(`GET /${file}`, response, `cache-control: ${response.headers()['cache-control']}`);
    expect(response.status(), `${file} is there`).toBe(200);
    expect(response.headers()['cache-control'], `${file} may stay in the browser cache for good`).toContain('immutable');
    expect(response.headers()['content-type'], `${file} comes with its type`).toMatch(file.endsWith('.css') ? /css/ : /javascript/);
    expect(response.headers()['x-content-type-options'], `${file}: the browser must not guess the type`).toBe('nosniff');
  }
});

test('a browser can install the site as an app from the manifest and its icons', async ({api}) => {
  const html = await (await api.get('/')).text();
  const href = html.match(/<link[^>]*rel="manifest"[^>]*href="([^"]+)"/)?.[1];
  expect(href, 'the page links its manifest').toBeDefined();
  const manifestUrl = new URL(href!, `${siteOrigin}/`);
  expect(manifestUrl.pathname).toBe('/manifest.webmanifest');

  const response = await api.get(manifestUrl.href);
  log(`GET ${manifestUrl.pathname}`, response, `cache-control: ${response.headers()['cache-control']}`);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toMatch(/^application\/manifest\+json/);
  // A release may change the manifest, so it is fetched afresh like the page
  expect(response.headers()['cache-control']).toContain('no-cache');
  expectSecurityHeaders('the manifest', response);

  const manifest = await response.json();
  expect(manifest.name).toBe('PiPoker');
  expect(manifest.start_url).toBe('/');
  expect(manifest.display).toBe('standalone');
  const icons: {src: string; type: string; sizes: string}[] = manifest.icons;
  expect(icons.map(icon => icon.src)).toEqual(expect.arrayContaining(['assets/app-icon-192.png', 'assets/app-icon-512.png', 'assets/app-icon-maskable-512.png']));
  // Icon addresses count from the manifest, which sits at the site root
  for (const icon of icons) {
    const iconUrl = new URL(icon.src, manifestUrl);
    const iconResponse = await api.get(iconUrl.href);
    log(`GET ${iconUrl.pathname}`, iconResponse);
    expect(iconResponse.status(), `${icon.src} is there`).toBe(200);
    expect(icon.type, `${icon.src} is declared as PNG`).toBe('image/png');
    expect(iconResponse.headers()['content-type'], `${icon.src} is served as PNG`).toMatch(/^image\/png/);
  }
});

test('an invitation link or a mistyped address opens the app, which decides what to show', async ({api}) => {
  // The browser asks the server for the full address, and only the app knows its routes: every address gets the page
  for (const path of ['/no/such/page', '/room/00000000-0000-4000-8000-000000000000']) {
    const response = await api.get(path);
    log(`GET ${path}`, response, `cache-control: ${response.headers()['cache-control']}`);
    expect(response.status(), `${path} gets the app's page`).toBe(200);
    expect(response.headers()['content-type']).toMatch(/^text\/html/);
    expect(await response.text()).toContain('<app-root');
    expect(response.headers()['cache-control'], `${path} is not kept by the browser either`).toContain('no-cache');
    expectSecurityHeaders(path, response);
  }
});

test('a browser learns that the WebSocket is there', async ({api}) => {
  // The first thing the web client asks before it connects: what the endpoint supports
  const response = await api.get('/ws/info');
  const body = await response.text();
  log('GET /ws/info', response, body);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toMatch(/json/);
  expect(JSON.parse(body).websocket, 'the endpoint speaks WebSocket').toBe(true);
});

// The handshake of a browser opening a WebSocket, with the Origin of the page that asks for it, or none for a
// client that is not a page, like the tests' own STOMP client.
type Upgrade = {label: string; status?: number; answeredBy?: string; accepted: boolean; outcome: string};

async function tryUpgrade(api: APIRequestContext, label: string, origin?: string): Promise<Upgrade> {
  const headers: Record<string, string> = {
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
    ...(origin ? {Origin: origin} : {})
  };
  try {
    const response = await api.get('/ws/websocket', {headers, timeout: UPGRADE_TIMEOUT_MS, maxRedirects: 0});
    // The Server header tells where a refusal came from: Cloudflare names itself, the backend behind Caddy says nothing
    const answeredBy = response.headers()['server'];
    const text = (await response.text()).trim().replace(/\s+/g, ' ').slice(0, 80);
    return {label, status: response.status(), answeredBy, accepted: false, outcome: `answered ${response.status()}${answeredBy ? ` by ${answeredBy}` : ''}${text ? ` "${text}"` : ''}`};
  } catch (error) {
    const message = String((error as Error).message).split('\n')[0];
    return /Timeout/.test(message)
      ? {label, accepted: true, outcome: `accepted: the connection was switched to a WebSocket, so no answer came within ${UPGRADE_TIMEOUT_MS} ms`}
      : {label, accepted: false, outcome: `no answer: ${message}`};
  }
}

test('a page on another site cannot open a room WebSocket, while the site\'s own pages can', async ({api}) => {
  const origins: [string, string | undefined][] = [
    ['no Origin header', undefined],
    [`the site's own origin ${siteOrigin}`, siteOrigin],
    [`the allowed origin ${allowedOrigin}`, allowedOrigin],
    [`the foreign origin ${foreignOrigin}`, foreignOrigin]
  ];

  // The info request comes first in the web client's handshake; the server already checks the Origin there
  const info = await Promise.all(origins.map(async ([label, origin]) => {
    const response = await api.get('/ws/info', {headers: origin ? {Origin: origin} : {}});
    log(`GET /ws/info with ${label}`, response);
    return response;
  }));
  const [infoWithoutOrigin, infoOwn, infoAllowed, infoForeign] = info;
  expect(infoWithoutOrigin.status(), 'a client that is not a page, like a script, is let in').toBe(200);
  expect(infoOwn.status(), `a page on the site itself, ${siteOrigin}, is let in`).toBe(200);
  expect(infoAllowed.status(), `a page on ${allowedOrigin} is let in`).toBe(200);
  expect(infoForeign.status(), `a page on ${foreignOrigin} is refused`).toBe(403);

  // Then the WebSocket itself, which is where a room would be opened
  const upgrades = await Promise.all(origins.map(([label, origin]) => tryUpgrade(api, label, origin)));
  for (const upgrade of upgrades) {
    console.log(`WebSocket upgrade with ${upgrade.label}: ${upgrade.outcome}`);
  }
  const [upgradeWithoutOrigin, upgradeOwn, upgradeAllowed, upgradeForeign] = upgrades;
  // The backend refuses a foreign page with 403. On the real domains Cloudflare stands in front, and when a server
  // answers a WebSocket handshake with anything but 101 Cloudflare keeps that answer to itself and reports a
  // 502 Bad Gateway of its own, so there the refusal shows as Cloudflare's 502. A local copy has no Cloudflare and
  // shows the 403 itself. Either way the foreign page gets no WebSocket.
  expect(upgradeForeign.accepted, `a WebSocket from ${foreignOrigin} is refused, got: ${upgradeForeign.outcome}`).toBe(false);
  const refusedByCloudflare = upgradeForeign.answeredBy === 'cloudflare' && upgradeForeign.status === 502;
  if (!refusedByCloudflare) {
    expect(upgradeForeign.status, `a WebSocket from ${foreignOrigin} is refused with 403, got: ${upgradeForeign.outcome}`).toBe(403);
  }
  expect(upgradeAllowed.accepted, `a WebSocket from ${allowedOrigin} is accepted, got: ${upgradeAllowed.outcome}`).toBe(true);
  expect(upgradeOwn.accepted, `a WebSocket from the site itself is accepted, got: ${upgradeOwn.outcome}`).toBe(true);
  expect(upgradeWithoutOrigin.accepted, `a WebSocket without an Origin is accepted, got: ${upgradeWithoutOrigin.outcome}`).toBe(true);
});

test('the feedback API takes a proper POST and nothing else', async ({api}) => {
  const get = await api.get('/api/feedback');
  log('GET /api/feedback', get, `allow: ${get.headers()['allow']}`);
  expect(get.status(), 'feedback cannot be read').toBe(405);
  expect(get.headers()['allow'], 'the answer says what is allowed').toContain('POST');

  // An empty message is refused before it could become an issue anywhere
  const empty = await api.post('/api/feedback', {data: {}});
  const emptyBody = await empty.text();
  log('POST /api/feedback {}', empty, emptyBody.slice(0, 120));
  expect(empty.status()).toBe(400);
  expect(emptyBody, 'the refusal gives no internals away').not.toMatch(/Exception|\n\s+at /);

  const unknown = await api.get('/api/no/such/endpoint');
  log('GET /api/no/such/endpoint', unknown);
  expect(unknown.status(), 'the API has nothing else to offer').toBe(404);
});

test('the backend\'s management endpoints cannot be reached through the site', async ({api}) => {
  // The health and the metrics are for the monitoring inside the server, never for a visitor. Through the site
  // such an address is unknown: the web server answers with the app's page like for any other, or with an error.
  for (const path of ['/actuator', '/actuator/health', '/actuator/prometheus', '/api/actuator/health']) {
    const response = await api.get(path);
    const body = await response.text();
    const isAppPage = response.status() === 200 && body.includes('<app-root');
    log(`GET ${path}`, response, isAppPage ? "(the app's page)" : body.slice(0, 100));
    expect(body, `${path} gives no health status away`).not.toMatch(/"status"\s*:\s*"(UP|DOWN|OUT_OF_SERVICE|UNKNOWN)"/);
    expect(body, `${path} gives no metrics away`).not.toMatch(/^# (HELP|TYPE) /m);
    expect(body, `${path} lists no management endpoints`).not.toContain('"_links"');
    if (response.status() === 200) {
      expect(response.headers()['content-type'], `${path} with 200 can only be the app's page`).toMatch(/^text\/html/);
      expect(body, `${path} with 200 can only be the app's page`).toContain('<app-root');
    }
    if (path.startsWith('/api/')) {
      expect(response.status(), 'the backend has no management endpoint under the API').not.toBe(200);
    }
  }
});

test('the activity dashboard answers on QA and nowhere else', async ({api}) => {
  const response = await api.get('/grafana/');
  const body = await response.text();
  const isGrafana = /<title>Grafana<\/title>|grafana/i.test(body) && !body.includes('<app-root');
  log('GET /grafana/', response, isGrafana ? '(the dashboard)' : body.includes('<app-root') ? "(the app's page)" : body.slice(0, 100));

  if (isQa) {
    // The dashboard of both environments lives behind the QA login
    expect(response.status()).toBe(200);
    expect(isGrafana, 'the address shows the dashboard, not the app').toBe(true);
    // PIP-46 parity: QA's /grafana carries the same hardening headers PROD's /grafana does. A strict CSP would
    // break Grafana's UI, and Grafana sets its own X-Frame-Options/X-Content-Type-Options, so Caddy adds only the
    // three it does not: HSTS, Referrer-Policy and Permissions-Policy. (X-Frame-Options still comes from Grafana.)
    const g = response.headers();
    expect(g['strict-transport-security'], 'QA /grafana keeps the browser on HTTPS').toMatch(/max-age=\d+/);
    expect(g['referrer-policy'], 'QA /grafana limits what other sites learn').toBe('strict-origin-when-cross-origin');
    expect(g['permissions-policy'], 'QA /grafana switches the camera off').toContain('camera=()');
    expect(g['x-frame-options']?.toLowerCase(), 'QA /grafana may not be framed (Grafana sets this itself)').toBe('deny');
  } else {
    // PROD runs no dashboard, so /grafana is just one more unknown address: the app's page, and it carries the
    // same security headers as every other page. (PIP-46: these addresses used to miss the hardening headers,
    // because the shared Caddy snippet kept them off /grafana for QA's dashboard and PROD inherited that.)
    expect(isGrafana, 'no dashboard is reachable outside QA').toBe(false);
    expect(response.status(), "/grafana/ on PROD is the app's page").toBe(200);
    expect(response.headers()['content-type']).toMatch(/^text\/html/);
    expect(body).toContain('<app-root');
    expectSecurityHeaders('/grafana/ on PROD', response);
  }
});
