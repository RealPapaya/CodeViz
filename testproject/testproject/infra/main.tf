# infra/main.tf — Core infrastructure
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.25"
    }
  }

  backend "s3" {
    bucket         = "myorg-tfstate"
    key            = "testproject/terraform.tfstate"
    region         = "ap-northeast-1"
    encrypt        = true
    dynamodb_table = "tfstate-lock"
  }
}

provider "aws" {
  region = var.aws_region
  default_tags { tags = local.common_tags }
}

# ── Variables ─────────────────────────────────────────────────────────────────
variable "aws_region"    { default = "ap-northeast-1" }
variable "env"           { default = "staging" }
variable "app_name"      { default = "testproject" }
variable "instance_type" { default = "t3.medium" }
variable "min_capacity"  { default = 2 }
variable "max_capacity"  { default = 10 }

# ── Locals ────────────────────────────────────────────────────────────────────
locals {
  name_prefix = "${var.app_name}-${var.env}"
  common_tags = {
    App         = var.app_name
    Environment = var.env
    ManagedBy   = "terraform"
  }
}

# ── VPC ───────────────────────────────────────────────────────────────────────
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.5.1"

  name = "${local.name_prefix}-vpc"
  cidr = "10.0.0.0/16"
  azs  = ["${var.aws_region}a", "${var.aws_region}b", "${var.aws_region}c"]

  private_subnets = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
  public_subnets  = ["10.0.101.0/24", "10.0.102.0/24", "10.0.103.0/24"]

  enable_nat_gateway   = true
  single_nat_gateway   = var.env != "production"
  enable_dns_hostnames = true

  tags = local.common_tags
}

# ── RDS ───────────────────────────────────────────────────────────────────────
resource "aws_db_instance" "main" {
  identifier        = "${local.name_prefix}-db"
  engine            = "postgres"
  engine_version    = "15.4"
  instance_class    = "db.t4g.medium"
  allocated_storage = 50
  storage_encrypted = true

  db_name  = var.app_name
  username = "appuser"
  password = data.aws_secretsmanager_secret_version.db_password.secret_string

  vpc_security_group_ids = [aws_security_group.rds.id]
  db_subnet_group_name   = aws_db_subnet_group.main.name

  backup_retention_period   = 7
  deletion_protection       = var.env == "production"
  skip_final_snapshot       = var.env != "production"
  final_snapshot_identifier = "${local.name_prefix}-final-snapshot"

  tags = local.common_tags
}

resource "aws_db_subnet_group" "main" {
  name       = "${local.name_prefix}-db-subnet"
  subnet_ids = module.vpc.private_subnets
  tags       = local.common_tags
}

resource "aws_security_group" "rds" {
  name   = "${local.name_prefix}-rds-sg"
  vpc_id = module.vpc.vpc_id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }
  tags = local.common_tags
}

resource "aws_security_group" "app" {
  name   = "${local.name_prefix}-app-sg"
  vpc_id = module.vpc.vpc_id
  tags   = local.common_tags
}

# ── ElastiCache (Redis) ───────────────────────────────────────────────────────
resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "${local.name_prefix}-redis"
  description          = "Redis for ${var.app_name} ${var.env}"
  node_type            = "cache.t4g.small"
  num_cache_clusters   = var.env == "production" ? 2 : 1
  engine_version       = "7.0"
  port                 = 6379
  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = [aws_security_group.app.id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  tags = local.common_tags
}

resource "aws_elasticache_subnet_group" "main" {
  name       = "${local.name_prefix}-redis-subnet"
  subnet_ids = module.vpc.private_subnets
}

# ── Outputs ───────────────────────────────────────────────────────────────────
output "vpc_id"         { value = module.vpc.vpc_id }
output "rds_endpoint"   { value = aws_db_instance.main.endpoint }
output "redis_endpoint" { value = aws_elasticache_replication_group.main.primary_endpoint_address }
