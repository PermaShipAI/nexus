output "certificate_arn" {
  value = aws_acm_certificate.main.arn
}

output "certificate_validation_arn" {
  value = aws_acm_certificate_validation.main.certificate_arn
}
