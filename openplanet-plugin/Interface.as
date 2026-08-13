// ImGui window, menu entry and the always-on HUD pill.

// Adds "OnZVoIP" to the game's "Plugins" menu (top bar) as a show/hide
// toggle, alongside every other installed plugin's entry there.
void RenderMenu() {
    UI::SetNextWindowSize(300, 0, UI::Cond::Always);
    if (UI::MenuItem("OnZVoIP", "", g_windowOpen)) {
        g_windowOpen = !g_windowOpen;
    }
}

// The chain behind proximity voice has four links that can each be down (the
// relay socket, the auth, the nonce/link, the browser tab), but the player
// only ever wants one answer: is my voice working, and if not, what do I do
// next? So both the window and the HUD pill derive everything — colour,
// wording, which controls to show — from this single stage instead of each
// printing its own piece of the chain. That is what removed the two separate
// "connected" lines the window used to show: one meant the TCP socket, the
// other meant the browser, and only the second one ever mattered.
enum VoipStage {
    VoipAuthFailed = 0,  // relay rejected the secret — needs the player to act
    VoipConnecting,      // no relay link yet, or no state pushed back yet
    VoipNoRace,          // relay is up, but there is no link outside a race
    VoipBrowserClosed,   // link is ready, nobody has opened it
    VoipActive           // voice is running
}

VoipStage CurrentStage() {
    if (g_authFailed) return VoipAuthFailed;
    if (g_socket is null || !g_socket.IsReady()) return VoipConnecting;
    // No nonce means no link to open: outside a race the plugin has no
    // position to send, so the relay never registers us and never pushes
    // state back. Saying "connecting..." there would be a lie that lasts as
    // long as the player stays in the menus.
    if (g_nonce == "") return VoipNoRace;
    // -1 = the relay has not pushed a state message yet (it does so every 5s,
    // see statePushIntervalMs in server/src/relay.js), so we genuinely do not
    // know whether a browser is in the room.
    if (g_statePlayersInRoom < 0) return VoipConnecting;
    return g_stateWebConnected ? VoipActive : VoipBrowserClosed;
}

// Title suffix, with the Trackmania colour code Openplanet's ImGui accepts.
string StageTitle(VoipStage stage) {
    if (stage == VoipAuthFailed)    return "\\$f00● auth failed";
    if (stage == VoipConnecting)    return "\\$f80● connecting...";
    if (stage == VoipNoRace)        return "\\$f80● no link yet";
    if (stage == VoipBrowserClosed) return "\\$f80● browser not open";
    return "\\$0f0● voice active";
}

// The URL carries a nonce instead of the raw login: the relay derives
// identity and room from the nonce, so the player has nothing to check.
string VoipUrl() {
    return g_nonce != "" ? S_VoipUrl + "?t=" + g_nonce : S_VoipUrl;
}

string PluginVersion() {
    auto@ self = Meta::ExecutingPlugin();
    return self !is null ? self.Version : "?";
}

void RenderInterface() {
    if (!g_windowOpen) return;

    VoipStage stage = CurrentStage();

    // AlwaysAutoResize: the window's content grows (auth-failed warning,
    // the Advanced section being unfolded) after OpenPlanet has already
    // persisted a smaller size from a previous session, and a
    // fixed/FirstUseEver size doesn't grow to fit — the extra rows would
    // silently get clipped below the window's bottom edge instead of showing.
    // Width is pinned every frame (Cond::Always) so only the height follows
    // AlwaysAutoResize — otherwise the width also auto-fits to whatever text
    // is currently longest (the URL, the server name...) and the window
    // visibly jitters wider/narrower as those change. 310 is wide enough for
    // the longest hint line to wrap onto two lines instead of getting clipped.
    // NoResize on top of AlwaysAutoResize: without it ImGui still draws a
    // drag handle in the bottom-right corner, which at this window's small
    // size looks like a stray glyph rather than a resize grip.
    // NoScrollbar: without it, ImGui reserves space for a scrollbar even
    // when none is needed, which shrinks the usable width for the
    // SetNextItemWidth(-1) fields below and keeps them from reaching the
    // window's right edge.
    UI::SetNextWindowSize(380, 0, UI::Cond::Always);
    UI::SetNextWindowPos(300, 200, UI::Cond::FirstUseEver);
    // Dear ImGui note: "##" only hides text from the *display* — the ID hash
    // still includes the whole string, suffix and all. "###" makes ID hashing
    // use ONLY the text after it, so the visible part before it (connection
    // status) can change freely without ImGui treating this as a new window
    // each time.
    UI::Begin("OnZVoIP " + StageTitle(stage) + "###OnZVoIP",
        UI::WindowFlags::AlwaysAutoResize | UI::WindowFlags::NoResize | UI::WindowFlags::NoScrollbar);

    string serverLogin, serverName, serverFail;
    if (TryGetServerInfo(serverLogin, serverName, serverFail)) {
        UI::Text(StripTmCodes(serverName));
        UI::SameLine();
        UI::TextDisabled("(" + serverLogin + ")");
    } else {
        UI::TextDisabled("(not on a server: " + serverFail + ")");
    }

    UI::Separator();

    // One block per stage: the player is shown the single next thing to do,
    // never the whole chain. Anything that is only useful when something is
    // wrong lives under "Advanced" at the bottom.
    //
    // "Open in browser" is the reason this window exists, so it is drawn as
    // soon as there is a link to open — not only while the browser is closed —
    // and always in the same spot, directly under the separator. Hiding it once
    // voice was up made the one button the player is looking for move around
    // and then disappear; a tab closed by accident, a browser that reopened on
    // the wrong profile, a second screen — all of those leave you staring at a
    // window whose whole job is that click. Nothing below it ever pushes it
    // down, so it can be found without reading.
    if (stage == VoipAuthFailed) {
        // An inline InputText for the secret never reliably kept keystrokes
        // (tried a persistent backing buffer, tried stabilizing the window ID
        // with "###" — neither held up in practice), so the field itself lives
        // in Settings > Plugins > OnZVoIP (S_RelaySecret) instead. This is
        // just the red flag telling the player to go set it there.
        UI::Text("\\$f00⚠ Auth failed");
        UI::TextWrapped("\\$888Check Relay secret in Settings > Plugins > OnZVoIP. Clear it if this relay needs none.");
        if (UI::Button("Retry", vec2(-1.0f, 0.0f))) g_forceReconnect = true;
    } else if (g_nonce == "") {
        // No link exists yet, so there is nothing to open. Which of the two
        // reasons it is matters to the player: one is on the plugin's side and
        // resolves itself, the other is the one thing only they can do.
        if (stage == VoipNoRace) {
            UI::TextWrapped("\\$888Enter a race to get your voice link.");
        } else {
            UI::TextWrapped("\\$888Connecting to the relay...");
        }
    } else {
        // One click instead of copy-then-paste: OpenBrowserURL() hands the
        // link (nonce included) straight to the default browser. Full width,
        // and the label says what it does — which is why the "Open in your
        // browser:" line that used to sit above it was pure repetition. Copy
        // URL stays under Advanced: it is the way out when the default browser
        // is not the one the player wants to talk in, or when the game runs
        // somewhere the browser doesn't (streaming, second PC), which is the
        // rare case, not the normal one.
        //
        // Pressing it while voice is already up is safe: the link is single-use,
        // so the plugin has already minted a fresh nonce (see "nonceUsed" in
        // Main.as) and the new tab gets its own valid token.
        if (UI::Button("Open in browser", vec2(-1.0f, 0.0f))) OpenBrowserURL(VoipUrl());

        if (stage != VoipActive) {
            // Covers "browser not open" and the few seconds after connecting
            // where the link is already valid but the relay has not pushed its
            // first state yet — in both, the tab is what is missing.
            UI::TextWrapped("\\$888Voice runs in that tab — allow the microphone when asked.");
        } else {
            string line = g_statePlayersInRoom == 1 ? "1 in voice" : (g_statePlayersInRoom + " in voice");
            // How many of the people around you are actually reachable. Only
            // added when the game gives a count, and never when that count is
            // below the room's — someone who left the server with the tab still
            // open is genuinely still in the room, and "3 in voice / 2 on the
            // server" would read as a bug rather than as that.
            int onServer = GetPlaygroundPlayerCount();
            if (onServer >= g_statePlayersInRoom) line += " / " + onServer + " on the server";
            UI::Text("\\$0f0" + line);
            // Green when the microphone is OPEN. The relay sends "mic": true for
            // open, and this pair of branches used to be the other way round, so
            // the widget told everyone the opposite of their own state.
            if (g_stateMicActive) {
                UI::Text("\\$0f0Mic: open");
            } else {
                UI::Text("\\$888Mic: muted");
            }
        }
    }

    UI::Separator();
    // Collapsed by default (no DefaultOpen flag): everything below is either
    // a fallback for the button above or something you only read when helping
    // someone debug on Discord.
    if (UI::CollapsingHeader("Advanced")) {
        if (g_nonce != "") {
            string urlBuf = VoipUrl();
            UI::SetNextItemWidth(-1);
            UI::InputText("##url", urlBuf, UI::InputTextFlags::ReadOnly);
            if (UI::Button("Copy URL", vec2(-1.0f, 0.0f))) IO::SetClipboard(VoipUrl());
        } else {
            UI::TextDisabled("No link yet — enter a race.");
        }

        UI::Separator();
        UI::TextDisabled("Relay: " + S_RelayHost + ":" + S_RelayPort);
        UI::TextDisabled("Plugin: v" + PluginVersion());

        // The single most useful diagnostic: whether the plugin can still
        // read the car. A player who is inaudible for no apparent reason is
        // almost always one whose position stopped going out (spectating,
        // not spawned, in the menus), and nothing else on screen says so.
        if (g_lastSendFail != "") {
            UI::TextWrapped("\\$f80Position paused: " + g_lastSendFail);
        } else if (g_lastPositionOkAt == 0) {
            UI::TextDisabled("Position: none sent yet");
        } else {
            UI::TextDisabled("Position: sent " + FormatAgo(Time::Now - g_lastPositionOkAt) + " ago");
        }

        if (UI::Button("Reconnect", vec2(-1.0f, 0.0f))) g_forceReconnect = true;
    }

    UI::End();
}

// Compact always-on status pill, e.g. "OnZVoIP ● 2 in room ● mic", drawn with
// NanoVG in the top-left corner. RenderInterface() above only draws while
// OpenPlanet's own overlay (F3) is open; Render() runs every frame
// regardless, so this is what keeps a status visible after the player closes
// the overlay — the "retracted" look, same idea as an ImGui window collapsed
// down to just its title bar. It is also the only OnZVoIP pixel visible while
// actually racing, which is why the mic sits here and not only in the window.
// Screen position lives in Settings (S_HudMarginRight/S_HudY, Settings.as) —
// anchored to the right edge via Display::GetWidth() so it lands near
// PyPlanet's local/live times widget on every resolution instead of a fixed
// X that only fits the developer's own screen.
const float HUD_PAD_X = 8.0f;
const float HUD_PAD_Y = 5.0f;
const float HUD_GAP = 6.0f;
const float HUD_DOT_RADIUS = 4.0f;
const float HUD_FONT_SIZE = 14.0f;

const vec4 HUD_GREEN = vec4(0.2f, 0.85f, 0.3f, 1.0f);
const vec4 HUD_ORANGE = vec4(1.0f, 0.6f, 0.1f, 1.0f);
const vec4 HUD_RED = vec4(0.9f, 0.15f, 0.15f, 1.0f);
const vec4 HUD_GREY = vec4(0.55f, 0.55f, 0.55f, 1.0f);
const vec4 HUD_WHITE = vec4(1.0f, 1.0f, 1.0f, 1.0f);

vec4 StageColor(VoipStage stage) {
    if (stage == VoipAuthFailed) return HUD_RED;
    if (stage == VoipActive) return HUD_GREEN;
    return HUD_ORANGE;
}

// The word "connected" is gone from the pill: the dot already carries it, and
// dropping it makes room for the mic without the pill growing. What is left
// is always the thing to do next, or the room once there is nothing to do.
string StageStatus(VoipStage stage) {
    if (stage == VoipAuthFailed)    return "auth failed";
    if (stage == VoipConnecting)    return "connecting...";
    if (stage == VoipNoRace)        return "enter a race";
    if (stage == VoipBrowserClosed) return "open browser!";
    return g_statePlayersInRoom == 1 ? "1 in room" : (g_statePlayersInRoom + " in room");
}

void Render() {
    if (!g_windowOpen) return;

    VoipStage stage = CurrentStage();
    string statusText = StageStatus(stage);
    vec4 dotColor = StageColor(stage);

    // The mic segment only appears once the browser is really in the room:
    // before that there is no microphone to report, and a grey "mic" would be
    // read as "you are muted" rather than "not known yet". The word itself
    // never changes, only its colour — a label that switched between "open"
    // and "muted" would change the pill's width every time, which catches the
    // eye far more than the state it is reporting.
    // Caveat worth knowing: this state comes from the relay's 5s poll of
    // LiveKit, so it can lag a few seconds behind a mute pressed in the
    // browser. Making it instant (and adding a "you are speaking" indicator)
    // means having the browser report the change as it happens — separate job.
    bool showMic = stage == VoipActive;
    vec4 micColor = g_stateMicActive ? HUD_GREEN : HUD_GREY;

    nvg::FontSize(HUD_FONT_SIZE);
    vec2 titleSize = nvg::TextBounds("OnZVoIP");
    vec2 statusSize = nvg::TextBounds(statusText);
    vec2 micSize = nvg::TextBounds("mic");

    float contentHeight = Math::Max(titleSize.y, statusSize.y);
    float boxWidth = HUD_PAD_X * 2.0f + titleSize.x + HUD_GAP + HUD_DOT_RADIUS * 2.0f + HUD_GAP + statusSize.x;
    if (showMic) boxWidth += HUD_GAP + HUD_DOT_RADIUS * 2.0f + HUD_GAP + micSize.x;
    float boxHeight = HUD_PAD_Y * 2.0f + contentHeight;
    float hudX = float(Display::GetWidth()) - boxWidth - S_HudMarginRight;
    float midY = S_HudY + boxHeight / 2.0f;

    nvg::BeginPath();
    nvg::RoundedRect(hudX, S_HudY, boxWidth, boxHeight, 6.0f);
    nvg::FillColor(vec4(0.0f, 0.0f, 0.0f, 0.55f));
    nvg::Fill();
    nvg::ClosePath();

    nvg::TextAlign(nvg::Align::Left | nvg::Align::Middle);

    float x = hudX + HUD_PAD_X;
    nvg::FillColor(HUD_WHITE);
    nvg::Text(x, midY, "OnZVoIP");
    x += titleSize.x + HUD_GAP;

    nvg::BeginPath();
    nvg::Circle(vec2(x + HUD_DOT_RADIUS, midY), HUD_DOT_RADIUS);
    nvg::FillColor(dotColor);
    nvg::Fill();
    nvg::ClosePath();
    x += HUD_DOT_RADIUS * 2.0f + HUD_GAP;

    nvg::FillColor(HUD_WHITE);
    nvg::Text(x, midY, statusText);
    x += statusSize.x;

    if (showMic) {
        x += HUD_GAP;
        nvg::BeginPath();
        nvg::Circle(vec2(x + HUD_DOT_RADIUS, midY), HUD_DOT_RADIUS);
        nvg::FillColor(micColor);
        nvg::Fill();
        nvg::ClosePath();
        x += HUD_DOT_RADIUS * 2.0f + HUD_GAP;

        nvg::FillColor(micColor);
        nvg::Text(x, midY, "mic");
    }
}
