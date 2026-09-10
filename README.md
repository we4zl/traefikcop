# TraefikCop

A local web application editor for multiple remote Docker Traefik hosts. A Weazl app.

## Run

```bash
# Node.js 22.13+ (Node 24+ recommended)
npm install
npm start
```

Open http://localhost:3001. Create a local administrator account on first use (minimum 12-character password). Existing accounts survive upgrades; a server restart signs out existing sessions.

For a portable Docker installation (Docker Engine and the Compose plugin required; no local Node or SSH directory needed):

```bash
git clone https://github.com/bprendie/traefikcop.git
cd traefikcop
docker compose up -d --build
```

The container is named **`traefikcop`** and listens on **port `3001`**. Compose builds the image from this checkout, publishes `127.0.0.1:3001`, checks the app's health, and restarts it unless stopped. No prebuilt registry image is required.

For Docker running on a remote server, forward its localhost port and open `http://localhost:3001` on your computer:

```bash
ssh -N -L 3001:127.0.0.1:3001 deploy@example.test
```

Replace the example SSH destination with your Docker server. To update, run `git pull` followed by `docker compose up -d --build`. `docker compose down` preserves the named data volume; `docker compose down -v` deletes it.

Open the same localhost URL. The named `traefikcop-data` volume contains the local account, host settings, history, and generated SSH keys. Do not delete this volume when upgrading. This starts an empty workspace; it does not import an existing `.data` directory automatically. If the development server already occupies port 3001, stop it before starting this deployment.

New workspaces start empty. Create your administrator account and add your first connection under **Hosts**. Existing local accounts and connections stay in the private data directory.

## Add a host and request its first certificate

**Hosts → Add host** guides you through four steps:

1. Enter the SSH hostname/IP, user and port. Generate an Ed25519 key in the app or reuse an app-managed key. Expand Traefik settings if its container name or static config path differs from the defaults.
2. Copy the public-key installation commands into that server's existing SSH session or hosting-provider console, as the selected SSH user. The wizard includes prerequisites and Docker-permission instructions. The computer running your browser does not need Linux, SSH, or a private key file.
3. Compare the scanned fingerprint with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` from the trusted server console. Confirm the match, then test SSH and Docker access. Future connections enforce that pinned key.
4. Choose **Get a Let’s Encrypt certificate**, or finish and return later through the host details or **Certificates → Get a certificate**.

For HTTPS setup, enter a domain and choose wildcard coverage. Reuse an existing production ACME resolver, or supply an email address and a scoped Cloudflare API token. The token needs **Zone / Zone / Read** and **Zone / DNS / Edit** for the relevant zone ([official provider instructions](https://go-acme.github.io/lego/dns/cloudflare/)). Zone access is checked before review; DNS write permissions are exercised during Traefik's ACME challenge. The flow does not create application A/AAAA records.

Review the changes before applying:

- **Existing resolver:** add a small certificate-request router to the watched dynamic file. No restart or application deployment is needed. Existing application routes are preserved.
- **Fresh Docker host:** install `traefik:v3.7.13` with Docker Compose, ports 80/443, HTTP-to-HTTPS redirect, a private application Docker network, watched YAML configuration, Cloudflare DNS validation, and persistent ACME storage. Files live under the SSH user's `~/traefikcop/<container>` directory. Existing containers or setup directories are not overwritten.
- **Existing Compose deployment without Cloudflare:** add the resolver, secret-file mount and persistent ACME storage, then recreate only the Traefik service. This briefly interrupts traffic. Static, dynamic and Compose files are backed up, conflict-checked, and updated without replacing bind-mounted inodes. A failed recreation attempts to restore the original files and service; the result is reported explicitly.

The certificate request runs on the server after the dialog closes. **Certificates → Certificate requests** shows progress and lets you check again. “Waiting” means the configuration was installed but a matching, in-date Let’s Encrypt certificate has not yet been observed. “Ready” requires observing domain coverage, including wildcard coverage when requested. This does not verify the full public trust chain. Checks use the host loopback HTTPS port, so unusual Docker port mappings can prevent detection. DNS validation can take several minutes; persistent waiting requires checking Traefik's ACME logs, nameservers and token permissions.

Traefik retains a reserved `traefikcop-certificate-…` router using `noop@internal`, a low-priority path match, and explicit TLS domains. These setup routers are omitted from the application list. They initiate issuance and remain configured for renewal. They do not proxy to a backend application. Traefik manages automatic renewal; there is no force-renew button ([Traefik ACME documentation](https://doc.traefik.io/traefik/reference/install-configuration/tls/certificate-resolvers/acme/)).

The Cloudflare token is sent over SSH via stdin and saved in a 0600 file on the remote host, referenced with `CF_DNS_API_TOKEN_FILE`. It is held only in the app's temporary review/job memory and is not written into the local state database or returned by APIs. Traefik reads that file for future renewals. Back up the remote deployment and ACME directory too.

## Publish and edit applications

1. Complete certificate setup above, which creates the domain profile automatically. Alternatively, use **Domains → Add domain** to bind a profile to an existing resolver without requesting a certificate immediately.
2. Under **Applications → Add application**, enter name/subdomain, domain, internal address, and backend port. Enable **HTTPS backend** only when the internal application uses HTTPS.
3. Review the public hostname and destination, then apply the change.

New applications use HTTPS and the selected certificate resolver automatically. Wildcard profiles request the domain and `*.domain` certificate through Traefik when a route is published. DNS records must already point to the correct host. A configured resolver does not prove that its credentials or certificate issuance work.

Existing single-hostname, single-backend file routes can be edited in place. Edits retain TLS settings, middleware references, priorities, backend transport options, and backend URL paths. A dedicated backend definition avoids changing other routers sharing the original backend. Original backend definitions are retained to protect cross-file references.

Applications can be disabled, enabled, or deleted. Disabled routers are removed from the active file, with their definitions retained in private local state for re-enabling. Deleting removes the router; it does not delete containers or shared backend definitions.

**History** records each change and can restore the previous file and application enabled state. Restore the newest change first; newer or external edits block rollback instead of being overwritten.

## How saves work

- Read the configured active file provider and resolve its Docker bind mount to the host path.
- Verify the host file matches the mounted file. Require `watch` to be enabled.
- Parse and modify YAML while retaining unrelated configuration and comments where possible.
- Use a file fingerprint to reject stale previews and external edits.
- Persist a private local before/after journal before the remote write.
- Lock the remote file and save a 0600 backup in `.traefikcop-history/<revision>.bak` next to it.
- Write through the existing inode so single-file Docker bind mounts remain valid; verify the bytes visible inside the container.
- Refresh discovery and backend health.

The file watcher applies changes without restarting Traefik. Writes are verified in the container; the production runtime API is not yet queried to confirm acceptance. Invalid or unsupported pre-existing configuration may still require manual diagnosis. Interrupted writes are reported as uncertain in History; refresh and inspect the latest change before retrying. Do not restore an entire file if another administrator's newer edits must be retained.

## Backend health

Green means the configured TCP port accepted a connection **from inside the Traefik container**; red means it was unreachable. Amber indicates mixed results across backends. Gray means no probe was performed. A port check does not validate HTTP responses, TLS, or application health. Per-backend details include the check time and result.

Checks run on login, manually, and every 60 seconds while the page is visible and no dialog is open. SSH errors clear the previous live snapshot. Docker-label backends and internal dashboard routes have no automatically resolved backend URL and therefore are not probed.

## Egress traffic and history

Applications and Overview show a clickable rolling 10-minute egress graph. Click it, or open **Traffic**, for 10-minute, 1-hour, 6-hour, 24-hour, 7-day and 30-day views. The host selector scopes both current and historical graphs. Rates use bytes per second; totals show observed outbound bytes.

The server samples `/proc/net/dev` from the Traefik container every 15 seconds, excluding loopback. This includes client responses, backend requests, and other container network traffic; it is not a per-application or internet billing metric. Host/shared-container network namespaces are excluded because their counters cannot isolate Traefik.

Collection continues with the browser closed while TraefikCop runs. History is retained for 30 days in `.data/traffic.sqlite` (SQLite WAL mode). Container restarts, counter resets, failed samples and gaps longer than 45 seconds break the rate series. Unknown intervals are not plotted as zero. Totals include only observed intervals; coverage indicates missing data. Historical graph points average observed intervals within the displayed bucket. Amber segments have partial time or host coverage. No traffic before collection started can be reconstructed.

## Served certificates and automatic renewal

Certificates shows the leaf certificates actually served by Traefik, obtained through TLS handshakes from the Docker host to its loopback HTTPS port, using each route's hostname as SNI. Identical certificates are combined into one card, showing issuer, wildcard/domain coverage, validity dates, days remaining and fingerprints. No private keys or ACME storage are read. A failed handshake is displayed explicitly; unusual port publishing or bind addresses may require a future probe-address setting.

Traefik automatically renews certificates it manages through ACME. The UI links served certificates to matching route/resolver configuration. For the default 2160-hour certificate duration it displays a renewal window starting 30 days before expiry. This is configuration evidence, not verification of ACME account ownership or successful renewal. **Check now** refreshes the served certificate. There is no force-renew operation.

## Remote connection requirements

- SSH address resolvable and reachable from this machine.
- Noninteractive Docker access for the SSH user.
- App-managed SSH key and verified server fingerprint from the wizard. Legacy connections can continue to use the configured SSH directory and existing `known_hosts`; encrypted legacy keys require an unlocked SSH agent inherited by the app.
- Python 3 (including SSL support) on the Docker host, plus `nc -z -w` inside Traefik for port checks.
- Host write permission on the active dynamic config and its parent directory for backups.

Discovery and health checks remain read-only. Installation and resolver creation occur only after applying the wizard’s review. Remote setup requires Docker Compose, permissions to update the relevant files, and outbound access to Cloudflare and Let’s Encrypt; fresh installation also needs image-registry access.

## Current boundaries

Automatic resolver creation on existing hosts supports a single Compose file, YAML static configuration, a watched file-provider filename with bind mounts, and Traefik running as root inside its container. Compose include/extends, CLI/environment static configuration, and multiple Compose files require manual resolver setup; existing resolvers can still be used. Existing Cloudflare credentials are preserved: reuse the configured resolver instead of replacing its token. Fresh installation requires an unused container name and free ports 80/443. Docker Engine installation, DNS A/AAAA record management, key import/deletion, and arbitrary deployment adoption are not automated.

The simple form supports YAML file-provider HTTP routes with one `Host()` match and one HTTP/HTTPS backend. Compound rules, multiple backends, credentials embedded in backend URLs, Docker-label adoption, TCP/UDP editing, and arbitrary YAML editing are excluded. For a directory provider, new applications are added to an existing discovered route file; creating the first file in an empty provider directory is not supported.

Discovery is bounded to 30 YAML files and 100 containers per host. Health checks cover up to 24 distinct backend URLs with eight parallel checks and five-second per-check deadlines. Certificate expiry and hostname coverage are inspected from served TLS certificates. Public DNS/HTTP reachability and certificate-chain trust checks are not implemented.

## Authentication and storage

The local Node server defaults to `127.0.0.1`; the Docker image listens inside its container and Compose publishes only to `127.0.0.1`. The server validates Host and Origin headers, hashes passwords with salted scrypt, uses HttpOnly/SameSite cookies and CSRF tokens, and throttles logins. Sessions expire after eight hours. Public or reverse-proxy deployment is not configured.

State lives in `.data/state.json` (0600 inside a 0700 directory). It contains the administrator hash, host/domain profiles, disabled application definitions, and full configuration rollback records, which may contain sensitive configuration. Keep it private and back it up. App-managed keys and host-key pins live in `<data directory>/ssh` (0700), with private keys stored as 0600 files. They are not encrypted at rest: protect and securely back up the data directory or Docker volume. Settings → SSH keys displays public keys and fingerprints only. Legacy keys remain in their previous directory until you use “Set up app-managed SSH” in the host details. Neither raw configuration history nor middleware credentials are returned to the browser.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | Local HTTP port |
| `TRAEFIKCOP_DATA_DIR` | `.data` | Private state directory |
| `TRAEFIKCOP_SSH_DIR` | `~/.local/share/traefikcop/ssh` | Legacy SSH key directory |
| `LISTEN_ADDRESS` | `127.0.0.1` | Bind address; Docker image uses `0.0.0.0` internally |

## Validation

```bash
npm test
# Requires local Docker, traefik:v3.7.13, and Playwright Chromium:
node scripts/editor-browser-check.mjs
# Fresh install, resolver setup/rollback, app keys, wizard and certificate progress:
node scripts/onboarding-check.mjs
# Traffic and certificate UI test uses a disposable container and generated test certificate:
node scripts/traffic-browser-check.mjs
```

The browser integration check creates an isolated local Traefik container and temporary user database. It exercises real file writes and runtime reloads for add, edit, disable, enable, delete, and rollback. No production config or account is changed. Test ACME points to a deliberately unusable local endpoint; no public certificate requests are made.

## Keeping deployments private

This repository contains application code and synthetic tests only. Runtime state, SSH keys, Cloudflare tokens, ACME accounts, certificates, configuration backups, logs, and screenshots are excluded from Git and Docker build contexts. Keep custom `TRAEFIKCOP_DATA_DIR` and `TRAEFIKCOP_SSH_DIR` locations outside your checkout. Never force-add runtime files to Git.

All tests use isolated temporary state and example domains. Browser tests generate disposable credentials and certificates; none need access to a personal server. Test screenshots are written to the temporary directory, not the repository.

The reviewed Weazl artwork at `public/assets/weazlhead.jpg` is the sole image exception to the default screenshot exclusions. The supplied file was JPEG-encoded despite its `.png` filename; the published asset uses the correct extension and preserves the original image bytes. Its metadata contains no EXIF fields, only a standard sRGB color profile.
