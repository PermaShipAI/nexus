locals {
  common_tags = merge(var.tags, { Module = "secrets" })
}

data "aws_caller_identity" "current" {}

# KMS Customer Managed Key
resource "aws_kms_key" "main" {
  description             = "CMK for ${var.project} ${var.environment} secrets"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "EnableRootAccountAccess"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      },
      {
        Sid    = "AllowECSTaskAccess"
        Effect = "Allow"
        Principal = {
          AWS = length(var.task_role_arns) > 0 ? var.task_role_arns : ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
        }
        Action   = ["kms:Decrypt", "kms:DescribeKey"]
        Resource = "*"
      }
    ]
  })

  tags = local.common_tags
}

resource "aws_kms_alias" "main" {
  name          = "alias/${var.project}-${var.environment}"
  target_key_id = aws_kms_key.main.key_id
}

# App secrets: webhook secret
resource "aws_secretsmanager_secret" "webhook_secret" {
  name                    = "${var.project}-${var.environment}-webhook-secret"
  description             = "HMAC signing secret shared with PermaShip-Comms"
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = 7
  tags                    = merge(local.common_tags, { SecretType = "webhook" })
}

# App secrets: encryption key
resource "aws_secretsmanager_secret" "encryption_key" {
  name                    = "${var.project}-${var.environment}-encryption-key"
  description             = "AES-256-GCM key for encrypting tenant secrets at rest"
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = 30
  tags                    = merge(local.common_tags, { SecretType = "encryption" })
}

# App secrets: Gemini API key
resource "aws_secretsmanager_secret" "gemini_api_key" {
  name                    = "${var.project}-${var.environment}-gemini-api-key"
  description             = "Default Gemini API key for agent execution"
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = 7
  tags                    = merge(local.common_tags, { SecretType = "api-key" })
}
