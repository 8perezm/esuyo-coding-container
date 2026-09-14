# Troubleshooting

Fixes for the most common setup, deploy, and connection failures.

**`config: image.registry is not set` (or `nfs.server` / `nfs.basePath`)**
Your global config is missing an environment-specific value. Run `coding-container setup` (it asks for them, or accept `--registry` / `--nfs-server` / `--nfs-base-path`), or add the values to `~/.config/coding-container/config.yaml` yourself.

**Push fails with an authentication error**
Log in to the registry first: `docker login registry.example.com`.

**Pod is stuck in `ImagePullBackOff`**
The cluster can't pull the image. On deploy, the CLI resolves a pull secret automatically: `k8s.imagePullSecret` if you set it, a managed secret it created from your local docker credentials, or an existing `dockerconfigjson` secret in the namespace that matches the registry. To force a refresh, delete the managed secret and redeploy:

```sh
kubectl -n coding delete secret coding-registry-example-com
coding-container deploy
```

Or pin a specific secret with `k8s.imagePullSecret` in `config.yaml`.

**Pod is stuck in `ContainerCreating`**
Almost always the NFS mount: a Kubernetes node can't reach `10.0.0.5`, or `nfs.basePath` does not exist on the NAS (per-project folders are created automatically, but the base path must exist). The mount error names the cause: `kubectl -n coding describe pod -l app=<project>`.

**`coding-container ssh` says port-forward did not start in time**
The pod isn't running yet (`kubectl -n coding get pods`), or kubectl can't reach the cluster. A busy local port 2222 is no longer a problem, the CLI switches to a free port automatically.

**SSH complains that the host key changed after a rebuild**
Current versions never store pod host keys (alias uses the OS null device), so there is nothing to go stale. If you still have a legacy `~/.config/coding-container/keys/<project>-known_hosts` file from an older version, run `coding-container deploy` (or `ssh`) once, it deletes the file and rewrites the alias. Still seeing `Port forwarding is disabled` in VS Code after that means the alias wasn't rewritten yet.

**Nodes keep using an old image after a rebuild**
Should not happen: the pod spec uses `imagePullPolicy: Always`, so every new pod re-checks the registry before starting. If a pod still runs an old image, the deployment's image string didn't change, so no new pod was created. Check it with `kubectl -n coding get deployment <project> -o jsonpath='{.spec.template.spec.containers[0].image}'` and force one with `kubectl -n coding rollout restart deployment/<project>`.

**NodePort already in use by another service**
`deploy` checks for this before applying anything and fails with the name of the service holding the port (e.g. `nodePort 30023 (k8s.nodePort (SSH)) is already allocated to service "tryout" in namespace "coding"`). NodePorts are allocated cluster-wide, so ports used by other projects count too. Pick a different `k8s.nodePort` (30000–32767) in `config.yaml` (and for sidecar `nodePort`s likewise), then deploy again.

**Web app unreachable in the browser (Ingress)**
Work the chain from the outside in:
1. Does the host resolve to your Traefik LoadBalancer IP? (`nslookup <host>`)
2. Is the Ingress present and does it list the host? `kubectl -n coding get ingress -o wide`
3. Is the ingress class `traefik` (bundled with many Kubernetes distributions)? `kubectl get ingressclass`
4. Is the dev server actually listening on the container port inside the pod? `kubectl -n coding exec deploy/<project> -- ss -ltnp` (or the tool's own log)
5. Is Traefik itself running? `kubectl -n kube-system get pods | grep traefik`

**Preview the exact manifests without touching the cluster**

```sh
coding-container validate --manifest
coding-container validate --manifest | kubectl apply --dry-run=client -f -
```

Or inspect what is currently deployed:

```sh
kubectl -n coding get deploy,svc,cm,pod -l coding-container=true
```

## See also

- [Configuration](./configuration.md): registry, NFS, and NodePort settings
- [SSH and VS Code](./ssh-and-vscode.md): connection fixes
- [SSH image paste](./ssh-image-paste.md): image paste into opencode over SSH
- [Development Guide](./development.md): debugging the CLI itself
