#!/bin/bash
set -e
# render build: node deps only. no yt-dlp, no ffmpeg — audio comes
# exclusively from Google Drive, streamed with Range support.
npm install
