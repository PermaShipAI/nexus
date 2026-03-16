variable "project" {
  type = string
}

variable "environment" {
  type = string
}

variable "vpc_cidr" {
  type    = string
  default = "10.1.0.0/16"
}

variable "tags" {
  type    = map(string)
  default = {}
}
