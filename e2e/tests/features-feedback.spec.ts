import {expect, Locator, Request, test} from '@playwright/test';
import {
  baseUrl,
  createRoom,
  expectRevealed,
  expectSeats,
  expectVoted,
  joinRoom,
  leaveAll,
  noConsoleErrors,
  openRoomLink,
  person,
  type Person,
  vote
} from './people';

// The Feedback button in the corner of every page and the dialog behind it, and the page shown for a room that is gone.
// On a real server a sent message becomes a Jira issue and an e-mail to the owner, so in these tests the browser's
// request is answered by the test itself and never reaches the server.
const deck = '1; 2; 3; 5; 8';
// A well-formed id that no room has
const MISSING_ROOM_ID = '00000000-0000-4000-8000-000000000001';
const THANKS = 'Thank you, the message has been sent.';

const feedbackButton = (someone: Person): Locator => someone.page.getByRole('button', {name: 'Feedback'});
const dialog = (someone: Person): Locator => someone.page.getByRole('dialog', {name: 'Feedback'});
const messageField = (someone: Person): Locator => dialog(someone).locator('#feedbackMessage');
const messageLabel = (someone: Person): Locator => dialog(someone).locator('label[for=feedbackMessage]');
const kind = (someone: Person, name: string): Locator => dialog(someone).getByRole('radio', {name});
const kindLabel = (someone: Person, value: string): Locator => dialog(someone).locator(`label[for=feedbackKind-${value}]`);
const sendButton = (someone: Person): Locator => dialog(someone).getByRole('button', {name: 'Send'});
const messageError = (someone: Person): Locator => dialog(someone).locator('.invalid-feedback');
// After a message is sent the X and a footer button are both named Close
const closeAfterSending = (someone: Person): Locator => dialog(someone).locator('.modal-footer').getByRole('button', {name: 'Close'});

// What the browser sent to /api/feedback, and the answer the test gives in the server's place
interface FeedbackLine {
  requests: Request[];
  answer: number;
  // When set, the answer waits until this settles, so the dialog can be seen sending
  hold?: Promise<void>;
}

async function answerFeedback(someone: Person, answer = 204): Promise<FeedbackLine> {
  const line: FeedbackLine = {requests: [], answer};
  await someone.page.route('**/api/feedback', async route => {
    line.requests.push(route.request());
    await line.hold;
    await route.fulfill({status: line.answer});
  });
  return line;
}

async function openFeedback(someone: Person) {
  await feedbackButton(someone).click();
  await expect(dialog(someone)).toBeVisible();
}

// The button sits in the bottom right corner of the window, whatever the page shows there
async function expectInTheCorner(someone: Person) {
  await expect(feedbackButton(someone)).toBeVisible();
  const box = (await feedbackButton(someone).boundingBox())!;
  const viewport = someone.page.viewportSize()!;
  expect(box.x + box.width, `${someone.name} sees the button at the right edge`).toBeGreaterThan(viewport.width - 40);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height, `${someone.name} sees the button at the bottom edge`).toBeGreaterThan(viewport.height - 40);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
}

// Console errors the browser writes by itself about a refused request or a room that is gone, not the page's own
function ownConsoleErrors(someone: Person, browsersOwn: RegExp): string[] {
  return someone.consoleErrors.filter(error => !browsersOwn.test(error));
}

test('the Feedback button waits in the corner of the start page, the room and the join page', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');

  await alice.page.goto('/');
  await expect(alice.page.locator('#roomNameInput')).toBeVisible();
  await expectInTheCorner(alice);

  const roomId = await createRoom(alice, {deck});
  await expectInTheCorner(alice);

  // Bob opens the invitation and has not joined yet
  await openRoomLink(bob, roomId);
  await expect(bob.page.getByRole('button', {name: 'Join Room'})).toBeVisible();
  await expectInTheCorner(bob);
  // The name is also the tooltip, so a phone that shows the icon alone still tells what it is
  await expect(feedbackButton(bob)).toHaveAttribute('title', 'Feedback');

  noConsoleErrors([alice, bob]);
  await leaveAll([bob, alice], roomId);
});

test('someone opens the dialog, picks what it is about and is asked for a message before anything is sent', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const line = await answerFeedback(alice);
  await alice.page.goto('/');
  await openFeedback(alice);

  // A problem is assumed, with its question over the message
  await expect(dialog(alice).getByRole('heading', {name: 'Feedback'})).toBeVisible();
  await expect(kind(alice, 'Problem')).toBeChecked();
  await expect(messageLabel(alice)).toHaveText('What happened?');
  await expect(messageField(alice)).toHaveAttribute('placeholder', 'What you did and what went wrong');
  await expect(messageField(alice), 'the message is ready to be typed').toBeFocused();
  await expect(dialog(alice).getByLabel('How to reach you (optional)')).toBeVisible();

  // An idea and a review get their own questions
  await kindLabel(alice, 'idea').click();
  await expect(kind(alice, 'Idea')).toBeChecked();
  await expect(kind(alice, 'Problem')).not.toBeChecked();
  await expect(messageLabel(alice)).toHaveText('What would you add or change?');
  await expect(messageField(alice)).toHaveAttribute('placeholder', 'What PiPoker lacks for your team');
  await kindLabel(alice, 'review').click();
  await expect(kind(alice, 'Review')).toBeChecked();
  await expect(messageLabel(alice)).toHaveText('What do you think of PiPoker?');
  // Choosing the kind alone does not scold the empty message
  await expect(messageField(alice)).not.toHaveClass(/is-invalid/);

  // Send without a message: the form asks for one and nothing leaves the browser
  await sendButton(alice).click();
  await expect(messageError(alice)).toBeVisible();
  await expect(messageError(alice)).toHaveText('Write a message');
  await expect(messageField(alice)).toHaveClass(/is-invalid/);
  await expect(dialog(alice)).toBeVisible();
  // Spaces are not a message either
  await messageField(alice).fill('   ');
  await sendButton(alice).click();
  await expect(messageError(alice)).toBeVisible();
  await expect(dialog(alice)).toBeVisible();
  expect(line.requests, 'nothing was sent').toEqual([]);

  noConsoleErrors([alice]);
  await leaveAll([alice]);
});

test('someone reports a problem from a room and the message carries the room and the browser', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const carol = await person(browser, 'Carol');
  const everyone = [alice, bob, carol];
  const alicesLine = await answerFeedback(alice);
  const carolsLine = await answerFeedback(carol);
  const roomId = await createRoom(alice, {deck});
  await joinRoom(bob, roomId);
  await joinRoom(carol, roomId, {watcher: true});
  await expectSeats(everyone, ['Alice', 'Bob', 'Carol']);
  // Alice votes and Bob does not, so the cards are still hidden while she writes
  await vote(alice, '3');
  await expectVoted(everyone, 'Alice');

  await openFeedback(alice);
  await messageField(alice).fill('  The cards do not turn over on my screen  ');
  await dialog(alice).locator('#feedbackContact').fill(' alice@example.com ');
  // The answer waits, so the dialog is seen sending
  let release!: () => void;
  alicesLine.hold = new Promise<void>(resolve => release = resolve);
  await sendButton(alice).click();
  await expect(sendButton(alice)).toBeDisabled();
  await expect(sendButton(alice).locator('.spinner-border')).toBeVisible();
  release();
  await expect(dialog(alice).getByRole('status')).toHaveText(THANKS);
  await expect(dialog(alice).locator('form'), 'the form is gone once the message is sent').toHaveCount(0);

  // One request went out, with the room as it is and the browser, without any names or votes
  expect(alicesLine.requests).toHaveLength(1);
  const request = alicesLine.requests[0];
  expect(request.method()).toBe('POST');
  expect(request.headers()['content-type']).toBe('application/json');
  const viewport = alice.page.viewportSize();
  const body = request.postDataJSON();
  expect(body).toEqual({
    kind: 'problem',
    message: 'The cards do not turn over on my screen',
    contact: 'alice@example.com',
    roomId,
    voters: 2,
    watchers: 1,
    voted: 1,
    round: 'voting',
    page: `${baseUrl}/room/${roomId}`,
    browser: expect.stringContaining('Mozilla/'),
    language: 'en',
    browserLanguages: expect.stringMatching(/^[A-Za-z]+(-[A-Za-z0-9]+)*(, [A-Za-z]+(-[A-Za-z0-9]+)*)*$/),
    screen: expect.stringMatching(/^\d+x\d+$/),
    window: viewport ? `${viewport.width}x${viewport.height}` : expect.stringMatching(/^\d+x\d+$/),
    time: expect.stringMatching(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d$/),
    timeZone: expect.stringMatching(/\S/)
  });
  expect(JSON.stringify(body), 'nobody is named in the message').not.toMatch(/Alice|Bob|Carol/);
  // The time is the browser's local time with its offset, so it reads as a moment on any clock
  const sentAt = Date.parse(body.time.replace(' ', 'T').replace(' ', ''));
  expect(Math.abs(Date.now() - sentAt), 'the time is now').toBeLessThan(60_000);

  await closeAfterSending(alice).click();
  await expect(dialog(alice)).toBeHidden();
  // The room is as Alice left it
  await expectSeats([alice], ['Alice', 'Bob', 'Carol']);
  await expectVoted([alice], 'Alice');

  // Bob's vote turns the cards over. Carol, who only watches, sends an idea: the message says how the round stands
  await vote(bob, '5');
  await expectRevealed(everyone, {Alice: '3', Bob: '5'});
  await openFeedback(carol);
  await kindLabel(carol, 'idea').click();
  await messageField(carol).fill('Show the average of the votes');
  await sendButton(carol).click();
  await expect(dialog(carol).getByRole('status')).toHaveText(THANKS);
  expect(carolsLine.requests).toHaveLength(1);
  expect(carolsLine.requests[0].postDataJSON()).toEqual(expect.objectContaining({
    kind: 'idea',
    message: 'Show the average of the votes',
    contact: '',
    roomId,
    voters: 2,
    watchers: 1,
    voted: 2,
    round: 'revealed',
    page: `${baseUrl}/room/${roomId}`
  }));
  await closeAfterSending(carol).click();
  await expect(dialog(carol)).toBeHidden();

  noConsoleErrors(everyone);
  await leaveAll(everyone, roomId);
});

test('the dialog says when the browser sent too many messages or the server failed, and keeps the text for another try', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const line = await answerFeedback(alice, 429);
  await alice.page.goto('/');
  await openFeedback(alice);
  await messageField(alice).fill('The deck is empty');

  // Too many messages from this browser lately
  await sendButton(alice).click();
  const alert = dialog(alice).getByRole('alert');
  await expect(alert).toHaveText('You have sent several messages lately. Try again in an hour.');
  await expect(messageField(alice), 'the text stays for another try').toHaveValue('The deck is empty');
  await expect(sendButton(alice)).toBeEnabled();
  expect(line.requests).toHaveLength(1);

  // The server could not pass the message on
  line.answer = 500;
  await sendButton(alice).click();
  await expect(alert).toHaveText("The message wasn't sent. Try again a bit later.");
  await expect(messageField(alice)).toHaveValue('The deck is empty');
  expect(line.requests).toHaveLength(2);

  // The next try goes through with the same text
  line.answer = 204;
  await sendButton(alice).click();
  await expect(dialog(alice).getByRole('status')).toHaveText(THANKS);
  expect(line.requests.map(request => request.postDataJSON().message)).toEqual(['The deck is empty', 'The deck is empty', 'The deck is empty']);
  await closeAfterSending(alice).click();
  await expect(dialog(alice)).toBeHidden();

  // The browser itself notes the refused requests; the page adds no error of its own
  expect.soft(ownConsoleErrors(alice, /Failed to load resource/), 'Alice has no errors of the page in the browser console').toEqual([]);
  await leaveAll([alice]);
});

test('someone changes their mind: Cancel, the cross and Escape close the dialog and nothing is sent', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const line = await answerFeedback(alice);
  await alice.page.goto('/');

  await openFeedback(alice);
  await messageField(alice).fill('Never mind');
  await dialog(alice).getByRole('button', {name: 'Cancel'}).click();
  await expect(dialog(alice)).toBeHidden();

  // The cross in the header is the only Close while the form is shown
  await openFeedback(alice);
  await messageField(alice).fill('Never mind');
  await dialog(alice).getByRole('button', {name: 'Close', exact: true}).click();
  await expect(dialog(alice)).toBeHidden();

  await openFeedback(alice);
  await messageField(alice).fill('Never mind');
  await alice.page.keyboard.press('Escape');
  await expect(dialog(alice)).toBeHidden();

  expect(line.requests, 'nothing was sent').toEqual([]);
  // The page behind the dialog is as it was
  await expect(alice.page.locator('#roomNameInput')).toBeVisible();
  await expect(feedbackButton(alice)).toBeVisible();

  noConsoleErrors([alice]);
  await leaveAll([alice]);
});

test('someone opens an invitation to a room that no longer exists', async ({browser}) => {
  const lost = await person(browser, 'Lost');
  await openRoomLink(lost, MISSING_ROOM_ID);

  await expect(lost.page.getByRole('heading', {name: 'This invitation is no longer valid'})).toBeVisible();
  await expect(lost.page.getByText('The room no longer exists: everyone has left it.')).toBeVisible();
  const createNew = lost.page.getByRole('link', {name: 'Create a new room'});
  await expect(createNew).toBeVisible();
  await expect(createNew).toHaveAttribute('href', '/');
  // Nothing of a room is left: no join form, and no name or invitation in the header
  await expect(lost.page.locator('#nicknameInput')).toHaveCount(0);
  await expect(lost.page.locator('app-table')).toHaveCount(0);
  await expect(lost.page.locator('header .room-name')).toHaveCount(0);
  await expect(lost.page.getByTitle('Copy the invitation link')).toHaveCount(0);
  // Feedback is still at hand on this page
  await expectInTheCorner(lost);
  // The browser notes the room that was not found; the page adds no error of its own
  expect.soft(ownConsoleErrors(lost, /not found/i), 'Lost has no errors of the page in the browser console').toEqual([]);

  // The link leads to a fresh start page
  await createNew.click();
  await lost.page.waitForURL(url => url.pathname === '/');
  await expect(lost.page.locator('#roomNameInput')).toBeVisible();

  await leaveAll([lost]);
});
