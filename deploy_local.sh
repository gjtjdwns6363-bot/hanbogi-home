#!/bin/zsh
# 매일 갱신(launchd com.hanbogi.home-daily → Terminal에서 실행). 키는 맥 키체인(hanbogi-data-go-kr)에서 읽는다.
# 빌드·배포 뒤, 신고가 비교용 과거 36개월 백필이 덜 끝났으면 하루 API별 8,000회까지 이어서 채운다.
export PATH=$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH
cd "$(dirname "$0")" || exit 1
echo "=== $(date '+%F %T') 시작"
export DATA_GO_KR_KEY=$(security find-generic-password -a "$USER" -s hanbogi-data-go-kr -w) || exit 1
node build.js 2>&1 | grep -v serviceKey | tail -3
[ -f dist/index.html ] && [ -d dist/data ] || { echo "빌드 결과 없음, 배포 안 함"; exit 1; }
(cd dist && touch .nojekyll && rm -rf .git && git init -q -b gh-pages && git add -A && git commit -qm "매일 갱신 $(date '+%F %H:%M')" \
 && git push -q -f https://github.com/gjtjdwns6363-bot/hanbogi-home.git gh-pages && rm -rf .git \
 && gh api -X POST repos/gjtjdwns6363-bot/hanbogi-home/pages/builds >/dev/null && echo "배포 완료 $(date)")
node backfill.js 2>&1 | grep -v serviceKey | grep -v '진행' | tail -4
