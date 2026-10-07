import {expect, Locator, test} from '@playwright/test';
import {
  baseUrl,
  createRoom,
  expectRevealed,
  expectSeats,
  expectVoted,
  joinRoom,
  leaveAll,
  mainButton,
  noConsoleErrors,
  person,
  type Person,
  seat,
  timed,
  vote
} from './people';
import {fetchRoom} from './stomp';

// Changing roles without leaving the room: the Watcher switch in the corner of the room takes a voter away from
// the table and brings them back. Everyone sees the move, a watcher has no deck, and the reveal rules follow:
// a vote made before the switch is dropped, and the cards turn over when the last voter who had not voted steps aside.
const deck = '1; 2; 3; 5; 8; 13; ?';
const deckSize = 7;

const watcherSwitch = (someone: Person): Locator => someone.page.locator('#watcherSwitch');
const watchers = (someone: Person): Locator => someone.page.locator('.watchers .watcher');
const tableSeats = (someone: Person): Locator => someone.page.locator('app-table-card');
const deckCards = (someone: Person): Locator => someone.page.locator('app-deck-card');
const selectedDeckCards = (someone: Person): Locator => someone.page.locator('app-deck-card.selected');
// The card values on the table only: the history list has .card-value too
const shownCards = (someone: Person): Locator => someone.page.locator('app-table-card .card-face .card-value');

// The switch moves when the room hears about the change from the server, not on the click
async function becomeWatcher(someone: Person) {
  await watcherSwitch(someone).click();
  await expect(watcherSwitch(someone), `${someone.name}'s switch shows a watcher`).toBeChecked();
}

async function becomeVoter(someone: Person) {
  await watcherSwitch(someone).click();
  await expect(watcherSwitch(someone), `${someone.name}'s switch shows a voter`).not.toBeChecked();
}

// Everyone sees these people at the table and those beside the eye. Seats are laid out from the viewer's own,
// so only who is there is checked, not the order.
async function expectRoles(everyone: Person[], voters: string[], watcherNames: string[]) {
  await expectSeats(everyone, [...voters, ...watcherNames]);
  for (const someone of everyone) {
    await expect(tableSeats(someone), `${someone.name} sees ${voters.length} at the table`).toHaveCount(voters.length);
    for (const nickname of voters) {
      await expect(seat(someone, nickname), `${someone.name} sees ${nickname} at the table`).toBeVisible();
    }
    await expect(watchers(someone), `${someone.name} sees the watchers`).toHaveText(watcherNames);
  }
}

async function expectHiddenCards(everyone: Person[]) {
  for (const someone of everyone) {
    await expect(shownCards(someone), `${someone.name} sees no card values yet`).toHaveCount(0);
    await expect(someone.page.locator('app-voting-result-chart canvas'), `${someone.name} sees no chart yet`).toHaveCount(0);
  }
}

const lastWatcher = (someone: Person) => someone.page.evaluate(() => localStorage.getItem('last-watcher'));
const storedSeat = (someone: Person, roomId: string) =>
  someone.page.evaluate(key => JSON.parse(sessionStorage.getItem(key) ?? 'null'), `seat-${roomId}`);

test('someone steps aside as a watcher and sits back down: the table, the deck and the hidden cards follow on every screen', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const carol = await person(browser, 'Carol');
  const everyone = [alice, bob, carol];
  const roomId = await createRoom(alice, {deck});
  await joinRoom(bob, roomId);
  await joinRoom(carol, roomId);
  await expectRoles(everyone, ['Alice', 'Bob', 'Carol'], []);
  await expect(alice.page.locator('.watchers')).toHaveCount(0);
  for (const someone of everyone) {
    await expect(watcherSwitch(someone), `${someone.name} joined as a voter`).not.toBeChecked();
  }

  // Alice votes; Bob and Carol have not, so the cards wait
  await vote(alice, '5');
  await expectVoted(everyone, 'Alice');
  await expect(mainButton(alice)).toHaveText('Reveal Cards');

  // Bob only wants to watch this one
  await timed('switch to watcher', async () => {
    await becomeWatcher(bob);
    await expectRoles(everyone, ['Alice', 'Carol'], ['Bob']);
  });
  await expect(deckCards(bob), 'a watcher has no deck').toHaveCount(0);
  await expect(deckCards(alice), 'the voters keep theirs').toHaveCount(deckSize);
  // Carol has still not voted, so nothing is revealed by Bob leaving the table
  await expectHiddenCards(everyone);
  await expectVoted(everyone, 'Alice');
  await expect(mainButton(alice)).toHaveText('Reveal Cards');
  await expect(mainButton(bob), 'a watcher can reveal the cards too').toHaveText('Reveal Cards');
  await expect(mainButton(bob)).toBeEnabled();

  // Bob changes his mind and comes back to vote
  await timed('switch back to voter', async () => {
    await becomeVoter(bob);
    await expectRoles(everyone, ['Alice', 'Bob', 'Carol'], []);
  });
  await expect(alice.page.locator('.watchers'), 'nobody is watching any more').toHaveCount(0);
  await expect(deckCards(bob), 'the deck is back').toHaveCount(deckSize);
  await expect(selectedDeckCards(bob), 'with no card picked').toHaveCount(0);
  await expectVoted(everyone, 'Bob', false);
  await expectHiddenCards(everyone);
  await expect(mainButton(alice)).toHaveText('Reveal Cards');

  // Bob can vote again like anyone else
  await vote(bob, '8');
  await expectVoted(everyone, 'Bob');
  await expectHiddenCards(everyone);
  const room = await fetchRoom(baseUrl, roomId);
  expect(room.participants, 'the server has everyone back as voters').toEqual([
    {nickname: 'Alice', watcher: false}, {nickname: 'Bob', watcher: false}, {nickname: 'Carol', watcher: false}
  ]);

  noConsoleErrors(everyone);
  await leaveAll(everyone, roomId);
});

test('the cards turn over by themselves when the last voter who has not voted becomes a watcher', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const carol = await person(browser, 'Carol');
  const everyone = [alice, bob, carol];
  const roomId = await createRoom(alice, {deck});
  await joinRoom(bob, roomId);
  await joinRoom(carol, roomId);
  await expectRoles(everyone, ['Alice', 'Bob', 'Carol'], []);

  // Two of three have voted; Carol holds the reveal
  await vote(alice, '5');
  await vote(bob, '8');
  await expectVoted(everyone, 'Alice');
  await expectVoted(everyone, 'Bob');
  await expectHiddenCards(everyone);
  await expect(mainButton(carol)).toHaveText('Reveal Cards');

  // Carol would rather watch, and now everyone at the table has voted
  await timed('the last unvoted voter steps aside and the cards are revealed', async () => {
    await becomeWatcher(carol);
    await expectRevealed(everyone, {Alice: '5', Bob: '8'});
  });
  await expectRoles(everyone, ['Alice', 'Bob'], ['Carol']);
  for (const someone of everyone) {
    await expect(mainButton(someone), `${someone.name} sees the round is over`).toHaveText('Start New Voting');
  }
  await expect(deckCards(carol), 'a watcher has no deck even after the reveal').toHaveCount(0);

  // Next round Carol sits back down and votes
  await mainButton(alice).click();
  for (const someone of everyone) {
    await expect(mainButton(someone)).toHaveText('Voting...');
  }
  await becomeVoter(carol);
  await expectRoles(everyone, ['Alice', 'Bob', 'Carol'], []);
  await expect(deckCards(carol)).toHaveCount(deckSize);
  await vote(carol, '3');
  await expectVoted(everyone, 'Carol');
  await expectVoted(everyone, 'Alice', false);
  await expectHiddenCards(everyone);
  await expect(mainButton(alice)).toHaveText('Reveal Cards');

  noConsoleErrors(everyone);
  await leaveAll(everyone, roomId);
});

test('someone who voted becomes a watcher before the reveal, and the vote goes with them', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const everyone = [alice, bob];
  const roomId = await createRoom(alice, {deck});
  await joinRoom(bob, roomId);
  await expectRoles(everyone, ['Alice', 'Bob'], []);

  // Alice votes; Bob has not, so her card stays hidden
  await vote(alice, '5');
  await expectVoted(everyone, 'Alice');
  await expect(mainButton(bob)).toHaveText('Reveal Cards');

  // Alice becomes a watcher: her vote no longer counts, and with Bob alone at the table nothing is revealed
  await timed('a voter with a vote becomes a watcher', async () => {
    await becomeWatcher(alice);
    await expectRoles(everyone, ['Bob'], ['Alice']);
  });
  await expectHiddenCards(everyone);
  for (const someone of everyone) {
    await expect(mainButton(someone), `${someone.name} sees that nobody has voted`).toHaveText('Voting...');
    await expect(mainButton(someone)).toBeDisabled();
  }
  await expectVoted(everyone, 'Bob', false);
  expect((await fetchRoom(baseUrl, roomId)).votes ?? [], 'the server dropped the vote').toEqual([]);

  // Back at the table Alice starts with a clean hand, and only the new votes are revealed
  await becomeVoter(alice);
  await expectRoles(everyone, ['Alice', 'Bob'], []);
  await expect(selectedDeckCards(alice), 'the old vote is not back').toHaveCount(0);
  await expectVoted(everyone, 'Alice', false);
  await expect(mainButton(bob)).toHaveText('Voting...');
  await vote(alice, '3');
  await expectVoted(everyone, 'Alice');
  await expect(mainButton(bob)).toHaveText('Reveal Cards');
  await vote(bob, '13');
  await expectRevealed(everyone, {Alice: '3', Bob: '13'});

  noConsoleErrors(everyone);
  await leaveAll(everyone, roomId);
});

test('the browser remembers the new role, and after a refresh the person is back as a watcher', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const everyone = [alice, bob];
  const roomId = await createRoom(alice, {deck});
  await joinRoom(bob, roomId);
  await expectRoles(everyone, ['Alice', 'Bob'], []);
  // The join form notes the role only when the checkbox is touched, so Bob's browser has nothing or a voter so far
  expect(await lastWatcher(bob), 'Bob joined as a voter').not.toBe('true');
  expect(await storedSeat(bob, roomId), 'the tab knows his seat').toEqual({nickname: 'Bob', watcher: false});

  // Bob becomes a watcher, and the browser notes the choice for a refresh and for the next room
  await becomeWatcher(bob);
  await expectRoles(everyone, ['Alice'], ['Bob']);
  await expect.poll(() => lastWatcher(bob), 'the last role is a watcher').toBe('true');
  await expect.poll(() => storedSeat(bob, roomId), 'the seat is a watcher too').toEqual({nickname: 'Bob', watcher: true});

  // Bob refreshes the page and takes his seat back as a watcher, without the join form
  await timed('refresh as a watcher and return to the room', async () => {
    await bob.page.reload();
    await expect(bob.page.locator('app-table'), 'Bob is back in the room').toBeVisible();
  });
  await expect(bob.page.locator('#nicknameInput'), 'without the join form').toHaveCount(0);
  await expect(watcherSwitch(bob), 'still a watcher').toBeChecked();
  await expect(deckCards(bob), 'still without a deck').toHaveCount(0);
  await expectRoles(everyone, ['Alice'], ['Bob']);
  const room = await fetchRoom(baseUrl, roomId);
  expect(room.participants, 'the server kept the role too').toEqual([{nickname: 'Alice', watcher: false}, {nickname: 'Bob', watcher: true}]);

  // Switching back is remembered the same way
  await becomeVoter(bob);
  await expectRoles(everyone, ['Alice', 'Bob'], []);
  await expect.poll(() => lastWatcher(bob), 'the last role is a voter again').toBe('false');
  await expect.poll(() => storedSeat(bob, roomId)).toEqual({nickname: 'Bob', watcher: false});
  await expect(deckCards(bob)).toHaveCount(deckSize);

  noConsoleErrors(everyone);
  await leaveAll(everyone, roomId);
});
