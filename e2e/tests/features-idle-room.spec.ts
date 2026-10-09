import {expect, test} from '@playwright/test';
import {baseUrl, createRoom, joinRoom, leaveAll, noConsoleErrors, openRoomLink, person, vote} from './people';
import {roomExists} from './stomp';

// The server closes a room nobody has done anything in for room.idle-timeout: 30 minutes on QA and PROD, too long to
// watch in a test. The local job starts its backend with a short timeout and says how long in ROOM_IDLE_SECONDS, with
// the interval between the server's checks in ROOM_IDLE_CHECK_SECONDS. Anywhere else this file is skipped.
const idleSeconds = Number(process.env.ROOM_IDLE_SECONDS ?? 0);
const checkSeconds = Number(process.env.ROOM_IDLE_CHECK_SECONDS ?? 10);

test.skip(idleSeconds === 0, 'needs a backend with a short room.idle-timeout, which the local job sets in ROOM_IDLE_SECONDS');

test('a room nobody does anything in for long is closed, and everyone in it is told', async ({browser}) => {
  // Half a timeout until the vote, a timeout and a check until the closing, and the rest for the pages
  test.setTimeout((idleSeconds * 2 + checkSeconds) * 1000 + 60_000);
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const everyone = [alice, bob];
  const roomId = await createRoom(alice, {deck: '1; 2; 3; 5; 8; 13; ?'});
  await joinRoom(bob, roomId);
  const joined = Date.now();

  // Alice votes halfway through the timeout. A vote is activity, so the room lives on past the first deadline
  await alice.page.waitForTimeout(idleSeconds * 500);
  await vote(alice, '5');
  const voted = Date.now();
  // Open pages that merely stay connected don't count, so the room would be closed by now without Alice's vote
  await alice.page.waitForTimeout(joined + (idleSeconds + checkSeconds) * 1000 + 5_000 - Date.now());
  for (const someone of everyone) {
    await expect(someone.page.locator('app-table'), `${someone.name} is still in the room after the vote`).toBeVisible();
  }
  expect(await roomExists(baseUrl, roomId), 'the room is still on the server').toBe(true);

  // A timeout after the vote the server closes the room, and both pages say so right away
  for (const someone of everyone) {
    await expect(someone.page.getByRole('heading', {name: 'The room is closed'}), `${someone.name} is told that the room is closed`)
      .toBeVisible({timeout: voted + (idleSeconds + checkSeconds) * 1000 + 15_000 - Date.now()});
    await expect(someone.page.getByText('Nobody did anything in the room for a long time, so it was closed and everyone left it.'))
      .toBeVisible();
    await expect(someone.page.getByRole('link', {name: 'Create a new room'})).toHaveAttribute('href', '/');
    await expect(someone.page.locator('app-table')).toHaveCount(0);
  }
  console.log(`the room was closed ${Math.round((Date.now() - voted) / 1000)} s after the last activity, the timeout being ${idleSeconds} s`);
  await expect.poll(() => roomExists(baseUrl, roomId), {message: 'the closed room is gone from the server'}).toBe(false);
  noConsoleErrors(everyone);

  // The invitation link is no longer valid: a newcomer sees that the room is gone, and so does Bob after a refresh,
  // whose seat was kept only for a room that still exists
  const carol = await person(browser, 'Carol');
  await openRoomLink(carol, roomId);
  await expect(carol.page.getByRole('heading', {name: 'This invitation is no longer valid'})).toBeVisible();
  await expect(carol.page.locator('#nicknameInput')).toHaveCount(0);
  await bob.page.reload();
  await expect(bob.page.getByRole('heading', {name: 'This invitation is no longer valid'})).toBeVisible();
  await expect(bob.page.getByText('The room no longer exists: everyone has left it.')).toBeVisible();

  await leaveAll([...everyone, carol]);
});
