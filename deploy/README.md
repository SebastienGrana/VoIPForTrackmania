# Deploy configs

Templates for running OnZVoIP on a VPS via systemd (the production setup — not Docker). Fill in the placeholders (`YOUR_VPS_PUBLIC_IP`, `YOUR_API_KEY`/`YOUR_API_SECRET`, `your.domain.example`) before installing.

- **`livekit.yaml`** → `/etc/livekit/livekit.yaml`
- **`livekit.service`** → `/etc/systemd/system/livekit.service`
- **`onzvoip-relay.service`** → `/etc/systemd/system/onzvoip-relay.service` — expects the repo checked out at `/opt/onzvoip-repo` with `server/.env` filled in (`cp server/.env.example server/.env`); edit `WorkingDirectory`/`EnvironmentFile` if you use a different path.
- **`Caddyfile`** → `/etc/caddy/Caddyfile` — reverse-proxies both LiveKit and the relay behind one HTTPS domain (required: the browser mic API needs HTTPS).

```bash
systemctl daemon-reload
systemctl enable --now livekit onzvoip-relay
systemctl reload caddy
```
