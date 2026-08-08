// Reading player and server info from the game.

// Tries to get the local player login without requiring an active race.
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

// Reads the current server's login (stable unique key) and name (human
// readable, contains $-formatting codes — stripping happens on the relay,
// see server/src/room-name.js). Object graph:
//
//   GetApp() : CTrackMania
//     .Network : CGameCtnNetwork        (concrete CTrackManiaNetwork)
//       .ServerInfo : CGameNetServerInfo (concrete CTrackManiaNetworkServerInfo)
//         (inherited from CGameCtnNetServerInfo):
//           .ServerLogin : string   e.g. "droppie_lolmaps"
//           .ServerName  : wstring  e.g. "$00F$W$OLOLMAPS$FFF"
//
// Returns false in solo / editor / menus, with failReason indicating exactly
// which step failed, so the widget can display "not on a server".
bool TryGetServerInfo(string &out login, string &out name, string &out failReason) {
    CGameManiaPlanet@ mp = cast<CGameManiaPlanet>(GetApp());
    if (mp is null) { failReason = "cast<CGameManiaPlanet>(GetApp()) is null"; return false; }

    CGameCtnNetwork@ network = mp.Network;
    if (network is null) { failReason = "mp.Network is null"; return false; }

    CGameNetServerInfo@ serverInfo = network.ServerInfo;
    if (serverInfo is null) { failReason = "network.ServerInfo is null (offline?)"; return false; }

    CGameCtnNetServerInfo@ info = cast<CGameCtnNetServerInfo>(serverInfo);
    if (info is null) { failReason = "cast<CGameCtnNetServerInfo> failed"; return false; }

    login = info.ServerLogin;
    name  = info.ServerName;
    if (login == "") { failReason = "ServerLogin is empty"; return false; }
    return true;
}

// Two ways to find "the local player": the primary path matches login
// against the full player list (works even with several players/terminals),
// the fallback grabs the first game terminal's controlled player (local slot 0).
bool TryGetLocalPlayerPosition(vec3 &out pos, string &out login, string &out failReason) {
    CGameCtnApp@ app = GetApp();
    CGameManiaPlanet@ mp = cast<CGameManiaPlanet>(app);
    if (mp is null) { failReason = "cast<CGameManiaPlanet>(GetApp()) is null"; return false; }

    CGamePlayground@ pg = mp.CurrentPlayground;
    if (pg is null) { failReason = "mp.CurrentPlayground is null (not in a race?)"; return false; }

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
