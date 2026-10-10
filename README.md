<div align="center">

<img src="https://raw.githubusercontent.com/LordDetson/pipoker-web/main/src/assets/svg/pipoker-logo.svg" alt="PiPoker logo" width="96">

# PiPoker infrastructure

**How [PiPoker](https://pipoker.app/?from=github) runs, ships and is checked: QA and PROD on one Docker host, live end-to-end tests
and uptime monitoring.**

[**pipoker.app**](https://pipoker.app/?from=github) &nbsp;·&nbsp;
[Backend](https://github.com/LordDetson/pipoker-app) &nbsp;·&nbsp;
[Web client](https://github.com/LordDetson/pipoker-web)

[![Test](https://github.com/LordDetson/pipoker-docker-config/actions/workflows/test.yml/badge.svg)](https://github.com/LordDetson/pipoker-docker-config/actions/workflows/test.yml)
[![Live E2E](https://github.com/LordDetson/pipoker-docker-config/actions/workflows/live-e2e.yml/badge.svg)](https://github.com/LordDetson/pipoker-docker-config/actions/workflows/live-e2e.yml)
[![Monitor PROD](https://github.com/LordDetson/pipoker-docker-config/actions/workflows/monitor.yml/badge.svg)](https://github.com/LordDetson/pipoker-docker-config/actions/workflows/monitor.yml)
[![Website](https://img.shields.io/website?url=https%3A%2F%2Fpipoker.app&label=pipoker.app)](https://pipoker.app/?from=github)
[![License](https://img.shields.io/github/license/LordDetson/pipoker-docker-config)](LICENSE)

[![Support the project](https://img.shields.io/badge/%F0%9F%A7%A1_Support_the_project-lorddetson.github.io-ff8c00?style=for-the-badge)](https://lorddetson.github.io/)

![Docker](https://img.shields.io/badge/Docker_Compose-2496ED?logo=docker&logoColor=white)
![Caddy](https://img.shields.io/badge/Caddy-1F88C0?logo=caddy&logoColor=white)
![Cloudflare](https://img.shields.io/badge/Cloudflare_Tunnel-F38020?logo=cloudflare&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-2EAD33?logo=playwright&logoColor=white)
![Grafana](https://img.shields.io/badge/Grafana-F46800?logo=grafana&logoColor=white)

</div>

## What's inside

The application code lives in [pipoker-app](https://github.com/LordDetson/pipoker-app) (backend) and
[pipoker-web](https://github.com/LordDetson/pipoker-web) (web client). Their GitHub Actions build and test every pull
request and publish images to GitHub Container Registry from main. Everything that runs and checks them is here:

| Path | What it is |
|------|------------|
| 🖥️ [`server/`](server/README.md) | The QA and PROD environments on one Docker host: compose files, Caddy, the Cloudflare Tunnel, the update script that pulls new images, Prometheus and Grafana. Its README describes the setup, releases and checks. |
| 🎭 [`e2e/`](e2e) | Live end-to-end tests with Playwright in Chrome, Firefox, Safari and on phones (iPhone and Android), plus a load test. |
| ✅ [`test.yml`](.github/workflows/test.yml) | Starts the whole server from `server/` on every pull request and checks QA and PROD with `server/check`. |
| 🔁 [`live-e2e.yml`](.github/workflows/live-e2e.yml) | Runs `e2e/` against QA, or against pipoker-app and pipoker-web branches started the way the server does. |
| 📟 [`monitor.yml`](.github/workflows/monitor.yml) | Checks PROD every 5 minutes and reports an outage by an issue and a Telegram message. |

## How it runs

```mermaid
flowchart LR
    user["Browser"] --> cf["Cloudflare"]
    cf -- "Tunnel" --> caddy["Caddy"]
    subgraph host["Docker host"]
        caddy -- "pipoker.app" --> prod["PROD<br/>web · backend · MongoDB · RabbitMQ"]
        caddy -- "qa.pipoker.app" --> qa["QA<br/>web · backend · MongoDB · RabbitMQ"]
        caddy -- "/grafana" --> mon["Prometheus · Grafana"]
        update["update<br/>(cron, every 2 min)"] -. "pulls :prod images" .-> prod
        update -. "pulls :qa images" .-> qa
    end
```

The server connects out to Cloudflare, so it needs no public IP and no open ports, and GitHub never connects to it:
it pulls new images itself.

## Releases

```mermaid
flowchart LR
    pr["Pull request<br/>pipoker-app / pipoker-web"] -- "CI" --> main["main"]
    main -- "image :qa" --> qa["QA<br/>qa.pipoker.app"]
    qa -- "Promote to PROD<br/>(with approval)" --> prod["PROD<br/>pipoker.app"]
```

1. Every push to main of pipoker-app and pipoker-web publishes images tagged `qa`; the server runs them on QA within
   a few minutes.
2. A commit checked on QA is tagged `prod` by the **Promote to PROD** workflow in its repository, which waits for
   approval.
3. The server picks up the `prod` image on its next update.

## Getting started

Setting up a server from scratch takes a Linux machine with Docker, a domain on Cloudflare and a few `.env` files.
The step-by-step guide is in [`server/README.md`](server/README.md).

To run the live tests against your own stack:

```bash
cd e2e
npm ci
npx playwright install --with-deps
BASE_URL=http://localhost npx playwright test   # QA by default
```

## License

PiPoker is released under the [Apache License 2.0](LICENSE).
