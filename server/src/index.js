import { RoomServiceClient } from 'livekit-server-sdk';
import { createRelay } from './relay.js';

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
} = process.env;

if (!LIVEKIT_INTERNAL_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_PUBLIC_WS_URL) {
  throw new Error('Missing LIVEKIT_INTERNAL_URL / LIVEKIT_PUBLIC_WS_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET env vars');
}

const roomService = new RoomServiceClient(LIVEKIT_INTERNAL_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

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
});
