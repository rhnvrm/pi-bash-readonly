#!/usr/bin/env bash
set -euo pipefail

mkdir -p /run/sshd /home/pi/.ssh /srv/project/subdir
chown pi:pi /home/pi /home/pi/.ssh /srv/project /srv/project/subdir
chmod 700 /home/pi/.ssh

cat >/etc/ssh/sshd_config.d/pi-bash-readonly.conf <<'EOF'
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
UsePAM no
PermitRootLogin no
StrictModes no
AllowUsers pi
AuthorizedKeysFile /home/pi/.ssh/authorized_keys
PrintMotd no
EOF

if [[ "${WITH_BWRAP:-0}" == "1" ]]; then
	cat >/usr/local/bin/bwrap <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'stub-bwrap\n' >> /tmp/pi-bash-ro-bwrap.log
while [[ $# -gt 0 ]]; do
	if [[ "$1" == "bash" ]]; then
		exec "$@"
	fi
	shift
done

echo "expected bash invocation" >&2
exit 1
EOF
	chmod +x /usr/local/bin/bwrap
else
	rm -f /usr/local/bin/bwrap
fi

exec /usr/sbin/sshd -D -e
