import {expect, test} from '@playwright/test';
import {
  baseUrl,
  createRoom,
  expectRevealed,
  expectSeats,
  expectVoted,
  fillJoinForm,
  joinRoom,
  leaveAll,
  mainButton,
  person,
  vote
} from './people';
import {fetchRoom, roomExists, Stomp} from './stomp';

const deck = '1; 2; 3; 5; 8';

test('someone refreshes the page and stays in the room', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const roomId = await createRoom(alice, {deck});
  await joinRoom(bob, roomId);
  await vote(bob, '3');
  await expectVoted([alice], 'Bob');

  await bob.page.reload();
  // What Bob sees right after the refresh
  const joinFormShown = await bob.page.locator('#nicknameInput').isVisible({timeout: 5_000}).catch(() => false);
  console.log(`After a refresh Bob sees ${joinFormShown ? 'the join form again' : 'the room'}`);
  if (joinFormShown) {
    // The form should at least remember who Bob is
    await expect.soft(bob.page.locator('#nicknameInput'), 'the join form remembers the nickname').toHaveValue('Bob');
    await fillJoinForm(bob);
  }
  await expectSeats([alice, bob], ['Alice', 'Bob']);
  await expect.soft(bob.page.locator('#nicknameInput'), 'a refresh keeps Bob in the room without joining again').toHaveCount(0);
  await expectVoted([alice, bob], 'Bob');

  await leaveAll([alice, bob], roomId);
});

test('the only person in a room refreshes the page and the room survives', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const roomId = await createRoom(alice, {deck});

  await alice.page.reload();
  await expect.poll(() => roomExists(baseUrl, roomId), {message: 'the room still exists after a refresh', timeout: 5_000})
    .toBe(true);
  if (await alice.page.locator('#nicknameInput').isVisible({timeout: 5_000}).catch(() => false)) {
    await fillJoinForm(alice);
  }
  await expectSeats([alice], ['Alice']);

  await leaveAll([alice], roomId);
});

test('someone loses the network for a while and comes back', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const roomId = await createRoom(alice, {deck});
  // Remember the page's WebSockets so the test can cut them
  await bob.page.addInitScript(() => {
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
  await joinRoom(bob, roomId);
  await expectSeats([alice, bob], ['Alice', 'Bob']);

  // Chromium keeps an open WebSocket when offline is emulated, so drop it the way a lost network does
  await bob.page.context().setOffline(true);
  await bob.page.evaluate(() => {
    const sockets = (window as any).__pipokerSockets ?? [];
    sockets.forEach((socket: WebSocket) => socket.close());
  });
  const carol = await person(browser, 'Carol');
  await joinRoom(carol, roomId);
  await vote(alice, '5');
  await bob.page.waitForTimeout(10_000);
  await bob.page.context().setOffline(false);

  // Bob's client reconnects on its own after a few seconds
  await expect.soft(async () => {
    await expectSeats([bob], ['Alice', 'Bob', 'Carol']);
  }, 'after reconnecting Bob sees who joined while he was offline').toPass({timeout: 30_000});
  await expect.soft(async () => {
    await expectVoted([bob], 'Alice');
  }, 'after reconnecting Bob sees votes made while he was offline').toPass({timeout: 5_000});

  // Bob can keep playing after the reconnect
  await expect(async () => {
    await vote(bob, '8');
    await expectVoted([alice, carol], 'Bob');
  }).toPass({timeout: 30_000});
  await mainButton(alice).click();
  await expectRevealed([alice, carol], {Alice: '5', Bob: '8'});
  await expect.soft(async () => {
    await expectRevealed([bob], {Alice: '5', Bob: '8'});
  }, 'Bob sees the reveal after reconnecting').toPass({timeout: 10_000});

  await leaveAll([alice, bob, carol], roomId);
});

test('a phone closes the browser without saying goodbye', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const roomId = await createRoom(alice, {deck});
  await joinRoom(bob, roomId);
  await expectSeats([alice, bob], ['Alice', 'Bob']);

  // No beforeunload: the browser is killed, like a phone that drops a background tab
  await bob.page.context().close();
  await expect.soft(async () => {
    await expectSeats([alice], ['Alice']);
  }, 'a person whose connection is gone disappears from the table').toPass({timeout: 60_000});

  const room = await fetchRoom(baseUrl, roomId);
  console.log(`Participants left on the server after Bob's browser was killed: ${room.participants.map(p => p.nickname).join(', ')}`);

  await leaveAll([alice]);
  // Without the goodbye, Bob may still be in the room; clean up for him through the API
  if (await roomExists(baseUrl, roomId)) {
    const client = await Stomp.connect(baseUrl);
    for (const participant of (await fetchRoom(baseUrl, roomId)).participants) {
      client.send(`/app/room/${roomId}/participants/remove`, participant.nickname);
    }
    await expect.poll(() => roomExists(baseUrl, roomId), {timeout: 20_000}).toBe(false);
    client.close();
  }
});
