import { RoomServiceClient } from 'livekit-server-sdk';
import { createRelay } from './relay.js';
import { createEventLog } from './event-log.js';

const {
  LIVEKIT_INTERNAL_URL,
  LIVEKIT_PUBLIC_WS_URL,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  ROOM_NAME = 'onzsm',
  PORT = 8080,
  INGEST_TCP_PORT = 8081,
  ENABLE_CALIBRATION_BOT,
  DEBUG_MODE,
  TCP_SHARED_SECRET = '',
  TCP_MAX_CONNECTIONS,
  TCP_IDLE_TIMEOUT_MS,
  POSITION_BROADCAST_INTERVAL_MS,
  STATE_PUSH_INTERVAL_MS,
  EVENT_LOG_FILE = '',
  ADMIN_USER = '',
  ADMIN_PASSWORD = '',
  ADMIN_ACTIONS,
  ENABLE_TEST_BOTS,
  BAN_FILE = '',
} = process.env;

if (!LIVEKIT_INTERNAL_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_PUBLIC_WS_URL) {
  throw new Error('Missing LIVEKIT_INTERNAL_URL / LIVEKIT_PUBLIC_WS_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET env vars');
}

const roomService = new RoomServiceClient(LIVEKIT_INTERNAL_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

// Without EVENT_LOG_FILE the events still reach stdout (so journalctl has
// them), they just aren't kept anywhere the relay can re-read for /admin.
const eventLog = createEventLog({ file: EVENT_LOG_FILE || null });

// Half-configured admin credentials are a trap: ADMIN_USER alone would leave
// the page reachable with an empty password if the check were per-field, so
// createRelay treats "both non-empty" as the only configured state. Say so
// loudly at boot rather than letting an admin believe the page is up.
if ((ADMIN_USER === '') !== (ADMIN_PASSWORD === '')) {
  console.error('ADMIN_USER and ADMIN_PASSWORD must both be set (or both empty) — /admin stays disabled');
}

// Audit #41: these all had hardcoded defaults inside createRelay() with no
// way to override them short of editing relay.js — fine while every deploy
// was ours, not fine now that a fork might need different tuning (a bigger
// community needs more than 1000 TCP connections, a slower VPS wants a
// longer flush interval). Falls through to createRelay()'s own defaults
// when unset, so an empty env is unchanged behavior.
const { server, tcpServer } = createRelay({
  roomService,
  apiKey: LIVEKIT_API_KEY,
  apiSecret: LIVEKIT_API_SECRET,
  liveKitPublicWsUrl: LIVEKIT_PUBLIC_WS_URL,
  roomName: ROOM_NAME,
  enableCalibrationBot: ENABLE_CALIBRATION_BOT === 'true',
  debugMode: DEBUG_MODE === 'true',
  tcpSharedSecret: TCP_SHARED_SECRET,
  eventLog,
  adminUser: ADMIN_USER,
  adminPassword: ADMIN_PASSWORD,
  // Both off unless asked for: they turn the admin page from a window into a
  // set of levers, and the bots inject positions under invented logins.
  adminActions: ADMIN_ACTIONS === 'true',
  // Without a path the ban list still works, it just dies with the process —
  // which for a list typed in the day before an event means it is gone by the
  // time it matters.
  banFile: BAN_FILE,
  enableTestBots: ENABLE_TEST_BOTS === 'true',
  ingestTcpPort: Number(INGEST_TCP_PORT),
  ...(TCP_MAX_CONNECTIONS && { tcpMaxConnections: Number(TCP_MAX_CONNECTIONS) }),
  ...(TCP_IDLE_TIMEOUT_MS && { tcpIdleTimeoutMs: Number(TCP_IDLE_TIMEOUT_MS) }),
  ...(POSITION_BROADCAST_INTERVAL_MS && { positionBroadcastIntervalMs: Number(POSITION_BROADCAST_INTERVAL_MS) }),
  ...(STATE_PUSH_INTERVAL_MS && { statePushIntervalMs: Number(STATE_PUSH_INTERVAL_MS) }),
});

tcpServer.listen(INGEST_TCP_PORT, () => {
  console.log(`onzvoip relay TCP ingest listening on :${INGEST_TCP_PORT}`);
});

server.listen(PORT, () => {
  console.log(`onzvoip relay listening on :${PORT} (room "${ROOM_NAME}", livekit at ${LIVEKIT_INTERNAL_URL})`);
  eventLog.log('relay.start', {
    port: Number(PORT),
    tcpPort: Number(INGEST_TCP_PORT),
    room: ROOM_NAME,
    debugMode: DEBUG_MODE === 'true',
    admin: ADMIN_USER !== '' && ADMIN_PASSWORD !== '',
    logFile: eventLog.file,
  });
});
