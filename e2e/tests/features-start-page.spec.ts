import {expect, Locator, test} from '@playwright/test';
import {
  baseUrl,
  createRoom,
  expectSeats,
  leaveAll,
  noConsoleErrors,
  person,
  type Person,
  testRoomName,
  timed
} from './people';

// The start page and what surrounds a room: the decks offered when a room is created, the field for a pasted
// invitation, the language and the theme in the header, and how the header shrinks when a room name is long.
const TIME_DECK = 'NA; 1h; 1.5h; 2h; 3h; 4h; 6h; 1d; 1.5d; 2d; 3d; 4d; 1w; 1.5w; 2w; 2.5w; 3w';
const FIBONACCI_DECK = '0; 1; 2; 3; 5; 8; 13; 21; 34; 55; 89; ?; ☕';
const TSHIRT_DECK = 'XS; S; M; L; XL; XXL; ?';
const cardsOf = (deck: string) => deck.split(';').map(card => card.trim());

const deckSelect = (someone: Person): Locator => someone.page.locator('#deckSelect');
const deckInput = (someone: Person): Locator => someone.page.locator('#deckInput');
const deckError = (someone: Person): Locator => someone.page.locator('#deckInput + .invalid-feedback');
const createButton = (someone: Person): Locator => someone.page.getByRole('button', {name: 'Create Room'});
const deckCards = (someone: Person): Locator => someone.page.locator('app-deck-card .card-text');
const stored = (someone: Person, key: string) => someone.page.evaluate(key => localStorage.getItem(key), key);

async function openStartPage(someone: Person) {
  await someone.page.goto('/');
  await expect(deckSelect(someone)).toBeVisible();
}

// The names are filled in so that only the deck decides whether the room can be created
async function fillNames(someone: Person) {
  await someone.page.locator('#nicknameInput').fill(someone.name);
  await someone.page.locator('#roomNameInput').fill(testRoomName());
}

// Creates the room with whatever the form holds at the moment, unlike createRoom, which starts from a fresh page
async function createRoomFromForm(someone: Person): Promise<string> {
  await createButton(someone).click();
  await someone.page.waitForURL(/\/room\/[0-9a-f-]{36}$/);
  await expect(someone.page.locator('app-table')).toBeVisible();
  return someone.page.url().split('/room/')[1];
}

test('someone picks a ready deck and the room is dealt its cards', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  await openStartPage(alice);

  // A fresh browser offers the hours-and-days deck, 17 cards
  await expect(deckSelect(alice)).toHaveValue('preset:time');
  await expect(deckInput(alice)).toHaveValue(TIME_DECK);
  expect(cardsOf(TIME_DECK)).toHaveLength(17);
  await expect(deckSelect(alice).locator('optgroup[label="Ready decks"] option')).toHaveText(['Fibonacci', 'Story points', 'Hours and days', 'T-shirt sizes']);
  // The page also tells newcomers what PiPoker is
  await expect(alice.page.getByRole('heading', {name: 'What is PiPoker?'})).toBeVisible();

  // Alice picks Fibonacci: the cards appear in the field, where she could still change them
  await deckSelect(alice).selectOption('preset:fibonacci');
  await expect(deckInput(alice)).toHaveValue(FIBONACCI_DECK);
  await expect(deckSelect(alice)).toHaveValue('preset:fibonacci');

  await fillNames(alice);
  await expect(createButton(alice)).toBeEnabled();
  const roomId = await timed('create a room with a ready deck', () => createRoomFromForm(alice));
  await expect(deckCards(alice)).toHaveCount(13);
  await expect(deckCards(alice)).toHaveText(cardsOf(FIBONACCI_DECK));
  // The deck is remembered for the next room
  expect(await stored(alice, 'last-deck')).toBe(FIBONACCI_DECK);

  noConsoleErrors([alice]);
  await leaveAll([alice], roomId);
});

test('someone saves their own deck, finds it after a reload and deletes it', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  await openStartPage(alice);
  await fillNames(alice);

  // "Own cards" clears the field and puts the cursor there; there is no deck yet, so no room either
  await deckSelect(alice).selectOption('');
  await expect(deckSelect(alice)).toHaveValue('');
  await expect(deckInput(alice)).toHaveValue('');
  await expect(deckInput(alice)).toBeFocused();
  await expect(createButton(alice)).toBeDisabled();
  await expect(alice.page.locator('#saveDeckButton')).toHaveCount(0);

  // Cards that match no listed deck can be saved under a name
  await deckInput(alice).fill('1; 2; 4');
  await expect(createButton(alice)).toBeEnabled();
  const deckName = alice.page.locator('#deckNameInput');
  const saveButton = alice.page.locator('#saveDeckButton');
  await expect(deckName).toBeVisible();
  await expect(deckName).toHaveAttribute('placeholder', 'Deck name to save it');
  await expect(saveButton, 'nothing to save under an empty name').toBeDisabled();
  await deckName.fill('Doubles');
  await expect(saveButton).toBeEnabled();
  await saveButton.click();

  // The deck is now listed under "My decks" and selected
  await expect(deckSelect(alice)).toHaveValue('mine:Doubles');
  await expect(deckSelect(alice).locator('optgroup[label="My decks"] option')).toHaveText(['Doubles']);
  await expect(deckInput(alice)).toHaveValue('1; 2; 4');
  await expect(deckName, 'a listed deck has nothing to save').toHaveCount(0);
  const deleteButton = alice.page.locator('#deleteDeckButton');
  await expect(deleteButton).toBeVisible();
  await expect(deleteButton).toHaveAttribute('title', 'Delete the deck from my decks');
  expect(JSON.parse(await stored(alice, 'my-decks') ?? 'null')).toEqual([{name: 'Doubles', cards: '1; 2; 4'}]);

  // The deck lives in this browser, so it is still there after a reload, and can be picked again
  await alice.page.reload();
  await expect(deckSelect(alice), 'the last deck is remembered').toHaveValue('mine:Doubles');
  await expect(deckInput(alice)).toHaveValue('1; 2; 4');
  await deckSelect(alice).selectOption('preset:tshirt');
  await expect(deckInput(alice)).toHaveValue(TSHIRT_DECK);
  await expect(deleteButton, 'a ready deck cannot be deleted').toHaveCount(0);
  await deckSelect(alice).selectOption('mine:Doubles');
  await expect(deckInput(alice)).toHaveValue('1; 2; 4');
  await expect(deleteButton).toBeVisible();

  // A room created with the saved deck has just those cards
  await fillNames(alice);
  const roomId = await createRoomFromForm(alice);
  await expect(deckCards(alice)).toHaveText(['1', '2', '4']);

  // Back on the start page through the logo, Alice deletes the deck. The cards stay in the field for one more room
  await alice.page.locator('header a.logo').click();
  await expect(deckSelect(alice)).toHaveValue('mine:Doubles');
  await deleteButton.click();
  await expect(deleteButton).toHaveCount(0);
  await expect(deckSelect(alice).locator('option[value="mine:Doubles"]')).toHaveCount(0);
  await expect(deckSelect(alice).locator('optgroup[label="My decks"]'), 'the group disappears with its last deck').toHaveCount(0);
  await expect(deckSelect(alice)).toHaveValue('');
  await expect(deckInput(alice)).toHaveValue('1; 2; 4');
  await expect(deckName, 'the cards can be saved again').toBeVisible();
  expect(await stored(alice, 'my-decks')).toBe('[]');

  noConsoleErrors([alice]);
  await leaveAll([alice], roomId);
});

test('the deck field says what is wrong with the cards', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  await openStartPage(alice);
  await fillNames(alice);
  await expect(createButton(alice)).toBeEnabled();

  // Too many cards. The reason shows once Alice leaves the field
  await deckInput(alice).fill(Array.from({length: 21}, (_, index) => String(index + 1)).join('; '));
  await expect(createButton(alice)).toBeDisabled();
  await deckInput(alice).blur();
  await expect(deckInput(alice)).toHaveClass(/is-invalid/);
  await expect(deckError(alice)).toBeVisible();
  await expect(deckError(alice)).toHaveText('The deck can contain at most 20 cards');
  await expect(alice.page.locator('#saveDeckButton'), 'a broken deck cannot be saved').toHaveCount(0);

  // The same card twice
  await deckInput(alice).fill('1; 2; 1');
  await expect(deckError(alice)).toHaveText('Card values must be unique: 1');
  await expect(createButton(alice)).toBeDisabled();

  // A card that is too long to fit on its face
  await deckInput(alice).fill('1; 2; 1234567');
  await expect(deckError(alice)).toHaveText('Card values can be at most 6 characters long: 1234567');
  await expect(createButton(alice)).toBeDisabled();

  // Fixed
  await deckInput(alice).fill('1; 2; 3');
  await expect(deckInput(alice)).toHaveClass(/is-valid/);
  await expect(deckError(alice)).toBeHidden();
  await expect(createButton(alice)).toBeEnabled();

  noConsoleErrors([alice]);
  await leaveAll([alice]);
});

test('someone pastes an invitation on the start page and is seated right away', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const carol = await person(browser, 'Carol');
  const everyone = [alice, bob, carol];
  const roomId = await createRoom(alice);
  const invitation = alice.page.locator('#invitationInput');
  const joinButton = alice.page.getByRole('button', {name: 'Join', exact: true});

  // Bob types his nickname, pastes the whole link and clicks Join: no join form, he is at the table
  await openStartPage(bob);
  await expect(bob.page.locator('#invitationInput')).toHaveAttribute('placeholder', 'Paste the invitation link');
  await expect(bob.page.getByRole('button', {name: 'Join', exact: true}), 'nothing to join yet').toBeDisabled();
  await bob.page.locator('#nicknameInput').fill('Bob');
  await bob.page.locator('#invitationInput').fill(`${baseUrl}/room/${roomId}`);
  await expect(bob.page.getByRole('button', {name: 'Join', exact: true})).toBeEnabled();
  await timed('join by a pasted invitation', async () => {
    await bob.page.getByRole('button', {name: 'Join', exact: true}).click();
    await bob.page.waitForURL(new RegExp(`/room/${roomId}$`));
    await expect(bob.page.locator('app-table')).toBeVisible();
  });
  await expect(bob.page.locator('#nicknameInput'), 'Bob did not have to fill the join form').toHaveCount(0);
  await expectSeats([alice, bob], ['Alice', 'Bob']);

  // Carol first pastes something that is not an invitation, then the bare room id, and presses Enter
  await openStartPage(carol);
  await carol.page.locator('#nicknameInput').fill('Carol');
  await carol.page.locator('#invitationInput').fill('see you at the table at noon');
  await expect(carol.page.locator('#invitationInput')).toHaveClass(/is-invalid/);
  await expect(carol.page.getByText('This is not a PiPoker invitation link')).toBeVisible();
  await expect(carol.page.getByRole('button', {name: 'Join', exact: true})).toBeDisabled();
  await carol.page.locator('#invitationInput').fill(roomId);
  await expect(carol.page.locator('#invitationInput')).not.toHaveClass(/is-invalid/);
  await expect(carol.page.getByRole('button', {name: 'Join', exact: true})).toBeEnabled();
  await carol.page.locator('#invitationInput').press('Enter');
  await carol.page.waitForURL(new RegExp(`/room/${roomId}$`));
  await expect(carol.page.locator('app-table')).toBeVisible();
  await expect(carol.page.locator('#nicknameInput')).toHaveCount(0);
  await expectSeats(everyone, ['Alice', 'Bob', 'Carol']);

  // Alice, already in a room, has no invitation field there
  await expect(invitation).toHaveCount(0);
  await expect(joinButton).toHaveCount(0);

  noConsoleErrors(everyone);
  await leaveAll(everyone, roomId);
});

test("someone sees the page in the browser's language and can switch it in the header", async ({browser}) => {
  const alisa = await person(browser, 'Алиса', {locale: 'ru-RU'});
  const bob = await person(browser, 'Bob', {locale: 'en-US'});

  // A Russian browser gets the Russian page without asking
  await openStartPage(alisa);
  await expect(alisa.page.getByRole('button', {name: 'Создать комнату'})).toBeVisible();
  await expect(alisa.page.locator('label[for=nicknameInput]')).toHaveText('Имя');
  await expect(alisa.page.getByRole('heading', {name: 'Что такое PiPoker?'})).toBeVisible();
  await expect(alisa.page.locator('html')).toHaveAttribute('lang', 'ru');
  await expect(alisa.page.locator('.language-select .button-label')).toHaveText('RU');
  expect(await stored(alisa, 'language'), 'nothing is stored until someone picks a language').toBeNull();

  // An English browser gets English, and Bob switches to Russian: the page changes at once, without a reload
  await openStartPage(bob);
  await expect(bob.page.getByRole('button', {name: 'Create Room'})).toBeVisible();
  await expect(bob.page.getByRole('heading', {name: 'What is PiPoker?'})).toBeVisible();
  await expect(bob.page.locator('html')).toHaveAttribute('lang', 'en');
  const languageMenu = bob.page.locator('.language-select');
  await expect(languageMenu.locator('.button-label')).toHaveText('EN');
  await languageMenu.locator('.dropdown-toggle').click();
  await expect(languageMenu.locator('.dropdown-item[lang=en]')).toHaveClass(/active/);
  await expect(languageMenu.locator('.dropdown-item[lang=ru]')).toHaveText('Русский');
  await languageMenu.locator('.dropdown-item[lang=ru]').click();
  await expect(bob.page.getByRole('button', {name: 'Создать комнату'})).toBeVisible();
  await expect(bob.page.locator('label[for=nicknameInput]')).toHaveText('Имя');
  await expect(bob.page.locator('html')).toHaveAttribute('lang', 'ru');
  await expect(languageMenu.locator('.button-label')).toHaveText('RU');
  expect(await stored(bob, 'language')).toBe('ru');

  // The choice outlives a reload
  await bob.page.reload();
  await expect(bob.page.getByRole('button', {name: 'Создать комнату'})).toBeVisible();
  await expect(bob.page.locator('html')).toHaveAttribute('lang', 'ru');
  await languageMenu.locator('.dropdown-toggle').click();
  await expect(languageMenu.locator('.dropdown-item[lang=ru]')).toHaveClass(/active/);

  // And back to English
  await languageMenu.locator('.dropdown-item[lang=en]').click();
  await expect(bob.page.getByRole('button', {name: 'Create Room'})).toBeVisible();
  await expect(bob.page.locator('html')).toHaveAttribute('lang', 'en');
  expect(await stored(bob, 'language')).toBe('en');

  noConsoleErrors([alisa, bob]);
  await leaveAll([alisa, bob]);
});

test('someone switches to the light theme and the browser remembers it', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  await openStartPage(alice);
  const body = alice.page.locator('body');
  const themeColor = alice.page.locator('meta[name=theme-color]');
  const slider = alice.page.locator('#slider');

  // Dark by default
  await expect(body).toHaveAttribute('data-bs-theme', 'dark');
  await expect(themeColor).toHaveAttribute('content', '#212529');
  await expect(slider).not.toBeChecked();

  // One click on the switch: the page and the browser's title bar colour turn light
  await alice.page.locator('#switch').click();
  await expect(body).toHaveAttribute('data-bs-theme', 'light');
  await expect(themeColor).toHaveAttribute('content', '#ffffff');
  await expect(slider).toBeChecked();
  expect(await stored(alice, 'last-theme')).toBe('true');

  // A reload keeps the light theme
  await alice.page.reload();
  await expect(body).toHaveAttribute('data-bs-theme', 'light');
  await expect(themeColor).toHaveAttribute('content', '#ffffff');
  await expect(slider).toBeChecked();

  // And back to dark
  await alice.page.locator('#switch').click();
  await expect(body).toHaveAttribute('data-bs-theme', 'dark');
  await expect(themeColor).toHaveAttribute('content', '#212529');
  expect(await stored(alice, 'last-theme')).toBe('false');

  noConsoleErrors([alice]);
  await leaveAll([alice]);
});

test('a long room name in a narrow window makes the header compact without anything sticking out', async ({browser}) => {
  const alice = await person(browser, 'Alice', {viewport: {width: 420, height: 800}});
  // 30 characters of several words, close to the longest name allowed
  const roomName = 'E2E room with a very long name';
  const roomId = await createRoom(alice, {roomName});
  const header = alice.page.locator('header');
  const roomNameElement = header.locator('.room-name');
  await expect(roomNameElement).toHaveText(roomName);
  await expect(roomNameElement, 'a name of several words may wrap').toHaveClass(/wraps/);

  // The header gives up its tagline first, and takes further steps until everything fits on its one line
  await expect(header).toHaveClass(/\bwithout-tagline\b/);
  await alice.page.evaluate(() => document.fonts.ready);
  const compactSteps = ['without-tagline', 'small-room-name', 'language-flag-only', 'support-heart-only', 'invite-icon-only', 'logo-only', 'settings-menu'];
  const taken = ((await header.getAttribute('class')) ?? '').split(/\s+/).filter(name => compactSteps.includes(name));
  console.log(`At 420px with "${roomName}" the header takes these steps: ${taken.join(', ')}`);
  expect(taken[0]).toBe('without-tagline');

  const sizes = await header.evaluate(element => ({
    header: {scrollWidth: element.scrollWidth, clientWidth: element.clientWidth},
    roomName: (({scrollWidth, clientWidth, scrollHeight, clientHeight}) => ({scrollWidth, clientWidth, scrollHeight, clientHeight}))(element.querySelector('.room-name')!),
    page: {scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth}
  }));
  expect(sizes.header.scrollWidth, `the header content fits (${sizes.header.scrollWidth}px in ${sizes.header.clientWidth}px)`)
    .toBeLessThanOrEqual(sizes.header.clientWidth);
  expect(sizes.roomName.scrollWidth, `the room name is not cut sideways (${sizes.roomName.scrollWidth}px in ${sizes.roomName.clientWidth}px)`)
    .toBeLessThanOrEqual(sizes.roomName.clientWidth);
  expect(sizes.roomName.scrollHeight, `the room name is not cut below (${sizes.roomName.scrollHeight}px in ${sizes.roomName.clientHeight}px)`)
    .toBeLessThanOrEqual(sizes.roomName.clientHeight);
  expect(sizes.page.scrollWidth, `nothing sticks out of the page (${sizes.page.scrollWidth}px in ${sizes.page.innerWidth}px)`)
    .toBeLessThanOrEqual(sizes.page.innerWidth);

  // The Invite button is still there, found by its title even when it shows only the icon
  const invite = alice.page.getByTitle('Copy the invitation link');
  await expect(invite).toBeVisible();
  await expect(invite).toBeInViewport();
  if (taken.includes('invite-icon-only')) {
    await expect(invite.locator('.button-label'), 'only the icon of Invite is shown').toBeHidden();
  } else {
    await expect(invite).toHaveText('Invite');
  }
  // Support, the language and the theme are either in the header or in one menu, never lost
  if (taken.includes('settings-menu')) {
    await expect(alice.page.locator('.language-select')).toHaveCount(0);
    await alice.page.getByTitle('Menu').click();
    await expect(alice.page.locator('.settings-dropdown .dropdown-item[lang=ru]')).toBeVisible();
    await expect(alice.page.locator('.settings-dropdown #switch')).toBeVisible();
    await expect(alice.page.locator('.settings-dropdown .support-item')).toHaveAttribute('href', 'https://lorddetson.github.io/');
  } else {
    await expect(alice.page.locator('.language-select .dropdown-toggle')).toBeVisible();
    await expect(alice.page.locator('header #switch')).toBeVisible();
    await expect(alice.page.locator('header .support-link')).toBeVisible();
  }

  noConsoleErrors([alice]);
  await leaveAll([alice], roomId);
});
