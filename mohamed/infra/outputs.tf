output "url" {
  value       = "https://${var.public_hosts[0]}:8443"
  description = "What a browser opens. HTTPS with the self-signed certificate; port 8443 is floci's 443 published on the host."
}

output "load_balancer_dns" {
  value = aws_lb.app.dns_name
}

output "cluster" {
  value = aws_ecs_cluster.main.name
}

output "service" {
  value = aws_ecs_service.app.name
}

output "repository_url" {
  value = aws_ecr_repository.catalogue.repository_url
}

output "task_role_arn" {
  value = aws_iam_role.task.arn
}

output "execution_role_arn" {
  value = aws_iam_role.execution.arn
}

output "log_group" {
  value = aws_cloudwatch_log_group.app.name
}

output "kms_key_arn" {
  value = data.aws_kms_alias.keystore.target_key_arn
}
