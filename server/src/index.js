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
  TCP_SHARED_SECRET = '',
} = process.env;

if (!LIVEKIT_INTERNAL_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_PUBLIC_WS_URL) {
  throw new Error('Missing LIVEKIT_INTERNAL_URL / LIVEKIT_PUBLIC_WS_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET env vars');
}

const roomService = new RoomServiceClient(LIVEKIT_INTERNAL_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

const { server, tcpServer } = createRelay({
  roomService,
  apiKey: LIVEKIT_API_KEY,
  apiSecret: LIVEKIT_API_SECRET,
  liveKitPublicWsUrl: LIVEKIT_PUBLIC_WS_URL,
  roomName: ROOM_NAME,
  enableCalibrationBot: ENABLE_CALIBRATION_BOT === 'true',
  tcpSharedSecret: TCP_SHARED_SECRET,
});

tcpServer.listen(INGEST_TCP_PORT, () => {
  console.log(`onzvoip relay TCP ingest listening on :${INGEST_TCP_PORT}`);
});

server.listen(PORT, () => {
  console.log(`onzvoip relay listening on :${PORT} (room "${ROOM_NAME}", livekit at ${LIVEKIT_INTERNAL_URL})`);
});
