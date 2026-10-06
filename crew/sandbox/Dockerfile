# sidequest-crew: the sandbox a crew member runs in. The harness CLIs (claude, codex, grok), Foundry and bun are mounted
# read-only from the host at run time (same versions as the host, nothing baked in); this image carries the OS,
# node for npx tools (wrangler, hyperframes), Chrome's libraries for headless rendering, git, python and ffmpeg.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq python3 python3-pip ripgrep ffmpeg unzip xz-utils \
      libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
      libxfixes3 libxrandr2 libgbm1 libasound2t64 libpango-1.0-0 libcairo2 libudev1 fonts-dejavu-core \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*
# the host's uid, so files in mounted directories stay owned by the host user
RUN userdel -r ubuntu 2>/dev/null; useradd -m -u 1000 -s /bin/bash agent
COPY sq-deliver /usr/local/bin/
USER agent
WORKDIR /crew/agent
