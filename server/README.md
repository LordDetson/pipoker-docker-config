# PiPoker server

Runs the QA and PROD environments side by side on one Docker host (for example a home server),
behind Caddy with automatic HTTPS.

```
Caddy (80, 443) ── PROD_DOMAIN ── /ws → prod-backend, rest → prod-web
                └─ QA_DOMAIN   ── /ws → qa-backend,   /grafana → grafana, rest → qa-web
pipoker-prod:       mongodb, rabbitmq, backend, web
pipoker-qa:         mongodb, rabbitmq, backend, web
pipoker-monitoring: prometheus (scrapes both backends), grafana
```

The server pulls new versions itself, so GitHub never connects to it:
- every push to main of [pipoker-app](https://github.com/LordDetson/pipoker-app) and
  [pipoker-web](https://github.com/LordDetson/pipoker-web) publishes images tagged `qa`;
- the **Promote to PROD** workflow in those repositories (with approval) tags a commit that was checked on QA as `prod`;
- `./update`, run by cron every 2 minutes, pulls the `qa` and `prod` images and restarts what changed.

## Requirements

- Linux with Docker and the compose plugin, switched on all the time.
- A Cloudflare account (free) with the site's domain `pipoker.app` on it. Requests reach the server through a
  Cloudflare Tunnel (see "How requests reach the server" below), an outbound connection, so the server needs
  no public IP of its own and no forwarded ports, and its home address stays hidden.

## Setup

1. Put the domain on Cloudflare. `pipoker.app` is registered at hoster.by with its DNS on Cloudflare (free
   plan). The tunnel creates the `pipoker.app` and `qa.pipoker.app` records itself (see "How requests reach
   the server"), each a proxied CNAME to the tunnel, so there is nothing to point at the server by hand.
   Set `CLOUDFLARE_API_TOKEN` in `caddy/.env` (see that file) so Caddy renews the certificates with a DNS-01
   challenge, which works behind the proxy. At home the router doesn't loop the public address back, so the
   home DNS (AdGuard) rewrites each domain to the server's LAN address.
2. Install Docker:
   ```
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker $USER   # log in again afterwards
   ```
3. Clone this repository and create the configuration:
   ```
   git clone https://github.com/LordDetson/pipoker-docker-config.git
   cd pipoker-docker-config/server
   cp qa.env.example qa.env && cp prod.env.example prod.env   # set real passwords
   cp caddy/.env.example caddy/.env                            # set the domains and the QA login
   cp monitoring/.env.example monitoring/.env                  # set the Grafana admin password
   ./update
   docker compose -f caddy/compose.yml up -d
   ```
4. Add the cron job (`crontab -e`) that pulls new images every 2 minutes:
   ```
   */2 * * * * $HOME/pipoker-docker-config/server/update >> $HOME/pipoker-update.log 2>&1
   ```
5. Set up the Cloudflare Tunnel so requests can reach the server — see "How requests reach the server" below.
6. In both pipoker-app and pipoker-web on GitHub create the environment `prod`
   (Settings → Environments) with yourself as a required reviewer.

## How requests reach the server

Requests arrive through a **Cloudflare Tunnel**: `cloudflared` makes an *outbound* connection to Cloudflare and
every request comes back through it, so the router needs no open ports and the home IP is never published. Caddy
still does all the routing, the security headers, the QA login and the dashboard — the tunnel only carries the
traffic in. It needs no paid plan and no Zero Trust seat; the free account is enough.

Set it up once, from the `server` directory (Docker is already installed, so `cloudflared` runs from its image
and nothing is added to the host):

```
cd ~/pipoker-docker-config/server
D='docker run --rm --user root -v '"$PWD"'/caddy/cloudflared:/etc/cloudflared -e TUNNEL_ORIGIN_CERT=/etc/cloudflared/cert.pem cloudflare/cloudflared:2026.10.0'

# 1. Authorise with your Cloudflare account. It prints a link; open it and pick the pipoker.app zone.
$D tunnel login            # (prepend `-it`: docker run -it ... for this one, so the link shows)

# 2. Create the tunnel, then give its credentials the fixed name the config expects.
$D tunnel create pipoker   # note the tunnel id it prints
mv caddy/cloudflared/<TUNNEL_ID>.json caddy/cloudflared/credentials.json

# 3. In caddy/.env set CLOUDFLARE_TUNNEL_ID=<TUNNEL_ID> and COMPOSE_PROFILES=tunnel (the latter turns the
#    cloudflared service on for every compose command here, so it keeps running after a reboot or a manual
#    bring-up once the ports are closed), then start the tunnel.
docker compose -f caddy/compose.yml up -d

# 4. Point the domains at the tunnel, one at a time, checking each from outside the home network before the next
#    (this creates or replaces their DNS records). Start with QA, then PROD.
$D tunnel route dns --overwrite-dns pipoker qa.pipoker.app
$D tunnel route dns --overwrite-dns pipoker pipoker.app
```

`credentials.json` and `cert.pem` are secrets and are git-ignored; only `cloudflared/config.yml` is tracked, and
it carries no id, so it is the same on every install. Caddy trusts the tunnel's fixed address `10.89.7.2` as a
proxy (see the Caddyfile), so the real visitor address still reaches the backend through `CF-Connecting-IP`.

Once both domains answer through the tunnel, keep the router's ports 80 and 443 closed to the internet: the
tunnel doesn't need them, and with them closed there is no way to reach the server around Cloudflare. At home
the sites keep working through the AdGuard rewrite, so closing the ports changes nothing there.

## QA access

QA is only for checking changes before a release. From the home network it opens directly;
from anywhere else Caddy asks for the login set by `QA_USERNAME` and `QA_PASSWORD_HASH` in `caddy/.env`.
After the login the browser also gets the cookie `pipoker_qa_login` for 30 days, which lets in the WebSocket
connections that Safari opens without the login. Its value is the random secret `QA_COOKIE_TOKEN` (also in
`caddy/.env`), not the password or its hash, so the cookie never carries the credential; changing the token
signs every browser out of QA without touching the password.
After changing any of them: `docker compose -f caddy/compose.yml up -d`.
Changes to `caddy/config/Caddyfile` need nothing: Caddy notices the new file, for example after a `git pull`,
and reloads it without dropping connections.

## Activity dashboard

`https://<QA_DOMAIN>/grafana/` shows what people do in PiPoker, for PROD and QA (the **Environment** switch at the top):
rooms and people online, rooms created, people joined, votes and rounds, why people left, and the backend memory.
It opens behind the QA login like QA itself; it can only be looked at, the dashboard comes from
`monitoring/grafana/dashboards/activity.json`.

Each backend serves its metrics on port 8081 (`/actuator/prometheus`), which only the server's internal network
reaches. Prometheus in `monitoring/` collects them every 30 seconds and keeps two years. Only counts are stored:
no nicknames, room names or room ids. `./update` starts the dashboard once `monitoring/.env` exists.

## Feedback

People send feedback from the site without signing up: a problem, an idea or a review. The backend turns each
message into an issue of the Jira project `JIRA_PROJECT` (PIP when it isn't set), a problem into a Bug and an idea
or a review into a Task, labelled `site-feedback`, its kind (`problem`, `idea`, `review`) and `qa` or `prod`, on behalf
of the owner of an API token. The project needs the issue types Bug and Task. It takes at most 3 messages an hour from
one address and 20 an hour in total, which keeps spam out of Jira. Until the token is set, the messages are only
written to the backend log (`docker compose --env-file prod.env -f compose.yml logs backend`).

The token is an Atlassian API token with scopes, limited to creating issues:
1. https://id.atlassian.com/manage-profile/security/api-tokens → **Create API token with scopes**,
   app **Jira**, scope **write:jira-work**.
2. In `qa.env` and `prod.env` set `JIRA_EMAIL` to the account's e-mail and `JIRA_API_TOKEN` to the token.
   `JIRA_URL` is the Jira site through Atlassian's API gateway, which scoped tokens require
   (`https://api.atlassian.com/ex/jira/<cloud id>`, the cloud id is at `https://<site>.atlassian.net/_edge/tenant_info`).
3. `./update` restarts the backends with the token. To file the feedback in another project, add `JIRA_PROJECT=<key>`
   to both files and run `./update` again.

## Releasing to PROD

Check the change on QA (for example with **Live E2E** below), then run **Promote to PROD** in pipoker-app and/or pipoker-web (Actions tab)
with the commit SHA. A rollback is the same workflow with an older SHA.

## Checking an environment

```
node smoke-test.mjs https://qa.pipoker.app
```
creates a room and waits for a room event, which exercises the web proxy, the backend, MongoDB and RabbitMQ.

## Live tests

The **Live E2E** workflow (`.github/workflows/live-e2e.yml`, Actions tab → Run workflow) uses PiPoker the way
people do, with Playwright: a team playing rounds in Chrome and Firefox, two people on phones (iPhone and Pixel),
refreshing the page, losing the network for a moment and for longer, a killed browser, and 10 teams of 8
voting at the same moment. The `qa` job runs the tests against QA from the internet, so it logs in with
the repository secrets `QA_USERNAME` and `QA_PASSWORD` (Settings → Secrets and variables → Actions); every test
removes the rooms it created. PROD is left to its users: only the monitor below checks it. The `local` job builds
pipoker-app and pipoker-web from the branches given as `app_ref` and `web_ref`, starts them like this server does
and runs the same tests there, so a fix can be checked before it is merged. The job log ends with a short report;
the full Playwright report is attached to the run.

## Monitoring

The **Monitor PROD** workflow (`.github/workflows/monitor.yml`) runs `./check` against PROD every 5 minutes
from GitHub, outside the home network: it opens the web client, asks the backend for `/ws/info` and creates
and deletes a room with `smoke-test.mjs`. So it also notices a switched-off server, a power cut,
a home internet outage or the tunnel going down. GitHub may start scheduled runs a few minutes late.

When PROD fails three checks in a row, the workflow opens an issue labelled `outage` (GitHub sends it by email)
and sends a Telegram message; when PROD works again, it closes the issue and sends another message.

Telegram setup:
1. In Telegram, create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and copy its token.
2. Open the new bot and press **Start**, otherwise it cannot write to you.
3. Find your chat id, for example with [@userinfobot](https://t.me/userinfobot).
4. In this repository, add the secrets `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`
   (Settings → Secrets and variables → Actions → New repository secret).
5. Run **Monitor PROD** by hand (Actions tab → Run workflow) with **Send a test message** ticked.

If GitHub stops running the workflow (it is late or skips runs when busy), nobody would be alerted.
To catch that, create a free check on https://healthchecks.io with period 15 minutes and grace 30 minutes,
connect Telegram or email to it there, and add its ping URL as the secret `HEALTHCHECKS_PING_URL`.
Every run pings it, so Healthchecks.io alerts when the pings stop.
