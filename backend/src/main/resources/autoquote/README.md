# autoquote/ — 런타임 프로비저닝 (커밋 금지)

이 디렉터리에는 자동견적 기밀 학습 데이터가 들어가지만 **git 에 절대 커밋하지 않는다**.
이 GitHub 저장소는 **PUBLIC** 이며 `corpus.json`(과거 명세서 코퍼스, ~4.7MB)·`priors.json`
(학습된 prior)은 **회사 기밀(명세서 원본 라인)** 이라 공개 호스팅이 금지된다(Iron Law).

## 서빙 방식

`AdminAutoQuoteController` 는 이 파일들을 classpath 가 아니라 **런타임 파일시스템**에서 읽는다.
경로는 프로퍼티 `autoquote.data-dir`(환경변수 `AUTOQUOTE_DATA_DIR`)로 설정한다.

- **로컬/통합테스트(bootRun, e2e)**: `auto-quote-data/autoquote/{corpus,priors}.json`
  (gitignore 된 개인 PC 데이터 홈). `application-autoquote-it.properties` 에서
  `autoquote.data-dir` 절대경로로 지정한다.
- **운영(Railway)**: 영구 볼륨을 마운트하고 `AUTOQUOTE_DATA_DIR` 를 그 마운트 경로로 설정한다.

파일이 없거나 디렉터리가 미설정/부재이면 엔드포인트는 **503 `{"error":"autoquote_data_unavailable"}`**
로 graceful 하게 응답한다(500/stacktrace 없음). admin JWT 는 항상 필요하다.

`.gitignore` 가 `backend/src/main/resources/autoquote/*.json` 를 차단하므로 실수로 이 위치에
실데이터를 떨어뜨려도 추적되지 않는다. 테스트는 `src/test/resources/autoquote-fixtures/` 의
**작은 가짜 픽스처**만 사용하며 실데이터를 참조하지 않는다.
