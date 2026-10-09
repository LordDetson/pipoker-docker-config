# Caddy with the Cloudflare DNS plugin. It lets Caddy prove it owns the Cloudflare-managed domains with a
# DNS-01 challenge, which keeps certificate renewal working once those domains sit behind the Cloudflare
# proxy (an HTTP-01 or TLS-ALPN-01 challenge can't reach the origin through the proxy). The plain image has
# no DNS provider built in, so we add just this one.
FROM caddy:2.11.7-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2.11.7-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
