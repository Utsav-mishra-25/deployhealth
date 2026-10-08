package com.example;

import java.util.Optional;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class App {
    String payments = System.getenv("PAYMENTS_URL");
    String region = System.getenv().getOrDefault("REGION", "eu");
    String timeout = Optional.ofNullable(System.getenv("TIMEOUT")).orElse("30");
    String token = System.getenv().get("API_TOKEN");
    String noDefault = System.getenv().getOrDefault("NULL_DEFAULT", null);

    @Value("${STRIPE_KEY}") String stripeKey;
    @Value("${CURRENCY:EUR}") String currency;
    @Value("${server.port}") int port;
    @Value("${OUTER:${INNER}}") String nested;
}
