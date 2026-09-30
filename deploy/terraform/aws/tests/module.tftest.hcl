mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
    }
  }

  mock_data "aws_region" {
    defaults = {
      region = "eu-central-1"
    }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  mock_resource "aws_db_instance" {
    defaults = {
      address = "flakemetry.c0ffee.eu-central-1.rds.amazonaws.com"
    }
  }

  mock_resource "aws_s3_bucket" {
    defaults = {
      arn = "arn:aws:s3:::flakemetry-artifacts-123456789012-eu-central-1"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/flakemetry-artifacts"
    }
  }

  mock_resource "aws_iam_access_key" {
    defaults = {
      id     = "AKIAIOSFODNN7EXAMPLE"
      secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
    }
  }
}

mock_provider "random" {}

mock_provider "http" {
  mock_data "http" {
    defaults = {
      status_code   = 200
      response_body = "-----BEGIN CERTIFICATE-----\nMIIBtest\n-----END CERTIFICATE-----\n"
    }
  }
}

variables {
  vpc_id                     = "vpc-0123456789abcdef0"
  database_subnet_ids        = ["subnet-aaaa", "subnet-bbbb"]
  allowed_security_group_ids = ["sg-nodes"]
}

run "database_is_private_encrypted_backed_up_and_hard_to_delete" {
  command = apply

  assert {
    condition     = aws_db_instance.this.publicly_accessible == false && aws_db_instance.this.storage_encrypted
    error_message = "The database must be private and encrypted at rest."
  }

  assert {
    condition     = aws_db_instance.this.engine == "postgres" && startswith(aws_db_instance.this.engine_version, "16")
    error_message = "Flakemetry runs on PostgreSQL 16."
  }

  assert {
    condition     = aws_db_instance.this.deletion_protection && !aws_db_instance.this.skip_final_snapshot && aws_db_instance.this.backup_retention_period >= 7
    error_message = "Deleting the instance must be deliberate, leave a final snapshot, and a week of backups must exist."
  }

  assert {
    condition     = keys(aws_vpc_security_group_ingress_rule.from_security_groups) == ["sg-nodes"] && length(aws_vpc_security_group_ingress_rule.from_cidr_blocks) == 0
    error_message = "Only the named security group may reach Postgres."
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.from_security_groups["sg-nodes"].from_port == 5432 && aws_vpc_security_group_ingress_rule.from_security_groups["sg-nodes"].to_port == 5432
    error_message = "The rule opens the Postgres port and nothing else."
  }
}

run "bucket_is_private_encrypted_and_refuses_plain_http" {
  command = apply

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.artifacts.block_public_acls,
      aws_s3_bucket_public_access_block.artifacts.block_public_policy,
      aws_s3_bucket_public_access_block.artifacts.ignore_public_acls,
      aws_s3_bucket_public_access_block.artifacts.restrict_public_buckets,
    ])
    error_message = "Every public access block must be on."
  }

  assert {
    condition     = one(one(aws_s3_bucket_server_side_encryption_configuration.artifacts.rule).apply_server_side_encryption_by_default).sse_algorithm == "AES256"
    error_message = "Without a KMS key the bucket still encrypts, with S3-managed keys."
  }

  assert {
    condition     = one(data.aws_iam_policy_document.tls_only.statement).effect == "Deny" && one(one(data.aws_iam_policy_document.tls_only.statement).condition).variable == "aws:SecureTransport"
    error_message = "The bucket policy denies requests that are not over TLS."
  }

  assert {
    condition     = aws_s3_bucket.artifacts.bucket == "flakemetry-artifacts-123456789012-eu-central-1"
    error_message = "The default bucket name carries the account and region, so it is unique."
  }

  assert {
    condition     = length(aws_s3_bucket_cors_configuration.artifacts) == 0
    error_message = "No CORS rule is added without an origin to allow."
  }

  assert {
    condition     = length(aws_s3_bucket_lifecycle_configuration.artifacts.rule) == 1
    error_message = "Only incomplete uploads are cleaned up unless expiration is asked for; the worker prunes by project policy."
  }
}

run "dashboard_origin_may_read_artifacts_and_only_read" {
  command = apply

  variables {
    web_origins              = ["https://flakemetry.example.com"]
    artifact_expiration_days = 400
  }

  assert {
    condition     = one(aws_s3_bucket_cors_configuration.artifacts[0].cors_rule).allowed_origins == toset(["https://flakemetry.example.com"])
    error_message = "CORS allows the dashboard origin."
  }

  assert {
    condition     = one(aws_s3_bucket_cors_configuration.artifacts[0].cors_rule).allowed_methods == toset(["GET", "HEAD"])
    error_message = "The browser reads artifacts; uploads come from CI with presigned URLs, not from the dashboard."
  }

  assert {
    condition     = length(aws_s3_bucket_lifecycle_configuration.artifacts.rule) == 2
    error_message = "An expiration rule is added when asked for."
  }
}

run "without_an_oidc_provider_the_pods_get_access_keys" {
  command = apply

  assert {
    condition     = length(aws_iam_access_key.artifacts) == 1 && length(aws_iam_role.artifacts) == 0
    error_message = "An IAM user with a key, and no role."
  }

  assert {
    condition     = yamldecode(output.helm_values).storage.accessKeyId == "AKIAIOSFODNN7EXAMPLE"
    error_message = "The key reaches the chart values."
  }

  assert {
    condition     = !contains(keys(yamldecode(output.helm_values)), "serviceAccount")
    error_message = "No service account annotation without a role."
  }
}

run "with_an_oidc_provider_the_service_account_assumes_a_role" {
  command = apply

  variables {
    eks_oidc_provider_arn      = "arn:aws:iam::123456789012:oidc-provider/oidc.eks.eu-central-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE"
    kubernetes_namespace       = "ci"
    kubernetes_service_account = "fm-flakemetry"
  }

  assert {
    condition     = length(aws_iam_access_key.artifacts) == 0 && length(aws_iam_user.artifacts) == 0 && length(aws_iam_role.artifacts) == 1
    error_message = "A role and no long-lived key."
  }

  assert {
    condition = contains(
      [for condition in one(data.aws_iam_policy_document.assume_from_service_account[0].statement).condition : condition.variable],
      "oidc.eks.eu-central-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE:sub",
    )
    error_message = "The trust policy is keyed on the cluster's issuer."
  }

  assert {
    condition = contains(
      flatten([for condition in one(data.aws_iam_policy_document.assume_from_service_account[0].statement).condition : condition.values]),
      "system:serviceaccount:ci:fm-flakemetry",
    )
    error_message = "Only the release's service account may assume the role."
  }

  assert {
    condition     = yamldecode(output.helm_values).serviceAccount.annotations["eks.amazonaws.com/role-arn"] == "arn:aws:iam::123456789012:role/flakemetry-artifacts"
    error_message = "The chart annotates its service account with the role."
  }

  assert {
    condition     = !contains(keys(yamldecode(output.helm_values).storage), "accessKeyId")
    error_message = "No access key in the values when the role is used."
  }
}

run "connection_string_verifies_the_server_and_names_the_schema" {
  command = apply

  assert {
    condition     = strcontains(output.database_url, "@flakemetry.c0ffee.eu-central-1.rds.amazonaws.com:5432/flakemetry?schema=public&sslmode=verify-full")
    error_message = "database_url points at the instance, the public schema, and verifies the certificate."
  }

  assert {
    condition     = !random_password.database.special && random_password.database.length >= 32
    error_message = "The password is long and needs no escaping inside a URL."
  }

  assert {
    condition     = yamldecode(output.helm_values).database.caBundle == output.database_ca_bundle
    error_message = "The CA bundle that verifies the server reaches the chart values."
  }
}

run "every_value_it_writes_is_one_the_chart_reads" {
  command = apply

  variables {
    eks_oidc_provider_arn = "arn:aws:iam::123456789012:oidc-provider/oidc.eks.eu-central-1.amazonaws.com/id/EXAMPLE"
  }

  assert {
    condition = alltrue(flatten([
      for section, entries in yamldecode(output.helm_values) : [
        for key, value in entries : contains(keys(yamldecode(file("${path.module}/../../helm/flakemetry/values.yaml"))[section]), key)
      ]
    ]))
    error_message = "helm_values names a key deploy/helm/flakemetry/values.yaml does not have."
  }
}

run "a_database_nothing_may_reach_is_refused" {
  command = plan

  variables {
    allowed_security_group_ids = []
    allowed_cidr_blocks        = []
  }

  expect_failures = [var.allowed_security_group_ids]
}

run "the_whole_internet_is_not_a_client" {
  command = plan

  variables {
    allowed_cidr_blocks = ["0.0.0.0/0"]
  }

  expect_failures = [var.allowed_cidr_blocks]
}

run "an_engine_the_platform_is_not_tested_on_is_refused" {
  command = plan

  variables {
    database = { engine_version = "15.7" }
  }

  expect_failures = [var.database]
}
