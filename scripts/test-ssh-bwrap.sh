#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="$repo_root/tests/docker-compose.ssh.yml"
project_name="pi-bash-ro-ssh-$$"
runtime_dir=""
docker_home_dir=""
docker_config_dir=""
docker_tmp_dir=""
with_bwrap_port=""
without_bwrap_port=""

runtime_base_candidates() {
	cat <<EOF
${PI_BASH_RO_SSH_RUNTIME_DIR_BASE:-}
${PI_BASH_RO_TEST_TMPDIR:-}
${BOSUN_WORKSPACE:+$BOSUN_WORKSPACE/scratch/pi-bash-readonly-docker}
${XDG_RUNTIME_DIR:+$XDG_RUNTIME_DIR/pi-bash-readonly-docker}
${TMPDIR:+$TMPDIR/pi-bash-readonly-docker}
/dev/shm/pi-bash-readonly-docker
/var/tmp/pi-bash-readonly-docker
/tmp/pi-bash-readonly-docker
$repo_root/tests/ssh-compose
EOF
}

create_runtime_dir() {
	local candidate
	while IFS= read -r candidate; do
		[[ -n "$candidate" ]] || continue
		mkdir -p "$candidate" 2>/dev/null || continue
		if runtime_dir="$(mktemp -d "$candidate/runtime.XXXXXX" 2>/dev/null)"; then
			return 0
		fi
	done < <(runtime_base_candidates)

	echo "[pi-bash-readonly] unable to create a writable runtime directory for docker ssh validation" >&2
	return 1
}

if ! create_runtime_dir; then
	if [[ "${PI_BASH_RO_DOCKER_TESTS_STRICT:-0}" == "1" ]]; then
		exit 1
	fi
	echo "[pi-bash-readonly] skipping docker ssh validation: no writable runtime directory available" >&2
	exit 0
fi

pick_free_port() {
	node -e 'const net = require("node:net"); const server = net.createServer(); server.listen(0, "127.0.0.1", () => { const address = server.address(); console.log(address && typeof address === "object" ? address.port : ""); server.close(); }); server.on("error", () => process.exit(1));'
}

with_bwrap_port="${PI_BASH_RO_SSH_PORT_WITH_BWRAP:-$(pick_free_port)}"
without_bwrap_port="${PI_BASH_RO_SSH_PORT_WITHOUT_BWRAP:-$(pick_free_port)}"
while [[ "$without_bwrap_port" == "$with_bwrap_port" ]]; do
	without_bwrap_port="$(pick_free_port)"
done

if [[ -z "$with_bwrap_port" || -z "$without_bwrap_port" ]]; then
	echo "[pi-bash-readonly] unable to allocate host ports for docker ssh validation" >&2
	exit 1
fi

docker_home_dir="$runtime_dir/docker-home"
docker_config_dir="$runtime_dir/docker-config"
docker_tmp_dir="$runtime_dir/docker-tmp"
mkdir -p "$docker_home_dir" "$docker_config_dir" "$docker_tmp_dir"

docker_cmd() {
	HOME="$docker_home_dir" \
	TMPDIR="$docker_tmp_dir" \
	TMP="$docker_tmp_dir" \
	TEMP="$docker_tmp_dir" \
	DOCKER_CONFIG="$docker_config_dir" \
	docker "$@"
}

compose() {
	HOME="$docker_home_dir" \
	TMPDIR="$docker_tmp_dir" \
	TMP="$docker_tmp_dir" \
	TEMP="$docker_tmp_dir" \
	PI_BASH_RO_SSH_PORT_WITH_BWRAP="$with_bwrap_port" \
	PI_BASH_RO_SSH_PORT_WITHOUT_BWRAP="$without_bwrap_port" \
	DOCKER_CONFIG="$docker_config_dir" \
	docker compose \
		-f "$compose_file" \
		-p "$project_name" \
		"$@"
}

cleanup() {
	local status=$?
	set +e
	if [[ -n "$runtime_dir" ]]; then
		if [[ $status -ne 0 ]]; then
			echo "[pi-bash-readonly] docker ssh validation failed; compose logs:" >&2
			compose logs --no-color >&2 || true
		fi
		compose down -v --remove-orphans >/dev/null 2>&1 || true
		rm -rf "$runtime_dir"
	fi
}
trap cleanup EXIT

ssh-keygen -q -t ed25519 -N "" -C "pi-bash-readonly-docker-test" -f "$runtime_dir/id_ed25519"
cp "$runtime_dir/id_ed25519.pub" "$runtime_dir/authorized_keys"
chmod 600 "$runtime_dir/authorized_keys"

compose up -d --build

install_authorized_keys() {
	local service=$1
	local container_id
	container_id="$(compose ps -q "$service")"
	if [[ -z "$container_id" ]]; then
		echo "[pi-bash-readonly] unable to resolve container id for service: $service" >&2
		return 1
	fi

	docker_cmd exec -i "$container_id" sh -lc 'cat > /home/pi/.ssh/authorized_keys && chown pi:pi /home/pi/.ssh/authorized_keys && chmod 600 /home/pi/.ssh/authorized_keys' < "$runtime_dir/authorized_keys"
	docker_cmd exec "$container_id" sh -lc 'test -s /home/pi/.ssh/authorized_keys'
}

install_authorized_keys with-bwrap
install_authorized_keys without-bwrap

wait_for_ssh() {
	local port=$1
	for _ in $(seq 1 30); do
		if ssh \
			-F /dev/null \
			-i "$runtime_dir/id_ed25519" \
			-o IdentitiesOnly=yes \
			-o StrictHostKeyChecking=no \
			-o UserKnownHostsFile=/dev/null \
			-o LogLevel=ERROR \
			-o ConnectTimeout=2 \
			-p "$port" \
			pi@127.0.0.1 true >/dev/null 2>&1; then
			return 0
		fi
		sleep 1
	done
	return 1
}

wait_for_ssh "$with_bwrap_port"
wait_for_ssh "$without_bwrap_port"

cd "$repo_root"
PI_BASH_RO_RUN_DOCKER_TESTS=1 \
PI_BASH_RO_SSH_HOST=127.0.0.1 \
PI_BASH_RO_SSH_USER=pi \
PI_BASH_RO_SSH_KEY_PATH="$runtime_dir/id_ed25519" \
PI_BASH_RO_SSH_PORT_WITH_BWRAP="$with_bwrap_port" \
PI_BASH_RO_SSH_PORT_WITHOUT_BWRAP="$without_bwrap_port" \
bun test tests/docker-ssh.test.ts
