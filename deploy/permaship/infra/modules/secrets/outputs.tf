output "kms_key_arn" {
  value = aws_kms_key.main.arn
}

output "kms_key_id" {
  value = aws_kms_key.main.key_id
}

output "webhook_secret_arn" {
  value = aws_secretsmanager_secret.webhook_secret.arn
}

output "encryption_key_secret_arn" {
  value = aws_secretsmanager_secret.encryption_key.arn
}

output "gemini_api_key_secret_arn" {
  value = aws_secretsmanager_secret.gemini_api_key.arn
}

output "all_secret_arns" {
  value = [
    aws_secretsmanager_secret.webhook_secret.arn,
    aws_secretsmanager_secret.encryption_key.arn,
    aws_secretsmanager_secret.gemini_api_key.arn,
  ]
}
