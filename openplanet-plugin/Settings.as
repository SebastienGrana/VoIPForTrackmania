// Relay host/port and voice-chat URL are player-configurable instead of
// hardcoded, so another community can self-host without editing the plugin
// and rebuilding — set these from the OpenPlanet overlay: Settings → Plugins
// → OnZVoIP. Defaults point at the ONZSM community server.

[Setting category="Connection" name="Relay host" description="TCP address of the OnZVoIP relay server (127.0.0.1 for a local docker-compose stack, a LAN IP, or a VPS public IP/hostname)."]
string S_RelayHost = "62.238.61.115";

[Setting category="Connection" name="Relay port" description="TCP port the relay listens on for position ingest."]
uint S_RelayPort = 8081;

[Setting category="Connection" name="Voice chat URL" description="Web client URL for the same relay as above (must match — this is where the Copy URL button points)."]
string S_VoipUrl = "https://62.238.61.115.sslip.io";

// Raises the bar on the open TCP ingest port from "anyone on the internet"
// to "someone who has the community's token" — it does not identify
// individual players (no verifiable Trackmania identity exists to bind to).
// Left blank by default: a relay with no TCP_SHARED_SECRET
// configured ignores this field entirely, so self-hosters aren't forced to
// set one. Ask your community's admin for the value if their relay requires it.
[Setting category="Connection" name="Relay secret" description="Shared token required by some relays on the TCP ingest port. Leave blank unless your community's admin gave you one."]
string S_RelaySecret = "";

// Anchored to the right edge (Display::GetWidth() in Interface.as) rather
// than a fixed X, so it lands in the same spot — near PyPlanet's local/live
// times widget — on every resolution instead of running off-screen on
// anything smaller than the developer's own screen. 295 is the value found by
// trying it in game: at 20 the pill sat under PyPlanet's own panels, this
// clears them.
[Setting category="Display" name="HUD margin from right edge" description="Distance from the right edge of the screen, in pixels, for the compact status pill."]
float S_HudMarginRight = 295.0f;

[Setting category="Display" name="HUD position Y" description="Distance from the top edge of the screen, in pixels, for the compact status pill."]
float S_HudY = 50.0f;
