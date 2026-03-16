output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "ecs_cluster_arn" {
  value = aws_ecs_cluster.main.arn
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "alb_dns_name" {
  value = aws_lb.main.dns_name
}

output "alb_zone_id" {
  value = aws_lb.main.zone_id
}

output "alb_arn" {
  value = aws_lb.main.arn
}

output "app_service_name" {
  value = aws_ecs_service.app.name
}

output "task_execution_role_arn" {
  value = aws_iam_role.task_execution.arn
}

output "app_task_role_arn" {
  value = aws_iam_role.app_task.arn
}
