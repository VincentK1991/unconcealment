package com.unconcealment.backend.config;

import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Contact;
import io.swagger.v3.oas.models.info.Info;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class OpenApiConfig {

    @Bean
    public OpenAPI unconcealmentOpenApi() {
        return new OpenAPI()
                .info(new Info()
                        .title("Unconcealment Backend API")
                        .description("SPARQL gateway, ingestion, document access, and health endpoints.")
                        .version("v1")
                        .contact(new Contact().name("Unconcealment Backend")));
    }
}
