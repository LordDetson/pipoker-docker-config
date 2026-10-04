# pipoker-docker-config

Everything that runs and checks [PiPoker](https://pipoker.duckdns.org) outside the application code.
The application itself lives in [pipoker-app](https://github.com/LordDetson/pipoker-app) (backend) and
[pipoker-web](https://github.com/LordDetson/pipoker-web) (web client); their GitHub Actions build and test every pull request
and publish images to GitHub Container Registry from main.

| Path | What it is |
|------|------------|
| [`server/`](server/README.md) | The QA and PROD environments on one Docker host: compose files, Caddy, the update script that pulls new images, the activity dashboard. Its README describes the setup, releases and checks. |
| `e2e/` | Live end-to-end tests with Playwright, run by the **Live E2E** workflow. |
| `.github/workflows/test.yml` | Starts the whole server from `server/` on every pull request and checks QA and PROD with `server/check`. |
| `.github/workflows/live-e2e.yml` | Runs `e2e/` against QA, or against pipoker-app and pipoker-web branches started like the server does. |
| `.github/workflows/monitor.yml` | Checks PROD every 5 minutes and reports an outage by an issue and a Telegram message. |
