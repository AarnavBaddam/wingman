FROM ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libnss3 libatk-bridge2.0-0t64 libgtk-3-0t64 \
    libgbm1 libasound2t64 libxss1 libsecret-1-0 \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home aether-test
USER aether-test
ENV HOME=/home/aether-test APPIMAGE_EXTRACT_AND_RUN=1
ENTRYPOINT ["/opt/Aether.AppImage", "--no-sandbox", "--ozone-platform=headless", "--disable-gpu", "--remote-debugging-port=9333", "--user-data-dir=/tmp/aether-profile"]
