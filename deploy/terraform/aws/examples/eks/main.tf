terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0, < 7.0"
    }
  }
}

provider "aws" {
  region = var.region
}

variable "region" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "cluster_security_group_id" {
  description = "Security group of the EKS nodes, allowed to reach Postgres."
  type        = string
}

variable "oidc_provider_arn" {
  description = "IAM OIDC provider of the EKS cluster."
  type        = string
}

variable "dashboard_url" {
  description = "Where the dashboard is served, such as https://flakemetry.example.com."
  type        = string
}

module "flakemetry" {
  source = "../.."

  vpc_id                     = var.vpc_id
  database_subnet_ids        = var.private_subnet_ids
  allowed_security_group_ids = [var.cluster_security_group_id]
  web_origins                = [var.dashboard_url]

  eks_oidc_provider_arn      = var.oidc_provider_arn
  kubernetes_namespace       = "flakemetry"
  kubernetes_service_account = "flakemetry"

  database = {
    instance_class = "db.t4g.medium"
    multi_az       = true
  }
}

output "helm_values" {
  value     = module.flakemetry.helm_values
  sensitive = true
}

output "database_endpoint" {
  value = module.flakemetry.database_endpoint
}
