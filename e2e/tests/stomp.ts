// A minimal STOMP client over the raw WebSocket endpoint of SockJS, enough to talk to PiPoker without a browser.
const frame = (command: string, headers: Record<string, string>, body = '') =>
  `${command}\n${Object.entries(headers).map(([key, value]) => `${key}:${value}`).join('\n')}\n\n${body}\0`;

export interface Frame {
  command: string;
  headers: Record<string, string>;
  body: string;
}

export class Stomp {
  private nextId = 0;
  private handlers = new Map<string, (frame: Frame) => void>();
  readonly errors: string[] = [];

  private constructor(private ws: WebSocket) {
  }

  static connect(baseUrl: string): Promise<Stomp> {
    const url = new URL(baseUrl);
    const ws = new WebSocket(`${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}/ws/websocket`);
    const client = new Stomp(ws);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('STOMP connection timed out')), 30_000);
      ws.onerror = () => reject(new Error(`cannot connect to ${url.host}`));
      // No host header: the broker relay would pass it to RabbitMQ as a virtual host
      ws.onopen = () => ws.send(frame('CONNECT', {'accept-version': '1.2', 'heart-beat': '0,0'}));
      ws.onmessage = event => {
        const parsed = parse(event.data.toString());
        if (!parsed) {
          return;
        }
        if (parsed.command === 'CONNECTED') {
          clearTimeout(timer);
          client.subscribe('/user/topic/room.errors', error => client.errors.push(error.body));
          resolve(client);
        } else if (parsed.command === 'MESSAGE') {
          client.handlers.get(parsed.headers['subscription'])?.(parsed);
        } else if (parsed.command === 'ERROR') {
          client.errors.push(parsed.headers['message'] ?? parsed.body);
          reject(new Error(parsed.body));
        }
      };
    });
  }

  subscribe(destination: string, handler: (frame: Frame) => void): string {
    const id = `sub-${this.nextId++}`;
    this.handlers.set(id, handler);
    this.ws.send(frame('SUBSCRIBE', {id, destination}));
    return id;
  }

  send(destination: string, body: unknown) {
    if (typeof body === 'string') {
      this.ws.send(frame('SEND', {destination}, body));
    } else {
      this.ws.send(frame('SEND', {destination, 'content-type': 'application/json'}, JSON.stringify(body)));
    }
  }

  // Answers to /app/... subscriptions come once, either as the reply or as an error.
  request<T>(destination: string, timeoutMs = 15_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const errorsBefore = this.errors.length;
      const timer = setTimeout(() => {
        clearInterval(poll);
        reject(new Error(this.errors.slice(errorsBefore).join('; ') || `no answer from ${destination}`));
      }, timeoutMs);
      const poll = setInterval(() => {
        if (this.errors.length > errorsBefore) {
          clearTimeout(timer);
          clearInterval(poll);
          reject(new Error(this.errors.slice(errorsBefore).join('; ')));
        }
      }, 100);
      this.subscribe(destination, message => {
        clearTimeout(timer);
        clearInterval(poll);
        resolve(JSON.parse(message.body));
      });
    });
  }

  close() {
    this.ws.close();
  }
}

function parse(data: string): Frame | undefined {
  const text = data.replace(/^\n+/, '');
  if (!text) {
    return undefined;
  }
  const headerEnd = text.indexOf('\n\n');
  const [command, ...headerLines] = text.slice(0, headerEnd).split('\n');
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const separator = line.indexOf(':');
    headers[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return {command, headers, body: text.slice(headerEnd + 2).replace(/\0\n*$/, '')};
}

export interface RoomDto {
  id: string;
  name: string;
  deck: {cards: string[]};
  participants: {nickname: string; watcher: boolean}[];
  votes?: {nickname: string; card: string}[];
}

// Reads a room the way a browser does when it opens a room link; rejects when the room is gone.
export async function fetchRoom(baseUrl: string, roomId: string): Promise<RoomDto> {
  const client = await Stomp.connect(baseUrl);
  try {
    return await client.request<RoomDto>(`/app/room/${roomId}`);
  } finally {
    client.close();
  }
}

export async function roomExists(baseUrl: string, roomId: string): Promise<boolean> {
  try {
    await fetchRoom(baseUrl, roomId);
    return true;
  } catch (error) {
    if (String(error).includes('not found')) {
      return false;
    }
    throw error;
  }
}
