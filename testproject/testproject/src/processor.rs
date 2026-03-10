// src/processor.rs — Core data processor in Rust
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tracing::{debug, error, info, instrument, warn};
use uuid::Uuid;

use crate::config::ProcessorConfig;
use crate::error::{AppError, Result};
use crate::metrics::Registry;
use crate::store::Store;

const DEFAULT_BATCH_SIZE: usize = 64;
const DEFAULT_CHANNEL_CAPACITY: usize = 512;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Job {
    pub id: Uuid,
    pub job_type: String,
    pub payload: serde_json::Value,
    pub priority: i32,
    pub retry_count: u32,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobResult {
    pub job_id: Uuid,
    pub success: bool,
    pub output: Option<serde_json::Value>,
    pub error_msg: Option<String>,
    pub elapsed_ms: u64,
}

pub type HandlerFn = Arc<dyn Fn(Job) -> Result<serde_json::Value> + Send + Sync>;

pub struct Processor {
    config: ProcessorConfig,
    store: Arc<dyn Store>,
    metrics: Arc<Registry>,
    handlers: Arc<Mutex<HashMap<String, HandlerFn>>>,
    tx: mpsc::Sender<Job>,
    rx: Arc<Mutex<mpsc::Receiver<Job>>>,
}

impl Processor {
    pub fn new(config: ProcessorConfig, store: Arc<dyn Store>, metrics: Arc<Registry>) -> Self {
        let (tx, rx) = mpsc::channel(DEFAULT_CHANNEL_CAPACITY);
        Self {
            config,
            store,
            metrics,
            handlers: Arc::new(Mutex::new(HashMap::new())),
            tx,
            rx: Arc::new(Mutex::new(rx)),
        }
    }

    pub fn register_handler(&self, job_type: &str, handler: HandlerFn) {
        let mut map = self.handlers.lock().unwrap();
        map.insert(job_type.to_string(), handler);
        info!("Registered handler for job type: {}", job_type);
    }

    pub async fn submit(&self, job: Job) -> Result<()> {
        self.tx.send(job).await.map_err(|e| AppError::Channel(e.to_string()))
    }

    #[instrument(skip(self))]
    pub async fn run(&self) -> Result<()> {
        info!("Processor starting with {} workers", self.config.workers);
        let semaphore = Arc::new(tokio::sync::Semaphore::new(self.config.workers));
        let rx = self.rx.clone();

        loop {
            let job = {
                let mut guard = rx.lock().unwrap();
                guard.try_recv().ok()
            };

            let Some(job) = job else {
                tokio::time::sleep(Duration::from_millis(10)).await;
                continue;
            };

            let permit = semaphore.clone().acquire_owned().await.unwrap();
            let handlers = self.handlers.clone();
            let store = self.store.clone();
            let metrics = self.metrics.clone();

            tokio::spawn(async move {
                let _permit = permit;
                let result = process_job(job, handlers, metrics).await;
                if let Err(e) = store.save_result(&result).await {
                    error!("Failed to save result for job {}: {}", result.job_id, e);
                }
            });
        }
    }

    pub fn queue_depth(&self) -> usize {
        DEFAULT_CHANNEL_CAPACITY - self.tx.capacity()
    }
}

async fn process_job(
    job: Job,
    handlers: Arc<Mutex<HashMap<String, HandlerFn>>>,
    metrics: Arc<Registry>,
) -> JobResult {
    let start = Instant::now();
    let job_id = job.id;
    let job_type = job.job_type.clone();

    let handler = {
        let map = handlers.lock().unwrap();
        map.get(&job_type).cloned()
    };

    let (success, output, error_msg) = match handler {
        None => {
            warn!("No handler for job type: {}", job_type);
            metrics.increment("jobs.unknown_type");
            (false, None, Some(format!("Unknown job type: {}", job_type)))
        }
        Some(h) => match h(job) {
            Ok(out) => {
                metrics.increment("jobs.success");
                (true, Some(out), None)
            }
            Err(e) => {
                error!("Job {} failed: {}", job_id, e);
                metrics.increment("jobs.failed");
                (false, None, Some(e.to_string()))
            }
        },
    };

    let elapsed_ms = start.elapsed().as_millis() as u64;
    metrics.record_histogram("jobs.duration_ms", elapsed_ms as f64);
    debug!("Job {} completed in {}ms (success={})", job_id, elapsed_ms, success);

    JobResult { job_id, success, output, error_msg, elapsed_ms }
}

pub fn build_processor(
    config: ProcessorConfig,
    store: Arc<dyn Store>,
    metrics: Arc<Registry>,
) -> Processor {
    let proc = Processor::new(config, store, metrics);
    register_default_handlers(&proc);
    proc
}

fn register_default_handlers(proc: &Processor) {
    proc.register_handler("echo", Arc::new(|job| {
        Ok(job.payload.clone())
    }));
    proc.register_handler("noop", Arc::new(|_job| {
        Ok(serde_json::json!({"status": "noop"}))
    }));
}
