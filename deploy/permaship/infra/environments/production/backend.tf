terraform {
  backend "s3" {
    bucket         = "conductor-tf-state-748560966555"
    key            = "agents/production/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "conductor-terraform-locks"
  }
}
