# Sidecars (databases, message queues, ...)

How to add app dependencies such as Postgres, Redis, or RabbitMQ to the pod.

If the app you're developing needs another container in the pod — a Postgres database, Redis, RabbitMQ — list it under `k8s.sidecars`. Each entry runs alongside the coding container in the same pod and shares its network namespace, so the app in the coding container reaches it on `localhost`:

```yaml
project: my-api

k8s:
  sidecars:
    - name: postgres
      image: postgres:16
      env:                             # map (like k8s.env) or a plain k8s env list
        POSTGRES_DB: myapi
        POSTGRES_PASSWORD: dev
      ports:
        - { containerPort: 5432, name: postgres }
      volumeMounts:                    # persist the data on the NAS workspace
        - name: workspace
          mountPath: /var/lib/postgresql/data
          subPath: postgres
      resources:
        requests: { cpu: 100m, memory: 128Mi }
        limits:   { cpu: "1",  memory: 1Gi }
```

- **Near-raw k8s container spec.** Only `name` and `image` are required; everything else (`command`, `args`, `env`, `envFrom`, `ports`, `volumeMounts`, `resources`, probes, `securityContext`, ...) passes through, so any image works. Two exceptions: `env` additionally accepts a plain map (converted to a k8s env list), and a port entry's `nodePort` is a service-level knob stripped from the rendered ContainerPort.
- **Persist state on the NAS.** Mount the `workspace` volume with its own `subPath` (as above) and the data survives restarts, isolated per project — same folder your `/workspace` lives in.
- **Access from the coding container: `localhost`.** All containers in a pod share the network namespace — point the app at `localhost:5432`, no hostnames needed. This is also how a dev server in the coding container reaches a sidecar: expose the coding container's port via `web.ports`, not the sidecar's.
- **Optional NodePort for external access.** Traefik's Ingress routes HTTP to the coding container, so TCP services (databases, queues) can't use `web.ports` for a sidecar port — validation rejects a sidecar `containerPort` that duplicates the SSH port or any `web.ports` port. Add a `nodePort` (30000–32767) to a sidecar port entry to expose it on every cluster node: `{ containerPort: 5432, name: postgres, nodePort: 30432 }` — then connect from your machine to `<node-ip>:30432`. The NodePort must be unique and different from the SSH NodePort (`k8s.nodePort`); `deploy` prints the resulting mapping.
- **Collisions are rejected.** A sidecar port must not duplicate the SSH port or a `web.ports` port, and container names/ports must be unique across sidecars — otherwise the service's port resolution becomes ambiguous.
- **Single replica.** `k8s.replicas` must stay `1`: replicas share the same NAS folder, so two stateful sidecars would clobber each other (validated whenever `k8s.sidecars` is set, which defaults to `[]` — effectively always `1`).

## See also

- [Configuration](./configuration.md) — where `k8s.sidecars` lives
- [Web access](./web-access.md) — exposing sidecar ports in the browser
- [Architecture](./architecture.md) — how sidecars are rendered into the pod spec
