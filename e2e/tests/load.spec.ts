import {expect, test} from '@playwright/test';
import {baseUrl} from './people';
import {fetchRoom, RoomDto, Stomp} from './stomp';

// A busy hour at a moderate scale: several teams plan at once, each person with their own connection.
// Not a stress test: the numbers stay well below what would slow the server down for real users.
const rooms = Number(process.env.LOAD_ROOMS ?? 10);
const peoplePerRoom = Number(process.env.LOAD_PEOPLE_PER_ROOM ?? 8);
const cards = ['1', '2', '3', '5', '8', '13', '21', '?'];

interface Member {
  nickname: string;
  client: Stomp;
  events: {eventType: string; vote?: {nickname: string}; participant?: {nickname: string}}[];
}

interface Team {
  roomId: string;
  members: Member[];
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};

async function waitFor(condition: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return condition();
}

test(`${rooms} teams of ${peoplePerRoom} plan at the same time`, async () => {
  test.setTimeout(300_000);
  const teams: Team[] = [];

  try {
    // Everybody opens the site at about the same time
    let started = Date.now();
    const clients = await Promise.all(Array.from({length: rooms * peoplePerRoom}, () => Stomp.connect(baseUrl)));
    console.log(`${clients.length} connections opened in ${Date.now() - started} ms`);

    // One person per team creates the room
    started = Date.now();
    await Promise.all(Array.from({length: rooms}, async (_, index) => {
      const client = clients[index * peoplePerRoom];
      const created = new Promise<RoomDto>(resolve =>
        client.subscribe('/user/topic/room.created', frame => resolve(JSON.parse(frame.body))));
      client.send('/app/room/create', {
        name: `E2E load ${index + 1}`,
        deck: {cards},
        participants: [{nickname: 'Member1', watcher: false}]
      });
      const room = await created;
      const members = clients.slice(index * peoplePerRoom, (index + 1) * peoplePerRoom)
        .map((memberClient, position) => ({nickname: `Member${position + 1}`, client: memberClient, events: []} as Member));
      for (const member of members) {
        member.client.subscribe(`/topic/room.${room.id}`, frame => member.events.push(JSON.parse(frame.body)));
      }
      teams.push({roomId: room.id, members});
    }));
    console.log(`${rooms} rooms created in ${Date.now() - started} ms`);
    // The broker confirms subscriptions asynchronously
    await new Promise(resolve => setTimeout(resolve, 2_000));

    // The rest of each team joins by link, all at once
    started = Date.now();
    for (const team of teams) {
      for (const member of team.members.slice(1)) {
        member.client.send(`/app/room/${team.roomId}/participants/add`, {nickname: member.nickname, watcher: false});
      }
    }
    const joinsSeen = await waitFor(() => teams.every(team => team.members.every(member =>
      member.events.filter(event => event.eventType === 'PARTICIPANT_ADDED').length >= peoplePerRoom - 1)), 30_000);
    console.log(`Joins broadcast to everyone: ${joinsSeen} in ${Date.now() - started} ms`);
    const joinErrors = teams.flatMap(team => team.members.flatMap(member => member.client.errors));
    console.log(`Join errors: ${joinErrors.length} ${joinErrors.slice(0, 3).join(' | ')}`);

    let lostParticipants = 0;
    for (const team of teams) {
      const room = await fetchRoom(baseUrl, team.roomId);
      lostParticipants += peoplePerRoom - room.participants.length;
    }
    console.log(`Participants missing on the server after simultaneous joins: ${lostParticipants} of ${rooms * peoplePerRoom}`);
    expect.soft(lostParticipants, 'every person who joined is in the room on the server').toBe(0);

    // Everyone votes at the same moment
    started = Date.now();
    const voteLatencies: number[] = [];
    await Promise.all(teams.flatMap(team => team.members.map(async (member, position) => {
      const sent = Date.now();
      member.client.send(`/app/room/${team.roomId}/votes/add`, {nickname: member.nickname, card: cards[position % cards.length]});
      if (await waitFor(() => member.events.some(event => event.eventType === 'VOTE_ADDED' && event.vote?.nickname === member.nickname), 30_000)) {
        voteLatencies.push(Date.now() - sent);
      }
    })));
    console.log(`Votes: ${voteLatencies.length} of ${rooms * peoplePerRoom} confirmed in ${Date.now() - started} ms; ` +
      `own vote seen after p50 ${percentile(voteLatencies, 0.5)} ms, p95 ${percentile(voteLatencies, 0.95)} ms, max ${Math.max(...voteLatencies)} ms`);

    let lostVotes = 0;
    for (const team of teams) {
      const room = await fetchRoom(baseUrl, team.roomId);
      lostVotes += room.participants.length - (room.votes?.length ?? 0);
    }
    console.log(`Votes missing on the server after simultaneous voting: ${lostVotes}`);
    expect.soft(lostVotes, 'every vote is stored on the server').toBe(0);

    // Reveal and a new round
    started = Date.now();
    for (const team of teams) {
      team.members[0].client.send(`/app/room/${team.roomId}/votes/show`, team.roomId);
    }
    const revealed = await waitFor(() => teams.every(team => team.members.every(member =>
      member.events.some(event => event.eventType === 'SHOW_VOTES'))), 30_000);
    console.log(`Reveal reached everyone: ${revealed} in ${Date.now() - started} ms`);
    expect.soft(revealed, 'the reveal reaches everyone').toBe(true);
  } finally {
    // Everyone leaves at once; the last one out deletes the room
    for (const team of teams) {
      for (const member of team.members) {
        member.client.send(`/app/room/${team.roomId}/participants/remove`, member.nickname);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 5_000));
    let leftovers = 0;
    for (const team of teams) {
      // Simultaneous leaving can leave someone behind; remove them one by one so no test room stays
      for (let attempt = 0; attempt < 5; attempt++) {
        const room = await fetchRoom(baseUrl, team.roomId).catch(() => undefined);
        if (!room) {
          break;
        }
        if (attempt === 0) {
          leftovers += room.participants.length;
        }
        for (const participant of room.participants) {
          team.members[0].client.send(`/app/room/${team.roomId}/participants/remove`, participant.nickname);
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }
    }
    console.log(`People still in rooms after everyone left at once: ${leftovers}`);
    for (const team of teams) {
      team.members.forEach(member => member.client.close());
    }
    expect.soft(leftovers, 'leaving at the same time empties and deletes the rooms').toBe(0);
  }
});
