import {Browser, BrowserContextOptions, expect, Locator, Page, test} from '@playwright/test';
import {httpCredentials, roomExists} from './stomp';

export const baseUrl = process.env.BASE_URL ?? 'https://pipoker-qa.duckdns.org';
export const testRoomName = () => `E2E ${new Date().toISOString().slice(11, 19)}`;

// One person is one browser profile: their own storage, their own WebSocket connection.
export interface Person {
  name: string;
  page: Page;
  consoleErrors: string[];
  frames: string[];
}

export async function person(browser: Browser, name: string, options: BrowserContextOptions = {}): Promise<Person> {
  const context = await browser.newContext({baseURL: baseUrl, httpCredentials, ...options});
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on('console', message => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', error => consoleErrors.push(error.message));
  // What went over the WebSocket, printed when a step fails
  const frames: string[] = [];
  page.on('websocket', socket => {
    socket.on('framesent', frame => frames.push(`> ${String(frame.payload).slice(0, 300)}`));
    socket.on('framereceived', frame => frames.push(`< ${String(frame.payload).slice(0, 300)}`));
    socket.on('close', () => frames.push('-- closed'));
  });
  return {name, page, consoleErrors, frames};
}

export async function createRoom(someone: Person, options: {deck?: string; watcher?: boolean; roomName?: string} = {}): Promise<string> {
  const {page} = someone;
  await page.goto('/');
  await page.locator('#nicknameInput').fill(someone.name);
  await page.locator('#roomNameInput').fill(options.roomName ?? testRoomName());
  if (options.deck) {
    await page.locator('#deckInput').fill(options.deck);
  }
  if (options.watcher) {
    await page.locator('#watcherInput').check();
  }
  await page.getByRole('button', {name: 'Create Room'}).click();
  await page.waitForURL(/\/room\/[0-9a-f-]{36}$/);
  await expect(page.locator('app-table')).toBeVisible();
  return page.url().split('/room/')[1];
}

export async function openRoomLink(someone: Person, roomId: string) {
  await someone.page.goto(`/room/${roomId}`);
}

// A person types the nickname, moves on and clicks Join once the form has checked the nickname with the server.
// quick: clicks right after typing, without waiting for that check.
export async function fillJoinForm(someone: Person, options: {watcher?: boolean; nickname?: string; quick?: boolean} = {}) {
  const {page} = someone;
  const nickname = page.locator('#nicknameInput');
  await nickname.fill(options.nickname ?? someone.name);
  if (options.watcher) {
    await page.locator('#watcherInput').check();
  }
  if (!options.quick) {
    await nickname.blur();
    await expect(nickname, 'the nickname check finishes').toHaveClass(/is-valid|is-invalid/);
  }
  await page.getByRole('button', {name: 'Join Room'}).click();
}

export async function joinRoom(someone: Person, roomId: string, options: {watcher?: boolean} = {}) {
  await openRoomLink(someone, roomId);
  await fillJoinForm(someone, options);
  try {
    await expect(someone.page.locator('app-table')).toBeVisible();
  } catch (error) {
    await explain(someone);
    throw error;
  }
}

export async function explain(someone: Person) {
  const text = await someone.page.locator('body').innerText().catch(() => '');
  console.log(`--- ${someone.name} at ${someone.page.url()}\n${text}\nconsole: ${someone.consoleErrors.join(' | ')}\n` +
    `frames:\n${someone.frames.slice(-25).join('\n')}`);
}

export const seat = (someone: Person, nickname: string): Locator =>
  someone.page.locator('app-table-card').filter({has: someone.page.locator('.card-title', {hasText: new RegExp(`^${escape(nickname)}$`)})}).first();

export const seats = (someone: Person): Locator => someone.page.locator('app-table-card');

export const deckCard = (someone: Person, value: string): Locator =>
  someone.page.locator('app-deck-card').filter({has: someone.page.locator('.card-text', {hasText: new RegExp(`^${escape(value)}$`)})});

export const mainButton = (someone: Person): Locator => someone.page.locator('#mainBtn');

export async function vote(someone: Person, value: string) {
  await deckCard(someone, value).click();
  await expect(deckCard(someone, value)).toHaveClass(/selected/);
}

// The server keeps the seat of someone whose connection is gone for 10 seconds, so they can come back after a refresh
export const SEAT_KEPT_MS = 10_000;
// Someone who closed the page disappears once the seat is no longer kept
export const LEAVE_TIMEOUT = SEAT_KEPT_MS + 20_000;

export async function expectSeats(everyone: Person[], nicknames: string[], timeout?: number) {
  for (const someone of everyone) {
    await expect(seats(someone), `${someone.name} sees everyone at the table`).toHaveCount(nicknames.length, {timeout});
    for (const nickname of nicknames) {
      await expect(seat(someone, nickname), `${someone.name} sees ${nickname}`).toBeVisible();
    }
  }
}

export async function expectVoted(everyone: Person[], nickname: string, voted = true) {
  for (const someone of everyone) {
    const card = seat(someone, nickname).locator('.card');
    if (voted) {
      await expect(card, `${someone.name} sees that ${nickname} voted`).toHaveClass(/\bvoted\b/);
    } else {
      await expect(card, `${someone.name} sees that ${nickname} has not voted`).not.toHaveClass(/\bvoted\b/);
    }
  }
}

export async function expectRevealed(everyone: Person[], votes: Record<string, string>) {
  for (const someone of everyone) {
    for (const [nickname, value] of Object.entries(votes)) {
      await expect(seat(someone, nickname).locator('.card-body-back .card-text'), `${someone.name} sees ${nickname}'s card`)
        .toHaveText(value);
    }
    await expect(someone.page.locator('app-voting-result-chart canvas'), `${someone.name} sees the chart`).toBeVisible();
  }
  for (const nickname of Object.keys(votes)) {
    await expectOnlyBackShown(everyone[0], nickname);
  }
}

// A turned card shows only its back. The front face is behind it, so hiding the front must not change a pixel;
// a browser that draws it anyway shows the nickname mirrored over the card.
async function expectOnlyBackShown(someone: Person, nickname: string) {
  const card = seat(someone, nickname).locator('.card');
  const front = card.locator('.card-body:not(.card-body-back)');
  const shown = await card.screenshot({animations: 'disabled'});
  await front.evaluate(element => (element as HTMLElement).style.visibility = 'hidden');
  const withoutFront = await card.screenshot({animations: 'disabled'});
  await front.evaluate(element => (element as HTMLElement).style.visibility = '');
  expect(shown.equals(withoutFront), `${someone.name} sees only the back of ${nickname}'s turned card`).toBe(true);
}

// Closing the tab the way a person does. Older versions of the page said goodbye in beforeunload;
// now the server notices the closed connection and lets the seat go a few seconds later.
export async function leave(someone: Person) {
  if (!someone.page.isClosed()) {
    await someone.page.close({runBeforeUnload: true});
    // page.close does not wait for beforeunload handlers to finish sending
    if (!someone.page.isClosed()) {
      await someone.page.waitForEvent('close', {timeout: 10_000}).catch(() => undefined);
    }
  }
  await someone.page.context().close();
}

export async function leaveAll(everyone: Person[], roomId?: string) {
  for (const someone of everyone) {
    await leave(someone);
  }
  if (roomId) {
    await expect.poll(() => roomExists(baseUrl, roomId), {message: `room ${roomId} is deleted after everyone left`, timeout: LEAVE_TIMEOUT})
      .toBe(false);
  }
}

export function noConsoleErrors(everyone: Person[]) {
  for (const someone of everyone) {
    if (someone.consoleErrors.length > 0) {
      console.log(`Browser console of ${someone.name}:\n  ${[...new Set(someone.consoleErrors)].map(error => error.slice(0, 300)).join('\n  ')}`);
    }
    expect.soft(someone.consoleErrors, `${someone.name} has no errors in the browser console`).toEqual([]);
  }
}

// Logged so the run log tells what each step cost on the real server.
export async function timed<T>(label: string, action: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await action();
  } finally {
    console.log(`${test.info().project.name} | ${label}: ${Date.now() - started} ms`);
  }
}

function escape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Remembers the page's WebSockets, so a test can cut them like a lost network does. Call before the page opens.
export async function recordSockets(someone: Person) {
  await someone.page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const sockets: WebSocket[] = [];
    (window as any).__pipokerSockets = sockets;
    (window as any).WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    };
  });
}

// Chromium keeps open WebSockets when offline is emulated, so they are closed the way a lost network does
export async function loseNetwork(someone: Person) {
  await someone.page.context().setOffline(true);
  await someone.page.evaluate(() => ((window as any).__pipokerSockets ?? []).forEach((socket: WebSocket) => socket.close()));
}

export async function restoreNetwork(someone: Person) {
  await someone.page.context().setOffline(false);
}
