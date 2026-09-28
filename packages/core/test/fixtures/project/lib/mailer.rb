class Mailer
  HOST = ENV["SMTP_HOST"]
  FALLBACK = ENV.fetch("SMTP_HOST", "localhost")
end
