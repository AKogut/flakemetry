locals {
  database_url = format(
    "postgresql://%s:%s@%s:%d/%s?schema=public&sslmode=verify-full",
    aws_db_instance.this.username,
    random_password.database.result,
    aws_db_instance.this.address,
    aws_db_instance.this.port,
    aws_db_instance.this.db_name,
  )

  helm_values = merge(
    {
      database = {
        url      = local.database_url
        caBundle = data.http.database_ca_bundle.response_body
      }
      storage = merge(
        {
          bucket         = aws_s3_bucket.artifacts.bucket
          region         = local.region
          endpoint       = ""
          publicEndpoint = ""
          forcePathStyle = false
        },
        local.use_irsa ? {} : {
          accessKeyId     = aws_iam_access_key.artifacts[0].id
          secretAccessKey = aws_iam_access_key.artifacts[0].secret
        },
      )
    },
    local.use_irsa ? {
      serviceAccount = {
        create      = true
        name        = var.kubernetes_service_account
        annotations = { "eks.amazonaws.com/role-arn" = aws_iam_role.artifacts[0].arn }
      }
    } : {},
  )
}

output "database_endpoint" {
  description = "Host and port of the Postgres instance."
  value       = "${aws_db_instance.this.address}:${aws_db_instance.this.port}"
}

output "database_url" {
  description = "Connection string for the chart's database.url, verifying the server certificate against database_ca_bundle."
  value       = local.database_url
  sensitive   = true
}

output "database_ca_bundle" {
  description = "CA bundle that signs RDS certificates, for the chart's database.caBundle."
  value       = data.http.database_ca_bundle.response_body
}

output "bucket_name" {
  description = "Artifact bucket."
  value       = aws_s3_bucket.artifacts.bucket
}

output "bucket_region" {
  description = "Region of the artifact bucket."
  value       = local.region
}

output "artifacts_role_arn" {
  description = "IAM role the service account assumes for S3, when eks_oidc_provider_arn is set."
  value       = local.use_irsa ? aws_iam_role.artifacts[0].arn : null
}

output "helm_values" {
  description = "Values for deploy/helm/flakemetry: write them to a file and pass it with -f before your own values."
  value       = yamlencode(local.helm_values)
  sensitive   = true
}
