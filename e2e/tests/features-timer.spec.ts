import {expect, test} from '@playwright/test';
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
import {fetchRoom, type RoomDto, Stomp} from './stomp';

// The discussion timer above the status button. Anyone starts it from the Timer menu, every page counts it down
// together, and anyone stops it with a click on the running pill. Once the cards are revealed there is nothing left
// to discuss: the timer goes and the estimate takes its place until the next round.
const deck = '1; 2; 3; 5; 8';

const timerToggle = (someone: Person) => someone.page.locator('button.timer-toggle');
const timerPill = (someone: Person) => someone.page.locator('button.timer');
const timeLeft = (someone: Person) => timerPill(someone).getByRole('timer');
const estimate = (someone: Person) => someone.page.locator('app-estimate .btn-group');

// Picks a length from the Timer menu
async function startTimer(someone: Person, minutes: number) {
  await timerToggle(someone).click();
  const menu = someone.page.locator('app-timer .dropdown-menu');
  await expect(menu, 'the Timer menu opens').toHaveClass(/\bshow\b/);
  await menu.getByRole('button', {name: `${minutes} min`, exact: true}).click();
}

// "1:05" as seconds
function secondsOf(text: string | null): number {
  const [minutes, seconds] = (text ?? '').trim().split(':').map(Number);
  return minutes * 60 + seconds;
}

// Nobody has a timer running, and everyone is offered one
async function expectIdleTimer(everyone: Person[]) {
  for (const someone of everyone) {
    await expect(timerPill(someone), `${someone.name} sees no running timer`).toHaveCount(0);
    await expect(timerToggle(someone), `${someone.name} is offered the timer`).toBeVisible();
    await expect(timerToggle(someone)).toHaveText('Timer');
    await expect(timerToggle(someone)).toHaveAttribute('title', 'Start the discussion timer');
  }
}

// What the server refused, from the error topic of a raw STOMP connection
function refusals(client: Stomp): {destination?: string; message?: string; code?: string}[] {
  return client.errors.flatMap(body => {
    try {
      return [JSON.parse(body)];
    } catch {
      return [];
    }
  });
}

test('someone starts a one minute timer, everyone counts it down together and someone else stops it', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const everyone = [alice, bob];
  const roomId = await createRoom(alice, {deck});
  await joinRoom(bob, roomId);
  await expectSeats(everyone, ['Alice', 'Bob']);
  await expectIdleTimer(everyone);

  await timed('start a timer and see it on every screen', async () => {
    await startTimer(alice, 1);
    for (const someone of everyone) {
      await expect(timerPill(someone), `${someone.name} sees the running timer`).toBeVisible();
      await expect(timeLeft(someone), `${someone.name} sees a minute counting down`).toHaveText(/^0:5\d$|^1:00$/);
      await expect(timerToggle(someone), 'the Timer menu makes way for the running timer').toHaveCount(0);
    }
  });
  await expect(timerPill(alice)).toHaveAttribute('title', 'Stop the timer');

  // It moves: the next second shows less time
  const first = await timeLeft(alice).textContent();
  await expect(timeLeft(alice), 'the timer counts down').not.toHaveText(first ?? '');
  const second = await timeLeft(alice).textContent();
  expect(secondsOf(second), `Alice saw ${first}, then ${second}`).toBeLessThan(secondsOf(first));
  // Everyone counts the same timer down
  const [alicesReading, bobsReading] = await Promise.all([timeLeft(alice).textContent(), timeLeft(bob).textContent()]);
  expect(Math.abs(secondsOf(alicesReading) - secondsOf(bobsReading)), `Alice sees ${alicesReading}, Bob sees ${bobsReading}`)
    .toBeLessThanOrEqual(1);

  // Bob stops it: the pill goes from every screen and the menu is back
  await timed('stop the timer', async () => {
    await timerPill(bob).click();
    await expectIdleTimer(everyone);
  });

  noConsoleErrors(everyone);
  await leaveAll(everyone, roomId);
});

test("a short timer warns in its last seconds, says Time's up and stays until someone clears it", async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const everyone = [alice, bob];
  const roomId = await createRoom(alice, {deck});
  await joinRoom(bob, roomId);
  await expectSeats(everyone, ['Alice', 'Bob']);

  // The menu offers a minute at least. The server takes ten seconds, the shortest it allows, so the end comes soon.
  const client = await Stomp.connect(baseUrl);
  try {
    client.send(`/app/room/${roomId}/timer/start`, {seconds: 10});
    for (const someone of everyone) {
      await expect(timeLeft(someone), `${someone.name} sees the seconds left`).toHaveText(/^0:(0[1-9]|10)$/);
      await expect(timerPill(someone), `${someone.name} sees the warning colour in the last ten seconds`).toHaveClass(/\bwarning\b/);
      await expect(timerPill(someone)).not.toHaveClass(/\btime-up\b/);
    }
    // The timer really runs for ten seconds, so this waits for it to run out
    await timed('the ten seconds run out', async () => {
      for (const someone of everyone) {
        await expect(timerPill(someone), `${someone.name} sees that the time is up`).toHaveClass(/\btime-up\b/);
        await expect(timeLeft(someone)).toHaveText("Time's up");
        await expect(timerPill(someone), 'the warning colour goes with the time').not.toHaveClass(/\bwarning\b/);
      }
    });
    expect(client.errors, 'the server took the ten second timer').toEqual([]);
  } finally {
    client.close();
  }

  // The pill pulses for three seconds when the time is up. Nothing takes it away by itself after that.
  await timerPill(alice).evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  for (const someone of everyone) {
    await expect(timerPill(someone), `${someone.name} still sees that the time is up`).toHaveClass(/\btime-up\b/);
    await expect(timeLeft(someone)).toHaveText("Time's up");
  }

  // Alice clears it with a click, for everyone
  await timerPill(alice).click();
  await expectIdleTimer(everyone);

  noConsoleErrors(everyone);
  await leaveAll(everyone, roomId);
});

test('the reveal takes the running timer away and refuses a new one until the next round', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const everyone = [alice, bob];
  const roomId = await createRoom(alice, {deck});
  await joinRoom(bob, roomId);
  await expectSeats(everyone, ['Alice', 'Bob']);

  await startTimer(alice, 2);
  for (const someone of everyone) {
    await expect(timeLeft(someone), `${someone.name} sees two minutes counting down`).toHaveText(/^1:5\d$|^2:00$/);
  }

  // The last vote reveals the cards, and the discussion is over
  await vote(alice, '3');
  await vote(bob, '5');
  await expectRevealed(everyone, {Alice: '3', Bob: '5'});
  for (const someone of everyone) {
    await expect(timerPill(someone), `${someone.name} sees the timer gone at the reveal`).toHaveCount(0);
    await expect(timerToggle(someone), `${someone.name} is not offered a timer while the cards are revealed`).toHaveCount(0);
    await expect(estimate(someone), `${someone.name} sees the estimate in the timer's place`).toBeVisible();
  }
  const revealed = await fetchRoom(baseUrl, roomId) as RoomDto & {votesShown?: boolean; timer?: unknown};
  expect(revealed.votesShown, 'the server has the cards revealed').toBe(true);
  expect(revealed.timer, 'the server dropped the timer with the reveal').toBeUndefined();

  // A timer asked for now is refused: the next round can have one
  const client = await Stomp.connect(baseUrl);
  try {
    client.send(`/app/room/${roomId}/timer/start`, {seconds: 60});
    await expect.poll(() => refusals(client).map(error => error.code), 'the server refuses a timer after the reveal')
      .toContain('CARDS_REVEALED');
    const refusal = refusals(client).find(error => error.code === 'CARDS_REVEALED');
    expect(refusal?.destination).toBe(`/app/room/${roomId}/timer/start`);
    console.log(`A timer after the reveal is refused with: ${refusal?.message}`);
  } finally {
    client.close();
  }
  for (const someone of everyone) {
    await expect(timerPill(someone), `${someone.name} sees no timer start`).toHaveCount(0);
  }

  // A new round brings the timer back, and it works
  await mainButton(alice).click();
  for (const someone of everyone) {
    await expect(mainButton(someone)).toHaveText('Voting...');
    await expect(estimate(someone), `${someone.name} sees the estimate go with the round`).toHaveCount(0);
  }
  await expectIdleTimer(everyone);
  await startTimer(bob, 1);
  for (const someone of everyone) {
    await expect(timeLeft(someone), `${someone.name} sees the new round's timer`).toHaveText(/^0:5\d$|^1:00$/);
  }
  await timerPill(alice).click();
  await expectIdleTimer(everyone);

  noConsoleErrors(everyone);
  await leaveAll(everyone, roomId);
});
