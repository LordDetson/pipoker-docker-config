// Stands in front of PiPoker on Cloudflare (see wrangler.toml for the domains). Every request goes on to the
// server unchanged, so WebSockets and the visitor's address (CF-Connecting-IP) reach it as before. Only when the
// server cannot answer a page, because tuf, the tunnel or the home internet is down, or Caddy finds no backend,
// the visitor gets a page saying that PiPoker is temporarily unavailable instead of Cloudflare's error page.

// What Caddy answers when an environment's container is down (502, 503, 504) and what Cloudflare answers when
// it cannot reach the server at all (52x, and 530 when the tunnel is down)
const UNAVAILABLE = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530]);

// The same languages the web client shows in Russian (see translations.ts in pipoker-web)
const RUSSIAN = ['ru', 'be', 'kk', 'ky', 'uz', 'tg', 'tk', 'az', 'hy'];

const TEXTS = {
	ru: {
		lang: 'ru',
		title: 'PiPoker временно недоступен',
		message: 'Сервис сейчас недоступен по техническим причинам. Мы уже работаем над этим.',
		retry: 'Страница обновится сама, как только PiPoker снова заработает.',
	},
	en: {
		lang: 'en',
		title: 'PiPoker is temporarily unavailable',
		message: 'The service is down for technical reasons. We are already working on it.',
		retry: 'This page reloads by itself as soon as PiPoker is back.',
	},
};

export default {
	async fetch(request) {
		let response;
		try {
			response = await fetch(request);
		} catch {
			response = null;
		}
		if (response && !UNAVAILABLE.has(response.status)) {
			return response;
		}
		// Scripts, WebSockets and the backend's API keep their own error: the web client handles those itself
		if (!isPage(request)) {
			return response ?? new Response(null, { status: 502 });
		}
		return unavailablePage(request);
	},
};

function isPage(request) {
	if (request.method !== 'GET') {
		return false;
	}
	const mode = request.headers.get('Sec-Fetch-Mode');
	if (mode) {
		return mode === 'navigate';
	}
	return (request.headers.get('Accept') ?? '').includes('text/html');
}

export function language(acceptLanguage) {
	const first = (acceptLanguage ?? '').split(',')[0].trim().toLowerCase().split('-')[0];
	return RUSSIAN.includes(first) ? TEXTS.ru : TEXTS.en;
}

function unavailablePage(request) {
	const text = language(request.headers.get('Accept-Language'));
	const html = `<!doctype html>
<html lang="${text.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<meta name="robots" content="noindex">
<title>${text.title}</title>
<style>
:root { color-scheme: light dark; --background: #f5f6fa; --card: #ffffff; --text: #1f2330; --muted: #5c6275; }
@media (prefers-color-scheme: dark) { :root { --background: #14161f; --card: #1f2230; --text: #eceef5; --muted: #a3a8ba; } }
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px;
	box-sizing: border-box; background: var(--background); color: var(--text); font-family: system-ui, sans-serif; }
main { max-width: 480px; padding: 32px; border-radius: 16px; background: var(--card); text-align: center; }
h1 { margin: 0 0 16px; font-size: 1.5rem; }
p { margin: 0 0 12px; line-height: 1.5; }
.muted { margin: 0; color: var(--muted); font-size: 0.9rem; }
</style>
</head>
<body>
<main>
<h1>${text.title}</h1>
<p>${text.message}</p>
<p class="muted">${text.retry}</p>
</main>
</body>
</html>
`;
	return new Response(html, {
		status: 503,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store',
			'Retry-After': '30',
		},
	});
}
