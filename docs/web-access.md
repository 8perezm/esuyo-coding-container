# Web access (Traefik Ingress)

How to reach dev servers in the browser without port-forwards.

List the container ports you need in `web.ports`; each entry gets one Ingress host that routes to that port on the project's service. The rule is rendered with `ingress.className` (default `traefik`, the class k3s ships) and is applied on every `deploy`:

```yaml
project: my-webapp

web:
  ports:
    - { port: 3000, host: my-webapp.example.com }        # e.g. Vite/Next
    - { port: 8080, host: my-api.example.com, name: api } # optional explicit port name
    - { port: 5173, host: my-vite.example.com, nodePort: 30080 } # + optional NodePort
```

- **You choose the hosts.** Nothing is hardcoded — the host is whatever you put in the config, per project. Use as many entries as you have ports.
- **DNS is on you.** Each host must resolve (A/AAAA record, wildcard, or hosts entry) to your Traefik LoadBalancer IP. The CLI does not manage DNS.
- **Optional NodePort per port.** An entry's `nodePort` (30000–32767) additionally exposes that port on every cluster node, so the app is also reachable at `http://<node-ip>:<nodePort>/` — useful when the Ingress hosts don't resolve from your machine. The port must be unique across the SSH NodePort, `web.ports`, and sidecar `nodePort`s; `deploy` checks the cluster for conflicts before applying and prints the resulting URL.
- After `deploy` the CLI prints the resulting URLs.

```sh
$ coding-container create
Deployed my-webapp in coding
Web (Traefik Ingress):
  http://my-webapp.example.com/  (container port 3000)
  http://my-api.example.com/  (container port 8080)
```

`delete` removes the Ingress along with the deployment, service and configmap.

## See also

- [Configuration](./configuration.md) — where `web.ports` lives in the config
- [Sidecars](./sidecars.md) — exposing sidecar ports over HTTP or NodePort
- [Troubleshooting](./troubleshooting.md) — web app unreachable checklist
