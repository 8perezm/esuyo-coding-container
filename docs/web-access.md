# Web access with Traefik Ingress

How to reach dev servers in the browser with no port forwards.

List the container ports you need in `web.ports` in the project editor. Each host in an entry gets an Ingress rule that routes to that port on the project service. The rule uses `ingress.className`, default `traefik` bundled with many Kubernetes distributions, and it is applied on the next Deploy.

```yaml
project: my-webapp

web:
  ports:
    - { port: 3000, hosts: [my-webapp.example.com, www.example.com] } # for example Vite or Next
    - { port: 8080, host: my-api.example.com, name: api } # optional explicit port name
    - { port: 5173, host: my-vite.example.com, nodePort: 30080 } # plus optional NodePort
```

* **You choose the hosts.** Nothing is hardcoded. Each entry points one or more domains at the same container port, so several names can share port `3000`. Use as many entries as you have ports.
* **DNS is on you.** Each host must resolve with an A or AAAA record, a wildcard, or a hosts entry to your Traefik LoadBalancer IP. The app does not manage DNS.
* **Optional NodePort per port.** An entry `nodePort` in 30000 to 32767 also exposes that port on every cluster node, so the app is also reachable at `http://<node-ip>:<nodePort>/`. This helps when the Ingress hosts do not resolve from your machine. The port must be unique across the SSH NodePort, `web.ports`, and sidecar `nodePort` entries. The app checks the cluster for conflicts before applying and prints the resulting address.
* After you press Deploy, the project deploy panel and the Jobs log show the resulting URLs, for example the Ingress hosts with the container port in brackets.

Removing the project removes the Ingress along with the deployment, service and config map.

## See also

- [Configuration](./configuration.md) for where `web.ports` lives in the config
- [Sidecars](./sidecars.md) for exposing sidecar ports over HTTP or NodePort
- [Troubleshooting](./troubleshooting.md) for the web app unreachable checklist
- [Web GUI](./gui.md) for the project editor with manifest preview
