# Troubleshooting

Fixes for the most common setup, deploy, and connection hiccups.

All paths below use the app pages. Open the Jobs page for the full log when a deploy or similar task reports an error.

**Missing registry or NAS settings**
Your global config is missing a value such as `image.registry`, `nfs.server` or `nfs.basePath`. Open the Setup page, fill in container registry, NFS server and NFS base path, and press Run setup. You can also open the System page and edit the global config by hand. The validation panel tells you what is missing.

**Push fails with an authentication error**
Log in to the registry first with Docker, for example `docker login registry.example.com`, then run the publish or deploy job again. The app reuses that login to build the cluster pull secret.

**Pod is stuck in `ImagePullBackOff`**
The cluster cannot pull the image. On deploy, the app resolves a pull secret automatically from the `k8s.imagePullSecret` value when you set one, from a managed secret it created from your local Docker login, or from an existing secret in the namespace that matches the registry. To force a refresh, delete the managed secret and deploy again:

```sh
kubectl -n coding delete secret coding-registry-example-com
```

Then press Deploy again on the project page. You can also pin a specific secret with `k8s.imagePullSecret` in the project editor.

**Pod is stuck in `ContainerCreating`**
Almost always the NFS mount. A Kubernetes node cannot reach the NAS address, or `nfs.basePath` does not exist on the NAS. Project folders are created automatically, but the base path must exist. The mount error names the cause:

```sh
kubectl -n coding describe pod -l app=<project>
```

**Browser terminal says the session did not start in time**
The pod is likely not running yet, or kubectl cannot reach the cluster. Check the Dashboard workload for the project and the Jobs log for the last deploy. A busy local port 2222 is no longer a problem, the app picks a free port automatically.

**SSH says the host key changed after a rebuild**
Current versions never store pod host keys. The alias uses the OS null device, so there is nothing to go stale. When you still have a legacy `~/.config/coding-container/keys/<project>-known_hosts` file from an older version, open the project terminal or press Deploy once. It deletes the file and rewrites the alias. When VS Code still shows `Port forwarding is disabled` after that, the alias was not rewritten yet, so run the refresh on the SSH and Keys page.

**Nodes keep using an old image after a rebuild**
This should not happen. The pod spec sets `imagePullPolicy: Always`, so every new pod checks the registry before starting. When a pod still runs an old image, the deployment image string did not change, so no new pod was created. Check it with:

```sh
kubectl -n coding get deployment <project> -o jsonpath='{.spec.template.spec.containers[0].image}'
```

And force a new rollout with:

```sh
kubectl -n coding rollout restart deployment/<project>
```

**NodePort already in use by another service**
The app checks before applying anything and fails with the name of the service holding the port, for example `nodePort 30023 is already allocated to service "tryout" in namespace "coding"`. NodePorts are cluster wide, so ports used by other projects count too. Pick a different `k8s.nodePort` in 30000 to 32767 in the project editor, same for sidecar `nodePort` values, then press Deploy again.

**Web app unreachable in the browser with Ingress**
Work the chain from the outside in:
1. Does the host resolve to your Traefik LoadBalancer IP. Try `nslookup <host>`.
2. Is the Ingress present and does it list the host. Try `kubectl -n coding get ingress -o wide`.
3. Is the ingress class `traefik` present. Try `kubectl get ingressclass`.
4. Is the dev server actually listening on the container port inside the pod. Try `kubectl -n coding exec deploy/<project> -- ss -ltnp` or read the tool own log.
5. Is Traefik itself running. Try `kubectl -n kube-system get pods | grep traefik`.

**Preview exact changes without touching the cluster**
Open the project in the app, edit the YAML, and use the validation and manifest preview in the editor. No deploy happens until you press Deploy. Or inspect what is currently deployed:

```sh
kubectl -n coding get deploy,svc,cm,pod -l coding-container=true
```

## See also

- [Configuration](./configuration.md) for registry, NFS, and NodePort settings
- [SSH and VS Code](./ssh-and-vscode.md) for connection fixes
- [SSH image paste](./ssh-image-paste.md) for image paste into opencode over SSH
- [Web GUI](./gui.md) for Jobs logs and validation
- [Development Guide](./development.md) for debugging the app itself
