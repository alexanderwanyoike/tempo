export const fictionIds = [1, 2, 3] as const;
export type SharedFictionId = (typeof fictionIds)[number];

export const carVariants = ["vector", "ember", "nova", "ghost"] as const;
export type CarVariant = (typeof carVariants)[number];

export const itemKinds = ["missile", "shield"] as const;
export type ItemKind = (typeof itemKinds)[number];

export type InventorySlot = "offensive" | "defensive";
export type RoomPhase = "lobby" | "staging" | "countdown" | "running";
export type RaceResultStatus = "finished" | "dnf";

export type RaceSetup = {
  songId: string;
  fictionId: SharedFictionId;
  seed: number;
  playerCap: number;
};

export type PreloadState = {
  sceneReady: boolean;
  audioReady: boolean;
};

export type RoomPlayerState = {
  clientId: string;
  name: string;
  carVariant: CarVariant;
  connected: boolean;
  ready: boolean;
  preload: PreloadState;
  isHost: boolean;
  isActiveRacer: boolean;
};

export type RoomDirectoryEntry = {
  roomCode: string;
  roomName: string;
  hostName: string;
  phase: RoomPhase;
  playerCount: number;
  playerCap: number;
  songId: string;
};

export type PickupSpawnState = {
  id: string;
  kind: ItemKind;
  slot: InventorySlot;
  u: number;
  lane: number;
  collectedBy: string | null;
};

export type RacePlayerState = {
  clientId: string;
  trackU: number;
  lateralOffset: number;
  speed: number;
  checkpointIndex: number;
  placement: number;
  offensiveItem: ItemKind | null;
  defensiveItem: ItemKind | null;
  shieldUntil: number;
  takenDownUntil: number;
  respawnRevision: number;
  finishedAt: number | null;
  takedowns: number;
};

export type RaceEvent =
  | {
      id: string;
      kind: "pickup";
      actorId: string;
      item: ItemKind;
      slot: InventorySlot;
      at: number;
    }
  | {
      id: string;
      kind: "fire";
      actorId: string;
      targetId: string | null;
      outcome: "miss" | "blocked" | "takedown";
      at: number;
    }
  | {
      id: string;
      kind: "shield";
      actorId: string;
      at: number;
    }
  | {
      id: string;
      kind: "blocked";
      actorId: string;
      targetId: string;
      at: number;
    }
  | {
      id: string;
      kind: "takedown";
      actorId: string;
      targetId: string;
      at: number;
    }
  | {
      id: string;
      kind: "respawn";
      targetId: string;
      at: number;
    }
  | {
      id: string;
      kind: "finish";
      actorId: string;
      placement: number;
      finishTimeMs: number;
      at: number;
    };

export type RaceResultEntry = {
  clientId: string;
  name: string;
  placement: number;
  status: RaceResultStatus;
  finishTimeMs: number | null;
  takedowns: number;
};

export type RaceResults = {
  roomCode: string;
  setup: RaceSetup;
  entries: RaceResultEntry[];
};

export type ClientMessage =
  | {
      type: "room.create";
      roomName: string;
      setup: RaceSetup;
      carVariant: CarVariant;
    }
  | {
      type: "room.join";
      roomCode: string;
      carVariant: CarVariant;
    }
  | {
      type: "room.leave";
    }
  | {
      type: "room.updateSetup";
      setup: RaceSetup;
    }
  | {
      type: "room.selectCar";
      carVariant: CarVariant;
    }
  | {
      type: "room.setReady";
      ready: boolean;
    }
  | {
      type: "room.start";
    }
  | {
      type: "room.preload";
      sceneReady?: boolean;
      audioReady?: boolean;
    }
  | {
      type: "race.report";
      trackU: number;
      lateralOffset: number;
      speed: number;
    }
  | {
      type: "race.fire";
    }
  | {
      type: "race.shield";
    }
  | {
      type: "ping";
      sentAt: number;
    };

export type ServerMessage =
  | {
      type: "server.ready";
      clientId: string;
      message: string;
      serverTime: number;
    }
  | {
      type: "room.error";
      message: string;
      serverTime: number;
    }
  | {
      type: "room.state";
      roomCode: string;
      roomName: string;
      phase: RoomPhase;
      hostId: string;
      setup: RaceSetup;
      players: RoomPlayerState[];
      serverTime: number;
    }
  | {
      type: "room.directory";
      rooms: RoomDirectoryEntry[];
      serverTime: number;
    }
  | {
      type: "race.countdown";
      startAt: number;
      serverTime: number;
    }
  | {
      type: "race.snapshot";
      players: RacePlayerState[];
      pickups: PickupSpawnState[];
      checkpointCount: number;
      serverTime: number;
    }
  | {
      type: "race.event";
      event: RaceEvent;
      serverTime: number;
    }
  | {
      type: "race.results";
      results: RaceResults;
      serverTime: number;
    }
  | {
      type: "pong";
      sentAt: number;
      serverTime: number;
    };
