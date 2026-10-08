package com.example

import org.springframework.beans.factory.annotation.Value

class Config {
    val secret = System.getenv("KT_SECRET") ?: "dev"
    val required = System.getenv("KT_REQUIRED") ?: error("KT_REQUIRED is required")
    val fromMap = System.getenv()["KT_MAP"]

    @Value("\${KT_VALUE}") lateinit var value: String
    // In Kotlin a bare ${…} is string interpolation, not a Spring placeholder.
    val interpolated = "${KT_INTERPOLATED}"
}
