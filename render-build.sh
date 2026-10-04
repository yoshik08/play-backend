#!/bin/bash
set -e
# render build: node deps + yt-dlp + static ffmpeg (via imageio-ffmpeg wheel)
npm install
pip3 install --break-system-packages -q yt-dlp imageio-ffmpeg
mkdir -p ./bin
FF=$(python3 -c "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())")
cp "$FF" ./bin/ffmpeg
chmod +x ./bin/ffmpeg
export PATH="$PWD/bin:$PATH"
./bin/ffmpeg -version | head -1
python3 -m yt_dlp --version
