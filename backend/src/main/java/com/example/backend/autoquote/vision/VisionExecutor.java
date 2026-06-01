package com.example.backend.autoquote.vision;

import jakarta.annotation.PreDestroy;
import org.springframework.stereotype.Component;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 비전 업스트림 호출을 별도 스레드에서 돌려 60초 예산 타임아웃을 걸 수 있게 하는 풀.
 * 데몬 스레드라 종료를 막지 않으며, 컨텍스트 종료 시 정리한다.
 */
@Component
public class VisionExecutor {

    private final ExecutorService executor = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "autoquote-vision");
        t.setDaemon(true);
        return t;
    });

    public ExecutorService get() {
        return executor;
    }

    @PreDestroy
    public void shutdown() {
        executor.shutdownNow();
    }
}
