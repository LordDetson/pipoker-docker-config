# PiPoker server

Runs the QA and PROD environments side by side on one Docker host (for example a home server),
behind Caddy with automatic HTTPS.

```
Caddy (80, 443) ── PROD_DOMAIN ── /ws → prod-backend, rest → prod-web
                └─ QA_DOMAIN   ── /ws → qa-backend,   rest → qa-web
pipoker-prod: mongodb, rabbitmq, backend, web
pipoker-qa:   mongodb, rabbitmq, backend, web
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
   cp caddy/.env.example caddy/.env                            # set the domains
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

## Releasing to PROD

Check the change on QA, then run **Promote to PROD** in pipoker-app and/or pipoker-web (Actions tab)
with the commit SHA. A rollback is the same workflow with an older SHA.

## Checking an environment

```
node smoke-test.mjs https://pipoker-qa.duckdns.org
```
creates a room and waits for a room event, which exercises the web proxy, the backend, MongoDB and RabbitMQ.
