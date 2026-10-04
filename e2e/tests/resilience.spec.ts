import {expect, test} from '@playwright/test';
import {
  baseUrl,
  createRoom,
  deckCard,
  expectGoneAtOnce,
  expectRevealed,
  expectSeats,
  expectVoted,
  inRoom,
  joinRoom,
  LEAVE_TIMEOUT,
  leaveAll,
  loseNetwork,
  mainButton,
  person,
  restoreNetwork,
  SEAT_KEPT_MS,
  vote
} from './people';
import {fetchRoom, roomExists} from './stomp';

// What happens when a page is closed or a connection is gone. Closing the page takes the person away from the table
// at once, and a refreshed page brings them back with their vote. A connection lost for a moment keeps them at
// the table; for longer it counts as leaving, and coming back offers the join form with the same nickname.
const deck = '1; 2; 3; 5; 8';
// Long enough to be sure nobody leaves who should not
const LONGER_THAN_SEAT_KEPT_MS = SEAT_KEPT_MS + 3_000;

function secondsSince(started: number) {
  return Math.round((Date.now() - started) / 100) / 10;
}

test('someone closes the tab and leaves the table at once', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const roomId = await createRoom(alice, {deck});
  await joinRoom(bob, roomId);
  await vote(bob, '2');
  await expectVoted([alice], 'Bob');

  const closed = Date.now();
  await bob.page.close();

  await expectGoneAtOnce([alice], ['Alice'], bob);
  console.log(`Alice saw Bob leave ${secondsSince(closed)} s after he closed the tab`);
  const room = await fetchRoom(baseUrl, roomId);
  expect(room.participants.map(p => p.nickname)).toEqual(['Alice']);
  expect(room.votes ?? [], "Bob's vote is gone with him").toEqual([]);

  await leaveAll([alice, bob], roomId);
});

test('someone closes the browser and leaves the table at once', async ({browser, browserName}) => {
  test.skip(browserName === 'webkit', "Playwright closes a WebKit browser without letting its pages say goodbye, so it can't be checked there");
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const roomId = await createRoom(alice, {deck});
  await joinRoom(bob, roomId);
  await expectSeats([alice, bob], ['Alice', 'Bob']);

  const closed = Date.now();
  await bob.page.context().close();

  await expectGoneAtOnce([alice], ['Alice'], bob);
  console.log(`Alice saw Bob leave ${secondsSince(closed)} s after he closed the browser`);

  await leaveAll([alice], roomId);
});

test('someone refreshes the page and stays at the table with the vote', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const roomId = await createRoom(alice, {deck});
  await joinRoom(bob, roomId);
  await vote(bob, '3');
  await expectVoted([alice], 'Bob');

  const refreshed = Date.now();
  await bob.page.reload();

  await expect(deckCard(bob, '3'), 'Bob is back at the table with his vote').toHaveClass(/selected/);
  await expect(bob.page.locator('#nicknameInput'), 'without the join form').toBeHidden();
  await expectSeats([alice, bob], ['Alice', 'Bob']);
  await expectVoted([alice, bob], 'Bob');
  console.log(`Alice saw Bob back at the table with his vote ${secondsSince(refreshed)} s after he refreshed the page`);
  await bob.page.waitForTimeout(LONGER_THAN_SEAT_KEPT_MS);
  await expectSeats([alice, bob], ['Alice', 'Bob']);
  const room = await fetchRoom(baseUrl, roomId);
  expect(room.participants.map(p => p.nickname)).toEqual(['Alice', 'Bob']);
  expect(room.votes, 'the server keeps the vote').toEqual([{nickname: 'Bob', card: '3'}]);

  await leaveAll([alice, bob], roomId);
});

test('the only person in a room refreshes the page and keeps the room', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const roomId = await createRoom(alice, {deck});

  await alice.page.reload();

  await expectSeats([alice], ['Alice']);
  await alice.page.waitForTimeout(LONGER_THAN_SEAT_KEPT_MS);
  await expectSeats([alice], ['Alice']);
  expect(await roomExists(baseUrl, roomId), 'the room is still there').toBe(true);

  await leaveAll([alice], roomId);
});

test('someone loses the network for a moment and stays at the table', {tag: '@network'}, async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const carol = await person(browser, 'Carol');
  const roomId = await createRoom(alice, {deck});
  await joinRoom(bob, roomId);
  await vote(bob, '8');
  await expectSeats([alice, bob], ['Alice', 'Bob']);

  await loseNetwork(bob);
  const lost = Date.now();
  // While Bob is offline, for at least 3 seconds
  await joinRoom(carol, roomId);
  await vote(alice, '5');
  await bob.page.waitForTimeout(Math.max(0, 3_000 - (Date.now() - lost)));
  console.log(`Bob was offline for ${secondsSince(lost)} s`);
  await restoreNetwork(bob);

  await expect(async () => {
    await expectSeats([bob], ['Alice', 'Bob', 'Carol']);
    await expectVoted([bob], 'Alice');
  }, 'after the network is back Bob sees what happened meanwhile').toPass({timeout: 15_000});
  await expect(bob.page.locator('#nicknameInput'), 'Bob did not have to join again').toHaveCount(0);
  await expect(deckCard(bob, '8'), 'Bob still sees his vote').toHaveClass(/selected/);
  // Nobody saw Bob leave
  await alice.page.waitForTimeout(LONGER_THAN_SEAT_KEPT_MS);
  await expectSeats([alice, carol, bob], ['Alice', 'Bob', 'Carol']);

  // Bob keeps playing
  await vote(bob, '3');
  await expectVoted([alice, carol], 'Bob');
  await mainButton(alice).click();
  await expectRevealed([alice, bob, carol], {Alice: '5', Bob: '3'});

  await leaveAll([alice, bob, carol], roomId);
});

test('someone loses the network for longer, leaves the table and joins again with one click', {tag: '@network'}, async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const roomId = await createRoom(alice, {deck});
  await joinRoom(bob, roomId, {watcher: true});
  await expectSeats([alice, bob], ['Alice', 'Bob']);

  await loseNetwork(bob);
  const lost = Date.now();
  await alice.page.waitForTimeout(SEAT_KEPT_MS);
  expect(await inRoom(alice).count(), 'Alice still sees Bob 10 s after his network was gone').toBe(2);
  await expectSeats([alice], ['Alice'], LEAVE_TIMEOUT - SEAT_KEPT_MS);
  console.log(`Alice saw Bob leave ${secondsSince(lost)} s after his network was gone`);
  await restoreNetwork(bob);

  // The join form is back with what Bob had
  const nickname = bob.page.locator('#nicknameInput');
  await expect(nickname, 'Bob sees the join form again').toBeVisible({timeout: 15_000});
  await expect(nickname, 'with his nickname').toHaveValue('Bob');
  await expect(bob.page.locator('#watcherInput'), 'and his role').toBeChecked();
  await expect(bob.page.getByRole('button', {name: 'Join Room'})).toBeEnabled();

  await bob.page.getByRole('button', {name: 'Join Room'}).click();

  await expectSeats([alice, bob], ['Alice', 'Bob']);
  await expect(deckCard(bob, '1'), 'Bob is a watcher again').toHaveCount(0);

  await leaveAll([alice, bob], roomId);
});

test('someone whose browser crashes leaves the table once the seat is no longer kept', async ({browser}) => {
  // Bob's browser runs in its own process, so it can be killed without a word to the server
  const browserType = browser.browserType();
  const bobsBrowserServer = await browserType.launchServer();
  try {
    const alice = await person(browser, 'Alice');
    const bob = await person(await browserType.connect(bobsBrowserServer.wsEndpoint()), 'Bob');
    const roomId = await createRoom(alice, {deck});
    await joinRoom(bob, roomId);
    await vote(bob, '2');
    await expectSeats([alice, bob], ['Alice', 'Bob']);

    const killed = Date.now();
    await bobsBrowserServer.kill();

    await alice.page.waitForTimeout(SEAT_KEPT_MS / 2);
    expect(await inRoom(alice).count(), 'Alice still sees Bob 5 s after his browser crashed').toBe(2);
    await expectSeats([alice], ['Alice'], LEAVE_TIMEOUT);
    console.log(`Alice saw Bob leave ${secondsSince(killed)} s after his browser crashed`);
    const room = await fetchRoom(baseUrl, roomId);
    expect(room.participants.map(p => p.nickname)).toEqual(['Alice']);
    expect(room.votes ?? [], "Bob's vote is gone with him").toEqual([]);

    await leaveAll([alice], roomId);
  } finally {
    await bobsBrowserServer.close().catch(() => undefined);
  }
});
