FROM eclipse-temurin:17-jdk-alpine AS build
WORKDIR /app
COPY gradlew .
COPY gradle gradle
COPY build.gradle .
COPY settings.gradle .
COPY src src
RUN chmod +x ./gradlew
RUN ./gradlew bootJar -x test

FROM eclipse-temurin:17-jre-alpine
WORKDIR /app
COPY --from=build /app/build/libs/*.jar app.jar
EXPOSE 8080
# 컨테이너 timezone — Asia/Seoul 로 고정. JVM 의 LocalDateTime.now() 와 @CreationTimestamp 가
# KST 기준으로 기록되므로 모바일/관리자에서 보이는 모든 시각이 한국 시간과 일치.
# 명시 안 하면 alpine 기본 UTC 라 9시간 어긋남(예: 13:40 누른 게 04:40 으로 보임).
ENV TZ=Asia/Seoul
# JVM 힙 천장을 절대값으로 고정 + JVM TZ 도 KST 명시(이중 보장).
#
# ⚠️ 왜 MaxRAMPercentage 가 아니라 -Xmx 절대값인가 (2026-07 결정):
# Railway Hobby 플랜은 서비스별 하드 메모리 리밋을 UI 에서 못 건다(Deploy 설정에 항목 자체가 없음).
# 그래서 컨테이너가 호스트 머신의 전체 RAM(32GB급)을 보게 되고, MaxRAMPercentage=75 를 쓰면
# JVM 이 그 75% 를 힙 천장으로 잡아 버린다. 실제 2026-06 사고: 지시서 렌더(DPI 600)가 힙을
# 19GB 까지 부풀렸고 G1 이 OS 로 반납하지 않아 한 달 내내 평균 2.69GB 점유 → 메모리 요금 폭탄
# $26.87. 컨테이너 리밋을 못 거는 환경에선 -Xmx 절대값이 유일하고 확실한 캡이다.
#
# -Xmx1536m: 힙은 무조건 1.5GB 이하. 여기에 metaspace/스레드/PDFBox native(~수백 MB)를 더해도
# RSS 는 ~2GB 를 넘지 않는다. Railway 과금은 실제 RSS 기반이므로 이 캡이 곧 요금 상한이 된다.
# -Xms256m: 초기 힙은 작게 잡아, 유휴 시 G1PeriodicGC 가 남는 영역을 OS 로 되돌릴 여지를 준다.
# 실사용은 평상시 ~0.3GB(2026-07 실측)라 1.5GB 힙이면 대형 지시서 동시 평탄화도 충분히 소화.
#
# G1PeriodicGC: 트래픽 스파이크(대형 지시서 평탄화 등)로 힙이 한번 부푼 뒤, 유휴 상태가 되면
# 주기적 concurrent GC 를 돌려 비어 있는 힙 영역을 OS 로 되돌린다(RSS 하향 → 점유시간 기반 과금 절감).
# InvokesConcurrent=주기 GC 를 STW full GC 가 아닌 concurrent 사이클로 → 응답성 영향 최소.
# Interval=60000: 60초마다 반납 기회 점검. 정상 부하에선 반납할 게 없어 오버헤드도 거의 없다.
#
# OOM 발생 시 컨테이너 즉사(ExitOnOutOfMemoryError)+힙덤프(/tmp)로 원인 추적. Railway Restart
# Policy(On Failure, 최대 10회)가 자동 재시작하므로 지저분하게 버티지 않고 깨끗이 복구된다.
ENV JAVA_TOOL_OPTIONS="-Duser.timezone=Asia/Seoul -Dfile.encoding=UTF-8 -Xmx1536m -Xms256m -XX:+G1PeriodicGCInvokesConcurrent -XX:G1PeriodicGCInterval=60000 -XX:+ExitOnOutOfMemoryError -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/tmp"
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8
ENTRYPOINT ["java", "-jar", "app.jar"]