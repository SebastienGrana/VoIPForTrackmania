// ImGui window and menu entry.

// Adds "OnZVoIP" to the game's "Plugins" menu (top bar) as a show/hide
// toggle, alongside every other installed plugin's entry there.
void RenderMenu() {
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
    UI::SetNextWindowSize(300, 0, UI::Cond::Always);
    if (connected) {
        UI::Begin("OnZVoIP \\$0f0● connected", UI::WindowFlags::AlwaysAutoResize | UI::WindowFlags::NoResize | UI::WindowFlags::NoScrollbar);
    } else {
        UI::Begin("OnZVoIP \\$f80● Connecting...", UI::WindowFlags::AlwaysAutoResize | UI::WindowFlags::NoResize | UI::WindowFlags::NoScrollbar);
    }

    string serverLogin, serverName, serverFail;
    if (TryGetServerInfo(serverLogin, serverName, serverFail)) {
        UI::Text("Server: " + StripTmCodes(serverName));
        UI::SameLine();
        UI::TextDisabled("(" + serverLogin + ")");
    } else {
        UI::TextDisabled("(not on a server: " + serverFail + ")");
    }

    UI::Separator();
    if (g_nonce != "") {
        UI::Text("Open in your browser:");
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

    // Surfaced here instead of only in Settings → Plugins so players
    // actually find it: shown in red with a hint the moment the relay
    // rejects our connection, not buried until someone thinks to look.
    UI::Separator();
    if (g_authFailed) {
        UI::Text("\\$f00⚠ This relay requires a secret token");
        UI::TextWrapped("\\$888Ask your community admin for it, then paste it below:");
    } else {
        UI::Text("Community token:");
        UI::TextWrapped("\\$888Leave blank unless the admin gave you one.");
    }
    string secretBuf = S_RelaySecret;
    UI::SetNextItemWidth(200);
    // UI::InputText's return type isn't reliably `bool` across OpenPlanet
    // builds (compiling against it in an `if` failed with "found 'string'"
    // on 1.29.5) — detect the edit by diffing the buffer instead.
    UI::InputText("Relay secret", secretBuf, UI::InputTextFlags::Password);
    if (secretBuf != S_RelaySecret) {
        S_RelaySecret = secretBuf;
        g_authSent = false; // retry immediately with the new value, no reconnect needed
    }

    UI::End();
}
