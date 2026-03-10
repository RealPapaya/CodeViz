// main.go — Application entry point
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/testproject/config"
	"github.com/testproject/server"
	"github.com/testproject/store"
	"github.com/testproject/worker"
)

var (
	configPath = flag.String("config", "config/app.yaml", "path to config file")
	verbose    = flag.Bool("verbose", false, "enable verbose logging")
	port       = flag.Int("port", 8080, "HTTP server port")
)

func main() {
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("failed to load config: %v", err)
	}

	if *verbose {
		cfg.Log.Level = "debug"
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	db, err := store.Connect(cfg.Database)
	if err != nil {
		log.Fatalf("failed to connect to database: %v", err)
	}
	defer db.Close()

	pool := worker.NewPool(cfg.Worker.Concurrency)
	pool.Start(ctx)

	srv := server.New(cfg, db, pool)
	srv.SetPort(*port)

	go func() {
		if err := srv.ListenAndServe(); err != nil {
			log.Printf("server error: %v", err)
		}
	}()

	fmt.Printf("🚀 Server running on :%d\n", *port)
	waitForShutdown(cancel, srv)
}

func waitForShutdown(cancel context.CancelFunc, srv *server.Server) {
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	sig := <-sigCh
	fmt.Printf("\nReceived signal: %s. Shutting down...\n", sig)
	cancel()

	shutdownCtx, done := context.WithTimeout(context.Background(), 10*time.Second)
	defer done()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown error: %v", err)
	}
	fmt.Println("Server stopped.")
}
