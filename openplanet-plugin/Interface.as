// ImGui window and menu entry.

// Adds "OnZVoIP" to the game's "Plugins" menu (top bar) as a show/hide
// toggle, alongside every other installed plugin's entry there.
void RenderMenu() {
    UI::SetNextWindowSize(300, 0, UI::Cond::Always);
    if (UI::MenuItem("OnZVoIP", "", g_windowOpen)) {
        g_windowOpen = !g_windowOpen;
    }
}

void RenderInterface() {
    if (!g_windowOpen) return;

    bool connected = g_socket !is null && g_socket.IsReady();

    // The URL carries a nonce instead of the raw login: the relay derives
    // identity and room from the nonce, so the player has nothing to check.
    string url = g_nonce != "" ? S_VoipUrl + "?t=" + g_nonce : S_VoipUrl;

    // AlwaysAutoResize: the window's content grows (auth-failed warning,
    // secret field) after OpenPlanet has already persisted a smaller size
    // from a previous session, and a fixed/FirstUseEver size doesn't grow to
    // fit — the extra rows would silently get clipped below the window's
    // bottom edge instead of showing.
    // Width is pinned every frame (Cond::Always) so only the height follows
    // AlwaysAutoResize — otherwise the width also auto-fits to whatever text
    // is currently longest (the URL, the server name...) and the window
    // visibly jitters wider/narrower as those change. 300 is wide enough for
    // the longest hint line to wrap onto two lines instead of getting clipped.
    // NoResize on top of AlwaysAutoResize: without it ImGui still draws a
    // drag handle in the bottom-right corner, which at this window's small
    // size looks like a stray glyph rather than a resize grip.
    // NoScrollbar: without it, ImGui reserves space for a scrollbar even
    // when none is needed, which shrinks the usable width for the
    // SetNextItemWidth(-1) fields below and keeps them from reaching the
    // window's right edge.
    UI::SetNextWindowSize(310, 0, UI::Cond::Always);
    UI::SetNextWindowPos(300, 200, UI::Cond::FirstUseEver);
    // Dear ImGui note: "##" only hides text from the *display* — the ID hash
    // still includes the whole string, suffix and all. "###" makes ID hashing
    // use ONLY the text after it, so the visible part before it (connection
    // status) can change freely without ImGui treating this as a new window
    // each time.
    if (connected) {
        UI::Begin("OnZVoIP \\$0f0● connected###OnZVoIP", UI::WindowFlags::AlwaysAutoResize | UI::WindowFlags::NoResize | UI::WindowFlags::NoScrollbar);
    } else if (g_authFailed) {
        UI::Begin("OnZVoIP \\$f00● auth failed###OnZVoIP", UI::WindowFlags::AlwaysAutoResize | UI::WindowFlags::NoResize | UI::WindowFlags::NoScrollbar);
    } else {
        UI::Begin("OnZVoIP \\$f80● Connecting...###OnZVoIP", UI::WindowFlags::AlwaysAutoResize | UI::WindowFlags::NoResize | UI::WindowFlags::NoScrollbar);
    }

    string serverLogin, serverName, serverFail;
    if (TryGetServerInfo(serverLogin, serverName, serverFail)) {
        UI::Text(StripTmCodes(serverName));
        UI::SameLine();
        UI::TextDisabled("(" + serverLogin + ")");
    } else {
        UI::TextDisabled("(not on a server: " + serverFail + ")");
    }

    UI::Separator();
    if (g_nonce != "") {
        UI::Text("Open in your browser:");
        UI::SameLine();
        // One click instead of copy-then-paste: OpenBrowserURL() hands the
        // link (nonce included) straight to the default browser. Copy URL is
        // kept next to it, because it is the only way out when the default
        // browser is not the one the player wants to talk in, or when the
        // game runs somewhere the browser doesn't (streaming, second PC).
        if (UI::Button("Open in browser")) {
            OpenBrowserURL(url);
        }
        UI::SameLine();
        if (UI::Button("Copy URL")) {
            IO::SetClipboard(url);
        }
        string urlBuf = url;
        UI::SetNextItemWidth(-1);
        UI::InputText("##url", urlBuf, UI::InputTextFlags::ReadOnly);
    } else {
        UI::Text("(enter a race to get a link)");
    }

    // Relay state — web connection status, mic, player count.
    if (connected && g_statePlayersInRoom >= 0) {
        UI::Separator();
        if (g_stateWebConnected) {
            string pc = g_statePlayersInRoom == 1 ? "1 player" : (g_statePlayersInRoom + " players");
            UI::Text("\\$0f0Web: connected (" + pc + ")");
            if (g_stateMicMuted) {
                UI::Text("\\$888Mic: muted");
            } else {
                UI::Text("\\$0f0Mic: active");
            }
        } else {
            UI::TextWrapped("\\$f80Web: not open — use Copy URL above");
        }
    }

    // An inline InputText here never reliably kept keystrokes (tried a
    // persistent backing buffer, tried stabilizing the window ID with
    // "###" — neither held up in practice), so the field itself lives in
    // Settings > Plugins > OnZVoIP (S_RelaySecret) instead. This is just the
    // red flag telling the player to go set it there.
    if (g_authFailed) {
        UI::Separator();
        UI::Text("\\$f00⚠ Auth failed");
        UI::TextWrapped("\\$888Check Relay secret in Settings > Plugins > OnZVoIP. Clear it if this relay needs none.");
        if (UI::Button("Retry")) {
            g_authFailed = false;
        }
    }

    UI::End();
}

// Compact always-on status pill, e.g. "OnZVoIP ● connected", drawn with
// NanoVG in the top-left corner. RenderInterface() above only draws while
// OpenPlanet's own overlay (F3) is open; Render() runs every frame
// regardless, so this is what keeps a status visible after the player closes
// the overlay — the "retracted" look, same idea as an ImGui window collapsed
// down to just its title bar.
// Screen position lives in Settings (S_HudMarginRight/S_HudY, Settings.as) —
// anchored to the right edge via Display::GetWidth() so it lands near
// PyPlanet's local/live times widget on every resolution instead of a fixed
// X that only fits the developer's own screen.
const float HUD_PAD_X = 8.0f;
const float HUD_PAD_Y = 5.0f;
const float HUD_GAP = 6.0f;
const float HUD_DOT_RADIUS = 4.0f;
const float HUD_FONT_SIZE = 14.0f;

void Render() {
    if (!g_windowOpen) return;

    bool connected = g_socket !is null && g_socket.IsReady();
    string statusText;
    if (!connected) {
        statusText = g_authFailed ? "auth failed" : "Connecting...";
    } else if (g_statePlayersInRoom < 0) {
        statusText = "connected";
    } else if (!g_stateWebConnected) {
        statusText = "connected | open browser!";
    } else {
        string pc = g_statePlayersInRoom == 1 ? "1 in room" : (g_statePlayersInRoom + " in room");
        statusText = "connected | " + pc;
    }
    vec4 dotColor = connected ? vec4(0.2f, 0.85f, 0.3f, 1.0f) : (g_authFailed ? vec4(0.9f, 0.15f, 0.15f, 1.0f) : vec4(1.0f, 0.6f, 0.1f, 1.0f));

    nvg::FontSize(HUD_FONT_SIZE);
    vec2 titleSize = nvg::TextBounds("OnZVoIP");
    vec2 statusSize = nvg::TextBounds(statusText);

    float contentHeight = Math::Max(titleSize.y, statusSize.y);
    float boxWidth = HUD_PAD_X * 2.0f + titleSize.x + HUD_GAP + HUD_DOT_RADIUS * 2.0f + HUD_GAP + statusSize.x;
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
    nvg::FillColor(vec4(1.0f, 1.0f, 1.0f, 1.0f));
    nvg::Text(x, midY, "OnZVoIP");
    x += titleSize.x + HUD_GAP;

    nvg::BeginPath();
    nvg::Circle(vec2(x + HUD_DOT_RADIUS, midY), HUD_DOT_RADIUS);
    nvg::FillColor(dotColor);
    nvg::Fill();
    nvg::ClosePath();
    x += HUD_DOT_RADIUS * 2.0f + HUD_GAP;

    nvg::FillColor(vec4(1.0f, 1.0f, 1.0f, 1.0f));
    nvg::Text(x, midY, statusText);
}
