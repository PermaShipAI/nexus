terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.5"
    }
  }
}

variable "project" {
  type = string
}

variable "environment" {
  type = string
}

variable "aws_region" {
  type = string
}

variable "domain" {
  type = string
}

variable "hosted_zone_name" {
  type = string
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project
      Environment = var.environment
      ManagedBy   = "terraform"
      Repository  = "agents"
    }
  }
}

# ---------- 1. Secrets (KMS + Secrets Manager) ----------
module "secrets" {
  source = "../../modules/secrets"

  project     = var.project
  environment = var.environment
}

# ---------- 2. Networking ----------
module "networking" {
  source = "../../modules/networking"

  project     = var.project
  environment = var.environment
  vpc_cidr    = "10.1.0.0/16"
}

# ---------- 3. Database ----------
module "database" {
  source = "../../modules/database"

  project               = var.project
  environment           = var.environment
  private_subnet_ids    = module.networking.private_subnet_ids
  rds_security_group_id = module.networking.rds_security_group_id
  kms_key_arn           = module.secrets.kms_key_arn
  instance_class        = "db.t3.micro"
  allocated_storage     = 20
  deletion_protection   = true
}

# ---------- 4. DNS (certificate first, needed by compute) ----------
module "dns" {
  source = "../../modules/dns"

  project          = var.project
  environment      = var.environment
  domain           = var.domain
  hosted_zone_name = var.hosted_zone_name
  alb_dns_name     = module.compute.alb_dns_name
  alb_zone_id      = module.compute.alb_zone_id
}

# ---------- 5. Compute (ECS + ALB) ----------
module "compute" {
  source = "../../modules/compute"

  project               = var.project
  environment           = var.environment
  vpc_id                = module.networking.vpc_id
  public_subnet_ids     = module.networking.public_subnet_ids
  private_subnet_ids    = module.networking.private_subnet_ids
  alb_security_group_id = module.networking.alb_security_group_id
  app_security_group_id = module.networking.app_security_group_id
  domain                = var.domain

  certificate_arn = module.dns.certificate_validation_arn

  db_credentials_secret_arn = module.database.db_credentials_secret_arn
  webhook_secret_arn        = module.secrets.webhook_secret_arn
  encryption_key_secret_arn = module.secrets.encryption_key_secret_arn
  gemini_api_key_secret_arn = module.secrets.gemini_api_key_secret_arn

  secret_arns = concat(
    module.secrets.all_secret_arns,
    [module.database.db_credentials_secret_arn],
  )

  app_cpu       = 512
  app_memory    = 1024
  desired_count = 1

  deletion_protection = true
}

# ---------- Outputs ----------
output "ecr_repository_url" {
  value = module.compute.ecr_repository_url
}

output "alb_dns_name" {
  value = module.compute.alb_dns_name
}

output "ecs_cluster_name" {
  value = module.compute.ecs_cluster_name
}

output "app_service_name" {
  value = module.compute.app_service_name
}

output "db_instance_address" {
  value     = module.database.db_instance_address
  sensitive = true
}
