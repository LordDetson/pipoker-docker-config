import {expect, Locator, test} from '@playwright/test';
import {
  baseUrl,
  createRoom,
  expectRevealed,
  expectSeats,
  joinRoom,
  leaveAll,
  mainButton,
  noConsoleErrors,
  person,
  type Person,
  timed,
  vote
} from './people';
import {fetchRoom, RoomDto} from './stomp';

// What a round is about and what the team agreed on: the task name and link above the table, the estimate accepted
// after the reveal, and what a new round does with them. Everyone in the room edits the task while the cards
// are hidden; a new round keeps it until an estimate is accepted.
const deck = '1; 2; 3; 5; 8; 13; ?';
// The page sends the task 1 s after the last key, or at once on Enter or when the field is left
const TASK_SAVE_DELAY_MS = 1_000;
// Long enough for a save that should not happen to have happened
const PAST_SAVE_DELAY_MS = TASK_SAVE_DELAY_MS + 1_000;

// The room as the server keeps it, with the parts that only this file looks at
interface StoredTask {
  name: string;
  url?: string;
}

interface StoredRound {
  revealedAt: string;
  votes: {nickname: string; card: string}[];
  task?: StoredTask;
  estimate?: string;
}

type StoredRoom = RoomDto & {task?: StoredTask; history?: StoredRound[]; votesShown?: boolean};

const storedRoom = (roomId: string): Promise<StoredRoom> => fetchRoom(baseUrl, roomId);

const exact = (value: string) => new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

const taskName = (someone: Person): Locator => someone.page.locator('input.task-name');
const taskLinkButton = (someone: Person): Locator => someone.page.locator('button.task-link');
const taskUrl = (someone: Person): Locator => someone.page.locator('input.task-url');
const taskOpenLink = (someone: Person): Locator => someone.page.locator('a.task-open');
const taskClearCross = (someone: Person): Locator => someone.page.locator('.task-field button.task-clear');

// The control is rendered only while the cards are revealed; its host element stays in the room
const estimate = (someone: Person): Locator => someone.page.locator('app-estimate .btn-group');
// One click accepts the card most people picked
const acceptButton = (someone: Person): Locator => someone.page.locator('app-estimate button.accept:not(.dropdown-toggle)');
// Opens the menu of all cards, the only button when the votes split
const estimateToggle = (someone: Person): Locator => someone.page.locator('app-estimate button.dropdown-toggle');
const acceptedEstimate = (someone: Person): Locator => someone.page.locator('app-estimate button.accepted');
const cardChoice = (someone: Person, value: string): Locator =>
  someone.page.locator('app-estimate .dropdown-menu.cards button.card-choice', {hasText: exact(value)});

const historyPanel = (someone: Person): Locator => someone.page.locator('#roomHistory');
const latestRound = (someone: Person): Locator => historyPanel(someone).locator('li.round').first();

// Types the name and presses Enter, which saves at once
async function nameTask(someone: Person, name: string) {
  await taskName(someone).fill(name);
  await taskName(someone).press('Enter');
}

// Opens the link field, pastes the link and presses Enter, which saves and closes the field
async function linkTask(someone: Person, url: string) {
  await taskLinkButton(someone).click();
  await expect(taskUrl(someone)).toBeFocused();
  await taskUrl(someone).fill(url);
  await taskUrl(someone).press('Enter');
}

async function expectTask(everyone: Person[], name: string) {
  for (const someone of everyone) {
    await expect(taskName(someone), `${someone.name} sees the task "${name}"`).toHaveValue(name);
  }
}

async function expectTaskLink(everyone: Person[], url: string) {
  for (const someone of everyone) {
    await expect(taskOpenLink(someone), `${someone.name} sees the link to the task`).toHaveAttribute('href', url);
    await expect(taskOpenLink(someone)).toHaveAttribute('title', url);
  }
}

async function expectEstimate(everyone: Person[], card: string) {
  for (const someone of everyone) {
    await expect(acceptedEstimate(someone), `${someone.name} sees the accepted estimate`).toHaveText(`Estimate: ${card}`);
  }
}

// Picks a card from the estimate menu, whether it offers the first estimate or a change of it
async function chooseEstimate(someone: Person, card: string) {
  await estimateToggle(someone).click();
  await expect(someone.page.locator('app-estimate .dropdown-menu.cards')).toBeVisible();
  await cardChoice(someone, card).click();
}

async function openHistory(someone: Person) {
  await someone.page.locator('button.history-toggle').click();
  await expect(historyPanel(someone)).toHaveClass(/\bopen\b/);
}

// Escape closes the panel; its backdrop would otherwise take every click on the room
async function closeHistory(someone: Person) {
  await someone.page.keyboard.press('Escape');
  await expect(historyPanel(someone)).not.toHaveClass(/\bopen\b/);
}

test('someone names the task and everyone sees it; Escape drops an edit, the cross clears the task', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const everyone = [alice, bob];
  const roomId = await createRoom(alice, {deck});
  await joinRoom(bob, roomId);
  await expectSeats(everyone, ['Alice', 'Bob']);
  await expect(taskName(bob)).toHaveAttribute('placeholder', 'Task name');

  // Alice types the name and stops: it is saved a second later, without Enter
  await timed('a typed task name reaches the other screen', async () => {
    await taskName(alice).fill('PIP-1 Login page');
    await expect(taskName(bob)).toHaveValue('PIP-1 Login page');
  });
  expect((await storedRoom(roomId)).task).toEqual({name: 'PIP-1 Login page'});

  // Enter saves at once and leaves the field
  await nameTask(alice, 'PIP-1 Login page and logout');
  await expect(taskName(alice)).not.toBeFocused();
  await expectTask(everyone, 'PIP-1 Login page and logout');

  // Alice starts changing the name, thinks better of it and presses Escape: the room's name is back and nothing was sent
  await taskName(alice).click();
  await taskName(alice).fill('Forgotten edit');
  await taskName(alice).press('Escape');
  await expect(taskName(alice)).toHaveValue('PIP-1 Login page and logout');
  await expect(taskName(alice)).not.toBeFocused();
  // The save would have happened a second after the typing, so let that moment pass before looking
  await alice.page.waitForTimeout(PAST_SAVE_DELAY_MS);
  await expectTask(everyone, 'PIP-1 Login page and logout');
  expect((await storedRoom(roomId)).task, 'the dropped edit never reached the server').toEqual({name: 'PIP-1 Login page and logout'});

  // The cross shows only while the name is being edited; it empties the field and clears the task for everyone
  await expect(taskClearCross(alice)).toHaveCount(0);
  await taskName(alice).click();
  await expect(taskClearCross(alice)).toBeVisible();
  await expect(taskClearCross(alice)).toHaveAttribute('title', 'Clear');
  await taskClearCross(alice).click();
  await expect(taskName(alice), 'the cursor stays in the emptied field').toBeFocused();
  await expectTask(everyone, '');
  await expect(taskClearCross(alice), 'nothing left to clear').toHaveCount(0);
  await expect.poll(async () => (await storedRoom(roomId)).task, {message: 'the server has no task anymore'}).toBeUndefined();

  noConsoleErrors(everyone);
  await leaveAll(everyone, roomId);
});

test('someone adds a link to the task: a bad link stays on the screen with an error, a good one is on every screen', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const everyone = [alice, bob];
  const roomId = await createRoom(alice, {deck});
  await joinRoom(bob, roomId);
  await nameTask(alice, 'PIP-7 Checkout');
  await expectTask(everyone, 'PIP-7 Checkout');
  await expect(taskOpenLink(alice)).toHaveCount(0);

  // The link icon opens the field with the cursor in it
  await expect(taskLinkButton(alice)).toHaveAttribute('aria-expanded', 'false');
  await taskLinkButton(alice).click();
  await expect(alice.page.locator('.task-link-field')).toBeVisible();
  await expect(taskUrl(alice)).toBeFocused();
  await expect(taskLinkButton(alice)).toHaveClass(/\bactive\b/);
  await expect(taskLinkButton(alice)).toHaveAttribute('aria-expanded', 'true');

  // A link without http:// is refused on the spot
  await taskUrl(alice).fill('example.com/browse/PIP-7');
  await expect(taskUrl(alice)).toHaveClass(/is-invalid/);
  await expect(alice.page.locator('.task-link-field .task-error')).toHaveText('The link must start with http:// or https://');
  // Leaving the field keeps it open with the error, so the link can be fixed
  await taskUrl(alice).blur();
  await expect(alice.page.locator('.task-link-field')).toBeVisible();
  await expect(taskUrl(alice)).toHaveClass(/is-invalid/);
  // A save would have happened a second after the typing, so let that moment pass before looking
  await alice.page.waitForTimeout(PAST_SAVE_DELAY_MS);
  await expect(taskOpenLink(bob), 'the bad link did not reach Bob').toHaveCount(0);
  await expect(taskOpenLink(alice)).toHaveCount(0);
  expect((await storedRoom(roomId)).task, 'the bad link did not reach the server').toEqual({name: 'PIP-7 Checkout'});

  // A proper link is saved with Enter, the field closes and the open icon appears for everyone
  const url = 'https://example.com/browse/PIP-7';
  await taskUrl(alice).fill(url);
  await expect(taskUrl(alice)).not.toHaveClass(/is-invalid/);
  await taskUrl(alice).press('Enter');
  await expect(alice.page.locator('.task-link-field')).toHaveCount(0);
  await expect(taskLinkButton(alice)).not.toHaveClass(/\bactive\b/);
  await expectTaskLink(everyone, url);
  for (const someone of everyone) {
    await expect(taskOpenLink(someone)).toHaveAttribute('target', '_blank');
    await expect(taskOpenLink(someone)).toHaveAttribute('aria-label', 'Open the task');
  }
  await expectTask(everyone, 'PIP-7 Checkout');
  expect((await storedRoom(roomId)).task).toEqual({name: 'PIP-7 Checkout', url});

  // Bob opens the link field and finds the same link in it
  await taskLinkButton(bob).click();
  await expect(taskUrl(bob)).toHaveValue(url);
  await taskUrl(bob).press('Escape');
  await expect(bob.page.locator('.task-link-field')).toHaveCount(0);

  noConsoleErrors(everyone);
  await leaveAll(everyone, roomId);
});

test('everyone picks the same card and someone accepts it as the estimate of the task', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const everyone = [alice, bob];
  const roomId = await createRoom(alice, {deck});
  await joinRoom(bob, roomId);
  await nameTask(alice, 'PIP-3 Payment form');
  await expectTask(everyone, 'PIP-3 Payment form');
  await expect(estimate(alice)).toHaveCount(0);

  // The second vote reveals the cards
  await vote(alice, '5');
  await vote(bob, '5');
  await expectRevealed(everyone, {Alice: '5', Bob: '5'});

  // The task can't change anymore: the name reads like a title and the link icon is gone
  for (const someone of everyone) {
    await expect(taskName(someone), `${someone.name} can't change the task after the reveal`).toBeDisabled();
    await expect(taskName(someone)).toHaveValue('PIP-3 Payment form');
    await expect(taskLinkButton(someone)).toHaveCount(0);
  }

  // Everyone picked 5, so that card is offered with one click
  for (const someone of everyone) {
    await expect(acceptButton(someone), `${someone.name} is offered the card everyone picked`).toHaveText('Accept 5');
    await expect(acceptedEstimate(someone)).toHaveCount(0);
  }
  await timed('accept the estimate and see it on every screen', async () => {
    await acceptButton(alice).click();
    await expectEstimate(everyone, '5');
  });
  await expect(acceptButton(bob)).toHaveCount(0);
  await expect(acceptedEstimate(bob)).toHaveAttribute('title', 'Change the estimate');

  // Bob's history has the round under the task's name, with the estimate in place of the counted result
  await openHistory(bob);
  await expect(historyPanel(bob).locator('li.round')).toHaveCount(1);
  await expect(latestRound(bob).locator('.round-task')).toHaveText('PIP-3 Payment form');
  await expect(latestRound(bob).locator('.tally .badge.leader')).toHaveText('5 × 2');
  await expect(latestRound(bob).locator('.estimate')).toHaveText('Estimate: 5');
  await expect(latestRound(bob).locator('.result')).toHaveCount(0);
  await expect(latestRound(bob).locator('.votes .card-value')).toHaveText(['5', '5']);
  await closeHistory(bob);

  const room = await storedRoom(roomId);
  expect(room.history?.length, 'the server keeps the round').toBe(1);
  expect(room.history?.[0].estimate, 'the server keeps the estimate').toBe('5');
  expect(room.history?.[0].task).toEqual({name: 'PIP-3 Payment form'});

  noConsoleErrors(everyone);
  await leaveAll(everyone, roomId);
});

test('the votes split, someone chooses the estimate from the cards and someone else changes it', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const everyone = [alice, bob];
  const roomId = await createRoom(alice, {deck});
  await joinRoom(bob, roomId);
  await nameTask(alice, 'PIP-5 Export');
  await expectTask(everyone, 'PIP-5 Export');

  await vote(alice, '3');
  await vote(bob, '8');
  await expectRevealed(everyone, {Alice: '3', Bob: '8'});

  // No card leads, so nothing is offered with one click: the estimate is chosen from the menu
  for (const someone of everyone) {
    await expect(estimateToggle(someone), `${someone.name} is asked to choose`).toHaveText('Accept estimate');
    await expect(acceptButton(someone)).toHaveCount(0);
  }
  await expect(estimateToggle(alice)).toHaveAttribute('title', 'Choose another card as the estimate');

  // Alice settles on 5, a card nobody picked
  await chooseEstimate(alice, '5');
  await expectEstimate(everyone, '5');
  await openHistory(alice);
  await expect(latestRound(alice).locator('.estimate')).toHaveText('Estimate: 5');
  await expect(latestRound(alice).locator('.tally .badge.leader'), 'no card led the vote').toHaveCount(0);
  await expect(latestRound(alice).locator('.tally .badge')).toHaveText(['3 × 1', '8 × 1']);
  await closeHistory(alice);
  expect((await storedRoom(roomId)).history?.[0].estimate).toBe('5');

  // Bob opens the accepted estimate, finds 5 marked in the menu, and changes it to 8
  await estimateToggle(bob).click();
  await expect(bob.page.locator('app-estimate .dropdown-menu.cards')).toBeVisible();
  await expect(bob.page.locator('app-estimate .card-choice.active')).toHaveText('5');
  await cardChoice(bob, '8').click();
  await expectEstimate(everyone, '8');
  await openHistory(alice);
  await expect(latestRound(alice).locator('.estimate')).toHaveText('Estimate: 8');
  await closeHistory(alice);
  await expect.poll(async () => (await storedRoom(roomId)).history?.[0].estimate, {message: 'the server keeps the changed estimate'})
    .toBe('8');

  noConsoleErrors(everyone);
  await leaveAll(everyone, roomId);
});

test('a new round keeps the task until an estimate is accepted, then starts without one', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const everyone = [alice, bob];
  const roomId = await createRoom(alice, {deck});
  await joinRoom(bob, roomId);
  const url = 'https://example.com/browse/PIP-9';
  await nameTask(alice, 'PIP-9 Search');
  await linkTask(alice, url);
  await expectTask(everyone, 'PIP-9 Search');
  await expectTaskLink(everyone, url);

  // Round 1: the votes split and nobody accepts anything, so the team votes on the same task again
  await vote(alice, '3');
  await vote(bob, '8');
  await expectRevealed(everyone, {Alice: '3', Bob: '8'});
  await expect(estimateToggle(alice)).toHaveText('Accept estimate');
  await timed('a new round without an estimate keeps the task', async () => {
    await mainButton(alice).click();
    for (const someone of everyone) {
      await expect(mainButton(someone)).toHaveText('Voting...');
    }
    await expectTask(everyone, 'PIP-9 Search');
    await expectTaskLink(everyone, url);
  });
  for (const someone of everyone) {
    await expect(taskName(someone), `${someone.name} can change the task again`).toBeEnabled();
    await expect(taskLinkButton(someone)).toBeVisible();
    await expect(estimate(someone), 'the estimate control is gone with the cards').toHaveCount(0);
    await expect(someone.page.locator('button.timer-toggle'), 'the timer is back in its place').toBeVisible();
  }
  let room = await storedRoom(roomId);
  expect(room.task).toEqual({name: 'PIP-9 Search', url});
  expect(room.history?.length).toBe(1);
  expect(room.history?.[0].estimate).toBeUndefined();

  // Round 2: the team agrees on 5 and accepts it
  await vote(alice, '5');
  await vote(bob, '5');
  await expectRevealed(everyone, {Alice: '5', Bob: '5'});
  await acceptButton(bob).click();
  await expectEstimate(everyone, '5');
  // Both rounds are listed under the task, with its link
  await openHistory(alice);
  await expect(historyPanel(alice).locator('li.round')).toHaveCount(2);
  await expect(historyPanel(alice).locator('li.round .round-task')).toHaveText(['PIP-9 Search', 'PIP-9 Search']);
  await expect(latestRound(alice).locator('a.round-task')).toHaveAttribute('href', url);
  await expect(latestRound(alice).locator('.estimate')).toHaveText('Estimate: 5');
  await expect(historyPanel(alice).locator('li.round').nth(1).locator('.result')).toHaveText('Votes split');
  await closeHistory(alice);

  // The task is done, so the next round starts with an empty line on every screen
  await timed('a new round after an accepted estimate clears the task', async () => {
    await mainButton(bob).click();
    for (const someone of everyone) {
      await expect(mainButton(someone)).toHaveText('Voting...');
    }
    await expectTask(everyone, '');
  });
  for (const someone of everyone) {
    await expect(taskOpenLink(someone), `${someone.name} sees no link anymore`).toHaveCount(0);
    await expect(taskName(someone)).toBeEnabled();
    await expect(estimate(someone)).toHaveCount(0);
  }
  room = await storedRoom(roomId);
  expect(room.task, 'the server starts the round without a task').toBeUndefined();
  expect(room.history?.length).toBe(2);
  expect(room.history?.[1].estimate).toBe('5');
  expect(room.history?.[1].task).toEqual({name: 'PIP-9 Search', url});

  noConsoleErrors(everyone);
  await leaveAll(everyone, roomId);
});
