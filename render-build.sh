#!/bin/bash
set -e
# render build: node deps + yt-dlp + static ffmpeg
npm install
pip3 install --break-system-packages -q yt-dlp
if [ ! -f ./bin/ffmpeg ]; then
  mkdir -p ./bin
  curl -sL https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz \
    | tar -xJ --wildcards '*/ffmpeg' --strip-components=1 -C /tmp
  mv /tmp/ffmpeg ./bin/ffmpeg
  chmod +x ./bin/ffmpeg
fi
export PATH="$PWD/bin:$PATH"
./bin/ffmpeg -version | head -1
python3 -m yt_dlp --version
