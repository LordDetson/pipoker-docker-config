// node --test (from cloudflare/unavailable-page; CI runs it, see .github/workflows/unavailable-page.yml)
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { language } from './worker.js';

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function serverAnswers(status, body = 'from the server') {
	globalThis.fetch = async () => new Response(body, { status });
}

function page(headers = {}) {
	return new Request('https://pipoker.app/room/abc', {
		headers: { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html', ...headers },
	});
}

test('passes what the server answers on', async () => {
	serverAnswers(200);
	const response = await worker.fetch(page());
	assert.equal(response.status, 200);
	assert.equal(await response.text(), 'from the server');
});

test('passes the server\'s own errors on', async () => {
	serverAnswers(404);
	assert.equal((await worker.fetch(page())).status, 404);
	serverAnswers(500);
	assert.equal((await worker.fetch(page())).status, 500);
});

for (const status of [502, 503, 504, 521, 522, 530]) {
	test(`shows the unavailable page when a page gets ${status}`, async () => {
		serverAnswers(status);
		const response = await worker.fetch(page({ 'Accept-Language': 'ru-RU,ru;q=0.9' }));
		assert.equal(response.status, 503);
		assert.equal(response.headers.get('Cache-Control'), 'no-store');
		assert.match(await response.text(), /недоступен по техническим причинам/);
	});
}

test('hardens the unavailable page like every other page', async () => {
	serverAnswers(530);
	const response = await worker.fetch(page());
	assert.match(response.headers.get('Content-Security-Policy'), /default-src 'none'.*frame-ancestors 'none'/);
	assert.equal(response.headers.get('Strict-Transport-Security'), 'max-age=31536000; includeSubDomains');
	assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
	assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
	assert.equal(response.headers.get('Referrer-Policy'), 'strict-origin-when-cross-origin');
	assert.match(response.headers.get('Permissions-Policy'), /camera=\(\)/);
	assert.doesNotMatch(await response.text(), /<script/);
});

test('shows the unavailable page when the server cannot be reached at all', async () => {
	globalThis.fetch = async () => {
		throw new TypeError('network connection lost');
	};
	const response = await worker.fetch(page({ 'Accept-Language': 'en-GB' }));
	assert.equal(response.status, 503);
	assert.match(await response.text(), /temporarily unavailable/);
});

test('leaves the errors of scripts and the backend to the web client', async () => {
	serverAnswers(502, 'backend down');
	const script = new Request('https://pipoker.app/main.js', { headers: { 'Sec-Fetch-Mode': 'no-cors' } });
	assert.equal((await worker.fetch(script)).status, 502);
	const api = new Request('https://pipoker.app/ws/info', { headers: { Accept: 'application/json' } });
	assert.equal(await (await worker.fetch(api)).text(), 'backend down');
	const feedback = new Request('https://pipoker.app/api/feedback', {
		method: 'POST',
		headers: { 'Sec-Fetch-Mode': 'navigate' },
	});
	assert.equal((await worker.fetch(feedback)).status, 502);
});

test('picks the language the way the web client does', () => {
	assert.equal(language('ru').lang, 'ru');
	assert.equal(language('be-BY,be;q=0.9,en;q=0.8').lang, 'ru');
	assert.equal(language('kk').lang, 'ru');
	assert.equal(language('en-US,ru;q=0.5').lang, 'en');
	assert.equal(language('de').lang, 'en');
	assert.equal(language(null).lang, 'en');
});
