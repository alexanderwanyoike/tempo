import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  carVariants,
  type CarVariant,
  type ClientMessage,
  type PickupSpawnState,
  type RaceEvent,
  type RacePlayerState,
  type RaceResultEntry,
  type RaceResults,
  type RaceSetup,
  type RoomPhase,
  type RoomDirectoryEntry,
  type RoomPlayerState,
  type ServerMessage,
} from "../../shared/network-types.js";
import { buildCheckpointUs, checkpointIndexForU } from "../../shared/race-utils.js";
import { songDefinitionSchema, type SongDefinition } from "../../shared/song-schema.js";
import type { Track } from "../client/runtime/track-builder.js";
import { TrackGenerator } from "../client/runtime/track-generator.js";
import {
  RACE_SIM,
  buildPickups as simBuildPickups,
  maybeCollectPickups as simMaybeCollectPickups,
  recomputePlacements as simRecomputePlacements,
  resolveFire as simResolveFire,
  resolveShield as simResolveShield,
  processRespawns as simProcessRespawns,
} from "../../shared/race-sim.js";
import { serverConfig } from "./config.js";

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("ok");
    return;
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Tempo realtime server");
});
const wss = new WebSocketServer({ server });

const DEFAULT_SETUP: RaceSetup = {
  songId: "the-prodigy-firestarter",
  fictionId: 1,
  seed: 2013961555,
  playerCap: 4,
};

const START_TRACK_U = RACE_SIM.START_TRACK_U;
const PICKUP_WORLD_RADIUS = RACE_SIM.PICKUP_WORLD_RADIUS;
const NOMINAL_HALF_WIDTH = RACE_SIM.NOMINAL_HALF_WIDTH;
const VEHICLE_HOVER_HEIGHT = RACE_SIM.VEHICLE_HOVER_HEIGHT;
const LOBBY_PRELOAD_TIMEOUT_MS = 120000;
const SNAPSHOT_INTERVAL_MS = 100;
const COUNTDOWN_MS = 4000;
const PLAYER_NAME_MIN_LENGTH = 2;
const PLAYER_NAME_MAX_LENGTH = 18;

type CatalogEntry = {
  id: string;
  songPath: string;
};

type CatalogFile = {
  songs: CatalogEntry[];
};

type ClientConnection = {
  clientId: string;
  name: string;
  socket: WebSocket;
  roomCode: string | null;
};

type InternalRacePlayer = RacePlayerState & {
  respawnAt: number;
  laneOffset: number;
  respawnTrackU: number;
  respawnLateralOffset: number;
};

type InternalPlayer = {
  clientId: string;
  name: string;
  socket: WebSocket;
  carVariant: CarVariant;
  connected: boolean;
  ready: boolean;
  preload: {
    sceneReady: boolean;
    audioReady: boolean;
  };
  isActiveRacer: boolean;
};

type Room = {
  code: string;
  name: string;
  hostId: string;
  phase: RoomPhase;
  setup: RaceSetup;
  players: Map<string, InternalPlayer>;
  checkpointUs: number[];
  pickups: PickupSpawnState[];
  racePlayers: Map<string, InternalRacePlayer>;
  song: SongDefinition | null;
  collisionTrack: Track | null;
  raceStartAt: number;
  songEndAt: number;
  stagingOpenedAt: number;
  preloadDeadlineAt: number;
  stagingTimer: NodeJS.Timeout | null;
  snapshotInterval: NodeJS.Timeout | null;
  countdownTimer: NodeJS.Timeout | null;
  eventSequence: number;
};

const clients = new Map<WebSocket, ClientConnection>();
const rooms = new Map<string, Room>();
let pilotSequence = 0;

wss.on("connection", (socket) => {
  const clientId = randomId();
  const connection: ClientConnection = {
    clientId,
    name: `Pilot ${++pilotSequence}`,
    socket,
    roomCode: null,
  };
  clients.set(socket, connection);

  send(socket, {
    type: "server.ready",
    clientId,
    message: "Tempo room server online.",
    serverTime: Date.now(),
  });
  sendDirectory(socket);

  socket.on("message", (message) => {
    void handleMessage(connection, message.toString()).catch((error) => {
      console.error("Message handling failed:", error);
      sendError(socket, "Server failed to process the request.");
    });
  });

  socket.on("close", () => {
    handleDisconnect(connection);
    clients.delete(socket);
  });
});

server.listen(serverConfig.port, () => {
  console.log(`Tempo server listening on :${serverConfig.port}`);
});

async function handleMessage(connection: ClientConnection, raw: string): Promise<void> {
  let message: ClientMessage;
  try {
    message = JSON.parse(raw) as ClientMessage;
  } catch {
    sendError(connection.socket, "Malformed JSON payload.");
    return;
  }

  switch (message.type) {
    case "room.create":
      await leaveCurrentRoom(connection);
      createRoom(connection, message.setup, message.carVariant, message.roomName);
      return;
    case "room.join":
      await leaveCurrentRoom(connection);
      joinRoom(connection, message.roomCode, message.carVariant);
      return;
    case "room.leave":
      await leaveCurrentRoom(connection);
      return;
    case "room.directory.request":
      sendDirectory(connection.socket);
      return;
    case "room.updateSetup":
      updateRoomSetup(connection, message.setup);
      return;
    case "room.selectCar":
      updateCarVariant(connection, message.carVariant);
      return;
    case "room.setPlayerName":
      updatePlayerName(connection, message.name);
      return;
    case "room.setReady":
      setReady(connection, message.ready);
      return;
    case "room.start":
      await startRoomRace(connection);
      return;
    case "room.preload":
      updatePreload(connection, message.sceneReady, message.audioReady);
      return;
    case "race.report":
      updateRaceReport(connection, message.trackU, message.lateralOffset, message.speed);
      return;
    case "race.fire":
      handleFire(connection);
      return;
    case "race.shield":
      handleShield(connection);
      return;
    case "ping":
      send(connection.socket, {
        type: "pong",
        sentAt: message.sentAt,
        serverTime: Date.now(),
      });
      return;
  }
}

function createRoom(connection: ClientConnection, setup: RaceSetup, carVariant: CarVariant, roomName: string): void {
  const room = makeRoom({
    code: createRoomCode(),
    name: sanitizeRoomName(connection, setup.songId, roomName),
    hostId: connection.clientId,
    phase: "lobby",
    setup: sanitizeSetup(setup),
  });

  room.players.set(connection.clientId, makePlayer(connection, carVariant));
  rooms.set(room.code, room);
  connection.roomCode = room.code;
  broadcastRoomState(room);
  broadcastDirectory();
}

function joinRoom(connection: ClientConnection, roomCode: string, carVariant: CarVariant): void {
  const room = rooms.get(roomCode.trim().toUpperCase());
  if (!room) {
    sendError(connection.socket, "Room code not found.");
    return;
  }
  if (room.players.size >= room.setup.playerCap) {
    sendError(connection.socket, "Room is full.");
    return;
  }
  if (room.phase !== "lobby") {
    sendError(connection.socket, "Race already staging or running.");
    return;
  }

  room.players.set(connection.clientId, makePlayer(connection, carVariant));
  connection.roomCode = room.code;
  broadcastRoomState(room);
  broadcastDirectory();
}

async function leaveCurrentRoom(connection: ClientConnection): Promise<void> {
  if (!connection.roomCode) return;
  const room = rooms.get(connection.roomCode);
  connection.roomCode = null;
  if (!room) return;

  room.players.delete(connection.clientId);
  room.racePlayers.delete(connection.clientId);

  if (room.hostId === connection.clientId) {
    room.hostId = room.players.keys().next().value ?? "";
  }

  if (room.players.size === 0) {
    disposeRoom(room);
    rooms.delete(room.code);
    broadcastDirectory();
    return;
  }

  if (!room.players.has(room.hostId)) {
    room.hostId = room.players.keys().next().value ?? "";
  }

  if (room.phase !== "lobby" && activeRacerCount(room) < 2) {
    if (room.phase === "running") {
      endRace(room);
    } else {
      returnRoomToLobby(room);
    }
    return;
  }

  broadcastRoomState(room);
  broadcastDirectory();
  if (room.phase === "running" || room.phase === "countdown" || room.phase === "staging") {
    broadcastRaceSnapshot(room);
  }
}

function updateRoomSetup(connection: ClientConnection, setup: RaceSetup): void {
  const room = getRoomFor(connection);
  if (!room) return;
  if (room.hostId !== connection.clientId) {
    sendError(connection.socket, "Only the host can change race setup.");
    return;
  }
  if (room.phase !== "lobby") {
    sendError(connection.socket, "Cannot change setup after staging begins.");
    return;
  }
  room.setup = sanitizeSetup(setup);
  broadcastRoomState(room);
  broadcastDirectory();
}

function updateCarVariant(connection: ClientConnection, carVariant: CarVariant): void {
  const room = getRoomFor(connection);
  if (!room) return;
  const player = room.players.get(connection.clientId);
  if (!player) return;
  player.carVariant = sanitizeCarVariant(carVariant);
  broadcastRoomState(room);
}

function updatePlayerName(connection: ClientConnection, requestedName: string): void {
  const nextName = sanitizePlayerName(requestedName, connection.name);
  if (nextName === connection.name) return;
  connection.name = nextName;

  const room = getRoomFor(connection);
  if (!room) return;
  const player = room.players.get(connection.clientId);
  if (!player) return;
  player.name = nextName;
  broadcastRoomState(room);
  broadcastDirectory();
}

function setReady(connection: ClientConnection, ready: boolean): void {
  const room = getRoomFor(connection);
  if (!room) return;
  if (room.phase !== "lobby") {
    sendError(connection.socket, "Ready state is only editable in lobby.");
    return;
  }
  const player = room.players.get(connection.clientId);
  if (!player) return;
  player.ready = ready;
  broadcastRoomState(room);
}

async function startRoomRace(connection: ClientConnection): Promise<void> {
  const room = getRoomFor(connection);
  if (!room) return;
  if (room.hostId !== connection.clientId) {
    sendError(connection.socket, "Only the host can start the room.");
    return;
  }
  if (room.phase !== "lobby") {
    sendError(connection.socket, "Room already staging or running.");
    return;
  }

  const activePlayers = [...room.players.values()].filter((player) => player.connected && player.ready);
  if (activePlayers.length < 2) {
    sendError(connection.socket, "Need at least two ready racers.");
    return;
  }

  const song = await loadSongById(room.setup.songId);
  room.song = song;
  room.collisionTrack = new TrackGenerator(song, room.setup.seed);
  room.phase = "staging";
  room.checkpointUs = buildCheckpointUs(song);
  room.pickups = buildPickups(room.collisionTrack, room.setup.seed);
  room.stagingOpenedAt = Date.now();
  room.preloadDeadlineAt = room.stagingOpenedAt + LOBBY_PRELOAD_TIMEOUT_MS;
  room.raceStartAt = 0;
  room.songEndAt = 0;
  room.eventSequence = 0;
  room.racePlayers.clear();

  for (const player of room.players.values()) {
    player.preload.sceneReady = false;
    player.preload.audioReady = false;
    player.isActiveRacer = player.connected && player.ready;
  }

  const laneOffsets = buildLaneOffsets(activePlayers.length);
  activePlayers.forEach((player, index) => {
    room.racePlayers.set(player.clientId, {
      clientId: player.clientId,
      trackU: START_TRACK_U,
      lateralOffset: laneOffsets[index] ?? 0,
      speed: 0,
      checkpointIndex: 0,
      placement: index + 1,
      offensiveItem: null,
      defensiveItem: null,
      shieldUntil: 0,
      takenDownUntil: 0,
      respawnRevision: 0,
      finishedAt: null,
      takedowns: 0,
      respawnAt: 0,
      laneOffset: laneOffsets[index] ?? 0,
      respawnTrackU: START_TRACK_U,
      respawnLateralOffset: laneOffsets[index] ?? 0,
    });
  });

  broadcastRoomState(room);
  broadcastRaceSnapshot(room);
  broadcastDirectory();
  if (room.stagingTimer) clearTimeout(room.stagingTimer);
  room.stagingTimer = setTimeout(() => {
    room.stagingTimer = null;
    if (room.phase !== "staging") return;
    pruneSlowPlayers(room);
    if (room.phase === "staging") {
      if (activeRacerCount(room) >= 2) maybeStartCountdownWhenEligible(room);
      else returnRoomToLobby(room);
    }
  }, LOBBY_PRELOAD_TIMEOUT_MS);
}

function updatePreload(connection: ClientConnection, sceneReady?: boolean, audioReady?: boolean): void {
  const room = getRoomFor(connection);
  if (!room || room.phase !== "staging") return;
  const player = room.players.get(connection.clientId);
  if (!player || !player.isActiveRacer) return;

  if (typeof sceneReady === "boolean") player.preload.sceneReady = sceneReady;
  if (typeof audioReady === "boolean") player.preload.audioReady = audioReady;
  broadcastRoomState(room);
  broadcastRaceSnapshot(room);
  broadcastDirectory();

  if (Date.now() > room.preloadDeadlineAt) {
    pruneSlowPlayers(room);
  }

  const ready = [...room.players.values()].filter((candidate) => candidate.isActiveRacer)
    .every((candidate) => candidate.preload.sceneReady && candidate.preload.audioReady);

  if (!ready) return;
  maybeStartCountdownWhenEligible(room);
}

function maybeStartCountdownWhenEligible(room: Room): void {
  if (room.phase !== "staging") return;
  if (activeRacerCount(room) < 2) {
    returnRoomToLobby(room);
    return;
  }

  startCountdown(room);
}

function startCountdown(room: Room): void {
  if (room.phase !== "staging") return;
  if (activeRacerCount(room) < 2) {
    returnRoomToLobby(room);
    return;
  }

  if (room.stagingTimer) {
    clearTimeout(room.stagingTimer);
    room.stagingTimer = null;
  }
  room.phase = "countdown";
  const startAt = Date.now() + COUNTDOWN_MS;
  room.raceStartAt = startAt;
  room.songEndAt = room.song ? startAt + Math.ceil(room.song.duration * 1000) : 0;
  broadcastRoomState(room);
  broadcastRaceSnapshot(room);
  broadcastDirectory();
  broadcast(room, {
    type: "race.countdown",
    startAt,
    serverTime: Date.now(),
  });

  if (room.countdownTimer) clearTimeout(room.countdownTimer);
  room.countdownTimer = setTimeout(() => {
    room.countdownTimer = null;
    if (room.phase !== "countdown") return;
    room.phase = "running";
    broadcastRoomState(room);
    broadcastDirectory();
    startSnapshotLoop(room);
  }, COUNTDOWN_MS);
}

function updateRaceReport(connection: ClientConnection, trackU: number, lateralOffset: number, speed: number): void {
  const room = getRoomFor(connection);
  if (!room || room.phase !== "running") return;
  if (hasSongEnded(room, Date.now())) {
    endRace(room);
    return;
  }
  const player = room.players.get(connection.clientId);
  const racePlayer = room.racePlayers.get(connection.clientId);
  if (!player || !racePlayer || !player.isActiveRacer) return;

  const now = Date.now();
  if (racePlayer.finishedAt !== null || racePlayer.takenDownUntil > now) {
    return;
  }

  const previousTrackU = racePlayer.trackU;
  const previousLateralOffset = racePlayer.lateralOffset;
  const floorU = racePlayer.checkpointIndex > 0
    ? room.checkpointUs[racePlayer.checkpointIndex - 1] ?? START_TRACK_U
    : START_TRACK_U;
  racePlayer.trackU = Math.max(floorU, clamp(trackU, START_TRACK_U, 0.9995));
  racePlayer.lateralOffset = clamp(lateralOffset, -14, 14);
  racePlayer.speed = clamp(speed, 0, 140);
  racePlayer.checkpointIndex = Math.max(
    racePlayer.checkpointIndex,
    checkpointIndexForU(racePlayer.trackU, room.checkpointUs),
  );

  maybeCollectPickups(room, racePlayer, previousTrackU, previousLateralOffset, now);

  if (racePlayer.trackU >= 0.999 && racePlayer.finishedAt === null) {
    racePlayer.finishedAt = now;
    recomputePlacements(room);
    const placement = room.racePlayers.get(connection.clientId)?.placement ?? 1;
    broadcastEvent(room, {
      id: nextEventId(room),
      kind: "finish",
      actorId: connection.clientId,
      placement,
      finishTimeMs: Math.max(0, now - room.raceStartAt),
      at: now,
    });
    endRace(room);
    return;
  }

  recomputePlacements(room);
}

function handleFire(connection: ClientConnection): void {
  const room = getRoomFor(connection);
  if (!room || room.phase !== "running") return;
  if (hasSongEnded(room, Date.now())) {
    endRace(room);
    return;
  }
  const attacker = room.racePlayers.get(connection.clientId);
  if (!attacker || attacker.offensiveItem !== "missile") return;
  const now = Date.now();
  const events = simResolveFire(room.racePlayers.values(), attacker, now);
  for (const ev of events) {
    broadcastEvent(room, { ...ev, id: nextEventId(room), at: now } as RaceEvent);
  }
}

function handleShield(connection: ClientConnection): void {
  const room = getRoomFor(connection);
  if (!room || room.phase !== "running") return;
  if (hasSongEnded(room, Date.now())) {
    endRace(room);
    return;
  }
  const racePlayer = room.racePlayers.get(connection.clientId);
  if (!racePlayer) return;
  const now = Date.now();
  const ev = simResolveShield(racePlayer, now);
  if (ev) {
    broadcastEvent(room, { ...ev, id: nextEventId(room), at: now } as RaceEvent);
  }
}

function startSnapshotLoop(room: Room): void {
  if (room.snapshotInterval) clearInterval(room.snapshotInterval);
  room.snapshotInterval = setInterval(() => {
    if (room.phase !== "running") return;
    tickRace(room);
  }, SNAPSHOT_INTERVAL_MS);
}

function tickRace(room: Room): void {
  const now = Date.now();
  if (hasSongEnded(room, now)) {
    endRace(room);
    return;
  }

  const respawnEvents = simProcessRespawns(room.racePlayers.values(), now);
  for (const ev of respawnEvents) {
    broadcastEvent(room, { ...ev, id: nextEventId(room), at: now });
  }

  recomputePlacements(room);
  broadcastRaceSnapshot(room);
}

function endRace(room: Room): void {
  if (room.phase !== "running" && room.phase !== "countdown" && room.phase !== "staging") return;
  const results = buildResults(room);
  clearTimers(room);
  broadcast(room, {
    type: "race.results",
    results,
    serverTime: Date.now(),
  });
  returnRoomToLobby(room);
}

function returnRoomToLobby(room: Room): void {
  clearTimers(room);
  room.phase = "lobby";
  room.song = null;
  room.collisionTrack = null;
  room.checkpointUs = [];
  room.pickups = [];
  room.racePlayers.clear();
  room.raceStartAt = 0;
  room.songEndAt = 0;
  room.stagingOpenedAt = 0;
  room.preloadDeadlineAt = 0;
  for (const player of room.players.values()) {
    player.ready = false;
    player.isActiveRacer = false;
    player.preload.sceneReady = false;
    player.preload.audioReady = false;
  }
  broadcastRoomState(room);
  broadcastDirectory();
}

function maybeCollectPickups(
  room: Room,
  racePlayer: InternalRacePlayer,
  previousTrackU: number,
  previousLateralOffset: number,
  now: number,
): void {
  const track = room.collisionTrack;
  if (!track) return;
  const ev = simMaybeCollectPickups(track, room.pickups, racePlayer, previousTrackU, previousLateralOffset);
  if (ev) {
    broadcastEvent(room, { ...ev, id: nextEventId(room), at: now });
  }
}

function recomputePlacements(room: Room): void {
  simRecomputePlacements([...room.racePlayers.values()]);
}

function buildResults(room: Room): RaceResults {
  recomputePlacements(room);
  const entries = [...room.racePlayers.values()]
    .map<RaceResultEntry>((racePlayer) => {
      const player = room.players.get(racePlayer.clientId);
      return {
        clientId: racePlayer.clientId,
        name: player?.name ?? racePlayer.clientId,
        placement: racePlayer.placement,
        status: racePlayer.finishedAt !== null ? "finished" : "dnf",
        finishTimeMs: racePlayer.finishedAt !== null ? Math.max(0, racePlayer.finishedAt - room.raceStartAt) : null,
        takedowns: racePlayer.takedowns,
      };
    })
    .sort((a, b) => a.placement - b.placement);

  return {
    roomCode: room.code,
    setup: room.setup,
    entries,
  };
}

function pruneSlowPlayers(room: Room): void {
  for (const player of room.players.values()) {
    if (!player.isActiveRacer) continue;
    if (player.preload.sceneReady && player.preload.audioReady) continue;
    player.isActiveRacer = false;
    room.racePlayers.delete(player.clientId);
  }
  if (activeRacerCount(room) < 2) {
    broadcast(room, {
      type: "room.error",
      message: "Not enough racers finished loading in time. Returned to lobby.",
      serverTime: Date.now(),
    });
    returnRoomToLobby(room);
  }
}

function broadcastRoomState(room: Room): void {
  broadcast(room, {
    type: "room.state",
    roomCode: room.code,
    roomName: room.name,
    phase: room.phase,
    hostId: room.hostId,
    setup: room.setup,
    players: [...room.players.values()].map((player): RoomPlayerState => ({
      clientId: player.clientId,
      name: player.name,
      carVariant: player.carVariant,
      connected: player.connected,
      ready: player.ready,
      preload: { ...player.preload },
      isHost: player.clientId === room.hostId,
      isActiveRacer: player.isActiveRacer,
    })),
    serverTime: Date.now(),
  });
}

function broadcastRaceSnapshot(room: Room): void {
  broadcast(room, {
    type: "race.snapshot",
    players: [...room.racePlayers.values()].map((player) => ({
      clientId: player.clientId,
      trackU: player.trackU,
      lateralOffset: player.lateralOffset,
      speed: player.speed,
      checkpointIndex: player.checkpointIndex,
      placement: player.placement,
      offensiveItem: player.offensiveItem,
      defensiveItem: player.defensiveItem,
      shieldUntil: player.shieldUntil,
      takenDownUntil: player.takenDownUntil,
      respawnRevision: player.respawnRevision,
      finishedAt: player.finishedAt,
      takedowns: player.takedowns,
    })),
    pickups: room.pickups,
    checkpointCount: room.checkpointUs.length + 1,
    serverTime: Date.now(),
  });
}

function broadcastEvent(room: Room, event: RaceEvent): void {
  broadcast(room, {
    type: "race.event",
    event,
    serverTime: Date.now(),
  });
}

function broadcast(room: Room, message: ServerMessage): void {
  for (const player of room.players.values()) {
    if (!player.connected) continue;
    send(player.socket, message);
  }
}

function buildDirectory(): RoomDirectoryEntry[] {
  return [...rooms.values()]
    .map((room) => ({
      roomCode: room.code,
      roomName: room.name,
      hostName: room.players.get(room.hostId)?.name ?? "Host",
      phase: room.phase,
      playerCount: room.players.size,
      playerCap: room.setup.playerCap,
      songId: room.setup.songId,
    }))
    .sort((a, b) => a.roomCode.localeCompare(b.roomCode));
}

function sendDirectory(socket: WebSocket): void {
  send(socket, {
    type: "room.directory",
    rooms: buildDirectory(),
    serverTime: Date.now(),
  });
}

function broadcastDirectory(): void {
  const message: ServerMessage = {
    type: "room.directory",
    rooms: buildDirectory(),
    serverTime: Date.now(),
  };
  for (const connection of clients.values()) {
    send(connection.socket, message);
  }
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function sendError(socket: WebSocket, message: string): void {
  send(socket, {
    type: "room.error",
    message,
    serverTime: Date.now(),
  });
}

function makeRoom(params: Pick<Room, "code" | "name" | "hostId" | "phase" | "setup">): Room {
  return {
    code: params.code,
    name: params.name,
    hostId: params.hostId,
    phase: params.phase,
    setup: params.setup,
    players: new Map(),
    checkpointUs: [],
    pickups: [],
    racePlayers: new Map(),
    song: null,
    collisionTrack: null,
    raceStartAt: 0,
    songEndAt: 0,
    stagingOpenedAt: 0,
    preloadDeadlineAt: 0,
    stagingTimer: null,
    snapshotInterval: null,
    countdownTimer: null,
    eventSequence: 0,
  };
}

function sanitizeRoomName(connection: ClientConnection, songId: string, requested: string): string {
  const normalized = requested.trim().replace(/\s+/g, " ");
  if (normalized.length > 0) {
    return normalized.slice(0, 32);
  }
  const titleStem = songId.split("-").slice(-2).join(" ") || "tempo room";
  return `${connection.name} / ${titleStem}`.slice(0, 32);
}

function sanitizePlayerName(requested: string, fallback: string): string {
  const normalized = requested
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^A-Za-z0-9 _'-]/g, "")
    .slice(0, PLAYER_NAME_MAX_LENGTH)
    .trim();
  return normalized.length >= PLAYER_NAME_MIN_LENGTH ? normalized : fallback;
}

function makePlayer(connection: ClientConnection, carVariant: CarVariant): InternalPlayer {
  return {
    clientId: connection.clientId,
    name: connection.name,
    socket: connection.socket,
    carVariant: sanitizeCarVariant(carVariant),
    connected: true,
    ready: false,
    preload: { sceneReady: false, audioReady: false },
    isActiveRacer: false,
  };
}

function handleDisconnect(connection: ClientConnection): void {
  if (!connection.roomCode) return;
  leaveCurrentRoom(connection).catch((error) => {
    console.error("Disconnect cleanup failed:", error);
  });
}

function disposeRoom(room: Room): void {
  clearTimers(room);
}

function clearTimers(room: Room): void {
  if (room.stagingTimer) {
    clearTimeout(room.stagingTimer);
    room.stagingTimer = null;
  }
  if (room.snapshotInterval) {
    clearInterval(room.snapshotInterval);
    room.snapshotInterval = null;
  }
  if (room.countdownTimer) {
    clearTimeout(room.countdownTimer);
    room.countdownTimer = null;
  }
}

function hasSongEnded(room: Room, now: number): boolean {
  return room.songEndAt > 0 && now >= room.songEndAt;
}


function getRoomFor(connection: ClientConnection): Room | null {
  if (!connection.roomCode) {
    sendError(connection.socket, "Not connected to a room.");
    return null;
  }
  const room = rooms.get(connection.roomCode);
  if (!room) {
    sendError(connection.socket, "Room no longer exists.");
    connection.roomCode = null;
    return null;
  }
  return room;
}

function activeRacerCount(room: Room): number {
  let count = 0;
  for (const player of room.players.values()) {
    if (player.isActiveRacer && player.connected) count += 1;
  }
  return count;
}

function sanitizeSetup(setup: RaceSetup): RaceSetup {
  return {
    songId: setup.songId || DEFAULT_SETUP.songId,
    fictionId: setup.fictionId === 2 || setup.fictionId === 3 ? setup.fictionId : 1,
    seed: Number.isFinite(setup.seed) ? Math.max(0, Math.floor(setup.seed)) : DEFAULT_SETUP.seed,
    playerCap: [2, 4, 6, 8].includes(setup.playerCap) ? setup.playerCap : DEFAULT_SETUP.playerCap,
  };
}

function sanitizeCarVariant(carVariant: CarVariant): CarVariant {
  return carVariants.includes(carVariant) ? carVariant : "vector";
}

function buildLaneOffsets(count: number): number[] {
  if (count <= 1) return [0];
  const step = Math.min(6, 16 / Math.max(1, count - 1));
  const start = -step * (count - 1) * 0.5;
  return Array.from({ length: count }, (_, index) => start + index * step);
}

function buildPickups(track: Track, seed: number): PickupSpawnState[] {
  return simBuildPickups(track, seed);
}

async function loadSongById(songId: string): Promise<SongDefinition> {
  const catalogPath = join(process.cwd(), "public", "song-catalog.json");
  const catalogJson = JSON.parse(await readFile(catalogPath, "utf8")) as CatalogFile;
  const entry = catalogJson.songs.find((candidate) => candidate.id === songId);
  if (!entry) {
    throw new Error(`Unknown song id: ${songId}`);
  }

  const songPath = join(process.cwd(), "public", entry.songPath.replace(/^\/+/, ""));
  const file = await readFile(songPath, "utf8");
  return songDefinitionSchema.parse(JSON.parse(file));
}

function createRoomCode(): string {
  while (true) {
    const code = Math.random().toString(36).slice(2, 6).toUpperCase();
    if (!rooms.has(code)) return code;
  }
}

function nextEventId(room: Room): string {
  room.eventSequence += 1;
  return `${room.code}-${room.eventSequence}`;
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

