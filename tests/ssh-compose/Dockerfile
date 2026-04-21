FROM debian:bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends bash ca-certificates openssh-server \
	&& rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash pi \
	&& passwd -d pi \
	&& mkdir -p /run/sshd /home/pi/.ssh /srv/project/subdir \
	&& chown -R pi:pi /home/pi /srv/project \
	&& chmod 700 /home/pi/.ssh \
	&& ssh-keygen -A

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
