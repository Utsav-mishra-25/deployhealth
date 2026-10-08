// Build tooling: CI and publishing secrets read here are never references or MISSING.
val signing = System.getenv("SIGNING_KEY") ?: ""
val sonar = System.getenv("SONAR_TOKEN")
