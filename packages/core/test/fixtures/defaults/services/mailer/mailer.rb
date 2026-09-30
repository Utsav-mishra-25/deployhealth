module Mailer
  URL = ENV.fetch("SMTP_URL")
  PORT = ENV.fetch("SMTP_PORT", 587)
  FROM = ENV.fetch("SMTP_FROM") { "noreply@example.com" }
  DEBUG = ENV["SMTP_DEBUG"] || "false"
  USER = ENV["SMTP_USER"]
end
