# Compile on the builder's native architecture, including when targeting another
# Linux architecture. This avoids emulating the compiler on small servers.
FROM --platform=$BUILDPLATFORM rust:1.95-slim-bookworm AS builder

ARG BUILDARCH
ARG TARGETARCH
RUN set -eux; \
    apt-get -o Acquire::Retries=4 update; \
    apt-get -o Acquire::Retries=4 install -y --no-install-recommends build-essential ca-certificates; \
    case "$BUILDARCH-$TARGETARCH" in \
      arm64-amd64) apt-get -o Acquire::Retries=4 install -y --no-install-recommends gcc-x86-64-linux-gnu libc6-dev-amd64-cross ;; \
      amd64-arm64) apt-get -o Acquire::Retries=4 install -y --no-install-recommends gcc-aarch64-linux-gnu libc6-dev-arm64-cross ;; \
      amd64-amd64|arm64-arm64) ;; \
      *) echo "Unsupported build/target architecture: $BUILDARCH/$TARGETARCH" >&2; exit 1 ;; \
    esac; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src/ src/
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    set -eux; \
    case "$TARGETARCH" in \
      amd64) target=x86_64-unknown-linux-gnu; \
        export CC_x86_64_unknown_linux_gnu=x86_64-linux-gnu-gcc; \
        export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=x86_64-linux-gnu-gcc ;; \
      arm64) target=aarch64-unknown-linux-gnu; \
        export CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc; \
        export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc ;; \
      *) echo "Unsupported target architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    rustup target add "$target"; \
    cargo build --locked --release --bin dogo-memo-server --target "$target"; \
    cp "target/$target/release/dogo-memo-server" /dogo-memo-server

FROM debian:bookworm-slim
COPY --from=builder /dogo-memo-server /usr/local/bin/dogo-memo-server
USER 65532:65532
WORKDIR /app
ENV DOGO_RUST_DATA_DIR=/data DOGO_RUST_LISTEN=0.0.0.0:8789
EXPOSE 8789
STOPSIGNAL SIGINT
ENTRYPOINT ["/usr/local/bin/dogo-memo-server"]
