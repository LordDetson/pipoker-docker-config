import {expect, test} from '@playwright/test';
import {
  baseUrl,
  createRoom,
  deckCard,
  expectRevealed,
  expectSeats,
  expectVoted,
  joinRoom,
  LEAVE_TIMEOUT,
  leaveAll,
  loseNetwork,
  mainButton,
  person,
  recordSockets,
  restoreNetwork,
  SEAT_KEPT_MS,
  vote
} from './people';
import {fetchRoom, roomExists} from './stomp';

// What happens when a connection is gone: for a moment the person stays at the table,
// for longer it counts as leaving, and coming back offers the join form with the same nickname.
const deck = '1; 2; 3; 5; 8';
// Longer than the server keeps a seat
const LONGER_THAN_SEAT_KEPT_MS = SEAT_KEPT_MS + 3_000;

test('someone refreshes the page and keeps the seat and the vote', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const roomId = await createRoom(alice, {deck});
  await joinRoom(bob, roomId);
  await vote(bob, '3');
  await expectVoted([alice], 'Bob');

  await bob.page.reload();

  await expect(bob.page.locator('app-table'), 'Bob is back at the table without joining again').toBeVisible();
  await expect(bob.page.locator('#nicknameInput')).toHaveCount(0);
  await expect(deckCard(bob, '3'), 'Bob still sees his vote').toHaveClass(/selected/);
  // Nobody saw Bob leave, also after the server would have let his seat go
  await alice.page.waitForTimeout(LONGER_THAN_SEAT_KEPT_MS);
  await expectSeats([alice, bob], ['Alice', 'Bob']);
  await expectVoted([alice, bob], 'Bob');
  expect((await fetchRoom(baseUrl, roomId)).participants.map(p => p.nickname).sort()).toEqual(['Alice', 'Bob']);

  await leaveAll([alice, bob], roomId);
});

test('the only person in a room refreshes the page and the room survives', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const roomId = await createRoom(alice, {deck});

  await alice.page.reload();

  await expect(alice.page.locator('app-table'), 'Alice is back at the table without joining again').toBeVisible();
  await alice.page.waitForTimeout(LONGER_THAN_SEAT_KEPT_MS);
  expect(await roomExists(baseUrl, roomId), 'the room still exists after a refresh').toBe(true);
  await expectSeats([alice], ['Alice']);

  await leaveAll([alice], roomId);
});

test('someone loses the network for a moment and stays at the table', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const carol = await person(browser, 'Carol');
  const roomId = await createRoom(alice, {deck});
  await recordSockets(bob);
  await joinRoom(bob, roomId);
  await vote(bob, '8');
  await expectSeats([alice, bob], ['Alice', 'Bob']);

  await loseNetwork(bob);
  // While Bob is offline
  await joinRoom(carol, roomId);
  await vote(alice, '5');
  await bob.page.waitForTimeout(3_000);
  await restoreNetwork(bob);

  await expect(async () => {
    await expectSeats([bob], ['Alice', 'Bob', 'Carol']);
    await expectVoted([bob], 'Alice');
  }, 'after reconnecting Bob sees what happened while he was offline').toPass({timeout: 15_000});
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

test('someone loses the network for longer, leaves the table and joins again with one click', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const roomId = await createRoom(alice, {deck});
  await recordSockets(bob);
  await joinRoom(bob, roomId, {watcher: true});
  await expectSeats([alice, bob], ['Alice', 'Bob']);

  await loseNetwork(bob);
  const lost = Date.now();
  await expectSeats([alice], ['Alice'], LEAVE_TIMEOUT + 30_000);
  console.log(`Alice saw Bob leave ${Math.round((Date.now() - lost) / 1000)} s after his network was gone`);
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

test('someone whose browser is killed leaves the table a few seconds later', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const roomId = await createRoom(alice, {deck});
  await joinRoom(bob, roomId);
  await vote(bob, '2');
  await expectSeats([alice, bob], ['Alice', 'Bob']);

  // No beforeunload: the browser is gone, like a phone that drops a background tab
  const killed = Date.now();
  await bob.page.context().close();

  await expectSeats([alice], ['Alice'], LEAVE_TIMEOUT);
  console.log(`Alice saw Bob leave ${Math.round((Date.now() - killed) / 1000)} s after his browser was killed`);
  const room = await fetchRoom(baseUrl, roomId);
  expect(room.participants.map(p => p.nickname)).toEqual(['Alice']);
  expect(room.votes ?? [], "Bob's vote is gone with him").toEqual([]);

  await leaveAll([alice], roomId);
});
