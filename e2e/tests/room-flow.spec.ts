import {expect, test} from '@playwright/test';
import {
  baseUrl,
  createRoom,
  deckCard,
  expectRevealed,
  expectSeats,
  expectVoted,
  fillJoinForm,
  joinRoom,
  leave,
  leaveAll,
  mainButton,
  noConsoleErrors,
  openRoomLink,
  person,
  type Person,
  seat,
  timed,
  vote
} from './people';
import {fetchRoom} from './stomp';

const deck = '1; 2; 3; 5; 8; 13; ?';

test('a team plays two rounds: voters, a watcher, revealing, a new round and someone leaving', async ({browser, browserName}) => {
  const alice = await person(browser, 'Alice', browserName === 'chromium' ? {permissions: ['clipboard-read', 'clipboard-write']} : {});
  const bob = await person(browser, 'Bob');
  const carol = await person(browser, 'Carol');
  const everyone = [alice, bob, carol];

  const roomId = await timed('create a room', () => createRoom(alice, {deck}));
  await expect(alice.page.locator('header strong.fs-3')).toHaveText(/^E2E /);

  if (browserName === 'chromium') {
    await alice.page.getByRole('button', {name: 'Copy Invitation Link'}).click();
    const link = await alice.page.evaluate(() => navigator.clipboard.readText());
    expect(link).toBe(`${baseUrl}/room/${roomId}`);
  }

  await timed('join by link as a voter', () => joinRoom(bob, roomId));
  await timed('join by link as a watcher', () => joinRoom(carol, roomId, {watcher: true}));
  await expectSeats(everyone, ['Alice', 'Bob', 'Carol']);

  // The watcher has no deck and is shown with an eye
  await expect(carol.page.locator('app-deck-card')).toHaveCount(0);
  await expect(seat(alice, 'Carol').locator('.eye-icon')).toBeVisible();
  await expect(alice.page.locator('app-deck-card')).toHaveCount(7);
  await expect(mainButton(alice)).toHaveText('Voting...');
  await expect(mainButton(alice)).toBeDisabled();

  // Round 1
  await timed('vote and see it on every screen', async () => {
    await vote(alice, '3');
    await expectVoted(everyone, 'Alice');
  });
  await vote(bob, '8');
  await expectVoted(everyone, 'Bob');
  await expectVoted(everyone, 'Carol', false);
  // Cards stay hidden until someone reveals them
  await expect(seat(carol, 'Alice').locator('.card-body-back .card-text')).toHaveCount(0);

  await expect(mainButton(carol)).toHaveText('Reveal Cards');
  await timed('reveal the cards', async () => {
    await mainButton(bob).click();
    await expectRevealed(everyone, {Alice: '3', Bob: '8'});
  });
  await expect(mainButton(alice)).toHaveText('Start New Voting');

  // Round 2
  await timed('start a new round', async () => {
    await mainButton(alice).click();
    for (const someone of everyone) {
      await expect(mainButton(someone)).toHaveText('Voting...');
    }
    await expectVoted(everyone, 'Alice', false);
    await expectVoted(everyone, 'Bob', false);
  });
  await expect(alice.page.locator('app-deck-card.selected')).toHaveCount(0);
  await expect(bob.page.locator('app-deck-card')).toHaveCount(7);

  await vote(bob, '5');
  // Changing your mind before the reveal
  await vote(alice, '1');
  await expectVoted(everyone, 'Alice');
  await vote(alice, '13');
  await expect(alice.page.locator('app-deck-card.selected')).toHaveCount(1);
  await expect.poll(async () => (await fetchRoom(baseUrl, roomId)).votes, {message: 'the server keeps only the last vote'})
    .toEqual(expect.arrayContaining([{nickname: 'Alice', card: '13'}, {nickname: 'Bob', card: '5'}]));
  await mainButton(carol).click();
  await expectRevealed(everyone, {Alice: '13', Bob: '5'});

  // Bob closes the tab
  await timed('leave and disappear from every screen', async () => {
    await leave(bob);
    await expectSeats([alice, carol], ['Alice', 'Carol']);
  });

  noConsoleErrors(everyone);
  await leaveAll([alice, carol], roomId);
});

test('someone who joins later sees the votes already made', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const roomId = await createRoom(alice, {deck});
  await vote(alice, '2');

  await joinRoom(bob, roomId);
  await expectSeats([alice, bob], ['Alice', 'Bob']);
  await expectVoted([bob], 'Alice');
  await expect(mainButton(bob)).toHaveText('Reveal Cards');

  await vote(bob, '3');
  await mainButton(bob).click();
  await expectRevealed([alice, bob], {Alice: '2', Bob: '3'});

  noConsoleErrors([alice, bob]);
  await leaveAll([alice, bob], roomId);
});

test('someone who joins after the reveal sees the revealed cards', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const roomId = await createRoom(alice, {deck});
  await vote(alice, '5');
  await mainButton(alice).click();
  await expectRevealed([alice], {Alice: '5'});

  await joinRoom(bob, roomId);
  await expectSeats([bob], ['Alice', 'Bob']);
  await expectRevealed([bob], {Alice: '5'});

  await leaveAll([alice, bob], roomId);
});

test('a taken nickname and a missing room are explained to the person', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const impostor = await person(browser, 'alice');
  const lost = await person(browser, 'Lost');
  const roomId = await createRoom(alice, {deck});

  await openRoomLink(impostor, roomId);
  await impostor.page.locator('#nicknameInput').fill('alice');
  await impostor.page.locator('#nicknameInput').blur();
  await expect(impostor.page.locator('.invalid-feedback')).toHaveText('alice is already in the room');
  await expect(impostor.page.getByRole('button', {name: 'Join Room'})).toBeDisabled();
  await expectSeats([alice], ['Alice']);

  await openRoomLink(lost, '00000000-0000-4000-8000-000000000000');
  await lost.page.waitForTimeout(3_000);
  console.log(`A missing room shows: ${(await lost.page.locator('app-root').innerText()).replace(/\n/g, ' | ')}`);
  await expect.soft(lost.page.getByText(/not found/i), 'a missing room says so instead of showing the join form').toBeVisible();

  await leaveAll([impostor, lost]);
  await leaveAll([alice], roomId);
});

test('joining right after typing the nickname works', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const carol = await person(browser, 'Carol');
  const roomId = await createRoom(alice, {deck});

  // Bob clicks Join at once, Carol presses Enter at once
  await openRoomLink(bob, roomId);
  await fillJoinForm(bob, {quick: true});
  await openRoomLink(carol, roomId);
  await carol.page.locator('#nicknameInput').fill('Carol');
  await carol.page.locator('#nicknameInput').press('Enter');

  await expect.soft(bob.page.locator('app-table'), 'Join clicked right after typing is not lost').toBeVisible({timeout: 10_000});
  await expect.soft(carol.page.locator('app-table'), 'Enter pressed right after typing is not lost').toBeVisible({timeout: 10_000});

  await leaveAll([alice, bob, carol], roomId);
});

test('everyone in a room votes at the same moment and every vote counts', async ({browser}) => {
  const names = ['Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Frank'];
  const team: Person[] = [];
  for (const name of names) {
    team.push(await person(browser, name));
  }
  const roomId = await createRoom(team[0], {deck});
  for (const someone of team.slice(1)) {
    await joinRoom(someone, roomId);
  }
  await expectSeats(team, names);

  const values = ['1', '2', '3', '5', '8', '13'];
  await timed('six people vote at once', async () => {
    await Promise.all(team.map((someone, index) => deckCard(someone, values[index]).click()));
    for (const name of names) {
      await expectVoted(team, name);
    }
  });
  const room = await fetchRoom(baseUrl, roomId);
  expect(room.votes?.length, 'the server stored every vote').toBe(names.length);

  await mainButton(team[0]).click();
  await expectRevealed(team, Object.fromEntries(names.map((name, index) => [name, values[index]])));

  noConsoleErrors(team);
  await leaveAll(team, roomId);
});
