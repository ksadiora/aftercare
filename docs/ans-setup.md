# ANS setup — what to do at the GoDaddy workshop tonight

Callsign's trust card runs five real checks against GoDaddy's Agent Name Service (ANS).
Today the demo runs in `ANS_MODE=local`: this server hosts an ANS-shaped registry (private CA,
X.509 identity certs, Merkle transparency log) and every check is real cryptography. The goal of
the workshop is to get the same two agents registered in GoDaddy's public ANS so we can flip to
`ANS_MODE=real`. If any part of that is not possible tonight, local mode is the demo and nothing
else changes.

Spec: <https://github.com/godaddy/ans-registry> (ANS-1 registration, ANS-2 naming/certs,
ANS-3 DNS, ANS-4 transparency). API: <https://developer.godaddy.com/docs/references/rest/ans/registration>.
Live log: <https://transparency.ans.godaddy.com/> (public, no auth; our verifier already checks
real entries in it).

## 0. At the table: the exact commands

If GoDaddy hands out a credential, this is the whole sequence. Everything else in this document
is the explanation. Run it from the repo root in Git Bash on the laptop, then again on the Vultr
box for the deployment that judges hit.

```bash
export PATH="/c/Program Files/nodejs:$PATH"          # Windows session only

# 1. credential + base URL they give you (Bearer token, or key+secret → sso-key)
cat >> .env <<'EOF'
ANS_API_KEY=<paste>
ANS_API_SECRET=                                        # only if they give a key AND a secret
ANS_API_BASE=https://api.godaddy.com/v1                # or https://api.ote-godaddy.com/v1 for OTE
EOF

# 2. register both agents (resumable; each run tells you the next DNS record to publish)
npm run register-ans -- patel.callsign-hcp.com
#    → publish the _acme-challenge TXT it prints in GoDaddy DNS, re-run
#    → publish the _ans / _ans-badge / TLSA records it prints, re-run until ACTIVE
npm run register-ans -- stelazio.brand-demo.com
#    same two DNS round-trips

# 3. confirm from a third party's point of view (no auth, public data)
nslookup -type=TXT _ans-badge.stelazio.brand-demo.com 8.8.8.8
curl -s https://transparency.ans.godaddy.com/v1/agents/<agentId-from-the-badge-TXT> | head -c 400
npm run register-ans -- stelazio.brand-demo.com --status

# 4. optional: pin GoDaddy's ANS CA so the certificate step also checks the issuer chain
#    (if they hand you the CA PEM, or register-ans saved <host>.chain.pem)
echo 'ANS_CA_PEM_FILE=server/keys/stelazio.brand-demo.com.chain.pem' >> .env

# 5. flip the mode and restart; then run the five attacks and the brand call once
sed -i 's/^ANS_MODE=.*/ANS_MODE=real/' .env
npm run start -w server
for v in no-record forged-cert tampered replay wrong-specialty; do
  curl -s -X POST localhost:8787/api/demo/impostor -H 'content-type: application/json' -d "{\"variant\":\"$v\"}"; sleep 5
done
curl -s -X POST localhost:8787/api/demo/brand-call
```

If step 2 stalls at any point, leave `ANS_MODE=local` and use Plan B (section 6) or nothing at
all: the demo is identical on screen, and every step's evidence drawer says which registry it
used.

## 0.1 What a judge can verify independently

Every verification is a public, self-contained record. `GET /api/proof/<requestId>` returns the
`ProofBundle`: the request as received (`id`, `from`, `to`, `claimedDisplayName`, `kind`, `ts`,
`signature`, and the SHA-256 of the payload), the full `VerificationResult` with each step's
`status`, `detail` and `evidence` rows (the DNS text that was read, the certificate's subject /
SAN / issuer / fingerprint, the log's leaf index, leaf hash, root hash and checkpoint signer, the
canonical message hash and the replay-window verdict), and `registry.mode` plus `registry.base`.
The `requestId` is in the trust card and in the response to `POST /api/demo/*`. In `real` mode
the evidence points at public DNS and <https://transparency.ans.godaddy.com>, so a judge can
`nslookup` the TXT record and fetch the badge themselves; in `local` mode `registry.base` is this
server's `/ans` and the same URLs are served there: `/ans/dns/<name>` (the zone), `/ans/ca.pem`
(the trust anchor), `/ans/v1/agents/<agentId>` (sealed event + Merkle proof + signed checkpoint),
`/ans/v1/agents/<agentId>/receipt`, `/ans/root-keys` and `/ans/v1/log/audit` (the hash chain).
Nothing in the bundle needs a key on the server to re-check: leaf hash, inclusion path,
checkpoint JWS and the ES256 message signature can all be recomputed from what it contains.

## 1. Our two agents

| Agent | ANS name (`ANS_MODE=real`) | Domain | Where the domain comes from |
| --- | --- | --- | --- |
| Doctor's Callsign agent | `ans://v1.0.0.patel.callsign-hcp.com` | `callsign-hcp.com` | MLH GoDaddy Registry code |
| Brand agent (Stelazio) | `ans://v1.0.0.stelazio.brand-demo.com` | `brand-demo.com` | bought separately |
| Impostor | `stelazio-updates.xyz` | none | never registered, on purpose |

Hostnames come from `.env` (`HCP_AGENT_NAME`, `BRAND_AGENT_NAME`). If the domains we end up with
differ, change those two values first; everything below derives from them.

## 2. Ask GoDaddy for

1. **An ANS API credential.** The developer portal lists the ANS API as "Auth: PAT". We need
   whatever they hand out for `POST https://api.godaddy.com/v1/agents/register`. Put it in `.env`:
   - `ANS_API_KEY=<token>` — sent as `Authorization: Bearer <token>`
   - if they give a key *and* secret (classic GoDaddy style), also set `ANS_API_SECRET=` and the
     script switches to `Authorization: sso-key KEY:SECRET`.
   - confirm the base URL: production `https://api.godaddy.com/v1` or OTE
     `https://api.ote-godaddy.com/v1` → `ANS_API_BASE=`.
2. **Whether external domains (ours) are accepted on the hackathon credential**, or only
   GoDaddy-registered domains. Both of ours are GoDaddy domains, which is the synchronous
   "GoDaddy domains with CSRs" flow in their docs — ask if that means the ACME step is automatic.
3. **The ANS private CA certificate (PEM)** that issues Identity Certificates
   (`CN=Agent Name Service CA,O=GoDaddy`). Optional: if we get it, save it as
   `server/keys/ans-ca.pem` and set `ANS_CA_PEM_FILE=server/keys/ans-ca.pem` so the certificate
   step also pins the issuer chain. Without it the certificate is anchored by the fingerprint the
   transparency log sealed, which is already a real check.
4. **`transports` enum values** for the registration body (docs show `STREAMABLE-HTTP`, `JSON-RPC`,
   `REST`). We omit the field; confirm that is accepted.

## 3. Point the domains at the Vultr box

In GoDaddy DNS for **each** domain (`callsign-hcp.com`, `brand-demo.com`):

| Type | Name | Value |
| --- | --- | --- |
| A | `patel` (on callsign-hcp.com) | `<Vultr IPv4>` |
| A | `stelazio` (on brand-demo.com) | `<Vultr IPv4>` |

Then on the box: `PUBLIC_BASE_URL=https://patel.callsign-hcp.com` in `.env`, and a TLS
terminator (Caddy is the least typing: `patel.callsign-hcp.com { reverse_proxy localhost:8787 }`).
The brand host only needs to resolve; it does not need to serve anything for the demo, but
`https://stelazio.brand-demo.com/.well-known/agent.json` is the metadata URL we register, so
pointing it at the same box is fine.

## 4. Register with GoDaddy ANS

```bash
export PATH="/c/Program Files/nodejs:$PATH"   # Windows session
npm run register-ans -- patel.callsign-hcp.com
npm run register-ans -- stelazio.brand-demo.com
```

Each run is resumable (progress in `server/keys/<host>.ans.json`). What the script does, and
what you do between runs:

1. Generates the P-256 key (`server/keys/<host>.key`) and two CSRs: identity CSR with
   `URI:ans://v1.0.0.<host>` as SAN (ANS-2 §3) and a server CSR with `DNS:<host>`.
   `--csr-only` prints them if GoDaddy wants us to paste CSRs into a portal instead.
2. `POST /v1/agents/register` → prints the **ACME challenge** TXT (`_acme-challenge.<host>`).
   **Publish it in GoDaddy DNS.** The script polls public DNS, then calls `verify-acme`.
3. Prints the **ANS records** the RA wants (from `GET /v1/agents/{agentId}`):
   `_ans.<host>` TXT, `_ans-badge.<host>` TXT, `_443._tcp.<host>` TLSA (and/or an SVCB row).
   **Publish them in GoDaddy DNS.** The script polls, then calls `verify-dns` → `ACTIVE`.
4. Saves the issued identity certificate to `server/keys/<host>.pem` (+ `<host>.chain.pem`) and
   prints the transparency receipt after verifying it locally (leaf hash, inclusion path,
   signed checkpoint against `https://transparency.ans.godaddy.com/root-keys`).

`npm run register-ans -- <host> --status` dumps the RA's view if something looks stuck.

## 5. Switch the server to real mode

```
ANS_MODE=real
```

Restart. In real mode the pipeline does, per inbound message:

| Step | What is checked | Source |
| --- | --- | --- |
| resolve | `_ans-badge.<from>` TXT exists (also accepts `_ra-badge`, and reads `_ans.<from>`) | public DNS via `node:dns`, 1.5 s cap |
| certificate | sender's presented cert: URI SAN = `ans://v<ver>.<from>`, validity window, optional CA chain (`ANS_CA_PEM_FILE`) | message `certificatePem` |
| transparency | badge from the URL in the TXT record: recompute leaf hash, walk Merkle path, verify checkpoint JWS against `/root-keys`, status ACTIVE, cert fingerprint sealed | `https://transparency.ans.godaddy.com` |
| signature | ES256 over the canonical message with the key inside that certificate, then the replay window: `ts` within 5 min past / 2 min future, `(from, id)` not verified before in this process | message |
| policy | specialty relevance, call window | doctor profile |

In real mode the certificate step fetches the badge first and pins the presented certificate to
the fingerprint GoDaddy sealed; the transparency step then verifies that badge's inclusion proof
and checkpoint. The same code runs in `local` mode against this server's registry.

### The five attacks (`POST /api/demo/impostor {"variant": ...}`)

| Variant | What the attacker sends | Fails at | Detail on the card (local mode) |
| --- | --- | --- | --- |
| `no-record` | `stelazio-updates.xyz`, its own key, no ANS record anywhere | resolve | `no ANS record for stelazio-updates.xyz` |
| `forged-cert` | claims `stelazio.brand-demo.com` and presents a certificate for that exact ANS name, minted by its own "Stelazio Updates Root CA" over its own key | certificate | `presented certificate rejected: issuer not trusted (Stelazio Updates Root CA, not Callsign Local ANS CA (demo)) · fingerprint … is not the one sealed for this agent (…)` |
| `tampered` | a genuine brand message whose dosing text was edited after signing (5 mg → 50 mg) | signature | `signature does not match message body · key in the identity certificate for ans://v1.0.0.stelazio.brand-demo.com` |
| `replay` | the last genuine brand message, resent with the same id and a timestamp 11 min old | signature | `signature valid, but message is 11 min old · replay window is 5 min · message id already verified at 10:42:03` |
| `wrong-specialty` | genuine brand, genuine certificate, a nephrology update | none (policy holds it) | `not relevant to Cardiology · held in inbox` |

The forged certificate is real X.509 (same tooling as the registry, `server/keys/forged-stelazio.brand-demo.com.pem`,
rogue CA in `server/keys/stelazio-updates-rogue-ca.pem`), minted at boot. In `real` mode the
variants behave the same way; `forged-cert` fails because its fingerprint is not the one sealed in
GoDaddy's log (and the issuer chain, if `ANS_CA_PEM_FILE` is set).

## 6. Plan B: publish the local registry's records in GoDaddy DNS

If GoDaddy's API is not available tonight, we can still make the resolve step hit **public DNS**
while the certificate/log checks stay on our box. The registry router is mounted at `/ans` in
`server/src/index.ts`, so `GET https://patel.callsign-hcp.com/ans/zone` prints the exact records. With the default
names and `PUBLIC_BASE_URL=https://patel.callsign-hcp.com` they are:

```
; callsign-hcp.com zone
_ans.patel.callsign-hcp.com.        3600 IN TXT  "v=ans1; version=v1.0.0; p=a2a; mode=direct; url=https://patel.callsign-hcp.com/reach"
_ans-badge.patel.callsign-hcp.com.  3600 IN TXT  "v=ans-badge1; version=v1.0.0; url=https://patel.callsign-hcp.com/ans/v1/agents/3d25e5ef-3c45-48aa-bf28-fa010a115b2d"
patel.callsign-hcp.com.             3600 IN SVCB 1 . alpn=a2a port=443 key65400=https://patel.callsign-hcp.com/.well-known/agent.json key65402=a2a key65409=agent.json

; brand-demo.com zone
_ans.stelazio.brand-demo.com.       3600 IN TXT  "v=ans1; version=v1.0.0; p=a2a; mode=direct; url=https://stelazio.brand-demo.com/reach"
_ans-badge.stelazio.brand-demo.com. 3600 IN TXT  "v=ans-badge1; version=v1.0.0; url=https://patel.callsign-hcp.com/ans/v1/agents/1c07a3a6-b304-4ff1-a078-db7cd9e0cfc7"
stelazio.brand-demo.com.            3600 IN SVCB 1 . alpn=a2a port=443 key65400=https://stelazio.brand-demo.com/.well-known/agent.json key65402=a2a key65409=agent.json
```

In GoDaddy's DNS editor that is: Type `TXT`, Name `_ans.patel`, Value `v=ans1; version=v1.0.0; …`
(GoDaddy adds the zone). The agent IDs are deterministic (derived from the ANS name), so they
are stable across restarts; copy them from `/ans/zone` to be safe. Skip the SVCB rows if the
editor rejects `key65400=`; only the `_ans-badge` TXT is required by the verifier.

Then set `ANS_LOCAL_PUBLIC_DNS=1` (stays in `ANS_MODE=local`). The resolve step now tries public
DNS first (1.2 s cap) and the card says "found via DNS"; certificate, transparency and signature
verify against our registry as before. If DNS is not published or is slow, it falls back to the
local zone, so the demo cannot break because of this.

## 7. Verify by hand

```bash
# a verdict, with the evidence behind every step (works in every mode)
curl -s -X POST localhost:8787/api/demo/impostor -H 'content-type: application/json' -d '{"variant":"replay"}'
curl -s localhost:8787/api/proof/<requestId> | jq '.result.steps[] | {id, status, detail, evidence}'

# local registry
curl -s localhost:8787/ans/                       # agents + endpoints
curl -s localhost:8787/ans/dns/_ans-badge.stelazio.brand-demo.com   # the TXT the resolve step read
curl -s localhost:8787/ans/v1/agents/<agentId>    # badge: sealed event + Merkle proof + signed checkpoint
curl -s localhost:8787/ans/v1/agents/<agentId>/receipt
curl -s localhost:8787/ans/v1/log/audit           # hash chain
openssl verify -CAfile server/keys/local-ans-ca.pem server/keys/stelazio.brand-demo.com.pem
openssl x509 -in server/keys/stelazio.brand-demo.com.pem -noout -ext subjectAltName
openssl verify -CAfile server/keys/local-ans-ca.pem server/keys/forged-stelazio.brand-demo.com.pem   # fails: the forgery

# public ANS
nslookup -type=TXT _ans-badge.stelazio.brand-demo.com 8.8.8.8
curl -s https://transparency.ans.godaddy.com/v1/log/checkpoint
```

## 8. Env summary

| Variable | Default | Meaning |
| --- | --- | --- |
| `ANS_MODE` | `local` | `mock` (canned resolve/log, real signature + replay + policy) · `local` (this server's registry, real crypto) · `real` (GoDaddy ANS) |
| `ANS_API_KEY` / `ANS_API_SECRET` | — | RA credential for `register-ans` (Bearer, or sso-key when both set) |
| `ANS_API_BASE` | `https://api.godaddy.com/v1/ans` | RA base; a trailing `/ans` is stripped, so `https://api.godaddy.com/v1` is what gets used |
| `ANS_TL_BASE` | `https://transparency.ans.godaddy.com` | badge URLs must live under this in real mode |
| `ANS_CA_PEM_FILE` | — | optional GoDaddy ANS private-CA PEM to pin the issuer chain |
| `ANS_AGENT_VERSION` | `1.0.0` | version segment of our ANS names |
| `ANS_LOCAL_PUBLIC_DNS` | unset | `1` = in local mode, try public DNS before the local zone |
