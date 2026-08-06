// OnZVoIP - reports the local player's live position to the OnZVoIP relay,
// so it can be broadcast to other players for proximity voice chat.
// Speaks the exact same protocol as ../tools/simulate-positions.js:
// one line of JSON per position update, newline-delimited, over raw TCP
// (see ../server/src/index.js "ingest over raw TCP" and ../context.txt /
// ../todo.txt ETAPE 3 for why raw TCP rather than a WebSocket dependency
// plugin: no extra plugin to install, and Net::Socket is guaranteed present
// on the ManiaPlanet build).
//
// Verified working in-game 2026-08-06 on a live ManiaPlanet server: positions
// reach the relay and drive the web client's proximity audio. The plugin
// prints its status to the OpenPlanet log, including exactly which step of
// TryGetLocalPlayerPosition() is failing when it can't read a position.

// Edit RELAY_HOST for your setup: 127.0.0.1 for the local docker-compose
// stack on the same machine as the game, your LAN IP if the relay runs on
// another machine on your network, or the VPS's public IP once deployed
// (ETAPE 1/2 in todo.txt).
const string RELAY_HOST = "62.238.61.115";
const uint16 RELAY_PORT = 8081;
const string VOIP_URL = "https://62.238.61.115.sslip.io";
const int SEND_INTERVAL_MS = 200;
const int RECONNECT_INTERVAL_MS = 2000;

const int DIAG_INTERVAL_MS = 3000; // throttle for the "still not sending" diagnostic below

Net::Socket@ g_socket = null;
int64 g_lastSendAt = 0;
int64 g_lastConnectAttemptAt = 0;
int64 g_lastDiagAt = 0;
bool g_loggedConnected = false;

void Main() {
    print("OnZVoIP: plugin started, Main() running");
    while (true) {
        yield();
        int64 now = Time::Now;

        if (g_socket is null || !g_socket.IsReady()) {
            g_loggedConnected = false;
            if (now - g_lastConnectAttemptAt < RECONNECT_INTERVAL_MS) continue;
            g_lastConnectAttemptAt = now;
            TryConnect();
            continue;
        }

        if (!g_loggedConnected) {
            print("OnZVoIP: connected to relay at " + RELAY_HOST + ":" + RELAY_PORT);
            g_loggedConnected = true;
        }

        if (now - g_lastSendAt < SEND_INTERVAL_MS) continue;
        g_lastSendAt = now;

        vec3 pos;
        string login;
        string failReason;
        if (!TryGetLocalPlayerPosition(pos, login, failReason)) {
            // Throttled so it doesn't spam the log 5x/sec while sitting in a menu.
            if (now - g_lastDiagAt >= DIAG_INTERVAL_MS) {
                g_lastDiagAt = now;
                print("OnZVoIP: not sending yet - " + failReason);
            }
            continue;
        }

        string line = "{\"type\":\"position\",\"pseudo\":\"" + login + "\","
            + "\"x\":" + FormatFloat(pos.x) + ","
            + "\"y\":" + FormatFloat(pos.y) + ","
            + "\"z\":" + FormatFloat(pos.z) + "}\n";
        if (!g_socket.WriteRaw(line) && now - g_lastDiagAt >= DIAG_INTERVAL_MS) {
            g_lastDiagAt = now;
            print("OnZVoIP: WriteRaw failed | IsReady=" + g_socket.IsReady()
                + " IsHungUp=" + g_socket.IsHungUp());
        }
    }
}

// Tries to get the local player login without requiring an active race -
// used by the UI so the "Open in browser" button works from the menu too.
string GetCurrentLogin() {
    CGameCtnApp@ app = GetApp();
    CGameManiaPlanet@ mp = cast<CGameManiaPlanet>(app);
    if (mp is null) return "";

    CGamePlayground@ pg = mp.CurrentPlayground;
    if (pg !is null && pg.GameTerminals.Length > 0) {
        CGamePlayer@ player = pg.GameTerminals[0].GUIPlayer;
        if (player !is null && player.User !is null) return player.User.Login;
    }

    CGameManiaPlanetScriptAPI@ scriptApi = mp.ManiaPlanetScriptAPI;
    if (scriptApi !is null && scriptApi.LocalUser !is null) return scriptApi.LocalUser.Login;

    return "";
}

void RenderInterface() {
    string login = GetCurrentLogin();
    bool connected = g_socket !is null && g_socket.IsReady();
    string url = login != "" ? VOIP_URL + "?identity=" + login : VOIP_URL;

    UI::SetNextWindowSize(240, 0, UI::Cond::FirstUseEver);
    UI::Begin("OnZVoIP");

    if (UI::Button("Copy URL")) {
        IO::SetClipboard(url);
    }
    UI::SameLine();
    if (connected) {
        UI::Text("\\$0f0● Relay connected");
    } else {
        UI::Text("\\$f80● Connecting to relay...");
    }

    if (login != "") {
        UI::Text("Login: " + login);
    } else {
        UI::TextDisabled("(enter a race to see your login)");
    }

    UI::Separator();
    UI::Text("Open in your browser:");
    string urlBuf = url;
    UI::SetNextItemWidth(-1);
    UI::InputText("##url", urlBuf, UI::InputTextFlags::ReadOnly);

    UI::End();
}

void TryConnect() {
    print("OnZVoIP: connecting to " + RELAY_HOST + ":" + RELAY_PORT + "...");
    @g_socket = Net::Socket();
    if (!g_socket.Connect(RELAY_HOST, RELAY_PORT)) {
        print("OnZVoIP: Connect() returned false immediately (relay unreachable at that host:port?)");
        @g_socket = null;
    }
}

// Trackmania logins/floats never contain a JSON-breaking character ("\" or
// quote), so plain concatenation is safe here - no escaping needed.
string FormatFloat(float v) {
    return "" + v;
}

// Two ways to find "the local player" - primary matches login against the
// full player list (works even with several players/terminals), fallback
// grabs the first game terminal's controlled player (local slot 0).
// failReason says exactly which step returned null, so the caller can print
// it - this is the main debugging tool while this chain is unverified.
bool TryGetLocalPlayerPosition(vec3 &out pos, string &out login, string &out failReason) {
    CGameCtnApp@ app = GetApp();
    CGameManiaPlanet@ mp = cast<CGameManiaPlanet>(app);
    if (mp is null) { failReason = "cast<CGameManiaPlanet>(GetApp()) is null"; return false; }

    CGamePlayground@ pg = mp.CurrentPlayground;
    if (pg is null) { failReason = "mp.CurrentPlayground is null (not in a race?)"; return false; }

    // Primary: the player controlled by the local (first) game terminal - this
    // doesn't depend on ManiaPlanetScriptAPI.LocalUser, which some server
    // mods (e.g. PyPlanet) apparently leave null - confirmed null in testing
    // on a PyPlanet server, see todo.txt.
    if (pg.GameTerminals.Length == 0) { failReason = "pg.GameTerminals is empty"; return false; }
    CGamePlayer@ localPlayer = pg.GameTerminals[0].GUIPlayer;
    if (localPlayer is null) { failReason = "pg.GameTerminals[0].GUIPlayer is null"; return false; }

    if (localPlayer.User !is null) {
        login = localPlayer.User.Login;
    } else {
        CGameManiaPlanetScriptAPI@ scriptApi = mp.ManiaPlanetScriptAPI;
        login = (scriptApi !is null && scriptApi.LocalUser !is null) ? scriptApi.LocalUser.Login : "unknown";
    }

    CTrackManiaPlayer@ tmPlayer = cast<CTrackManiaPlayer>(localPlayer);
    if (tmPlayer is null) { failReason = "cast<CTrackManiaPlayer>(localPlayer) is null"; return false; }

    pos = tmPlayer.Position;
    return true;
}
