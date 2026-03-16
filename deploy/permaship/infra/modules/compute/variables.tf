variable "project" {
  type = string
}

variable "environment" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "alb_security_group_id" {
  type = string
}

variable "app_security_group_id" {
  type = string
}

variable "certificate_arn" {
  type = string
}

variable "db_credentials_secret_arn" {
  type = string
}

variable "secret_arns" {
  type        = list(string)
  description = "All Secrets Manager ARNs the task needs access to"
}

variable "app_cpu" {
  type    = number
  default = 512
}

variable "app_memory" {
  type    = number
  default = 1024
}

variable "migration_cpu" {
  type    = number
  default = 256
}

variable "migration_memory" {
  type    = number
  default = 512
}

variable "desired_count" {
  type    = number
  default = 1
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "domain" {
  type = string
}

variable "webhook_secret_arn" {
  type = string
}

variable "encryption_key_secret_arn" {
  type = string
}

variable "gemini_api_key_secret_arn" {
  type = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
