# PiPoker server

Runs the QA and PROD environments side by side on one Docker host, behind Caddy with automatic HTTPS.

```
Caddy (80, 443) ── PROD_DOMAIN ── /ws → prod-backend, rest → prod-web
                └─ QA_DOMAIN   ── /ws → qa-backend,   rest → qa-web
pipoker-prod: mongodb, rabbitmq, backend, web
pipoker-qa:   mongodb, rabbitmq, backend, web
```

Images come from GitHub Container Registry and are published by the CI of
[pipoker-app](https://github.com/LordDetson/pipoker-app) and [pipoker-web](https://github.com/LordDetson/pipoker-web).
Every push to main is deployed to QA. PROD is deployed by running the **Deploy** workflow manually
with the commit SHA that was checked on QA; the `prod` environment asks for approval.

## Server setup

1. Create a VM with Ubuntu (Oracle Cloud Always Free Ampere A1 is enough for both environments)
   and open TCP 80 and 443 in its firewall. On Oracle images also open them in iptables:
   ```
   sudo iptables -I INPUT 6 -p tcp -m multiport --dports 80,443 -j ACCEPT
   sudo netfilter-persistent save
   ```
2. Point the PROD and QA domains to the VM public IP (for example `pipoker` and `pipoker-qa` on duckdns.org).
3. Install Docker with the compose plugin and create a deployment user:
   ```
   curl -fsSL https://get.docker.com | sudo sh
   sudo useradd -m -s /bin/bash -G docker deploy
   ```
4. As `deploy`, clone this repository into the home directory and create the environment files:
   ```
   git clone https://github.com/LordDetson/pipoker-docker-config.git
   cd pipoker-docker-config/server
   cp qa.env.example qa.env && cp prod.env.example prod.env   # set real passwords
   cp caddy/.env.example caddy/.env                            # set the domains
   docker network create pipoker-edge
   docker compose -f caddy/compose.yml up -d
   ```
5. Create an SSH key for GitHub Actions and allow it for `deploy`:
   ```
   ssh-keygen -t ed25519 -N "" -f pipoker-deploy
   cat pipoker-deploy.pub >> ~/.ssh/authorized_keys
   ```
6. In both pipoker-app and pipoker-web on GitHub (Settings → Secrets and variables → Actions):
   - variables `DEPLOY_HOST` (VM address) and `DEPLOY_USER` (`deploy`);
   - secrets `DEPLOY_SSH_KEY` (content of `pipoker-deploy`) and `DEPLOY_KNOWN_HOSTS` (output of `ssh-keyscan <VM address>`).
7. In both repositories create the environments `qa` and `prod`; give `prod` a required reviewer.
8. Make the packages `pipoker-controller` and `pipoker-web` public on GitHub (package settings), so the server pulls them without logging in.
9. Deploy the current main once: run the **Deploy** workflow in both repositories with environment `qa`
   and then `prod`, tag `main`.

## Manual deployment

```
./deploy <qa|prod> <backend|web> <tag>
```
The deployed tags are kept in `qa.env` and `prod.env`.
