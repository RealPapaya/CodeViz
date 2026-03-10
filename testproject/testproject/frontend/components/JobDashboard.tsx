// frontend/components/JobDashboard.tsx
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { JobList } from './JobList';
import { JobDetail } from './JobDetail';
import { StatusBadge } from './StatusBadge';
import { useJobStore } from '../store/jobStore';
import { fetchJobs, cancelJob, retryJob } from '../api/jobs';
import { formatDuration, formatTimestamp } from '../utils/format';
import type { Job, JobStatus, ListJobsParams } from '../types';

const POLL_INTERVAL_MS = 3000;
const DEFAULT_PAGE_SIZE = 25;

interface DashboardProps {
  projectId: string;
  onJobSelect?: (job: Job) => void;
  initialFilter?: JobStatus;
}

export const JobDashboard: React.FC<DashboardProps> = ({
  projectId,
  onJobSelect,
  initialFilter,
}) => {
  const { jobs, setJobs, updateJob } = useJobStore();
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [filter, setFilter] = useState<JobStatus | 'all'>(initialFilter ?? 'all');
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadJobs = useCallback(async (params: ListJobsParams) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchJobs(projectId, params);
      setJobs(result.jobs);
      setTotalCount(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load jobs');
    } finally {
      setLoading(false);
    }
  }, [projectId, setJobs]);

  useEffect(() => {
    const params: ListJobsParams = {
      limit: DEFAULT_PAGE_SIZE,
      offset: page * DEFAULT_PAGE_SIZE,
      status: filter === 'all' ? undefined : filter,
    };
    loadJobs(params);
  }, [loadJobs, page, filter]);

  useEffect(() => {
    pollTimerRef.current = setInterval(() => {
      const params: ListJobsParams = {
        limit: DEFAULT_PAGE_SIZE,
        offset: page * DEFAULT_PAGE_SIZE,
        status: filter === 'all' ? undefined : filter,
      };
      loadJobs(params);
    }, POLL_INTERVAL_MS);

    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [loadJobs, page, filter]);

  const handleJobSelect = useCallback((job: Job) => {
    setSelectedJobId(job.id);
    onJobSelect?.(job);
  }, [onJobSelect]);

  const handleCancel = useCallback(async (jobId: string) => {
    try {
      const updated = await cancelJob(projectId, jobId);
      updateJob(updated);
    } catch (err) {
      console.error('Cancel failed:', err);
    }
  }, [projectId, updateJob]);

  const handleRetry = useCallback(async (jobId: string) => {
    try {
      const newJob = await retryJob(projectId, jobId);
      setJobs([newJob, ...jobs]);
    } catch (err) {
      console.error('Retry failed:', err);
    }
  }, [projectId, jobs, setJobs]);

  const totalPages = Math.ceil(totalCount / DEFAULT_PAGE_SIZE);
  const selectedJob = jobs.find(j => j.id === selectedJobId) ?? null;

  return (
    <div className="dashboard-root">
      <DashboardHeader
        filter={filter}
        onFilterChange={f => { setFilter(f); setPage(0); }}
        totalCount={totalCount}
        loading={loading}
      />
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <div className="dashboard-body">
        <JobList
          jobs={jobs}
          selectedId={selectedJobId}
          onSelect={handleJobSelect}
          onCancel={handleCancel}
          onRetry={handleRetry}
          loading={loading}
        />
        {selectedJob && (
          <JobDetail
            job={selectedJob}
            onCancel={() => handleCancel(selectedJob.id)}
            onRetry={() => handleRetry(selectedJob.id)}
            formatDuration={formatDuration}
            formatTimestamp={formatTimestamp}
          />
        )}
      </div>
      <Pagination page={page} total={totalPages} onChange={setPage} />
    </div>
  );
};

// ── Sub-components ────────────────────────────────────────────────────────────

interface HeaderProps {
  filter: JobStatus | 'all';
  onFilterChange: (f: JobStatus | 'all') => void;
  totalCount: number;
  loading: boolean;
}

const DashboardHeader: React.FC<HeaderProps> = ({ filter, onFilterChange, totalCount, loading }) => (
  <header className="dashboard-header">
    <h2 className="dashboard-title">
      Jobs <span className="count-badge">{totalCount}</span>
      {loading && <Spinner size="sm" />}
    </h2>
    <FilterTabs active={filter} onChange={onFilterChange} />
  </header>
);

const FilterTabs: React.FC<{ active: string; onChange: (f: any) => void }> = ({ active, onChange }) => {
  const tabs: Array<{ key: JobStatus | 'all'; label: string }> = [
    { key: 'all', label: 'All' },
    { key: 'pending', label: 'Pending' },
    { key: 'running', label: 'Running' },
    { key: 'completed', label: 'Completed' },
    { key: 'failed', label: 'Failed' },
  ];
  return (
    <nav className="filter-tabs">
      {tabs.map(t => (
        <button
          key={t.key}
          className={`tab-btn ${active === t.key ? 'active' : ''}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
};

const ErrorBanner: React.FC<{ message: string; onDismiss: () => void }> = ({ message, onDismiss }) => (
  <div className="error-banner" role="alert">
    <span>⚠ {message}</span>
    <button onClick={onDismiss} aria-label="Dismiss error">✕</button>
  </div>
);

const Pagination: React.FC<{ page: number; total: number; onChange: (p: number) => void }> = ({ page, total, onChange }) => (
  <footer className="pagination">
    <button onClick={() => onChange(page - 1)} disabled={page === 0}>← Prev</button>
    <span>{page + 1} / {Math.max(total, 1)}</span>
    <button onClick={() => onChange(page + 1)} disabled={page >= total - 1}>Next →</button>
  </footer>
);

const Spinner: React.FC<{ size?: 'sm' | 'md' }> = ({ size = 'md' }) => (
  <span className={`spinner spinner-${size}`} aria-label="Loading" />
);

export default JobDashboard;
