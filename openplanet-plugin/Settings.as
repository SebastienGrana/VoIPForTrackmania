// #32: relay host/port and voice-chat URL are player-configurable instead of
// hardcoded, so another community can self-host without editing Main.as and
// rebuilding — set these from the OpenPlanet overlay: Settings → Plugins →
// OnZVoIP. Defaults point at the ONZSM community server.

[Setting category="Connection" name="Relay host" description="TCP address of the OnZVoIP relay server (127.0.0.1 for a local docker-compose stack, a LAN IP, or a VPS public IP/hostname)."]
string S_RelayHost = "62.238.61.115";

[Setting category="Connection" name="Relay port" description="TCP port the relay listens on for position ingest."]
uint S_RelayPort = 8081;

[Setting category="Connection" name="Voice chat URL" description="Web client URL for the same relay as above (must match — this is where the Copy URL button points)."]
string S_VoipUrl = "https://62.238.61.115.sslip.io";
