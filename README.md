# 부동산 알리미 (home.hanbogi.com)

공공데이터로 매일 05:00 KST에 다시 만드는 정적 사이트. GitHub Actions(`.github/workflows/build.yml`)가 `node build.js`로 `dist/`를 만들어 GitHub Pages에 배포한다. 생성물은 커밋하지 않는다.

- `node build.js` — 실제 API 호출 (env `DATA_GO_KR_KEY` = 공공데이터포털 **디코딩** 키, 저장소 시크릿)
- `node build.js --fixtures` — `fixtures/`의 샘플 응답으로 생성 (키 불필요)
- `node test.js` — 가격 표시·중위값·날짜 파싱·XML 파서 검사

## 데이터
| 자료 | 엔드포인트 | 명세 |
|---|---|---|
| 아파트 매매 실거래가 상세 | `apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev` (XML) | https://www.data.go.kr/data/15126468/openapi.do |
| 아파트 전월세 실거래가 | `apis.data.go.kr/1613000/RTMSDataSvcAptRent/getRTMSDataSvcAptRent` (XML) | https://www.data.go.kr/data/15126474/openapi.do |
| 청약홈 APT 분양정보 상세 / 주택형별 | `api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail`, `.../getAPTLttotPblancMdl` (JSON) | https://www.data.go.kr/data/15098547/openapi.do |
| LH 분양임대공고문 조회 | `apis.data.go.kr/B552555/lhLeaseNoticeInfo1/lhLeaseNoticeInfo1` (JSON) | https://www.data.go.kr/data/15058530/openapi.do (활용가이드 docx 20260708) |

`regions.json` (시군구 255곳) 출처: 국토교통부_전국 법정동 (https://www.data.go.kr/data/15063424/fileData.do, 2026-06-09 판) CSV에서 `법정동코드`가 `xxxxx00000`이고 시군구명이 있는 행의 앞 5자리. 구가 있는 시(예: 수원시 41110)는 빼고 구 코드(41111 등)만 남겼다. 법정동 개편 시 같은 방식으로 다시 만든다.

## 하루 호출 수 (대략)
- 실거래 매매·전월세: 255곳 × 2개월 × 1~2쪽 → API별 약 510~600회
- 청약홈: 목록 1회 + 공고별 주택형 약 50~150회
- LH: 1~2회
API별 1회 실행 상한 4,000회(`CAP`), 일일 한도 10,000회.
