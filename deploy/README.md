# Deploying Aftercare on Vultr

Two small instances, per the sponsor plan: one for the app and its SQLite volume, one for
LiveKit and TURN. No Kubernetes, no GPU instances, no second TLS service competing with Caddy.

**This has now been run**, on two Atlanta instances against `aftercare.work` (19 September 2026).
One bug surfaced on first use and is fixed here: a `:` inside a `${VAR:?message}` default made
Compose read the line as a nested YAML mapping, so every such message is now quoted. Everything
below completed without further changes.

Still true: a call that works between two tabs on one laptop does not prove the relay works
between networks. Step 3 of the verification is the only thing that does.

## Before you start

Register DNS first; both TLS setups depend on it resolving.

| Host | Points at | Serves |
| --- | --- | --- |
| `app.<domain>` | Instance 1 | Patient page, nurse dashboard, API |
| `rtc.<domain>` | Instance 2 | LiveKit signalling over `wss://` |
| `turn.<domain>` | Instance 2 | TURN relay |

`intake.<domain>` and `careteam.<domain>` are only needed once you register ANS agents; both can
point at instance 1.

## Instance 1 — the application

1. Create a small instance (1 vCPU / 1 GB is enough) with Docker installed.
2. Copy the repository and your `.env` onto it. `.env` must contain `GEMINI_API_KEY`, the
   ElevenLabs values, and the LiveKit key/secret you choose below.
3. Choose dashboard credentials and generate a password hash:

   ```sh
   docker run --rm caddy:2-alpine caddy hash-password --plaintext 'choose-a-real-password'
   ```

4. Start it, passing the domain and those credentials:

   ```sh
   APP_DOMAIN=app.example.com \
   DASHBOARD_USER=careteam \
   DASHBOARD_PASSWORD_HASH='<paste the hash>' \
     docker compose -f deploy/compose.app.yml up -d --build
   ```

`TRUSTED_HOSTS` is set from `APP_DOMAIN` by the compose file. Without it the server answers only
for localhost and returns 403 — that is deliberate, not a misconfiguration.

**On the password.** The application has no authentication of its own and the nurse identity is a
query parameter, so this basic-auth prompt is the only thing between the internet and a patient
worklist plus endpoints that spend your Gemini quota. The compose file and `Caddyfile` both treat
the credentials as required: leave either unset and Caddy refuses to start rather than publishing
the dashboard openly. Share the one credential with your teammates; it is not per-user.

## Instance 2 — LiveKit, TURN, and TLS

The browser connects to `wss://rtc.<domain>`, which is port **443**. LiveKit's own signalling
listener speaks plain HTTP on 7880, so something has to terminate TLS in front of it. Caddy does
that here. Skipping it is not a degraded demo, it is a dead one: the app page is served over
HTTPS, so browsers block a plain `ws://` fallback as mixed content and the handoff fails at the
exact moment it is needed.

1. Create a second instance with Docker and a public IPv4 address.
2. Copy the repository onto it and obtain **one certificate covering both hostnames**. Run this
   before starting any container, while port 80 is free:

   ```sh
   docker run --rm -p 80:80 \
     -v "$PWD/deploy/certs:/etc/letsencrypt" \
     certbot/certbot certonly --standalone --non-interactive --agree-tos \
     -m you@example.com --cert-name aftercare \
     -d rtc.example.com -d turn.example.com
   ```

   This writes `deploy/certs/live/aftercare/{fullchain.pem,privkey.pem}`. Caddy and LiveKit's
   TURN listener both read exactly those files, so there is a single renewal path on this
   instance. Certbot is used instead of Caddy's automatic ACME precisely so that TURN can share
   the certificate; renewal needs port 80, so stop Caddy first, renew, then start it again.

3. Render the LiveKit config, substituting your values:

   ```sh
   TURN_DOMAIN=turn.example.com LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... \
     envsubst < deploy/livekit.yaml > deploy/livekit.rendered.yaml
   ```

4. Start LiveKit and its TLS terminator together:

   ```sh
   RTC_DOMAIN=rtc.example.com docker compose -f deploy/compose.media.yml up -d
   ```

Both containers use host networking: the RTC and TURN port ranges are too wide to publish through
Docker's proxy, and Caddy can only reach LiveKit on `127.0.0.1:7880` from the same network
namespace.

### Firewall

Open these on instance 2, in both the Vultr firewall and any host firewall:

| Port | Protocol | Purpose |
| --- | --- | --- |
| 443 | TCP | `wss://rtc.<domain>` signalling, terminated by Caddy |
| 80 | TCP | Only needed while running or renewing certbot |
| 7881 | TCP | WebRTC over TCP fallback |
| 50000–50200 | UDP | WebRTC media |
| 3478 | UDP | TURN |
| 5349 | TCP | TURN over TLS |

**Leave 7880 closed.** Caddy reaches it over loopback; exposing it publishes unencrypted
signalling alongside the encrypted endpoint.

Missing the UDP range is the usual cause of a call that connects and then carries no audio. If
UDP is blocked on a participant's network — plausible on conference wifi — TURN over TLS on 5349
is what saves the call, so verify that path explicitly rather than assuming it.

## Point the app at the media server

In the app's `.env` on instance 1:

```
LIVEKIT_URL=wss://rtc.example.com
LIVEKIT_API_KEY=<same key as livekit.yaml>
LIVEKIT_API_SECRET=<same secret as livekit.yaml>
```

Restart the app. `GET /api/capabilities` should report `"handoff": true`.

## Verify, honestly

**Check the signalling endpoint positively, before anything else.** The automated browser test
`an unreachable media server is reported as a failure, never as a transfer` asserts the *failure*
path — it points `LIVEKIT_URL` at a host that does not exist and checks the app fails cleanly. A
genuinely broken `wss://` URL in production therefore looks identical to that passing test. The
suite can tell you the failure is handled; it cannot tell you your URL is right. Only this does:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://rtc.example.com/
```

An HTTP status means TLS terminated and LiveKit answered. A connection or TLS error means Caddy
is not listening on 443, and the handoff will fail in the demo exactly as it does in that test.

Then:

1. `curl https://app.example.com/api/health` returns `{"ok":true}` after the auth prompt.
2. `GET /api/capabilities` reports `chat`, `handoff`, and `voice` as you expect.
3. Two people, **two different networks**, two browsers. One opens the patient page, one opens
   `?nurse=<name>`. Request a handoff, accept, and confirm both hear each other.
4. Force the relay path: have one participant block UDP (or use a mobile hotspot with a
   restrictive NAT) and confirm the call still connects through TURN.
5. Decline one handoff and let another ring out, and confirm both leave an urgent callback task.

Only step 3 passing on two networks justifies claiming a working live handoff.
