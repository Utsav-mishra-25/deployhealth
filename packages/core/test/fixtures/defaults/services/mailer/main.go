package main

import "os"

func main() {
	region := os.Getenv("MAILER_REGION")
	_ = region
}
