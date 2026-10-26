# Linux build and test environment. The mod host runs mods only on macOS, so runner, sandbox and broker tests fail
# here by design.
# Build it from a clone: a linked worktree's `.git` file points outside the image, so Git-backed checks fail.
FROM debian:trixie-slim

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential bubblewrap ca-certificates curl git libasound2-dev libcap-dev libssl-dev netcat-openbsd \
      openssh-client pkg-config sqlite3 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /private && ln -s /tmp /private/tmp

RUN useradd --create-home omd
USER omd
WORKDIR /home/omd/oh-my-diff
ENV PATH=/home/omd/.local/bin:/home/omd/.local/share/mise/shims:/home/omd/.cargo/bin:$PATH \
    OMD_WORK_ROOT=/home/omd/work COREPACK_ENABLE_DOWNLOAD_PROMPT=0

COPY --chown=omd:omd mise.toml upstream.lock.json ./
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --component clippy,rustfmt,rust-src \
      --default-toolchain "$(sed -n 's/.*"rust_toolchain": "\(.*\)".*/\1/p' upstream.lock.json)" \
    && curl -fsSL https://mise.run | MISE_VERSION=v2026.9.15 sh \
    && mise trust mise.toml && mise install && mise use -g python@3.14.6 \
    && mise exec -- corepack enable --install-directory /home/omd/.local/bin

COPY --chown=omd:omd mods/package.json mods/pnpm-lock.yaml mods/
RUN corepack install -g "$(sed -n 's/.*"packageManager": "\(.*\)".*/\1/p' mods/package.json)"

COPY --chown=omd:omd . .
RUN mkdir -p /home/omd/work && pnpm --dir mods install --frozen-lockfile
CMD ["bash"]
