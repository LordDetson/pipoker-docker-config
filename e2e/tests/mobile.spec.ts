import {expect, Page, test} from '@playwright/test';
import {createRoom, deckCard, expectRevealed, expectSeats, joinRoom, leaveAll, mainButton, noConsoleErrors, person, vote} from './people';

// The default deck has 17 cards, the most a real team is likely to see on a phone
async function expectFitsTheScreen(page: Page, what: string) {
  const {scrollWidth, innerWidth} = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth
  }));
  expect.soft(scrollWidth, `${what}: nothing sticks out to the side (page ${scrollWidth}px, screen ${innerWidth}px)`)
    .toBeLessThanOrEqual(innerWidth);
  await test.info().attach(what, {body: await page.screenshot({fullPage: true}), contentType: 'image/png'});
  // A small copy in the log, so the screens can be looked at without downloading the report
  const small = await page.screenshot({fullPage: true, type: 'jpeg', quality: 40, scale: 'css'});
  console.log(`SCREENSHOT ${test.info().project.name} ${what.replace(/ /g, '-')} ${small.toString('base64')}`);
}

test('two people play a round on phones', async ({browser}, testInfo) => {
  const device = testInfo.project.use;
  const options = {
    viewport: device.viewport,
    userAgent: device.userAgent,
    deviceScaleFactor: device.deviceScaleFactor,
    isMobile: device.isMobile,
    hasTouch: device.hasTouch
  };
  const alice = await person(browser, 'Alice', options);
  const bob = await person(browser, 'Bob', options);

  await alice.page.goto('/');
  await expectFitsTheScreen(alice.page, 'create room form');
  const roomId = await createRoom(alice);
  await expectFitsTheScreen(alice.page, 'room after creating it');
  await expect(alice.page.getByRole('button', {name: 'Copy Invitation Link'})).toBeInViewport();

  await bob.page.goto(`/room/${roomId}`);
  await expectFitsTheScreen(bob.page, 'join form');
  await joinRoom(bob, roomId);
  await expectSeats([alice, bob], ['Alice', 'Bob']);

  await deckCard(alice, '1d').tap();
  await expect(deckCard(alice, '1d')).toHaveClass(/selected/);
  await vote(bob, '2d');
  await expectFitsTheScreen(alice.page, 'room with votes');

  // The person has to find the button: scroll to it as a finger would
  await mainButton(bob).scrollIntoViewIfNeeded();
  await mainButton(bob).tap();
  await expectRevealed([alice, bob], {Alice: '1d', Bob: '2d'});
  await expectFitsTheScreen(alice.page, 'revealed cards');

  noConsoleErrors([alice, bob]);
  await leaveAll([alice, bob], roomId);
});
