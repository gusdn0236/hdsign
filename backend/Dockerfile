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
# Railway 컨테이너 메모리에 맞춰 JVM 힙 자동 스케일 + JVM TZ 도 KST 명시(이중 보장).
# MaxRAMPercentage=75 면 512MB 컨테이너에서 ~384MB, 2GB 컨테이너에서 ~1.5GB 힙.
# 명시 안 하면 JVM 이 보수적으로 ~25% 만 잡아 OOM 위험이 커짐.
# OOM 발생 시 힙 덤프를 컨테이너 로그 경로에 남겨 원인 추적 가능.
ENV JAVA_TOOL_OPTIONS="-Duser.timezone=Asia/Seoul -XX:MaxRAMPercentage=75 -XX:+ExitOnOutOfMemoryError -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/tmp"
ENTRYPOINT ["java", "-jar", "app.jar"]