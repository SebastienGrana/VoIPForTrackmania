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

// Generates an 8-char hex nonce. Not cryptographically random but hard
// enough to guess in the 2-minute window: the relay also checks login+server
// match, and nonces are single-use.
string GenerateNonce() {
    // XOR-mix of timestamp + counter so two calls in the same millisecond differ.
    uint t = uint(Time::Now) ^ uint(g_nonceCounter++ * 2654435761);
    t ^= t >> 16;
    t *= 0x45d9f3b;
    t ^= t >> 16;
    string hex = "0123456789abcdef";
    string result = "";
    for (int i = 7; i >= 0; i--) {
        result += hex.SubStr(int((t >> uint(i * 4)) & uint(0xF)), 1);
    }
    return result;
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

    if (req.ResponseCode() != 200) {
        print("OnZVoIP: /tcp-auth failed (HTTP " + req.ResponseCode() + ") — wrong secret, or relay has none configured?");
        return "";
    }

    Json::Value@ json = Json::Parse(req.String());
    if (json is null || !json.HasKey("token")) {
        print("OnZVoIP: /tcp-auth returned an unexpected response");
        return "";
    }
    return string(json["token"]);
}
