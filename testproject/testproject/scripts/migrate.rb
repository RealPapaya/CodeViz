# scripts/migrate.rb — Database migration runner
require 'pg'
require 'json'
require 'logger'
require 'optparse'
require 'fileutils'
require_relative '../lib/db/connection'
require_relative '../lib/db/migrator'
require_relative '../lib/config/loader'

LOG = Logger.new($stdout, level: Logger::INFO)

class MigrationRunner
  MIGRATIONS_DIR = File.expand_path('../../db/migrations', __dir__)

  def initialize(options = {})
    @options  = options
    @dry_run  = options[:dry_run] || false
    @rollback = options[:rollback] || false
    @steps    = options[:steps] || 1
    @config   = Config::Loader.load(options[:env] || 'development')
    @db       = DB::Connection.new(@config.database)
    @migrator = DB::Migrator.new(@db, MIGRATIONS_DIR)
  end

  def run
    LOG.info("Starting migration (dry_run=#{@dry_run}, rollback=#{@rollback})")
    @migrator.ensure_schema_table!

    if @rollback
      run_rollback
    else
      run_migrate
    end
  end

  private

  def run_migrate
    pending = @migrator.pending_migrations
    if pending.empty?
      LOG.info('No pending migrations.')
      return
    end

    LOG.info("Found #{pending.size} pending migration(s):")
    pending.each { |m| LOG.info("  - #{m.version}: #{m.name}") }

    return if @dry_run

    pending.each do |migration|
      LOG.info("Applying #{migration.version} #{migration.name}…")
      start = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      @migrator.apply!(migration)
      elapsed = ((Process.clock_gettime(Process::CLOCK_MONOTONIC) - start) * 1000).round(1)
      LOG.info("  ✓ Done in #{elapsed}ms")
    end
  end

  def run_rollback
    applied = @migrator.applied_migrations.last(@steps)
    if applied.empty?
      LOG.warn('Nothing to roll back.')
      return
    end

    LOG.info("Rolling back #{applied.size} migration(s):")
    applied.reverse_each { |m| LOG.info("  - #{m.version}: #{m.name}") }

    return if @dry_run

    applied.reverse_each do |migration|
      LOG.info("Rolling back #{migration.version}…")
      @migrator.rollback!(migration)
      LOG.info('  ✓ Rolled back')
    end
  end
end

def parse_options(argv)
  opts = {}
  parser = OptionParser.new do |o|
    o.banner = "Usage: migrate.rb [options]"
    o.on('--env ENV', 'Environment (default: development)') { |v| opts[:env] = v }
    o.on('--dry-run', 'Print migrations without running them') { opts[:dry_run] = true }
    o.on('--rollback', 'Roll back instead of migrating') { opts[:rollback] = true }
    o.on('--steps N', Integer, 'Number of steps to roll back') { |v| opts[:steps] = v }
    o.on('-h', '--help', 'Show help') { puts o; exit }
  end
  parser.parse!(argv)
  opts
end

if __FILE__ == $PROGRAM_NAME
  options = parse_options(ARGV)
  runner  = MigrationRunner.new(options)
  runner.run
end
