// Creates a room in a running environment and waits for a room event sent through the broker.
// Usage: node smoke-test.mjs <base url>, e.g. node smoke-test.mjs https://pipoker-qa.duckdns.org
const baseUrl = new URL(process.argv[2] ?? 'http://localhost');
const wsUrl = `${baseUrl.protocol === 'https:' ? 'wss' : 'ws'}://${baseUrl.host}/ws/websocket`;

const frame = (command, headers, body = '') =>
  `${command}\n${Object.entries(headers).map(([key, value]) => `${key}:${value}`).join('\n')}\n\n${body}\0`;
const fail = (message) => {
  console.error(`FAILED: ${message}`);
  process.exit(1);
};
const timeout = setTimeout(() => fail('no answer in 30 seconds'), 30000);

const ws = new WebSocket(wsUrl);
let roomId;
ws.onerror = () => fail(`cannot connect to ${wsUrl}`);
ws.onopen = () => ws.send(frame('CONNECT', { 'accept-version': '1.2', host: baseUrl.hostname }));
ws.onmessage = (event) => {
  const data = event.data.toString();
  const command = data.split('\n')[0];
  const body = data.slice(data.indexOf('\n\n') + 2).replace(/\0$/, '');
  if (command === 'CONNECTED') {
    ws.send(frame('SUBSCRIBE', { id: 'created', destination: '/user/topic/room.created' }));
    ws.send(frame('SUBSCRIBE', { id: 'errors', destination: '/user/topic/room.errors' }));
    ws.send(frame('SEND', { destination: '/app/room/create', 'content-type': 'application/json' },
      JSON.stringify({ name: 'Smoke test', deck: { cards: ['1', '2'] }, participants: [{ nickname: 'Alice', watcher: false }] })));
  } else if (command === 'MESSAGE' && data.includes('destination:/user/topic/room.errors')) {
    fail(body);
  } else if (command === 'MESSAGE' && !roomId) {
    roomId = JSON.parse(body).id;
    console.log(`Room ${roomId} created`);
    ws.send(frame('SUBSCRIBE', { id: 'room', destination: `/topic/room.${roomId}` }));
    // The broker confirms subscriptions asynchronously, so give it a moment before triggering the event
    setTimeout(() => ws.send(frame('SEND', { destination: `/app/room/${roomId}/participants/add`, 'content-type': 'application/json' },
      JSON.stringify({ nickname: 'Bob', watcher: false }))), 1000);
  } else if (command === 'MESSAGE') {
    console.log(`Room event received: ${body}`);
    clearTimeout(timeout);
    ws.close();
  } else if (command === 'ERROR') {
    fail(data);
  }
};
