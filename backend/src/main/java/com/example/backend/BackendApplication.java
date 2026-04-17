package com.example.backend;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class BackendApplication {

    public static void main(String[] args) {
        var context = SpringApplication.run(BackendApplication.class, args);
        var encoder = context.getBean(org.springframework.security.crypto.password.PasswordEncoder.class);
        System.out.println(encoder.encode("hdno0958"));
    }

}
