// JSON and Trackmania string helpers.

// Escapes " and \ for safe JSON string embedding.
// TM logins are safe as-is; server names are free text so escaping is needed.
string EscapeJsonStr(const string &in s) {
    string result = "";
    for (int i = 0; i < int(s.Length); i++) {
        string c = s.SubStr(i, 1);
        if      (c == "\"") result += "\\\"";
        else if (c == "\\") result += "\\\\";
        else                 result += c;
    }
    return result;
}

// Strips Trackmania $-formatting codes from a display string.
// Rules: $$ → literal $, $[0-9a-fA-F]{1,3} → color (skip), $l/$h[...] → link (skip brackets too),
// any other $X → style code (skip 2 chars).
string StripTmCodes(const string &in s) {
    string result = "";
    int len = int(s.Length);
    int i = 0;
    while (i < len) {
        string c = s.SubStr(i, 1);
        if (c != "$") { result += c; i++; continue; }
        if (i + 1 >= len) { i++; continue; } // trailing $ — drop it
        string next = s.SubStr(i + 1, 1);
        if (next == "$") { result += "$"; i += 2; continue; } // $$ → $
        // Color code: 1–3 hex digits
        int hexLen = 0;
        for (int j = 1; j <= 3 && (i + j) < len; j++) {
            string h = s.SubStr(i + j, 1);
            if ((h >= "0" && h <= "9") || (h >= "a" && h <= "f") || (h >= "A" && h <= "F"))
                hexLen = j;
            else
                break;
        }
        if (hexLen > 0) { i += 1 + hexLen; continue; }
        // Link/URL codes: skip optional [...] after $l / $h
        if (next == "l" || next == "h") {
            i += 2;
            if (i < len && s.SubStr(i, 1) == "[") {
                i++; // skip [
                while (i < len && s.SubStr(i, 1) != "]") i++;
                if (i < len) i++; // skip ]
            }
            continue;
        }
        // Any other style code — just skip $X
        i += 2;
    }
    return result;
}

// Trackmania logins/floats never contain a JSON-breaking character, so plain
// concatenation is safe for those — EscapeJsonStr is only needed for server names.
string FormatFloat(float v) {
    return "" + v;
}

// A duration a player reads at a glance — "0.4 s", "12 s", "3 min" — for the
// widget's Advanced diagnostics. One decimal only under ten seconds, because
// past that the exact tenth says nothing the whole number doesn't. Built from
// integer arithmetic rather than a float format so it carries no dependency
// beyond the language itself.
string FormatAgo(int64 ms) {
    if (ms < 0) ms = 0;
    if (ms < 10000) {
        int64 tenths = ms / 100;
        return "" + (tenths / 10) + "." + (tenths % 10) + " s";
    }
    if (ms < 60000) return "" + (ms / 1000) + " s";
    return "" + (ms / 60000) + " min";
}
