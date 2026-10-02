# Network Egress Filtering

An optional, recommended second line of defence. The service already refuses private and reserved addresses in code (see [Security Overview](Security-Overview)). A network rule is the independent backstop for whatever the code might miss - a bug in the address check or in the local proxy, a future Chrome feature that bypasses the proxy switches, any other process in the container: **private, link-local (cloud metadata), carrier-grade-NAT, multicast and other reserved addresses become unreachable from the container, whatever Chrome tries.**

[`docker-compose.egress.example.yml`](https://github.com/solarssk/wp-critical-css/blob/main/docker-compose.egress.example.yml) does that with a small helper container, `egress-guard`, that installs firewall rules in the service's network namespace. It adds a layer; it does not replace the code-level checks.

This page is the working summary. The complete behaviour, the restart table and every known limitation are in the [deployment guide](https://github.com/solarssk/wp-critical-css/blob/main/docs/DEPLOYMENT.md#optional-network-level-egress-filtering) - read its limitations before you rely on this.

## Set it up

1. **Find out where `WP_RECEIVER_URL` points.** A public address (`https://your-site.example/...`) needs no exception. A private one (WordPress in another container, a LAN host, `host.docker.internal`) needs its IP address and port. Give a WordPress container a fixed address (`ipv4_address:` in its network, which needs an `ipam` subnet), or a recreated container gets a new address and delivery is refused.
2. **Copy the example** next to your `docker-compose.yml`, and replace `your_wordpress_network` with the network name your own compose file uses.
3. **Add two lines to the `.env` next to your `docker-compose.yml`:**

   | Variable | Value |
   |---|---|
   | `EGRESS_ALLOW` | Private destinations the service may still open TCP connections to, as space-separated `ADDRESS:PORT` pairs, e.g. `172.20.0.10:80`. IPv6 is written `[fd00::10]:80`. Leave it empty if `WP_RECEIVER_URL` is public. List the receiver's exact address and port, nothing wider. |
   | `EGRESS_ALLOW_DNS` | Only if your DNS resolver is itself one of the refused addresses (a private or link-local one, or Azure's `168.63.129.16`). Space-separated resolver addresses, port 53 only. |

4. **Move networking settings to the guard.** The service now shares the guard's network namespace, so `ports`, `dns`, `dns_search`, `extra_hosts`, `hostname` and `sysctls` belong on the `egress-guard` service, not on `critical-css-service`. Docker refuses them on a service that uses `network_mode: service:...`.
5. **Start both files together:**

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.egress.example.yml up -d
   ```

You need Docker Compose 2.24 or newer.

## Verify it

```bash
docker exec critical-css-service node -e "fetch('http://169.254.169.254/',{signal:AbortSignal.timeout(4000)}).then(()=>console.log('NOT FILTERED'),e=>console.log(e.cause?.code==='ECONNREFUSED'?'OK: egress filtering is active':'NOT CONCLUSIVE: '+(e.cause?.code||e.name)))"
```

- `OK` - the connection was refused locally, at once.
- `NOT FILTERED` - the address answered; the rules are not working.
- `NOT CONCLUSIVE` (usually a timeout) - nothing refused it. Check `docker compose ps` (the guard should be `healthy`) and `docker logs critical-css-egress-guard`, which should end with `ready`.

Then run a normal render ([Getting Started](Getting-Started#7-confirm-it-works)) to confirm delivery to your receiver still works, and `docker exec critical-css-service node -e "require('dns').lookup('example.com',console.log)"` to confirm name resolution still works.

## What to expect

- The guard starts first and **gates the service**: it only starts once the rules are in the kernel, and the service's own start command also waits until a connection to the metadata address is refused. A guard that cannot install the rules never becomes healthy, so the service never starts.
- If the guard dies, the service loses its network. That fails closed.
- Restarting only the service keeps the rules. Restarting only the guard with plain Docker leaves the service without a network until you restart it too; `docker compose restart egress-guard` does both.
- If name lookups start failing with `SERVFAIL` after you switch it on, your DNS resolver is one of the refused addresses. Put it in `EGRESS_ALLOW_DNS`.

## What it does not cover

- Anything inside the container's own loopback. The service's port, Chrome's DevTools port and `127.0.0.0/8` stay reachable from Chrome because loopback has to stay open; the local proxy keeps Chrome off it.
- Whatever you put in `EGRESS_ALLOW` and `EGRESS_ALLOW_DNS`. Page content can reach those addresses too.
- The public internet. The service renders your public site and its assets, so those stay open by design.
- Not tested on a plain Linux host yet, and Compose only: plain `docker run`, Swarm, Kubernetes and rootless Docker or Podman are untested (on Kubernetes use a `NetworkPolicy` with an `ipBlock` `except` list). Do not combine it with `network_mode: host`.
