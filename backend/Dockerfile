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
# Railway 컨테이너 메모리에 맞춰 JVM 힙 자동 스케일.
# MaxRAMPercentage=75 면 512MB 컨테이너에서 ~384MB, 2GB 컨테이너에서 ~1.5GB 힙.
# 명시 안 하면 JVM 이 보수적으로 ~25% 만 잡아 OOM 위험이 커짐.
# OOM 발생 시 힙 덤프를 컨테이너 로그 경로에 남겨 원인 추적 가능.
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75 -XX:+ExitOnOutOfMemoryError -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/tmp"
ENTRYPOINT ["java", "-jar", "app.jar"]