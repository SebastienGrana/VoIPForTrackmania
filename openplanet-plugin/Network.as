// Relay connection and protocol: opening the TCP socket, exchanging the
// HTTPS auth token, and issuing nonces for the "Copy URL" link.

// Generates a fresh nonce, registers it with the relay, and remembers it for
// the "Copy URL" button in RenderInterface().
void SendNonce(const string &in login, const string &in serverLogin, const string &in serverName, int64 now) {
    g_nonce = GenerateNonce();
    g_nonceServerLogin = serverLogin;
    g_nonceSentAt = now;
    string line = "{\"type\":\"nonce\","
        + "\"nonce\":\"" + g_nonce + "\","
        + "\"login\":\"" + login + "\","
        + "\"server\":\"" + serverLogin + "\","
        + "\"serverName\":\"" + EscapeJsonStr(serverName) + "\"}\n";
    g_socket.WriteRaw(line);
    string target = serverLogin != "" ? "server \"" + serverLogin + "\"" : "global room";
    print("OnZVoIP: nonce sent for " + target + " → ?t=" + g_nonce);
}

// Audit #35: used to be a timestamp/counter XOR-mix, not a CSPRNG — findable
// via OpenPlanet's Crypto namespace instead. 6 bytes of real entropy, encoded
// URL-safe (no +, /, or = to escape when embedded in "?t=" or a JSON string).
string GenerateNonce() {
    return Crypto::RandomBase64(6, true);
}

void TryConnect() {
    print("OnZVoIP: connecting to " + S_RelayHost + ":" + S_RelayPort + "...");
    @g_socket = Net::Socket();
    if (!g_socket.Connect(S_RelayHost, uint16(S_RelayPort))) {
        print("OnZVoIP: Connect() returned false immediately (relay unreachable at that host:port?)");
        @g_socket = null;
    }
}

// Trades the permanent community secret for a short-lived, single-use token
// via an HTTPS POST to the relay's web server (the same host serving
// S_VoipUrl, behind TLS in production), instead of ever writing the
// permanent secret onto the raw, unencrypted TCP socket. Only the disposable
// token travels over that plaintext socket. Blocks (via yield()) until the
// HTTP call finishes or fails; the caller treats "" as failure and drops the
// socket to retry through the normal reconnect path.
string FetchAuthToken() {
    string body = "{\"secret\":\"" + EscapeJsonStr(S_RelaySecret) + "\"}";
    Net::HttpRequest@ req = Net::HttpPost(S_VoipUrl + "/tcp-auth", body, "application/json");
    while (!req.Finished()) yield();

    if (req.ResponseCode() == 404) {
        // Relay has no TCP_SHARED_SECRET configured — it doesn't expose /tcp-auth
        // at all. The user's secret setting is irrelevant; connect without auth.
        print("OnZVoIP: /tcp-auth → 404 (relay has no secret configured) — connecting without auth");
        return "__no_auth__";
    }
    if (req.ResponseCode() != 200) {
        print("OnZVoIP: /tcp-auth failed (HTTP " + req.ResponseCode() + ") — secret rejected");
        return "";
    }

    Json::Value@ json = Json::Parse(req.String());
    if (json is null || !json.HasKey("token")) {
        print("OnZVoIP: /tcp-auth returned an unexpected response");
        return "";
    }
    return string(json["token"]);
}
