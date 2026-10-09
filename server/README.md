# PiPoker server

Runs the QA and PROD environments side by side on one Docker host (for example a home server),
behind Caddy with automatic HTTPS.

```
Caddy (80, 443) ── PROD_DOMAIN ── /ws → prod-backend, rest → prod-web
                └─ QA_DOMAIN   ── /ws → qa-backend,   /grafana → grafana, rest → qa-web
pipoker-prod:       mongodb, rabbitmq, backend, web
pipoker-qa:         mongodb, rabbitmq, backend, web
pipoker-monitoring: prometheus (scrapes both backends and the server), grafana, alertmanager,
                    node-exporter, cadvisor
```

The server pulls new versions itself, so GitHub never connects to it:
- every push to main of [pipoker-app](https://github.com/LordDetson/pipoker-app) and
  [pipoker-web](https://github.com/LordDetson/pipoker-web) publishes images tagged `qa`;
- the **Promote to PROD** workflow in those repositories (with approval) tags a commit that was checked on QA as `prod`;
- `./update`, run by cron every 2 minutes, pulls the `qa` and `prod` images and restarts what changed.

## Requirements

- Linux with Docker and the compose plugin, switched on all the time.
- A public IP address. Compare the WAN address in the router settings with the one shown by https://2ip.ru;
  if they differ, the provider uses CGNAT and the server is not reachable from the internet
  (most providers give a public, often dynamic, address on request).
- Ports 80 and 443 forwarded on the router to the server. Caddy needs them for the HTTPS certificates.

## Setup

1. Register two subdomains on https://www.duckdns.org, for example `pipoker` and `pipoker-qa`,
   and note the token.
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
   cp monitoring/.env.example monitoring/.env                  # set the Grafana password and where alerts go
   ./update
   docker compose -f caddy/compose.yml up -d
   ```
4. Add the cron jobs (`crontab -e`): updates every 2 minutes and the DuckDNS address every 5 minutes,
   because a home IP address can change.
   ```
   */2 * * * * $HOME/pipoker-docker-config/server/update >> $HOME/pipoker-update.log 2>&1
   */5 * * * * curl -fsS "https://www.duckdns.org/update?domains=pipoker,pipoker-qa&token=<token>" > /dev/null
   ```
5. In both pipoker-app and pipoker-web on GitHub create the environment `prod`
   (Settings → Environments) with yourself as a required reviewer.

## QA access

QA is only for checking changes before a release. From the home network it opens directly;
from anywhere else Caddy asks for the login set by `QA_USERNAME` and `QA_PASSWORD_HASH` in `caddy/.env`.
After the login the browser also gets the cookie `pipoker_qa_login` for 30 days, which lets in the WebSocket
connections that Safari opens without the login. A new password makes the old cookies useless.
After changing them: `docker compose -f caddy/compose.yml up -d`.
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

## Capacity

Is the server strong enough for the load PiPoker has now? The **PiPoker capacity** dashboard
(`https://<QA_DOMAIN>/grafana/d/pipoker-capacity`) answers it: **Headroom** is what the busiest resource has left,
and **Load by resource** shows each one as a share of what the server has:

| Resource | Measured |
|---|---|
| `cpu`, `memory`, `disk` | the server, by node-exporter |
| `uplink`, `downlink` | the server's network card against the speed of the home internet connection, by cAdvisor |
| `prod_heap` | objects the PROD backend keeps after garbage collection, against its heap |
| `container_memory` | the container closest to its `mem_limit`, by cAdvisor |

The rules in `monitoring/rules/capacity.yml` raise an alert while the load is still approaching a limit
(the processor busy over 80% for 15 minutes, memory over 90%, the disk filling up within a week,
the backend's message queues growing, and so on), and Alertmanager sends it to Telegram and by email, with
another message once it is over. When the whole server is down nothing here can send anything: the
Monitor PROD workflow below covers that.

Setup, once:
1. Set the speeds of the internet plan in `pipoker:uplink_capacity` and `pipoker:downlink_capacity`
   (bits per second) in `monitoring/rules/capacity.yml`.
2. In `monitoring/.env` fill in `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (the bot of Monitor PROD will do,
   see Telegram setup below), `ALERT_EMAIL`, and the mailbox the email is sent from: `SMTP_USERNAME` and
   `SMTP_PASSWORD`. For Gmail that is an app password (Google account → Security → 2-Step Verification →
   App passwords), and `SMTP_SMARTHOST` stays `smtp.gmail.com:587`.
3. `./update`, then `monitoring/send-test-alert`: the test message arrives in Telegram and by email.

Prometheus reads its configuration and rules when it starts, so after a change to them:
`docker compose -f monitoring/compose.yml restart prometheus`. The rules are tested with
`promtool test rules tests/capacity.test.yml` (in `monitoring/`; CI runs it).

## Bug reports

People report bugs from the site without signing up: the backend turns each report into a Bug in the Jira project
PIP with the label `site-bug-report` (and `qa` or `prod`), on behalf of the owner of an API token. It takes at most
3 reports an hour from one address and 20 an hour in total, which keeps spam out of Jira. Until the token is set,
the reports are only written to the backend log (`docker compose --env-file prod.env -f compose.yml logs backend`).

The token is an Atlassian API token with scopes, limited to creating issues:
1. https://id.atlassian.com/manage-profile/security/api-tokens → **Create API token with scopes**,
   app **Jira**, scope **write:jira-work**.
2. In `qa.env` and `prod.env` set `JIRA_EMAIL` to the account's e-mail and `JIRA_API_TOKEN` to the token.
   `JIRA_URL` is the Jira site through Atlassian's API gateway, which scoped tokens require
   (`https://api.atlassian.com/ex/jira/<cloud id>`, the cloud id is at `https://<site>.atlassian.net/_edge/tenant_info`).
3. `./update` restarts the backends with the token.

## Releasing to PROD

Check the change on QA (for example with **Live E2E** below), then run **Promote to PROD** in pipoker-app and/or pipoker-web (Actions tab)
with the commit SHA. A rollback is the same workflow with an older SHA.

## Checking an environment

```
node smoke-test.mjs https://pipoker-qa.duckdns.org
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
a home internet outage or an outdated DuckDNS address. GitHub may start scheduled runs a few minutes late.

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
