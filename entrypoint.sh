#!/bin/bash
#
# Container entrypoint for the coding-container image.
#
# Two modes, chosen by the effective UID at start:
#   root  -> the historical behavior: sshd on 22, env in /etc/profile.d.
#   non-0 -> rootless: sshd as the image user on CODING_CONTAINER_SSH_PORT
#            (default 2222), with host keys/config/pid in the user's home.
#
# A non-root sshd cannot switch users, cannot bind a privileged port, and
# skips the root-only /run/sshd check (OpenSSH >= 7.6), so this script never
# writes /run or /etc in that mode. The app sets the port and grants no
# capabilities; see docs/rootless.md.
#
# The Dockerfile copies this file to /entrypoint.sh and strips CR so a
# Windows (CRLF) checkout still produces a valid script. Setup copies the
# same file next to the global Dockerfile for the image build.

set -e

# Republish the container environment for login and non-login shells. Session
# fields are skipped: sshd sets HOME/USER/SHELL from /etc/passwd, and a stale
# HOME=/root inherited from the image would break a rootless session.
publish_env() {
    local target="$1"
    : > "$target"
    while IFS= read -r -d '' kv; do
        name=${kv%%=*}
        case "$name" in
            HOME|USER|LOGNAME|SHELL|PWD|OLDPWD|SHLVL|_) continue ;;
        esac
        value=${kv#*=}
        escaped=${value//"'"/"'\\''"}
        printf "export %s='%s'\n" "$name" "$escaped"
    done < /proc/self/environ >> "$target"
}

if [ "$(id -u)" -ne 0 ]; then
    # Rootless mode: the image's non-root user runs sshd for itself. It cannot
    # switch users and cannot bind a privileged port, so the app config uses
    # port 2222 and the manifest grants no capabilities.
    home="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)"
    if [ -z "$home" ]; then
        echo "entrypoint: cannot resolve the home directory for uid $(id -u)" >&2
        exit 1
    fi
    export HOME="$home"
    mkdir -p "$home/.ssh"
    chmod 700 "$home/.ssh"

    # Fail fast with a clear message when the NFS export or folder ownership
    # does not match this UID; otherwise the pod would start and fail later.
    if ! touch /workspace/.coding-container-write-test 2>/dev/null; then
        echo "entrypoint: /workspace is not writable by uid $(id -u) (gid $(id -g)); fix the NFS export or folder ownership for this UID" >&2
        exit 1
    fi
    rm -f /workspace/.coding-container-write-test

    # Keep the k8s env (image ENV + pod spec) visible without writing /etc.
    env_file="$home/.coding-container-env.sh"
    publish_env "$env_file"
    chmod 600 "$env_file"
    for rc in "$home/.profile" "$home/.bashrc"; do
        touch "$rc"
        if ! grep -q 'coding-container env' "$rc"; then
            printf '\n# coding-container env\n[ -f "%s" ] && . "%s"\n' "$env_file" "$env_file" >> "$rc"
        fi
    done

    # Host keys are ephemeral, like the root path: generate per pod unless
    # present. The key is user-owned, so sshd can read it without root.
    if [ ! -s "$home/.ssh/ssh_host_ed25519_key" ]; then
        ssh-keygen -q -t ed25519 -N '' -f "$home/.ssh/ssh_host_ed25519_key"
    fi

    port="${CODING_CONTAINER_SSH_PORT:-2222}"
    cat > "$home/.ssh/sshd_config" <<EOF
Port $port
HostKey $home/.ssh/ssh_host_ed25519_key
PidFile $home/.ssh/sshd.pid
AuthorizedKeysFile $home/.ssh/authorized_keys
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
UsePAM no
AllowUsers $(id -un)
StrictModes yes
PrintMotd no
PrintLastLog no
UseDNS no
AllowTcpForwarding yes
AllowAgentForwarding yes
X11Forwarding no
Subsystem sftp internal-sftp
LogLevel INFO
EOF
    exec /usr/sbin/sshd -D -e -f "$home/.ssh/sshd_config" "$@"
fi

# Root mode: unchanged behavior.
mkdir -p /run/sshd
publish_env /etc/profile.d/99-container-env.sh
exec /usr/sbin/sshd -D "$@"
