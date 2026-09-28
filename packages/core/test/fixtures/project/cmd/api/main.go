package main

import "os"

func main() {
	_ = os.Getenv("DATABASE_URL")
	_ = os.Getenv(`GO_TOKEN`)
	_, _ = os.LookupEnv("REGION")
}
