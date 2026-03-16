output "db_instance_id" {
  value = aws_db_instance.main.id
}

output "db_instance_address" {
  value = aws_db_instance.main.address
}

output "db_credentials_secret_arn" {
  value = aws_secretsmanager_secret.db_credentials.arn
}
