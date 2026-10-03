import {Browser, BrowserContextOptions, expect, Locator, Page, test} from '@playwright/test';
import {roomExists} from './stomp';

export const baseUrl = process.env.BASE_URL ?? 'https://pipoker.duckdns.org';
export const testRoomName = () => `E2E ${new Date().toISOString().slice(11, 19)}`;

// One person is one browser profile: their own storage, their own WebSocket connection.
export interface Person {
  name: string;
  page: Page;
  consoleErrors: string[];
  frames: string[];
}

export async function person(browser: Browser, name: string, options: BrowserContextOptions = {}): Promise<Person> {
  const context = await browser.newContext({baseURL: baseUrl, ...options});
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

export async function fillJoinForm(someone: Person, options: {watcher?: boolean; nickname?: string} = {}) {
  const {page} = someone;
  await page.locator('#nicknameInput').fill(options.nickname ?? someone.name);
  if (options.watcher) {
    await page.locator('#watcherInput').check();
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
  someone.page.locator('app-table-card').filter({has: someone.page.locator('.card-title', {hasText: new RegExp(`^${nickname}$`)})}).first();

export const seats = (someone: Person): Locator => someone.page.locator('app-table-card');

export const deckCard = (someone: Person, value: string): Locator =>
  someone.page.locator('app-deck-card').filter({has: someone.page.locator('.card-text', {hasText: new RegExp(`^${escape(value)}$`)})});

export const mainButton = (someone: Person): Locator => someone.page.locator('#mainBtn');

export async function vote(someone: Person, value: string) {
  await deckCard(someone, value).click();
  await expect(deckCard(someone, value)).toHaveClass(/selected/);
}

export async function expectSeats(everyone: Person[], nicknames: string[]) {
  for (const someone of everyone) {
    await expect(seats(someone), `${someone.name} sees everyone at the table`).toHaveCount(nicknames.length);
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
}

// Closing the tab the way a person does: the page says goodbye in beforeunload.
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
    await expect.poll(() => roomExists(baseUrl, roomId), {message: `room ${roomId} is deleted after everyone left`, timeout: 20_000})
      .toBe(false);
  }
}

export function noConsoleErrors(everyone: Person[]) {
  for (const someone of everyone) {
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
