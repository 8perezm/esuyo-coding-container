# Sidecars for databases, queues and more

How to add app dependencies such as Postgres, Redis, or RabbitMQ to the pod.

If the app you are building needs another container in the pod, such as a Postgres database, Redis, or RabbitMQ, list it under `k8s.sidecars` in the project editor. Each entry runs beside the coding container in the same pod and shares its network, so the app in the coding container reaches it on `localhost`:

```yaml
project: my-api

k8s:
  sidecars:
    - name: postgres
      image: postgres:16
      env:                             # map like k8s.env, or a plain Kubernetes env list
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

Press Save in the editor, check the validation panel, then press Deploy to apply.

* **Near raw container spec.** Only `name` and `image` are required. Everything else such as `command`, `args`, `env`, `envFrom`, `ports`, `volumeMounts`, `resources`, probes and `securityContext` passes through, so any image works. Two small exceptions: `env` also accepts a plain map that is converted to a Kubernetes env list, and a port entry `nodePort` is a service level knob that is removed from the rendered container port.
* **Persist state on the NAS.** Mount the `workspace` volume with its own `subPath` as above and the data survives restarts, isolated per project in the same folder your `/workspace` lives in.
* **Reach it on `localhost`.** All containers in a pod share the network. Point the app at `localhost:5432`. No host names are needed. This is also how a dev server in the coding container reaches a sidecar. Expose the coding container port with `web.ports`, not the sidecar port.
* **Optional NodePort for outside access.** Traefik Ingress routes HTTP to the coding container, so TCP services such as databases and queues cannot use `web.ports` for a sidecar port. Validation rejects a sidecar `containerPort` that duplicates the SSH port or any `web.ports` port. Add a `nodePort` in 30000 to 32767 to a sidecar port entry to expose it on every cluster node, for example `{ containerPort: 5432, name: postgres, nodePort: 30432 }`, then connect from your machine to `<node-ip>:30432`. The NodePort must be unique and different from the SSH NodePort. Deploy prints the resulting mapping in the job log.
* **Collisions are rejected.** A sidecar port must not duplicate the SSH port or a `web.ports` port, and container names and ports must be unique across sidecars, otherwise the service port mapping would be unclear.
* **Keep one replica.** `k8s.replicas` must stay `1`. Replicas would share the same NAS folder, so two stateful sidecars would clobber each other. The editor validation enforces this whenever `k8s.sidecars` is set.

## See also

- [Configuration](./configuration.md) for where `k8s.sidecars` lives
- [Web access](./web-access.md) for exposing ports in the browser
- [Web GUI](./gui.md) for editing with validation and manifest preview
- [Architecture](./architecture.md) for how sidecars are rendered into the pod spec
