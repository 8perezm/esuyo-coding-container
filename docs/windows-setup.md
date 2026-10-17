# Windows Setup Guide

Set up a Windows laptop to work with `coding-container`: Docker Desktop and `kubectl` on Windows, K3s on a Linux server, an in-cluster container registry, and the K3s kubeconfig copied to Windows.

## Contents

- [How it fits together](#how-it-fits-together)
- [Prerequisites](#prerequisites)
- [1. Install Docker Desktop on Windows](#1-install-docker-desktop-on-windows)
- [2. Install kubectl on Windows](#2-install-kubectl-on-windows)
- [3. Install K3s on the Linux server](#3-install-k3s-on-the-linux-server)
- [4. Install a container registry into K3s](#4-install-a-container-registry-into-k3s)
- [5. Copy the K3s kubeconfig to Windows](#5-copy-the-k3s-kubeconfig-to-windows)
- [6. Wire up coding-container](#6-wire-up-coding-container)
- [Troubleshooting (Windows)](#troubleshooting-windows)
- [See also](#see-also)

## How it fits together

K3s does not run natively on Windows, so the cluster lives on a Linux machine and Windows is the client:

```
Windows 11 laptop                    Linux server (Ubuntu 22.04 / 24.04)
----------------                     ----------------------------------
Docker Desktop (build + push)  --->  K3s cluster (runs your pods)
kubectl (deploy, logs)         --->  K3s API on :6443
kubeconfig in %USERPROFILE%\.kube\config
                                     container registry in K3s on :30500
                                     NFS / NAS share for /workspace
```

You end up with:

- [ ] Docker Desktop working on Windows (`docker version`, `docker run hello-world`)
- [ ] `kubectl` on `PATH` on Windows (`kubectl version --client`)
- [ ] K3s running on the Linux server (`kubectl get nodes` shows `Ready`)
- [ ] A registry reachable from both Windows and K3s (`docker login` + `docker push` succeed)
- [ ] The K3s kubeconfig installed on Windows and pointing at the server IP

> Internal network only. This guide uses plain HTTP for the in-cluster registry and opens NodePorts on every node. Only run this on a trusted home lab, LAN, or VPN-gated network behind a firewall. See [Architecture](./architecture.md#security-notes).

## Prerequisites

- Windows 10 64-bit (21H2+) or Windows 11, with administrator rights.
- One Linux machine for K3s: bare metal, a VM, or a NAS-hosted VM. 2 CPUs / 4 GB RAM minimum for a single-node test cluster. Ubuntu 22.04 LTS or 24.04 LTS is assumed below.
- The Linux server's IP address on your LAN (used as `192.168.1.50` in the examples — substitute yours).
- A NAS or NFS export for project workspaces (any host K3s nodes can reach). Note its IP and export path now; `coding-container setup` asks for them later.

## 1. Install Docker Desktop on Windows

Docker builds and pushes the coding image. Docker Desktop with the WSL 2 backend is the supported setup.

1. Enable WSL 2. In an elevated PowerShell prompt:
   ```powershell
   wsl --install
   ```
   Reboot if prompted, then confirm with `wsl --status`. On older Windows builds you may need to enable the `VirtualMachinePlatform` feature first — the `wsl --install` output tells you.
2. Download and install [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop/). During setup keep "Use WSL 2 instead of Hyper-V" checked.
3. Start Docker Desktop. Wait until the whale icon in the system tray says "Engine running".
4. Verify in a new PowerShell window:
   ```powershell
   docker version
   docker run --rm hello-world
   ```
   Both must succeed without `permission denied` or `pipe not found` errors.

   Stop here for now. Registry login happens in [step 4](#4-install-a-container-registry-into-k3s), after the registry exists: an external registry needs `docker login <host>` there, and the in-cluster registry needs its insecure-registry exception first.

## 2. Install kubectl on Windows

Pick one method (each puts `kubectl` on `PATH`):

**Option A — winget (recommended):**
```powershell
winget install -e --id Kubernetes.kubectl
```

**Option B — Chocolatey:**
```powershell
choco install kubernetes-cli
```

**Option C — manual download:**
```powershell
curl.exe -LO "https://dl.k8s.io/release/v1.30.0/bin/windows/amd64/kubectl.exe"
# Move kubectl.exe to a folder on PATH, e.g. C:\kubectl\kubectl.exe
```

Verify in a new terminal (new window so `PATH` reloads):
```powershell
kubectl version --client
```
Expected: `Client Version: v1.30.x` (any recent 1.28+ works with K3s).

Also confirm the SSH tools exist (Windows 10+ ships them):
```powershell
ssh -V
ssh-keygen --help
```
If missing, add them in Settings > Apps > Optional features > OpenSSH Client.

## 3. Install K3s on the Linux server

Run these commands on the Linux server over SSH (not on Windows).

1. Install K3s (single node, bundled Traefik + Flannel):
   ```sh
   curl -sfL https://get.k3s.io | sh -
   ```
2. Install the NFS client (required — every K3s node needs it to mount `/workspace`):
   ```sh
   sudo apt-get update && sudo apt-get install -y nfs-common
   ```
   Repeat on every node in a multi-node cluster. Without it, pods stay `ContainerCreating` with a `mount.nfs: No such file or directory` error. Verify the NAS is reachable from the server:
   ```sh
   showmount -e <nas-ip>
   ```
3. Check the node is Ready:
   ```sh
   sudo systemctl status k3s --no-pager
   sudo kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml get nodes
   ```
   Expected: one node, `STATUS Ready`, `ROLES control-plane,master`.
4. Open firewall ports (UFW example):
   ```sh
   sudo ufw allow 6443/tcp comment 'K3s API'
   sudo ufw allow 30000:32767/tcp comment 'K3s NodePorts (SSH + web + registry)'
   ```
   `6443` is the Kubernetes API your Windows `kubectl` talks to. `30000-32767` is the NodePort range `coding-container` uses for SSH (`30022` by default), optional web ports, and the example registry below (`30500`). If the server runs `firewalld` instead of `ufw`, open the same ports with `firewall-cmd`.
5. Confirm Traefik (bundled Ingress, used for `web.ports` browser access):
   ```sh
   sudo kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml -n kube-system get pods -l app.kubernetes.io/name=traefik
   ```
   One pod in `Running` state means Ingress is ready.

Multi-node or hardened installs (separate agents, `--disable traefik`, TLS SANs) work the same way — the rest of this guide only needs the API on `:6443` and NodePorts reachable from Windows.

## 4. Install a container registry into K3s

`coding-container` pushes every image to a registry the cluster can pull from. You have two choices:

- **A (simplest for a lab):** run `registry:2` inside K3s itself (below). Free, private, no account needed. Plain HTTP, so both Docker Desktop and K3s need an explicit insecure-registry exception.
- **B (no insecure-registry hassle):** use an external registry with TLS — Docker Hub, GHCR, Harbor, or your NAS registry. Skip the YAML below and point `coding-container setup --registry` at it instead.

### Option A — in-cluster `registry:2`

Apply this manifest on the Linux server. It creates a `registry` namespace, a one-replica `registry:2` Deployment storing images under `/opt/registry-data` on the node, and a NodePort Service exposing it on every node at `:30500`:

```yaml
# registry.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: registry
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: registry
  namespace: registry
spec:
  replicas: 1
  selector:
    matchLabels:
      app: registry
  template:
    metadata:
      labels:
        app: registry
    spec:
      containers:
        - name: registry
          image: registry:2
          ports:
            - containerPort: 5000
          env:
            - name: REGISTRY_STORAGE_FILESYSTEM_ROOTDIRECTORY
              value: /data
          volumeMounts:
            - name: data
              mountPath: /data
      volumes:
        - name: data
          hostPath:
            path: /opt/registry-data
            type: DirectoryOrCreate
---
apiVersion: v1
kind: Service
metadata:
  name: registry
  namespace: registry
spec:
  type: NodePort
  selector:
    app: registry
  ports:
    - port: 5000
      targetPort: 5000
      nodePort: 30500
```

```sh
sudo mkdir -p /opt/registry-data
sudo kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml apply -f registry.yaml
sudo kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml -n registry get pods,svc
```

Expected: pod `Running`, service `registry` with `5000:30500/TCP`.

Test it from the server:
```sh
curl http://localhost:30500/v2/_catalog
# {"repositories":[]}  <- empty registry, working
```

**Tell K3s the registry is insecure.** On the server, create `/etc/rancher/k3s/registries.yaml` so K3s pulls without TLS (replace `192.168.1.50` with your server IP):

```yaml
mirrors:
  "192.168.1.50:30500":
    endpoint:
      - "http://192.168.1.50:30500"
```

Then restart K3s:
```sh
sudo systemctl restart k3s
sudo kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml -n registry get pods
```

**Tell Windows Docker the same.** In Docker Desktop, open Settings > Docker Engine and add the insecure registry to the JSON (replace `192.168.1.50` with your server IP):

```json
{
  "insecure-registries": ["192.168.1.50:30500"]
}
```

Click Apply & Restart, then log in and test the round trip from PowerShell:
```powershell
docker login 192.168.1.50:30500
docker pull hello-world
docker tag hello-world 192.168.1.50:30500/hello-world:test
docker push 192.168.1.50:30500/hello-world:test
curl.exe http://192.168.1.50:30500/v2/_catalog
```
The catalog should now list `hello-world`. If `docker push` fails with `https: ... http: server gave HTTP response to HTTPS client`, the insecure-registry entry has not applied — check the JSON syntax and that Docker restarted.

Your registry value for `coding-container setup` in [step 6](#6-wire-up-coding-container) is then:
```
192.168.1.50:30500/you
```
where `you` is any repo prefix (e.g. your username). Global-mode images become `192.168.1.50:30500/you/coding-container:v1.0.0`.

> Prefer authentication? For a lab the open registry above is normal. For anything shared, front it with an Ingress + TLS, or switch to Harbor / Docker Hub instead. `coding-container` passes your `docker login` credentials to the cluster as the pull secret either way.

### Option B — external registry

Nothing to install in K3s. From PowerShell on Windows, log in now that Docker is installed:

```powershell
docker login registry.example.com
```

Then use that host as the registry value in [step 6](#6-wire-up-coding-container), e.g. `registry.example.com/you` or `ghcr.io/you`. The cluster pulls over the internet with TLS, so no insecure-registry config is needed anywhere. `coding-container deploy` reuses this login to create the cluster pull secret, so log in with an account that can push.

## 5. Copy the K3s kubeconfig to Windows

The K3s kubeconfig lives at `/etc/rancher/k3s/k3s.yaml` on the server and defaults to `https://127.0.0.1:6443`, which only works on the server itself. Copy it to Windows and point it at the server IP.

1. On the Linux server, read the kubeconfig (root-only by default):
   ```sh
   sudo cat /etc/rancher/k3s/k3s.yaml
   ```
   Copy the whole output. Alternatively copy the file over SSH with `scp` (run on Windows, replace `user` and the IP):
   ```powershell
   scp user@192.168.1.50:/etc/rancher/k3s/k3s.yaml $env:USERPROFILE\k3s.yaml
   ```
   `scp` reads a root-owned file only if your SSH user has permission — if it fails with Permission denied, `sudo cat` the file and paste the contents into a local file instead.
2. On Windows, place it at the default kubectl location:
   ```powershell
   mkdir $env:USERPROFILE\.kube -Force
   Move-Item -Force $env:USERPROFILE\k3s.yaml $env:USERPROFILE\.kube\config
   ```
   If you pasted the contents, save them as `%USERPROFILE%\.kube\config` (no extension) with UTF-8, LF line endings.
3. Edit `%USERPROFILE%\.kube\config` and replace the server line:
   ```yaml
   server: https://127.0.0.1:6443
   ```
   with your server's LAN address:
   ```yaml
   server: https://192.168.1.50:6443
   ```
   Leave the `certificate-authority-data` and token fields untouched.
4. Verify from Windows (new PowerShell window):
   ```powershell
   kubectl get nodes
   kubectl cluster-info
   ```
   Expected: the server node `Ready`, and `Kubernetes control plane is running at https://192.168.1.50:6443`.

Notes:

- The default K3s token in the kubeconfig is a long-lived admin credential. Anyone holding the file controls the cluster — do not email it or check it into git. Back it up like a password.
- If `kubectl` on Windows reports `Unable to connect to the server: x509: certificate is valid for 127.0.0.1, ... not 192.168.1.50`, K3s generated its certificate before it knew its LAN IP. On the server, add the IP as a TLS SAN and restart:
  ```sh
  sudo sh -c 'echo "tls-san:\n  - 192.168.1.50" >> /etc/rancher/k3s/config.yaml'
  sudo systemctl restart k3s
  ```
  Then copy the fresh `k3s.yaml` to Windows again.
- Multiple clusters: keep K3s as the `current-context` in `%USERPROFILE%\.kube\config`, or set `KUBECONFIG` per terminal to switch files. `coding-container` uses the same default kubectl resolution, so whatever `kubectl get nodes` shows is what it deploys to.

## 6. Wire up coding-container

With Docker, `kubectl`, K3s, and the registry all reachable from Windows:

```powershell
npm install -g @esuyo/coding-container
coding-container setup --registry 192.168.1.50:30500/you --nfs-server 10.0.0.5 --nfs-base-path /workspaces
```

Substitute your NFS server IP and export path (the NAS share K3s nodes mount for `/workspace`). Omit the flags to be prompted interactively.

Then bootstrap the shared image once per cluster and deploy this project:

```powershell
coding-container system init --tag v1.0.0 --keep 10
coding-container create
coding-container ssh
```

See [Configuration](./configuration.md) for config layering, [CLI reference](./cli-reference.md) for all commands, and [Troubleshooting](./troubleshooting.md) for deploy failures.

## Troubleshooting (Windows)

- **`kubectl` not recognized:** you installed it but the terminal predates the `PATH` change. Open a new PowerShell window, or check with `Get-Command kubectl`. The manual download must sit in a folder on `PATH`.
- **`Unable to connect to the server` / timeout:** the server IP is wrong, `:6443` is firewalled, or K3s is down. From Windows try `Test-NetConnection 192.168.1.50 -Port 6443`. On the server check `sudo systemctl status k3s`.
- **`x509: certificate is valid for ...`:** add the `tls-san` entry as in step 5 and re-copy the kubeconfig.
- **`docker push` to the in-cluster registry fails with HTTPS errors:** Docker Desktop has no insecure-registry entry for `server-ip:30500`, or it did not restart after you added it. Settings > Docker Engine must be valid JSON containing the `insecure-registries` array.
- **Pod stuck `ImagePullBackOff`:** K3s lacks the insecure mirror (step 4 `registries.yaml` + `systemctl restart k3s`), or the pull secret is stale. Delete the managed secret and redeploy:
  ```powershell
  kubectl -n coding delete secret coding-192-168-1-50-30500
  coding-container deploy
  ```
- **Pod stuck `ContainerCreating` (NFS):** the K3s node cannot reach the NAS, or `nfs.basePath` does not exist on it (per-project folders are auto-created, the base export must exist). `kubectl -n coding describe pod -l app=<project>` names the cause.
- **Line-ending / YAML errors in `.kube\config`:** the file must be UTF-8 without BOM and use LF or CRLF consistently. If you pasted it via Notepad, re-save as UTF-8; stray whitespace before `server:` breaks parsing.

## See also

- [Configuration](./configuration.md) — registry, NFS, and NodePort settings
- [CLI reference](./cli-reference.md) — all commands and flags
- [Troubleshooting](./troubleshooting.md) — deploy and connection fixes
- [Architecture](./architecture.md) — how build, push, deploy, and SSH fit together
