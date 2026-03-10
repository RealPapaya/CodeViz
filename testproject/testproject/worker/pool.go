// worker/pool.go — Concurrent worker pool
package worker

import (
	"context"
	"log"
	"sync"
	"sync/atomic"
	"time"
)

// Job represents a unit of work.
type Job struct {
	ID      string
	Type    string
	Payload map[string]any
	Retry   int
}

// Result holds the outcome of processing a Job.
type Result struct {
	JobID   string
	Success bool
	Output  map[string]any
	Error   error
	Elapsed time.Duration
}

// Pool manages a pool of goroutine workers.
type Pool struct {
	concurrency int
	jobs        chan Job
	results     chan Result
	handlers    map[string]HandlerFunc
	wg          sync.WaitGroup
	mu          sync.RWMutex

	totalProcessed atomic.Int64
	totalFailed    atomic.Int64
	totalDropped   atomic.Int64
}

type HandlerFunc func(ctx context.Context, job Job) (map[string]any, error)

// NewPool creates a Pool with the given concurrency.
func NewPool(concurrency int) *Pool {
	return &Pool{
		concurrency: concurrency,
		jobs:        make(chan Job, concurrency*4),
		results:     make(chan Result, concurrency*4),
		handlers:    make(map[string]HandlerFunc),
	}
}

// RegisterHandler associates a job type with a handler function.
func (p *Pool) RegisterHandler(jobType string, fn HandlerFunc) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.handlers[jobType] = fn
}

// Start launches the worker goroutines.
func (p *Pool) Start(ctx context.Context) {
	for i := 0; i < p.concurrency; i++ {
		p.wg.Add(1)
		go p.runWorker(ctx, i)
	}
	go p.drainResults(ctx)
}

func (p *Pool) runWorker(ctx context.Context, id int) {
	defer p.wg.Done()
	log.Printf("[worker %d] started", id)
	for {
		select {
		case <-ctx.Done():
			log.Printf("[worker %d] shutting down", id)
			return
		case job, ok := <-p.jobs:
			if !ok {
				return
			}
			result := p.processJob(ctx, job)
			select {
			case p.results <- result:
			default:
				p.totalDropped.Add(1)
			}
		}
	}
}

func (p *Pool) processJob(ctx context.Context, job Job) Result {
	start := time.Now()
	p.mu.RLock()
	handler, ok := p.handlers[job.Type]
	p.mu.RUnlock()

	if !ok {
		p.totalFailed.Add(1)
		return Result{JobID: job.ID, Success: false, Error: errUnknownJobType(job.Type), Elapsed: time.Since(start)}
	}

	output, err := handler(ctx, job)
	elapsed := time.Since(start)

	if err != nil {
		p.totalFailed.Add(1)
		return Result{JobID: job.ID, Success: false, Error: err, Elapsed: elapsed}
	}

	p.totalProcessed.Add(1)
	return Result{JobID: job.ID, Success: true, Output: output, Elapsed: elapsed}
}

func (p *Pool) drainResults(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case r := <-p.results:
			if !r.Success {
				log.Printf("[pool] job %s failed: %v", r.JobID, r.Error)
			}
		}
	}
}

// Submit enqueues a job without blocking.
func (p *Pool) Submit(job Job) bool {
	select {
	case p.jobs <- job:
		return true
	default:
		p.totalDropped.Add(1)
		return false
	}
}

// Stats returns a snapshot of pool metrics.
func (p *Pool) Stats() map[string]any {
	return map[string]any{
		"concurrency": p.concurrency,
		"queue_depth": len(p.jobs),
		"queue_cap":   cap(p.jobs),
	}
}

// Metrics returns counters for Prometheus-style export.
func (p *Pool) Metrics() map[string]int64 {
	return map[string]int64{
		"processed": p.totalProcessed.Load(),
		"failed":    p.totalFailed.Load(),
		"dropped":   p.totalDropped.Load(),
	}
}

// Stop drains and closes the job channel.
func (p *Pool) Stop() {
	close(p.jobs)
	p.wg.Wait()
}

type unknownJobTypeError struct{ jobType string }

func (e unknownJobTypeError) Error() string {
	return "unknown job type: " + e.jobType
}

func errUnknownJobType(t string) error { return unknownJobTypeError{t} }
