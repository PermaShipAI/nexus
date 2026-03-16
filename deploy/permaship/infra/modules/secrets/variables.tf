variable "project" {
  type = string
}

variable "environment" {
  type = string
}

variable "task_role_arns" {
  type    = list(string)
  default = []
}

variable "tags" {
  type    = map(string)
  default = {}
}
