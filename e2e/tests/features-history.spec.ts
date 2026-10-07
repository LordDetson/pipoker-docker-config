import {readFileSync} from 'node:fs';
import {Download, expect, Locator, test} from '@playwright/test';
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
  testRoomName,
  timed,
  vote
} from './people';
import {fetchRoom, RoomDto} from './stomp';

// The estimate history: a button in the corner of the room opens a panel with every revealed round, newest first,
// and offers the rounds as a summary for the clipboard or as a file to download. Everyone in the room sees the
// same rounds, and the files are named after the room.
const deck = '1; 2; 3; 5; 8; 13; ?';

type StoredRoom = RoomDto & {history?: {revealedAt: string; votes: {nickname: string; card: string}[]}[]};

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const historyButton = (someone: Person): Locator => someone.page.locator('button.history-toggle');
const historyBadge = (someone: Person): Locator => historyButton(someone).locator('.badge');
const historyPanel = (someone: Person): Locator => someone.page.locator('aside#roomHistory');
const historyBackdrop = (someone: Person): Locator => someone.page.locator('.history-backdrop');
const emptyNote = (someone: Person): Locator => historyPanel(someone).locator('p.text-body-secondary');
const rounds = (someone: Person): Locator => historyPanel(someone).locator('ol > li.round');
// The copy button stands on its own in the actions row; the download button is inside its menu's wrapper
const copySummaryButton = (someone: Person): Locator => historyPanel(someone).locator('.history-actions > button');
const summaryLabel = (someone: Person): Locator => copySummaryButton(someone).locator('.summary-label > span:not(.invisible)');
const downloadToggle = (someone: Person): Locator => historyPanel(someone).locator('.history-export button.dropdown-toggle');
const downloadMenu = (someone: Person): Locator => historyPanel(someone).locator('.history-export .dropdown-menu');

// A round as the panel shows it: the label, the tally badges in deck order, the leading badge if one card won,
// the outcome line, and the votes in the order of the nicknames
interface ShownRound {
  label: string;
  tally: string[];
  leader?: string;
  outcome: string;
  votes: [string, string][];
}

const roundOfFives: ShownRound = {
  label: 'Round 1', tally: ['5 × 2'], leader: '5 × 2', outcome: 'Result: 5', votes: [['Alice', '5'], ['Bob', '5']]
};
const splitRound: ShownRound = {
  label: 'Round 2', tally: ['3 × 1', '8 × 1'], outcome: 'Votes split', votes: [['Alice', '3'], ['Bob', '8']]
};

async function openHistory(someone: Person) {
  await historyButton(someone).click();
  await expect(historyPanel(someone), `${someone.name} sees the history panel open`).toHaveClass(/\bopen\b/);
  await expect(historyButton(someone)).toHaveAttribute('aria-expanded', 'true');
  await expect(historyBackdrop(someone)).toBeVisible();
}

// The panel slides out and is hidden a moment later; the backdrop goes at once
async function expectHistoryClosed(someone: Person) {
  await expect(historyPanel(someone), `${someone.name} sees the history panel closed`).not.toHaveClass(/\bopen\b/);
  await expect(historyButton(someone)).toHaveAttribute('aria-expanded', 'false');
  await expect(historyBackdrop(someone)).toHaveCount(0);
  await expect(historyPanel(someone), 'the closed panel stays on the page out of sight').toHaveCount(1);
  await expect(historyPanel(someone)).toBeHidden();
}

async function closeHistory(someone: Person) {
  await someone.page.keyboard.press('Escape');
  await expectHistoryClosed(someone);
}

// Everyone opens the panel and finds these rounds in it, newest first, then closes it
async function expectHistory(everyone: Person[], shown: ShownRound[]) {
  for (const someone of everyone) {
    await expect(historyBadge(someone), `${someone.name} sees how many rounds the history holds`).toHaveText(String(shown.length));
    await openHistory(someone);
    await expect(rounds(someone), `${someone.name} sees every revealed round`).toHaveCount(shown.length);
    await expect(rounds(someone).locator('.round-head .fw-medium'), `${someone.name} sees the rounds newest first`)
      .toHaveText(shown.map(round => round.label));
    for (const [index, round] of shown.entries()) {
      const item = rounds(someone).nth(index);
      await expect(item.locator('.tally .badge'), `${someone.name} sees the tally of ${round.label}`).toHaveText(round.tally);
      if (round.leader) {
        await expect(item.locator('.tally .badge.leader'), 'the card most people picked stands out').toHaveText(round.leader);
      } else {
        await expect(item.locator('.tally .badge.leader'), 'no card led the vote').toHaveCount(0);
      }
      await expect(item.locator('.result')).toHaveText(round.outcome);
      await expect(item.locator('.estimate'), 'nobody accepted an estimate').toHaveCount(0);
      await expect(item.locator('.votes li .text-truncate'), 'the votes are listed by nickname')
        .toHaveText(round.votes.map(([nickname]) => nickname));
      await expect(item.locator('.votes li .card-value')).toHaveText(round.votes.map(([, card]) => card));
      await expect(item.locator('.round-when time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
      await expect(item.locator('.round-when time'), 'the time of the reveal in hours and minutes').toHaveText(/^\d{2}:\d{2}(\s[AP]M)?$/);
    }
    await closeHistory(someone);
  }
}

// Round 1: both pick 5, the second vote reveals the cards. Round 2: Bob picks 8 and Alice 3, so the votes split.
async function playTwoRounds(alice: Person, bob: Person) {
  const everyone = [alice, bob];
  await vote(alice, '5');
  await vote(bob, '5');
  await expectRevealed(everyone, {Alice: '5', Bob: '5'});
  await mainButton(alice).click();
  for (const someone of everyone) {
    await expect(mainButton(someone)).toHaveText('Voting...');
  }
  // Bob votes first, so a list by nickname is not just the order of the votes
  await vote(bob, '8');
  await vote(alice, '3');
  await expectRevealed(everyone, {Alice: '3', Bob: '8'});
}

// Picks a format from the Download menu of the open panel and returns the file the browser received
async function downloadHistory(someone: Person, format: string): Promise<Download> {
  await downloadToggle(someone).click();
  await expect(downloadMenu(someone), 'the Download menu opens').toHaveClass(/\bshow\b/);
  const download = someone.page.waitForEvent('download');
  await downloadMenu(someone).getByRole('button', {name: format, exact: true}).click();
  return download;
}

// The text of the summary and of the text file, without the line that says when it was made
function withoutDownloadedLine(lines: string[]): string[] {
  expect(lines[1], 'the second line says when the text was made').toMatch(/^Downloaded \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  return lines.filter((line, index) => index !== 1);
}

test('the history is empty before the first reveal, and the panel closes with the cross, a click beside it and Escape', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const everyone = [alice, bob];
  const roomId = await createRoom(alice, {deck});
  await joinRoom(bob, roomId);
  await expectSeats(everyone, ['Alice', 'Bob']);

  // Nothing has been revealed yet, so the button carries no count and the panel is out of sight
  await expect(historyButton(alice)).toHaveText('History');
  await expect(historyBadge(alice)).toHaveCount(0);
  await expectHistoryClosed(alice);

  await openHistory(alice);
  await expect(historyPanel(alice).locator('#roomHistoryTitle')).toHaveText('History');
  await expect(emptyNote(alice)).toHaveText('Revealed rounds will appear here.');
  await expect(rounds(alice)).toHaveCount(0);
  await expect(historyPanel(alice).locator('.history-actions'), 'nothing to copy or download yet').toHaveCount(0);

  // The cross in the panel's head
  const cross = historyPanel(alice).locator('button.history-close');
  await expect(cross).toHaveAttribute('title', 'Close the history');
  await expect(cross).toHaveAccessibleName('Close the history');
  await cross.click();
  await expectHistoryClosed(alice);

  // A click on the room beside the panel
  await openHistory(alice);
  await historyBackdrop(alice).click({position: {x: 10, y: 10}});
  await expectHistoryClosed(alice);

  // The Escape key
  await openHistory(alice);
  await alice.page.keyboard.press('Escape');
  await expectHistoryClosed(alice);

  // A vote that does not reveal the cards adds nothing to the history on anyone's screen
  await vote(alice, '5');
  await expectVoted(everyone, 'Alice');
  await expect(historyBadge(bob)).toHaveCount(0);
  await openHistory(bob);
  await expect(emptyNote(bob)).toHaveText('Revealed rounds will appear here.');
  await expect(rounds(bob)).toHaveCount(0);
  await closeHistory(bob);

  noConsoleErrors(everyone);
  await leaveAll(everyone, roomId);
});

test('two revealed rounds are listed newest first on every screen, with the tallies and the votes by nickname', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const everyone = [alice, bob];
  const roomId = await createRoom(alice, {deck});
  await joinRoom(bob, roomId);
  await expectSeats(everyone, ['Alice', 'Bob']);

  // Round 1: everyone picks 5, and the reveal puts the round into everyone's history
  await vote(alice, '5');
  await vote(bob, '5');
  await expectRevealed(everyone, {Alice: '5', Bob: '5'});
  await timed('the revealed round shows up in the history on every screen', () => expectHistory(everyone, [roundOfFives]));

  // Round 2: a new round adds nothing until its cards are revealed
  await mainButton(alice).click();
  for (const someone of everyone) {
    await expect(mainButton(someone)).toHaveText('Voting...');
  }
  await expect(historyBadge(bob)).toHaveText('1');
  await vote(bob, '8');
  // Bob reads the history while the round is still on: the reveal reaches the open panel as it happens
  await openHistory(bob);
  await expect(rounds(bob)).toHaveCount(1);
  await vote(alice, '3');
  await expect(rounds(bob), 'the open panel gets the new round as the cards are revealed').toHaveCount(2);
  await expect(historyBadge(bob)).toHaveText('2');
  await closeHistory(bob);
  await expectRevealed(everyone, {Alice: '3', Bob: '8'});

  await expectHistory(everyone, [splitRound, roundOfFives]);
  const room: StoredRoom = await fetchRoom(baseUrl, roomId);
  expect(room.history?.length, 'the server keeps both rounds').toBe(2);
  expect(room.history?.map(round => round.votes), 'oldest first, the votes by nickname').toEqual([
    [{nickname: 'Alice', card: '5'}, {nickname: 'Bob', card: '5'}],
    [{nickname: 'Alice', card: '3'}, {nickname: 'Bob', card: '8'}]
  ]);

  noConsoleErrors(everyone);
  await leaveAll(everyone, roomId);
});

test('someone downloads the history as text, CSV, Excel and XML files named after the room', async ({browser}) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  const everyone = [alice, bob];
  const roomName = testRoomName();
  const roomId = await createRoom(alice, {deck, roomName});
  await joinRoom(bob, roomId);
  await playTwoRounds(alice, bob);
  // A file name can't hold the colons of the room's name, so they become spaces
  const fileRoomName = roomName.replace(/[\\/:*?"<>|]/g, ' ');
  const fileNamed = (extension: string) =>
    new RegExp(`^${escape(fileRoomName)} history \\d{4}-\\d{2}-\\d{2} \\d{2}-\\d{2}\\.${extension}$`);

  await openHistory(alice);
  await expect(downloadToggle(alice)).toHaveText('Download');
  await downloadToggle(alice).click();
  await expect(downloadMenu(alice)).toHaveClass(/\bshow\b/);
  await expect(downloadMenu(alice).locator('button.dropdown-item')).toHaveText(['Excel (.xlsx)', 'CSV (.csv)', 'Text (.txt)', 'XML (.xml)']);
  await downloadToggle(alice).click();
  await expect(downloadMenu(alice)).not.toHaveClass(/\bshow\b/);

  // The text file reads like the panel, oldest round first, and is named after the room and the moment
  const textFile = await timed('download the text file', () => downloadHistory(alice, 'Text (.txt)'));
  expect(textFile.suggestedFilename()).toMatch(fileNamed('txt'));
  const textLines = readFileSync(await textFile.path(), 'utf8').split('\r\n');
  expect(textLines[0]).toBe(`PiPoker estimate history: ${roomName}`);
  expect(textLines[1]).toMatch(/^Downloaded \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  expect(textLines.slice(2)).toEqual([
    '',
    expect.stringMatching(/^Round 1 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/),
    'Result: 5',
    '  Alice: 5',
    '  Bob: 5',
    '',
    expect.stringMatching(/^Round 2 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/),
    'Votes split',
    '  Alice: 3',
    '  Bob: 8',
    ''
  ]);
  const downloadedAt = textLines[1].replace('Downloaded ', '');
  expect(textFile.suggestedFilename(), 'the file is named after the moment it says it was downloaded')
    .toBe(`${fileRoomName} history ${downloadedAt.replace(':', '-')}.txt`);

  // The CSV file: a byte order mark for Excel, a header, then every vote on its own row next to its round
  const csvFile = await downloadHistory(alice, 'CSV (.csv)');
  expect(csvFile.suggestedFilename()).toMatch(fileNamed('csv'));
  const csv = readFileSync(await csvFile.path(), 'utf8');
  expect(csv.startsWith('﻿'), 'the CSV starts with the byte order mark').toBe(true);
  const time = '\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}';
  expect(csv.slice(1).split('\r\n')).toEqual([
    'Round,Task,Task link,Time,Accepted estimate,Vote result,Participant,Card',
    expect.stringMatching(new RegExp(`^1,,,${time},,5,Alice,5$`)),
    expect.stringMatching(new RegExp(`^1,,,${time},,5,Bob,5$`)),
    expect.stringMatching(new RegExp(`^2,,,${time},,Votes split,Alice,3$`)),
    expect.stringMatching(new RegExp(`^2,,,${time},,Votes split,Bob,8$`)),
    ''
  ]);

  // The Excel file is a ZIP archive with the parts of a workbook
  const excelFile = await downloadHistory(alice, 'Excel (.xlsx)');
  expect(excelFile.suggestedFilename()).toMatch(fileNamed('xlsx'));
  const excel = readFileSync(await excelFile.path());
  expect(excel.subarray(0, 2).toString('latin1'), 'the Excel file is a ZIP archive').toBe('PK');
  expect(excel.includes('[Content_Types].xml'), 'the archive holds a workbook').toBe(true);
  expect(excel.includes('xl/worksheets/sheet1.xml')).toBe(true);

  // The XML file: the rounds as the server keeps them, a round with a winning card carries it
  const xmlFile = await downloadHistory(alice, 'XML (.xml)');
  expect(xmlFile.suggestedFilename()).toMatch(fileNamed('xml'));
  const xml = readFileSync(await xmlFile.path(), 'utf8');
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'the XML file starts with its declaration').toBe(true);
  expect(xml).toContain(`<history room="${roomName}" downloadedAt="`);
  expect(xml).toMatch(/<round number="1" revealedAt="[^"]+" result="5">\s*<vote participant="Alice" card="5"\/>\s*<vote participant="Bob" card="5"\/>\s*<\/round>/);
  expect(xml).toMatch(/<round number="2" revealedAt="[^"]+">\s*<vote participant="Alice" card="3"\/>\s*<vote participant="Bob" card="8"\/>\s*<\/round>/);
  expect(xml.trimEnd().endsWith('</history>')).toBe(true);

  await closeHistory(alice);
  noConsoleErrors(everyone);
  await leaveAll(everyone, roomId);
});

test('someone copies the summary and gets the text of the text file on the clipboard', async ({browser, browserName}) => {
  test.skip(browserName !== 'chromium', 'Only Chromium lets a test read the clipboard');
  const alice = await person(browser, 'Alice', {permissions: ['clipboard-read', 'clipboard-write']});
  const bob = await person(browser, 'Bob');
  const everyone = [alice, bob];
  const roomId = await createRoom(alice, {deck});
  await joinRoom(bob, roomId);
  await playTwoRounds(alice, bob);

  await openHistory(alice);
  await expect(copySummaryButton(alice)).toHaveAccessibleName('Copy summary');
  await expect(summaryLabel(alice)).toHaveText('Copy summary');
  await timed('copy the summary', async () => {
    await copySummaryButton(alice).click();
    // The button says so for a moment (1.5 s), then offers to copy again
    await expect(copySummaryButton(alice)).toHaveAccessibleName('Copied');
  });
  await expect(summaryLabel(alice)).toHaveText('Copied');
  const summary = await alice.page.evaluate(() => navigator.clipboard.readText());
  await expect(copySummaryButton(alice)).toHaveAccessibleName('Copy summary');
  await expect(summaryLabel(alice)).toHaveText('Copy summary');

  // The summary is the text file, with the line breaks of the clipboard instead of a Windows text file's
  const textFile = await downloadHistory(alice, 'Text (.txt)');
  const text = readFileSync(await textFile.path(), 'utf8');
  expect(summary.startsWith('PiPoker estimate history: E2E '), 'the summary starts with the title').toBe(true);
  expect(summary).toContain('\nRound 1 · ');
  expect(summary).toContain('\nResult: 5\n  Alice: 5\n  Bob: 5\n');
  expect(summary).toContain('\nRound 2 · ');
  expect(summary).toContain('\nVotes split\n  Alice: 3\n  Bob: 8\n');
  expect(summary).not.toContain('\r');
  // Copied and downloaded a moment apart, so only the minute of the second line may differ
  expect(withoutDownloadedLine(summary.split('\n'))).toEqual(withoutDownloadedLine(text.split('\r\n')));

  await closeHistory(alice);
  noConsoleErrors(everyone);
  await leaveAll(everyone, roomId);
});
