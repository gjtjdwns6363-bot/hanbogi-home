#!/bin/zsh
# 임시 매일 갱신(GitHub Actions 권한 승인 전까지). 키는 맥 키체인(hanbogi-data-go-kr)에서 읽는다.
export PATH=$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH
cd "$(dirname "$0")" || exit 1
export DATA_GO_KR_KEY=$(security find-generic-password -a "$USER" -s hanbogi-data-go-kr -w) || exit 1
node build.js 2>&1 | grep -v serviceKey | tail -3 || exit 1
cd dist && touch .nojekyll && rm -rf .git && git init -q -b gh-pages && git add -A && git commit -qm "매일 갱신 $(date '+%F %H:%M')" \
 && git push -q -f https://github.com/gjtjdwns6363-bot/hanbogi-home.git gh-pages && rm -rf .git \
 && gh api -X POST repos/gjtjdwns6363-bot/hanbogi-home/pages/builds >/dev/null && echo "배포 완료 $(date)"
